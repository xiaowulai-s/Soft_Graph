/**
 * 跨基线兼容探测（C1 前置 · v3.0.0）
 * ============================================================
 * C1 的阻塞点是「没有 Win10 测试机」，但这台机器到位之前能做的事一直没做：
 * 本项目对环境能力的依赖散落在十几个降级分支里（USN 能否读、API Set 动态映射、
 * PowerShell P/Invoke、长路径、符号链接权限、WinSxS 索引、sql.js / node:sqlite …），
 * 换一台机器是「全绿」还是「静默降级」，此前只能靠手点。
 *
 * 本脚本把这些变成**一条命令 + 一份可横向对比的 JSON + 一行兼容矩阵**：
 * Win10 机器到位后跑
 *   npm run compat:probe -- --with-smoke
 * 再把控制台打印的矩阵行贴进 `docs/benchmarks/compat-matrix.md`。
 *
 *   node scripts/run-ts.mjs tests/compat-probe.ts
 *   node scripts/run-ts.mjs tests/compat-probe.ts --with-smoke --with-e2e
 *   node scripts/run-ts.mjs tests/compat-probe.ts --out .tmp/win10-22h2.json
 *
 * 约束：
 *   1. **只读优先**，需要写时只碰临时目录与 `.tmp`（唯一例外：为验证 USN 记录解析，
 *      在临时卷上创建一个临时文件再删掉）。
 *   2. 探测项互不阻塞 —— 任一项抛异常都记成 `{ok:false, error}` 继续跑完。
 *      一台「某项能力缺失」的机器必须仍能产出完整报告，否则最该看结果的机器恰好出不了结果。
 *   3. 结果写 UTF-8 JSON：中文系统的控制台代码页会把输出显示成乱码，看不清就没法对比。
 */
import { spawn } from 'node:child_process'
import { promises as fsp, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { hostname, release, tmpdir, arch as osArch, type as osType } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { queryJournal, readJournal, decodeConsole } from '@junk/usn'
import { isElevated, findLockingProcessesDetailed } from '@junk/locks'
import { loadApiSetSchema, resetApiSetCache } from '@scanner/apiset'
import { mapApiSet, loadKnownDlls, loadSxsIndex } from '@scanner/dllresolve'
import { minimalPsEnv, shutdownPsPool } from '@scanner/psbridge'
import { loadNativeCapabilities } from '@native/capabilities'
import { openDb } from '@main/db/driver'

const ROOT = process.cwd()
const CACHE_FILE = join(ROOT, '.tmp', `compat-apiset-${randomBytes(3).toString('hex')}.json`)

type Rec = Record<string, unknown>

/** 包一层：任何探测项都不允许把整份报告带崩 */
async function probe(name: string, fn: () => Promise<Rec>): Promise<Rec> {
  const t0 = Date.now()
  try {
    return { probe: name, ok: true, ...(await fn()), probeMs: Date.now() - t0 }
  } catch (e) {
    return { probe: name, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300), probeMs: Date.now() - t0 }
  }
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let bytes = 0
    const killer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length
      if (bytes < 16 * 1024 * 1024) out.push(c)
    })
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({
        code: code ?? -1,
        stdout: decodeConsole(Buffer.concat(out)),
        stderr: decodeConsole(Buffer.concat(err))
      })
    })
    child.on('error', (e) => {
      clearTimeout(killer)
      resolve({ code: -1, stdout: '', stderr: String((e as Error).message) })
    })
  })
}

/** `reg query` 输出走控制台代码页（中文系统 GBK），必须经 decodeConsole */
async function regQuery(key: string): Promise<Rec> {
  const r = await new Promise<{ stdout: Buffer } | { error: string }>((resolve) => {
    execFile(
      'reg.exe',
      ['query', key],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (err && !stdout) resolve({ error: String(err.message) })
        else resolve({ stdout: stdout as unknown as Buffer })
      }
    )
  })
  if ('error' in r) return { __error: r.error }
  const out: Rec = {}
  for (const line of decodeConsole(r.stdout).split(/\r?\n/)) {
    const m = line.trim().match(/^(.+?)\s+(REG_[A-Z_]+)\s+(.+)$/)
    if (m) out[m[1]] = m[3]
  }
  return out
}

/**
 * 一次性 PowerShell（不经会话池）。**必须带最小环境块** —— 宿主环境块过大时
 * PowerShell 内 `Add-Type` 会静默失败（BUG-22），这一项本身就是要看
 * 「原生 PS 在这台机器上到底能不能起来」，用异常环境跑出来的结论没有意义。
 */
async function psOnce(script: string): Promise<string> {
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    30_000,
    minimalPsEnv()
  )
  return r.stdout.trim()
}

/**
 * `ProductName` 在 Win11 上仍写作「Windows 10 Pro」（兼容性垫片），
 * 因此市场版本按 build 号判定，而不是信 ProductName。
 */
function friendlyOs(build: number): string {
  if (!build) return '未知版本'
  if (build >= 26100) return 'Win11 24H2 线'
  if (build >= 22621) return 'Win11 23H2/22H2 线'
  if (build >= 22000) return 'Win11 21H2 线'
  if (build >= 19045) return 'Win10 22H2 线'
  if (build >= 19041) return 'Win10 2004/21H1 线'
  return `build ${build}`
}

/** REG_DWORD 从 `reg query` 打出来是十六进制文本，不换算成十进制就没法横向对比 */
function regNum(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const m = v.trim().match(/^0x([0-9a-fA-F]+)$/)
  return m ? Number.parseInt(m[1], 16) : Number.isNaN(Number(v)) ? undefined : Number(v)
}

async function probeOsInfo(): Promise<Rec> {
  const nt = await regQuery('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion')
  const net = await regQuery('HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full')
  const unlock = await regQuery('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock')
  const build = Number(nt.CurrentBuildNumber ?? 0)
  const ubr = regNum(nt.UBR)
  return {
    hostname: hostname(),
    osType: osType(),
    kernelRelease: release(),
    machineArch: osArch,
    nodeVersion: process.version,
    productName: nt.ProductName,
    displayVersion: nt.DisplayVersion,
    releaseId: nt.ReleaseId,
    build,
    ubr,
    buildLab: nt.BuildLabEx,
    installationType: nt.InstallationType,
    friendlyName: friendlyOs(build),
    netFx4Release: regNum(net.Release),
    netFx4Version: net.Version,
    developerMode: regNum(unlock.AllowDevelopmentWithoutExpLicense) ?? 0
  }
}

/** 固定卷清单。DriveInfo 拿不到时退回盘符扫描 —— 枚举本身不依赖 PowerShell。 */
async function listVolumes(): Promise<{ volume: string; format?: string; totalBytes?: number }[]> {
  try {
    const text = await psOnce(
      '[string]::Join("|",[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq "Fixed" } | ForEach-Object { "$($_.Name.TrimEnd([char]92)),$($_.DriveFormat),$($_.TotalSize)" })'
    )
    const rows = text
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [name, format, size] = s.split(',')
        return { volume: (name || '').replace(/\\+$/, ''), format, totalBytes: Number(size) || 0 }
      })
    if (rows.length > 0) return rows
  } catch {
    /* 走盘符扫描 */
  }
  const out: { volume: string }[] = []
  for (let c = 67; c <= 90; c++) {
    const v = `${String.fromCharCode(c)}:\\`
    if (existsSync(v)) out.push({ volume: v.slice(0, 2) })
  }
  return out
}

async function probeVolumes(): Promise<Rec> {
  const vols = await listVolumes()
  const tmpVol = (tmpdir().slice(0, 2) || 'C:').toUpperCase()
  const list: Rec[] = []

  for (const d of vols) {
    const isTempVol = d.volume.toUpperCase() === tmpVol
    const entry: Rec = { volume: d.volume, isTempVolume: isTempVol, totalBytes: d.totalBytes }
    const info = await queryJournal(d.volume)
    entry.usnQuery = info ? { ok: true, nextUsn: info.nextUsn, journalId: info.journalId } : { ok: false }

    // readjournal 需要提权；**不带 startusn 会吐出整卷变更**（实测 >128MB 撑爆缓冲），
    // 因此起点取查询到的 nextUsn。临时卷上先造一次真实变更（建文件再删），
    // 这样回读到的记录能同时验证解析器认得这台机器的输出格式（语言/字段顺序）。
    if (info?.nextUsn) {
      const start = info.nextUsn
      if (isTempVol) {
        const f = join(tmpdir(), `sg-compat-${randomBytes(3).toString('hex')}.tmp`)
        try {
          await fsp.writeFile(f, 'compat-probe')
          await fsp.rm(f, { force: true })
        } catch {
          /* 只读卷：0 条记录也算能力可用 */
        }
      }
      const r = await readJournal(d.volume, start)
      entry.usnRead = {
        ok: !r.needsElevation,
        needsElevation: r.needsElevation,
        records: r.records.length,
        withFileId: r.records.filter((x) => !!x.fileId).length,
        sample: r.records.slice(0, 3).map((x) => ({ name: x.name, reasons: x.reasons })),
        error: r.error
      }
    } else {
      entry.usnRead = { ok: false, note: 'queryjournal 不可用，未尝试 readjournal' }
    }
    list.push(entry)
  }
  return { volumes: list, count: list.length }
}

async function probeApiSet(): Promise<Rec> {
  resetApiSetCache()
  const schema = await loadApiSetSchema(CACHE_FILE)
  const spot: Rec = {}
  for (const n of [
    'api-ms-win-core-file-l1-1-0.dll',
    'api-ms-win-core-processthreads-l1-1-0.dll',
    'api-ms-win-crt-runtime-l1-1-0.dll',
    'api-ms-win-power-base-l1-1-0.dll'
  ])
    spot[n] = mapApiSet(n)
  return {
    ok: !!schema,
    source: schema?.source,
    entries: schema?.entries ?? 0,
    probed: schema?.probed ?? 0,
    spotHit: Object.values(spot).filter((v) => !!v).length,
    spot
  }
}

async function probeTables(): Promise<Rec> {
  const known = await loadKnownDlls()
  const sxs = await loadSxsIndex()
  return { knownDlls: known.size, sxsAssemblies: sxs.size, winsxsPresent: existsSync(join(process.env.SystemRoot || 'C:\\Windows', 'WinSxS')) }
}

/**
 * Restart Manager —— 同时是 **BUG-22 的哨兵**。
 * 宿主环境块过大时 PowerShell 内的 `Add-Type`（要再起 csc.exe）会**静默失败**：
 * 不报错，只是结果为空。因此这里查的是「当前 node.exe 自己」—— 它必然是本进程
 * 已加载的模块，查不到就说明 P/Invoke 通道坏了，而不是「恰好没人占用」。
 */
async function probeRm(): Promise<Rec> {
  const r = await findLockingProcessesDetailed(process.execPath)
  const selfSeen = r.lockers.some((l) => l.pid === process.pid)
  return {
    ok: r.lockers.length > 0,
    source: r.source,
    lockers: r.lockers.length,
    selfSeen,
    names: r.lockers.slice(0, 3).map((l) => l.name),
    error: r.error
  }
}

async function probePowerShell(): Promise<Rec> {
  const v = await psOnce('$PSVersionTable.PSVersion.ToString()')
  const edition = await psOnce("$PSVersionTable.PSEdition")
  return { ok: /\d+\.\d+/.test(v), version: v, edition }
}

/** 长路径：注册表开关只是旁证，真正要测的是「建一条 300 字符的路径能不能成」 */
async function probeLongPath(): Promise<Rec> {
  const reg = await regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem')
  const base = join(tmpdir(), 'sg-longpath-' + randomBytes(3).toString('hex'))
  let deep = base
  while (deep.length < 300) deep = join(deep, 'segment-dir')
  const registryLongPathsEnabled = regNum(reg.LongPathsEnabled) ?? 0
  try {
    await fsp.mkdir(deep, { recursive: true })
    const f = join(deep, 'probe.txt')
    await fsp.writeFile(f, 'ok')
    const st = await fsp.stat(f)
    const ok = st.size === 2
    return {
      ok,
      registryLongPathsEnabled,
      probePathLen: deep.length,
      // 注册表关着却建得起来（Win11 24H2 实测如此）：说明长路径不再只由该开关决定。
      // 记下来是为了让「Win10 上必须打开 LongPathsEnabled」这个前提可核对。
      note: ok && registryLongPathsEnabled === 0 ? '注册表关闭但实测可用' : undefined
    }
  } catch (e) {
    return {
      ok: false,
      registryLongPathsEnabled,
      probePathLen: deep.length,
      error: String((e as Error).message).slice(0, 200)
    }
  } finally {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

/** 符号链接：非管理员且未开开发者模式会失败 —— 扫描的防逃逸判定与测试夹具都依赖它 */
async function probeSymlink(): Promise<Rec> {
  const base = join(tmpdir(), 'sg-sym-' + randomBytes(3).toString('hex'))
  try {
    await fsp.mkdir(base, { recursive: true })
    const target = join(base, 'target-dir')
    await fsp.mkdir(target, { recursive: true })
    const link = join(base, 'link-dir')
    await fsp.symlink(target, link, 'dir')
    const st = await fsp.lstat(link)
    return { ok: st.isSymbolicLink() }
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 200), hint: '开启「开发人员模式」可免提权创建' }
  } finally {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

/** 数据层：驱动选择与 FTS5（I-11 前提）。CLI 侧随 Node 版本变，打包侧恒为 sql.js。 */
async function probeDb(): Promise<Rec> {
  const file = join(ROOT, '.tmp', `compat-db-${randomBytes(3).toString('hex')}.db`)
  const t0 = Date.now()
  try {
    const db = await openDb({ file, wasmDir: join(ROOT, 'node_modules', 'sql.js', 'dist') })
    const driver = db.driverName
    const fts = db.supportsFts5
    await db.close()
    return { ok: true, driver, supportsFts5: fts, openMs: Date.now() - t0 }
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      await fsp.rm(file + suffix, { force: true }).catch(() => {})
    }
  }
}

async function probeNative(): Promise<Rec> {
  const c = loadNativeCapabilities(true)
  return {
    source: c.source,
    usn: c.usn,
    restartManager: c.restartManager,
    restartManagerPs: c.restartManagerPs,
    apiSet: c.apiSet,
    version: c.version,
    loadError: c.loadError
  }
}

/** 把既有的内核冒烟 / CDP 端到端纳入同一份报告（Win10 机器上一步到位） */
async function runStep(args: string[], timeoutMs: number): Promise<Rec> {
  const t0 = Date.now()
  const env: NodeJS.ProcessEnv = { ...process.env }
  // 宿主注入的 ELECTRON_RUN_AS_NODE 会让 electron.exe 退化成纯 Node（BUG-23）
  delete env.ELECTRON_RUN_AS_NODE
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0
    const killer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length
      if (bytes < 16 * 1024 * 1024) chunks.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (bytes < 16 * 1024 * 1024) chunks.push(c)
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ code: code ?? -1, out: decodeConsole(Buffer.concat(chunks)) })
    })
    child.on('error', (e) => {
      clearTimeout(killer)
      resolve({ code: -1, out: String((e as Error).message) })
    })
  })
  // **退出码是权威判据**：run-smoke / e2e-ci 都会把内部结果透传成进程退出码。
  // 输出文本只用来记「有哪些失败字样」作旁证 —— 冒烟报告里本来就有「解析失败：0」
  // 这类计数行，按文本判失败会把一次通过的冒烟误判成失败（第一次跑就踩到了）。
  const markers = (r.out.match(/✘|失败|FAIL|Error:/g) || []).length
  return {
    ok: r.code === 0,
    exitCode: r.code,
    ms: Date.now() - t0,
    markers,
    tail: r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-10).join(' ⏎ ').slice(0, 4000)
  }
}

// ───────────────── 矩阵与结论 ─────────────────

const HEADER =
  '| 机器 / 系统版本 | build | 架构 | 提权 | USN 查询 | USN 读取 | API Set 条目 | KnownDLLs / SxS | RM(P-Invoke) | PowerShell | 长路径 | 符号链接 | 数据层驱动 | 内核冒烟 |'
const SEP = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'

function cell(v: unknown): string {
  return String(v ?? '-')
}

function matrixRow(r: Rec): string {
  const os = (r.osInfo ?? {}) as Rec
  const vols = (((r.volumes ?? {}) as Rec).volumes ?? []) as Rec[]
  const api = (r.apiSet ?? {}) as Rec
  const tables = (r.tables ?? {}) as Rec
  const rm = (r.restartManager ?? {}) as Rec
  const ps = (r.powerShell ?? {}) as Rec
  const lp = (r.longPath ?? {}) as Rec
  const sym = (r.symlink ?? {}) as Rec
  const db = (r.db ?? {}) as Rec
  const smoke = r.smoke as Rec | undefined
  return [
    cell(`${os.hostname ?? '?'} / ${os.friendlyName}（${cell(os.productName)}）`),
    cell(`${os.build}.${os.ubr}`),
    cell(os.machineArch),
    cell(r.elevation),
    `${vols.filter((v) => (v.usnQuery as Rec)?.ok).length}/${vols.length}`,
    `${vols.filter((v) => (v.usnRead as Rec)?.ok).length}/${vols.length}`,
    cell(api.entries),
    `${cell(tables.knownDlls)} / ${cell(tables.sxsAssemblies)}`,
    rm.selfSeen ? '正常' : '异常',
    cell(ps.version),
    lp.ok ? '是' : '否',
    sym.ok ? '是' : '否',
    cell(db.driver) + (db.supportsFts5 ? ' +FTS5' : ''),
    smoke ? (smoke.ok ? '通过' : '失败') : '未跑'
  ].join(' | ')
}

function verdict(r: Rec): string[] {
  const v: string[] = []
  const vols = (((r.volumes ?? {}) as Rec).volumes ?? []) as Rec[]
  const api = (r.apiSet ?? {}) as Rec
  const rm = (r.restartManager ?? {}) as Rec
  const lp = (r.longPath ?? {}) as Rec
  const sym = (r.symlink ?? {}) as Rec
  const db = (r.db ?? {}) as Rec
  if (!vols.some((x) => (x.usnRead as Rec)?.ok)) v.push('USN readjournal 不可用 → 增量只走「卷哨兵 + 目录签名」，与 v2.0.0 一致')
  else v.push('USN readjournal 可用 → 若提权运行，可启用 reuse-all 快路径')
  if (!api.ok) v.push('API Set 动态映射不可用 → 回退静态前缀表，依赖解析准确率下降，需在验收报告注明')
  if (!rm.selfSeen) v.push('⚠ Restart Manager 未查出本进程 → 高度疑似 BUG-22（Add-Type 静默失败），占用检测不可信')
  if (!lp.ok) v.push('长路径不可用 → 深层安装目录会被截断，扫描与清理的路径健壮性需人工复核')
  if (!sym.ok) v.push('符号链接创建失败 → 只影响测试夹具与防逃逸自测，不影响产品功能')
  if (db.supportsFts5) v.push('数据层支持 FTS5（子串检索可走 MATCH）；注意打包运行时恒为 sql.js，此项通常 false')
  return v
}

async function main(): Promise<void> {
  const argv = process.argv
  const outArg = argv.findIndex((a) => a === '--out')
  const report: Rec = {
    probeVersion: 1,
    ranAt: new Date().toISOString(),
    osInfo: await probe('os', probeOsInfo),
    elevation: (await isElevated()) ? '是' : '否',
    volumes: await probe('volumes', probeVolumes),
    apiSet: await probe('apiSet', probeApiSet),
    tables: await probe('tables', probeTables),
    restartManager: await probe('rm', probeRm),
    powerShell: await probe('powershell', probePowerShell),
    longPath: await probe('longPath', probeLongPath),
    symlink: await probe('symlink', probeSymlink),
    db: await probe('db', probeDb),
    native: await probe('native', probeNative)
  }
  if (argv.includes('--with-smoke')) report.smoke = await runStep(['run', 'smoke'], 10 * 60_000)
  if (argv.includes('--with-e2e')) report.e2e = await runStep(['run', 'e2e:ci', '--', '--port', '9222', '--wait', '120000'], 12 * 60_000)

  report.verdict = verdict(report)
  report.matrixRow = matrixRow(report)

  const os = report.osInfo as Rec
  const file =
    outArg >= 0 && argv[outArg + 1]
      ? argv[outArg + 1]
      : join(ROOT, '.tmp', `compat-build-${os.build ?? 'unknown'}-${hostname()}.json`)
  await fsp.mkdir(join(file, '..'), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(report, null, 2), 'utf8')

  console.log('探测结论：')
  for (const v of report.verdict as string[]) console.log('  · ' + v)
  console.log(`\n兼容矩阵行（贴进 docs/benchmarks/compat-matrix.md）：\n${HEADER}\n${SEP}\n| ${report.matrixRow} |`)
  console.log(`\n完整报告：${file}`)

  await fsp.rm(CACHE_FILE, { force: true }).catch(() => {})
  // 会话池里的 PowerShell 常驻进程会钉住事件循环，显式收尾
  shutdownPsPool()
  process.exit(0)
}

main().catch((e) => {
  console.error('兼容探测失败：', e)
  process.exit(1)
})
