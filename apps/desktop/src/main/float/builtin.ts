/**
 * 内置浮窗插件集（模块二）
 * 每个插件都是独立对象，与外部插件走完全相同的契约 —— 这保证插件化不是花架子：
 * 内置插件可以被禁用、排序，外部插件享有同等能力。
 */

import * as os from 'node:os'
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import type { FloatPluginDatum } from '@shared/types'
import type { FloatPlugin, PluginContext } from './plugin-api'

const statfsAsync = promisify(statfs)

// ───────────────── 1. CPU 与内存 ─────────────────

interface CpuSnapshot {
  idle: number
  total: number
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

const cpuMemPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.cpumem',
    name: 'CPU 与内存',
    description: '实时 CPU 占用率与物理内存使用情况',
    interval: 2000,
    view: 'bars',
    icon: 'cpu',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  collect(ctx: PluginContext): FloatPluginDatum[] {
    const prev = ctx.state.get('cpu') as CpuSnapshot | undefined
    const cur = cpuSnapshot()
    ctx.state.set('cpu', cur)

    let cpuPercent = 0
    if (prev) {
      const dIdle = cur.idle - prev.idle
      const dTotal = cur.total - prev.total
      cpuPercent = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0
    }

    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const memPercent = (usedMem / totalMem) * 100

    return [
      {
        label: 'CPU',
        value: `${cpuPercent.toFixed(0)}%`,
        ratio: cpuPercent,
        tone: cpuPercent > 85 ? 'danger' : cpuPercent > 60 ? 'warn' : 'normal'
      },
      {
        label: '内存',
        value: `${ctx.formatBytes(usedMem, 1)} / ${ctx.formatBytes(totalMem, 0)}`,
        ratio: memPercent,
        tone: memPercent > 88 ? 'danger' : memPercent > 70 ? 'warn' : 'normal'
      }
    ]
  }
}

// ───────────────── 2. 磁盘空间 ─────────────────

const diskPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.disk',
    name: '磁盘空间',
    description: '各分区可用空间与使用率',
    interval: 30_000,
    view: 'bars',
    icon: 'disk',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx: PluginContext): Promise<FloatPluginDatum[]> {
    const out: FloatPluginDatum[] = []
    for (const letter of 'CDEFGH') {
      const root = `${letter}:\\`
      try {
        const st = await statfsAsync(root)
        const total = Number(st.blocks) * Number(st.bsize)
        const free = Number(st.bavail) * Number(st.bsize)
        if (!total) continue
        const usedPercent = ((total - free) / total) * 100
        out.push({
          label: `${letter}:`,
          value: `剩余 ${ctx.formatBytes(free, 1)}`,
          ratio: usedPercent,
          hint: `共 ${ctx.formatBytes(total, 1)}`,
          tone: usedPercent > 92 ? 'danger' : usedPercent > 80 ? 'warn' : 'normal'
        })
      } catch {
        /* 盘符不存在或不可访问 */
      }
    }
    if (out.length === 0) out.push({ label: '磁盘', value: '无法读取' })
    return out
  }
}

// ───────────────── 3. 网络速率 ─────────────────

/**
 * 网络计数器需要系统性能数据，Node 无内置 API。
 * 这里用一个「常驻 PowerShell 采样进程」而非每轮新建进程：
 * 后者每次约 300~600ms 冷启动，1~3s 的刷新间隔下完全不可接受。
 */
const netPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.network',
    name: '网络速率',
    description: '实时上传与下载速率（基于网卡累计字节数差分）',
    interval: 3000,
    view: 'metric',
    icon: 'network',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx: PluginContext): Promise<FloatPluginDatum[]> {
    let cur: { rx: number; tx: number } | null = null
    try {
      const rows = await ctx.psJson<{ rx: number; tx: number }>(
        `
$rx = 0; $tx = 0
try {
  $stats = Get-NetAdapterStatistics -ErrorAction Stop
  foreach ($s in $stats) { $rx += [double]$s.ReceivedBytes; $tx += [double]$s.SentBytes }
} catch {
  try {
    $ifs = Get-CimInstance -ClassName Win32_PerfRawData_Tcpip_NetworkInterface -ErrorAction Stop
    foreach ($i in $ifs) { $rx += [double]$i.BytesReceivedPersec; $tx += [double]$i.BytesSentPersec }
  } catch { }
}
Write-SgJson ([pscustomobject]@{ rx = $rx; tx = $tx })
`,
        12_000
      )
      if (rows && Number.isFinite(rows.rx)) cur = { rx: Number(rows.rx), tx: Number(rows.tx) }
    } catch {
      cur = null
    }
    if (!cur) return [{ label: '网络', value: '不可用', tone: 'warn', hint: '需要 Get-NetAdapterStatistics 权限' }]

    const now = Date.now()
    const prev = ctx.state.get('net') as { rx: number; tx: number; ts: number } | undefined
    ctx.state.set('net', { ...cur, ts: now })
    if (!prev) return [{ label: '下载', value: '采样中…' }, { label: '上传', value: '采样中…' }]

    const dt = Math.max((now - prev.ts) / 1000, 0.5)
    const down = Math.max(0, (cur.rx - prev.rx) / dt)
    const up = Math.max(0, (cur.tx - prev.tx) / dt)
    return [
      { label: '↓ 下载', value: `${ctx.formatBytes(down, 1)}/s`, tone: down > 1e6 ? 'good' : 'normal' },
      { label: '↑ 上传', value: `${ctx.formatBytes(up, 1)}/s` }
    ]
  }
}

// ───────────────── 4. 时钟 ─────────────────

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const clockPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.clock',
    name: '时钟日期',
    description: '当前时间、日期与星期',
    interval: 1000,
    view: 'text',
    icon: 'clock',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  collect(): FloatPluginDatum[] {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return [
      { label: 'time', value: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` },
      {
        label: 'date',
        value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${WEEK[d.getDay()]}`,
        tone: 'normal'
      }
    ]
  }
}

// ───────────────── 5. 垃圾体积 ─────────────────

const junkPlugin: FloatPlugin = {
  manifest: {
    id: 'sg.junk',
    name: '垃圾占用',
    description: '上次扫描发现的可释放空间与一键可清理量',
    interval: 15_000,
    view: 'metric',
    icon: 'trash',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  collect(ctx: PluginContext): FloatPluginDatum[] {
    const total = ctx.app.junkTotalBytes()
    const oneClick = ctx.app.junkOneClickBytes()
    const at = ctx.app.lastJunkScanAt()
    if (!at) return [{ label: '垃圾', value: '尚未扫描', tone: 'warn', hint: '点击浮窗打开主界面开始扫描' }]
    const ageH = (Date.now() - at) / 3_600_000
    return [
      {
        label: '可释放',
        value: ctx.formatBytes(total, 1),
        tone: total > 10e9 ? 'danger' : total > 3e9 ? 'warn' : 'good'
      },
      { label: '一键可清', value: ctx.formatBytes(oneClick, 1), hint: `${ageH.toFixed(1)} 小时前扫描` }
    ]
  }
}

// ───────────────── 6. 系统概览 ─────────────────

const overviewPlugin: FloatPlugin = {
  manifest: {
    id: 'sg.overview',
    name: 'SoftGraph 概览',
    description: '已收录软件数、隔离区条目与系统运行时长',
    interval: 20_000,
    view: 'list',
    icon: 'graph',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  collect(ctx: PluginContext): FloatPluginDatum[] {
    const up = os.uptime()
    const d = Math.floor(up / 86400)
    const h = Math.floor((up % 86400) / 3600)
    const m = Math.floor((up % 3600) / 60)
    return [
      { label: '已收录软件', value: `${ctx.app.softwareCount()} 个` },
      { label: '隔离区', value: `${ctx.app.quarantineCount()} 条` },
      { label: '开机时长', value: d > 0 ? `${d} 天 ${h} 小时` : `${h} 小时 ${m} 分` }
    ]
  }
}

// ───────────────── 7. 内存 TOP 进程 ─────────────────

const topProcPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.topproc',
    name: '内存占用 TOP',
    description: '物理内存占用最高的前 4 个进程',
    interval: 10_000,
    view: 'list',
    icon: 'process',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx: PluginContext): Promise<FloatPluginDatum[]> {
    try {
      const rows = await ctx.psJson<{ name: string; ws: number }[]>(
        `
$top = Get-Process | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 4
$out = New-Object System.Collections.ArrayList
foreach ($p in $top) { [void]$out.Add([pscustomobject]@{ name = $p.ProcessName; ws = [double]$p.WorkingSet64 }) }
Write-SgJson @($out)
`,
        15_000
      )
      const arr = Array.isArray(rows) ? rows : [rows as unknown as { name: string; ws: number }]
      if (!arr.length || !arr[0]?.name) return [{ label: '进程', value: '不可用', tone: 'warn' }]
      return arr.map((r) => ({ label: r.name, value: ctx.formatBytes(Number(r.ws), 1) }))
    } catch {
      return [{ label: '进程', value: '读取失败', tone: 'warn' }]
    }
  }
}

// ───────────────── 8. 温度与风扇（F3） ─────────────────

/**
 * 温度没有统一的 Windows API：不同厂商走不同 WMI 类，且多数消费级主板
 * 根本不暴露。因此这里对三个常见来源依次尝试，任何一个命中即可；
 * 全都取不到时明确显示「本机未暴露」—— 不假装成 0°C。
 */
const tempPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.temp',
    name: '温度与风扇',
    description: 'CPU/主板温度与风扇转速（依赖主板是否暴露传感器）',
    interval: 20_000,
    view: 'metric',
    icon: 'temp',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx: PluginContext): Promise<FloatPluginDatum[]> {
    let data: { temp: number | null; fan: number | null } | null = null
    try {
      data = await ctx.psJson<{ temp: number | null; fan: number | null }>(
        `
$temp = $null
$fan = $null
try {
  $z = Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
  if ($z) { $temp = [math]::Round((([double]$z[0].CurrentTemperature) / 10) - 273.15, 1) }
} catch { }
if ($null -eq $temp) {
  try {
    $p = Get-CimInstance -ClassName Win32_TemperatureProbe -ErrorAction Stop
    if ($p -and $p[0].CurrentReading) { $temp = [math]::Round((([double]$p[0].CurrentReading) / 10) - 273.15, 1) }
  } catch { }
}
try {
  $f = Get-CimInstance -ClassName Win32_Fan -ErrorAction Stop
  if ($f -and $f[0].DesiredSpeed) { $fan = [double]$f[0].DesiredSpeed }
} catch { }
Write-SgJson ([pscustomobject]@{ temp = $temp; fan = $fan })
`,
        15_000
      )
    } catch {
      data = null
    }
    const temp = data?.temp
    if (temp === null || temp === undefined || !Number.isFinite(Number(temp))) {
      return [{ label: '温度', value: '本机未暴露', tone: 'warn', hint: '多数消费级主板不提供传感器读数' }]
    }
    const t = Number(temp)
    const fan = Number(data?.fan)
    const out: FloatPluginDatum[] = [
      {
        label: '温度',
        value: `${t.toFixed(0)}°C`,
        ratio: Math.max(0, Math.min(100, ((t - 30) / 70) * 100)),
        tone: t > 90 ? 'danger' : t > 75 ? 'warn' : 'normal'
      }
    ]
    if (Number.isFinite(fan) && fan > 0) out.push({ label: '风扇', value: `${Math.round(fan)} RPM` })
    return out
  }
}

// ───────────────── 9. 电池与电源（F3） ─────────────────

/** Win32_Battery.BatteryStatus：1 放电 / 2 交流供电 / 3 已充满 / 4 低电 / 5 临界 / 6 充电中 */
const BATTERY_STATUS: Record<number, string> = {
  1: '放电中',
  2: '已充满 · 接电源',
  3: '已充满',
  4: '电量低',
  5: '电量临界',
  6: '充电中',
  7: '充电中 · 电量低',
  8: '充电中 · 电量临界',
  9: '充电中 · 电量高',
  10: '部分充电',
  11: '未知'
}

const batteryPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.battery',
    name: '电池与电源',
    description: '电池剩余电量与充放电状态；台式机显示「无电池」',
    interval: 30_000,
    view: 'gauge',
    icon: 'battery',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx: PluginContext): Promise<FloatPluginDatum[]> {
    let data: { percent: number | null; status: number | null } | null = null
    try {
      data = await ctx.psJson<{ percent: number | null; status: number | null }>(
        `
$percent = $null
$status = $null
try {
  $b = Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop
  if ($b) { $percent = [double]$b[0].EstimatedChargeRemaining; $status = [double]$b[0].BatteryStatus }
} catch { }
Write-SgJson ([pscustomobject]@{ percent = $percent; status = $status })
`,
        15_000
      )
    } catch {
      data = null
    }
    // 注意：不能写成 Number(data?.percent) >= 0 —— Number(null) 得 0，
    // 会把「没有电池」显示成「电量 0%」，两者对用户含义完全不同
    const raw = data?.percent
    if (raw === null || raw === undefined) {
      return [{ label: '电池', value: '无电池', hint: '台式机或未安装电池' }]
    }
    const p = Number(raw)
    if (!Number.isFinite(p) || p < 0) {
      return [{ label: '电池', value: '无电池', hint: '台式机或未安装电池' }]
    }
    const st = Number(data?.status)
    const text = Number.isFinite(st) ? (BATTERY_STATUS[st] ?? '未知') : ''
    return [
      {
        label: '电量',
        value: `${Math.round(p)}%`,
        ratio: p,
        hint: text,
        tone: p <= 10 ? 'danger' : p <= 25 ? 'warn' : 'normal'
      }
    ]
  }
}

// ───────────────── 10. 网络连接（F3） ─────────────────

const netConnPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.netconn',
    name: '网络连接',
    description: '已建立的 TCP 连接数与对外连接最多的进程',
    interval: 15_000,
    view: 'list',
    icon: 'network',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx: PluginContext): Promise<FloatPluginDatum[]> {
    let rows: { name: string; count: number }[] | null = null
    try {
      const r = await ctx.psJson<{ total: number; tops: { name: string; count: number }[] }>(
        `
$total = 0
$tops = @()
try {
  $conns = Get-NetTCPConnection -State Established -ErrorAction Stop
  $total = @($conns).Count
  $proc = @{}
  foreach ($c in $conns) {
    if (-not $c.OwningProcess) { continue }
    if (-not $proc.ContainsKey($c.OwningProcess)) { $proc[$c.OwningProcess] = 0 }
    $proc[$c.OwningProcess] = $proc[$c.OwningProcess] + 1
  }
  $tops = @($proc.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 3 | ForEach-Object {
    $p = Get-Process -Id $_.Key -ErrorAction SilentlyContinue
    [pscustomobject]@{ name = if ($p) { $p.ProcessName } else { 'PID ' + $_.Key }; count = [double]$_.Value }
  })
} catch { }
Write-SgJson ([pscustomobject]@{ total = [double]$total; tops = @($tops) })
`,
        15_000
      )
      rows = r?.tops ?? []
      const total = Number(r?.total)
      if (!Number.isFinite(total)) return [{ label: '连接', value: '不可用', tone: 'warn' }]
      const out: FloatPluginDatum[] = [{ label: '已建立连接', value: String(total) }]
      for (const t of rows.slice(0, 3)) {
        if (!t?.name) continue
        out.push({ label: t.name, value: `${Number(t.count) || 0} 条` })
      }
      return out
    } catch {
      return [{ label: '连接', value: '读取失败', tone: 'warn' }]
    }
  }
}

// ───────────────── 11. 专注计时（F3） ─────────────────

/**
 * 专注计时是唯一「不采集、只记账」的插件：它把浮窗在屏时长累加成专注时长。
 * 状态存在 ctx.state（跨轮次保留，进程重启即清零），不做持久化 ——
 * 一次专注不该跨越应用重启。
 */
const focusPlugin: FloatPlugin = {
  manifest: {
    id: 'sg.focus',
    name: '专注计时',
    description: '累计专注时长（浮窗在屏期间累加，重启清零）',
    interval: 60_000,
    view: 'text',
    icon: 'focus',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  collect(ctx: PluginContext): FloatPluginDatum[] {
    const KEY = 'focus'
    const prev = ctx.state.get(KEY) as { ms: number; last: number } | undefined
    const now = Date.now()
    // 首轮只立起点，不计时长（否则一启用就显示 1 分钟）
    if (!prev) {
      ctx.state.set(KEY, { ms: 0, last: now })
      return [{ label: '专注', value: '0 分钟', hint: '开始计时' }]
    }
    const delta = Math.max(0, now - prev.last)
    const ms = prev.ms + delta
    ctx.state.set(KEY, { ms, last: now })
    const mins = Math.floor(ms / 60000)
    const text = mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟` : `${mins} 分钟`
    return [{ label: '专注', value: text, hint: mins >= 25 ? '已达一个番茄钟' : '持续中' }]
  }
}

// ───────────────── 12. CPU 占用 TOP（F3 补齐） ─────────────────

/**
 * 与「内存占用 TOP」（sys.topproc）配对：一个看内存，一个看 CPU。
 *
 * 为什么用 Win32_PerfFormattedData 而不是 Get-Process 的 CPU 字段：
 *   `Get-Process.CPU` 是**进程启动以来的累计 CPU 秒数**，单调增长 ——
 *   按它排序等于「谁活得久谁第一」，完全反映不了此刻谁在烧 CPU。
 *   `PercentProcessorTime` 是瞬时占比，才是这个问题要的答案。
 *
 * 归一化：该计数器在多核机器上以「单核 = 100%」计量，8 核满载可到 800%。
 * 这里除以逻辑核数换算成「占整机比例」，与任务管理器的口径一致，
 * 避免浮窗上出现「180%」这种让人困惑的数字。
 *
 * 按进程名合并多实例进程（chrome 的十几个渲染进程应算作一条）。
 */
const topCpuPlugin: FloatPlugin = {
  manifest: {
    id: 'sys.topcpu',
    name: 'CPU 占用 TOP',
    description: '当前 CPU 占用最高的前 4 个进程（同名进程已合并）',
    interval: 10_000,
    view: 'list',
    icon: 'process',
    builtin: true,
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx: PluginContext): Promise<FloatPluginDatum[]> {
    let rows: { name: string; cpu: number }[] | null = null
    try {
      const r = await ctx.psJson<{ name: string; cpu: number }[]>(
        `
$proc = @{}
try {
  $rows = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process -ErrorAction Stop
  foreach ($p in $rows) {
    if (-not $p.Name) { continue }
    if ($p.Name -eq '_Total' -or $p.Name -eq 'Idle') { continue }
    $v = [double]$p.PercentProcessorTime
    if ($proc.ContainsKey($p.Name)) { $proc[$p.Name] = $proc[$p.Name] + $v } else { $proc[$p.Name] = $v }
  }
} catch { }
$out = New-Object System.Collections.ArrayList
foreach ($e in ($proc.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 4)) {
  [void]$out.Add([pscustomobject]@{ name = [string]$e.Key; cpu = [double]$e.Value })
}
Write-SgJson @($out)
`,
        15_000
      )
      const arr = Array.isArray(r) ? r : r ? [r as unknown as { name: string; cpu: number }] : []
      rows = arr.filter((x) => x && typeof x.name === 'string' && x.name.length > 0)
    } catch {
      rows = null
    }
    if (!rows || rows.length === 0) return [{ label: 'CPU', value: '不可用', tone: 'warn' }]

    const cores = Math.max(1, os.cpus().length)
    return rows.map((r) => {
      const raw = Number(r.cpu)
      // 非有限值一律归 0：浮窗上出现 NaN 比数字不准更糟
      const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw / cores)) : 0
      return {
        label: r.name,
        value: `${pct.toFixed(1)}%`,
        ratio: pct,
        tone: pct > 50 ? 'danger' : pct > 20 ? 'warn' : 'normal'
      }
    })
  }
}

export const BUILTIN_PLUGINS: FloatPlugin[] = [
  cpuMemPlugin,
  diskPlugin,
  junkPlugin,
  clockPlugin,
  netPlugin,
  overviewPlugin,
  topProcPlugin,
  topCpuPlugin,
  tempPlugin,
  batteryPlugin,
  netConnPlugin,
  focusPlugin
]

/** 默认启用的插件顺序 */
export const DEFAULT_ENABLED = ['sys.cpumem', 'sys.disk', 'sg.junk', 'sys.clock']
