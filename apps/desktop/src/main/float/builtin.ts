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

export const BUILTIN_PLUGINS: FloatPlugin[] = [
  cpuMemPlugin,
  diskPlugin,
  junkPlugin,
  clockPlugin,
  netPlugin,
  overviewPlugin,
  topProcPlugin
]

/** 默认启用的插件顺序 */
export const DEFAULT_ENABLED = ['sys.cpumem', 'sys.disk', 'sg.junk', 'sys.clock']
