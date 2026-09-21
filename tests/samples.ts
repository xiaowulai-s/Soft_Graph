/**
 * 样本库采集与回归校验（M0 · G3）
 * ============================================================
 * 为什么样本文件本身不入库：第三方 exe/dll 有版权与体积问题。
 * 因此采用「清单入库、样本本地留存」的方式：
 *
 *   tests/samples/manifest.json   ← 入库：每个样本的来源、哈希与**解析期望值**（golden）
 *   tests/samples/files/          ← 不入库：实际文件副本（可选，--copy 才复制）
 *
 * 用法：
 *   npm run samples:collect                 采集系统自带样本，写清单（不复制文件）
 *   npm run samples:collect -- --copy       同时把文件复制到 tests/samples/files/
 *   npm run samples:collect -- --max 60     只采 60 个（冒烟用，验证采集链路本身）
 *   npm run samples:verify                  按清单重跑解析并比对（检测解析器回归）
 *
 * 取样三原则（v3.0.0 G3 扩容时确立，改回去会静默失去意义）：
 *   1. **按内容去重**，不按文件名 —— System32 / SysWOW64 / WinSxS 里同名不同字节的
 *      x64/x86 变体都是有效样本；按文件名去重会让配额被上游组吃空（实测 WinSxS 组
 *      配额 12 只落 2 个）。
 *   2. **分层取样**，不取「最大的 N 个」 —— 纯按体积降序会让配额全被巨型文件吃掉，
 *      500 个样本要读几十 GB，采集本身跑不完。
 *   3. **不跟随符号链接与 junction** —— 既防逃逸出根目录，也避免同一份字节被重复计入。
 */
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs, existsSync, readdirSync, statSync } from 'node:fs'
import { release as osRelease } from 'node:os'
import { join, basename } from 'node:path'

import { parsePe } from '@scanner/pe'

// 由 scripts/run-ts.mjs 以项目根目录为 cwd 启动，且打包为 CJS（import.meta 不可用）
const ROOT = process.cwd()
const DIR = join(ROOT, 'tests', 'samples')
const FILES = join(DIR, 'files')
const MANIFEST = join(DIR, 'manifest.json')

const SYS = process.env.SystemRoot || 'C:\\Windows'
const S32 = join(SYS, 'System32')
const WOW = join(SYS, 'SysWOW64')
const NETFX = join(SYS, 'Microsoft.NET', 'Framework64')

interface SampleEntry {
  id: string
  /** 采集来源（系统路径，任何 Windows 机器上应存在） */
  source: string
  /** 该样本用于覆盖什么场景 */
  covers: string
  sha256: string
  sizeBytes: number
  /** --copy 模式下的留存文件名（同名样本靠它区分，不传则按 basename 找） */
  storedName?: string
  /** 解析期望值（golden）：解析器行为变化时这些值会漂移 */
  expect: {
    parseStatus: string
    arch: string
    isDll: boolean
    isDotNet: boolean
    importsAtLeast: number
    hasDelayImports: boolean
    hasVersionRes: boolean
    /** 是否导出符号（低层模块零导入但仍为 ok 的判定依据） */
    hasExports: boolean
    /** 加壳特征（用于确认加壳识别未回归） */
    packerSection?: string
  }
  capturedAt: string
  host: string
}

/** 从目录中挑选文件，按谓词过滤，限量 */
async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path)
    s.on('error', reject)
    s.on('data', (c) => h.update(c as Buffer))
    s.on('end', () => resolve())
  })
  return h.digest('hex')
}

/**
 * 采集组：每个组针对一类 PE 形态。
 * v3.0.0（G3）把原先写死的 19 个样本改为「分组采集 + 配额」，目标是 100+ 且覆盖
 * 加壳 / .NET / x86 / x64 / 驱动 / WinSxS / 第三方软件 这些真正会触发解析器分支的形态。
 */
interface SampleGroup {
  dir: string
  covers: string
  /** 该组最多取多少个 */
  limit: number
  pattern: RegExp
  /** 递归深度，0 表示只看当前目录 */
  depth?: number
  /** 单文件体积上限，避免把几百 MB 的安装包拉进来 */
  maxBytes?: number
  /** 本组的字节预算（分层取样时超预算的样本跳过、继续试更小的） */
  budgetBytes?: number
  /** walk 阶段的候选上限：WinSxS / DriverStore 这类巨型树不能无限展开 */
  maxCandidates?: number
}

const MB = 1024 * 1024
const DEFAULT_MAX_BYTES = 128 * MB
const DEFAULT_BUDGET = 400 * MB
const DEFAULT_MAX_CANDIDATES = 6000
const MIN_BYTES = 8 * 1024
/** 全部组合计的字节预算：哈希 + 解析各读一遍，超出即停止采集后续组 */
const GLOBAL_BUDGET = Number(process.env.SG_SAMPLES_BUDGET_MB ?? 6000) * MB

/**
 * 取环境变量指向的目录。
 * `ProgramFiles` 与 `ProgramW6432` 在 64 位系统上是同一个目录，必须去重 ——
 * 否则同一棵树会被采两遍，配额与字节预算全花在重复内容上（内容去重会把第二遍清空）。
 */
function envDir(...names: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of names) {
    const v = process.env[n]
    if (!v || !existsSync(v)) continue
    const key = v.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

const PF64 = envDir('ProgramFiles', 'ProgramW6432')
const PF86 = envDir('ProgramFiles(x86)')

const GROUPS: SampleGroup[] = [
  // ── 系统可执行文件：导入表与延迟导入的典型形态
  { dir: SYS, covers: 'x64 可执行文件 · 导入表与延迟导入', limit: 8, pattern: /\.exe$/i, depth: 1, maxBytes: 32 * MB },
  { dir: S32, covers: 'x64 可执行文件 · 导入表与延迟导入', limit: 30, pattern: /\.exe$/i, depth: 0 },

  // ── 系统 DLL：KnownDLLs / API Set 引用密集
  { dir: S32, covers: 'x64 系统 DLL · KnownDLLs / API Set', limit: 110, pattern: /\.dll$/i, depth: 0 },
  // System32 子目录（spool / oobe / NDF / sdiagn host 等）里的 DLL 形态与根目录不同
  { dir: S32, covers: 'x64 系统 DLL · 子系统目录', limit: 60, pattern: /\.dll$/i, depth: 2, maxBytes: 64 * MB },

  // ── 共享运行库：WinSxS 重定向与清单依赖
  { dir: S32, covers: '共享运行库 · WinSxS/清单依赖', limit: 20, pattern: /^(msvcp|msvcr|vcruntime|ucrtbase|mfc|atl|concrt)/i, depth: 0 },

  // ── x86 模块：WOW64 位数处理（与 x64 同名不同字节，靠内容哈希才留得下来）
  { dir: WOW, covers: 'x86 模块 · WOW64 位数处理', limit: 45, pattern: /\.dll$/i, depth: 0 },
  { dir: WOW, covers: 'x86 可执行 · WOW64 位数处理', limit: 20, pattern: /\.exe$/i, depth: 0 },

  // ── 驱动：子系统与导入形态与用户态不同
  { dir: join(S32, 'drivers'), covers: '内核驱动 · 子系统与导入形态', limit: 35, pattern: /\.sys$/i, depth: 0 },
  // DriverStore 里的第三方驱动：数量最大的一类 .sys，且含大量非微软厂商形态
  {
    dir: join(S32, 'DriverStore', 'FileRepository'),
    covers: '第三方驱动 · DriverStore 形态',
    limit: 45,
    pattern: /\.sys$/i,
    depth: 2,
    maxBytes: 32 * MB
  },
  {
    dir: join(S32, 'DriverStore', 'FileRepository'),
    covers: '驱动配套 DLL · UserModeDriver',
    limit: 30,
    pattern: /\.dll$/i,
    depth: 2,
    maxBytes: 32 * MB
  },

  // ── WinSxS：并排程序集，路径重定向的极端场景
  { dir: join(SYS, 'WinSxS'), covers: 'WinSxS 并排程序集 · 路径重定向', limit: 45, pattern: /\.(dll|exe)$/i, depth: 3, maxBytes: 32 * MB },

  // ── .NET Framework 汇编：CLR 头与 AssemblyRef
  { dir: NETFX, covers: '.NET Framework 64 汇编 · CLR 头与 AssemblyRef', limit: 30, pattern: /\.(dll|exe)$/i, depth: 2 },
  { dir: join(SYS, 'Microsoft.NET', 'Framework'), covers: '.NET Framework 32 汇编 · x86 CLR', limit: 30, pattern: /\.(dll|exe)$/i, depth: 2 },
  // NGEN 原生镜像：托管程序集的**另一个** PE 形态（有 CLR 头同时又是本机代码）
  {
    dir: join(NETFX, 'v4.0.30319', 'NativeImages'),
    covers: '.NET NGEN 原生镜像 · 托管+本机双形态',
    limit: 6,
    pattern: /\.ni\.dll$/i,
    depth: 1
  },

  // ── 系统组件宿主：WMI / PowerShell，真实世界被依赖解析大量命中的对象
  { dir: join(S32, 'wbem'), covers: 'WMI 宿主与提供程序', limit: 20, pattern: /\.(dll|exe)$/i, depth: 1 },
  {
    dir: join(S32, 'WindowsPowerShell', 'v1.0'),
    covers: 'PowerShell 模块 · 托管 DLL 依赖',
    limit: 25,
    pattern: /\.dll$/i,
    depth: 3,
    maxBytes: 32 * MB
  },

  // ── 系统应用：UWP/现代部署形态
  { dir: join(SYS, 'SystemApps'), covers: '系统应用 · 现代部署形态', limit: 15, pattern: /\.(dll|exe)$/i, depth: 2, maxBytes: 32 * MB },

  // ── 第三方软件：真实世界的加壳 / 混淆 / 大体积形态
  ...PF64.map((d) => ({ dir: d, covers: '第三方软件 x64 · 真实世界形态', limit: 45, pattern: /\.exe$/i, depth: 3, maxBytes: 64 * MB })),
  ...PF86.map((d) => ({ dir: d, covers: '第三方软件 x86 · 真实世界形态', limit: 35, pattern: /\.exe$/i, depth: 3, maxBytes: 64 * MB })),

  // ── 第三方 DLL：依赖解析的主力对象
  ...PF64.map((d) => ({ dir: d, covers: '第三方 DLL · 依赖解析主力', limit: 45, pattern: /\.dll$/i, depth: 3, maxBytes: 64 * MB })),
  ...PF86.map((d) => ({ dir: d, covers: '第三方 DLL x86 · 依赖解析主力', limit: 30, pattern: /\.dll$/i, depth: 3, maxBytes: 64 * MB }))
].filter((g) => existsSync(g.dir)) as SampleGroup[]

/**
 * 按组扫描目录：任何权限/IO 异常都静默跳过（非管理员、目录被占用都是正常情况）。
 *
 * `withFileTypes` 而非逐个 `statSync`：巨型树上目录项的 stat 是主要成本，
 * 而 Dirent 已经带类型信息。副作用正是想要的 —— 符号链接与 junction 的
 * `isDirectory()` 为 false，落到文件分支后 `st.isFile()` 又不成立，直接被跳过。
 */
function scanGroup(g: SampleGroup): { path: string; size: number }[] {
  const maxBytes = g.maxBytes ?? DEFAULT_MAX_BYTES
  const budget = g.budgetBytes ?? DEFAULT_BUDGET
  const depth = g.depth ?? 0
  const maxCandidates = g.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const found: { path: string; size: number }[] = []

  const walk = (dir: string, d: number): void => {
    if (found.length >= maxCandidates) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (found.length >= maxCandidates) return
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (d > 0) walk(p, d - 1)
        continue
      }
      if (!g.pattern.test(e.name)) continue
      let size: number
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        size = st.size
      } catch {
        continue
      }
      if (size < MIN_BYTES || size > maxBytes) continue
      found.push({ path: p, size })
    }
  }

  walk(g.dir, depth)
  // 体积降序 + 路径升序兜底：大文件的导入表/资源更完整，回归价值更高；
  // 路径兜底是为了让同一棵目录树在两次采集里给出**同样**的取样结果。
  found.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return spread(found, g.limit, budget)
}

/**
 * 分层取样：从体积降序清单里等间隔抽取，直到凑满 limit 且不超字节预算。
 * 超预算的样本**跳过而非终止** —— 清单是降序的，后面的更小，很可能还装得下。
 */
function spread(list: { path: string; size: number }[], limit: number, budget: number): { path: string; size: number }[] {
  if (limit <= 0 || list.length === 0) return []
  const stride = Math.max(1, Math.ceil(list.length / limit))
  const picked: { path: string; size: number }[] = []
  let bytes = 0
  for (let i = 0; i < list.length && picked.length < limit; i += stride) {
    const it = list[i]
    if (bytes + it.size > budget) continue
    picked.push(it)
    bytes += it.size
  }
  return picked
}

/** 找到一个 .NET 汇编样本（带 CLR 头） */
async function findDotNet(): Promise<string | null> {
  if (!existsSync(NETFX)) return null
  try {
    const versions = readdirSync(NETFX)
      .filter((v) => /^v\d/.test(v))
      .sort()
      .reverse()
    for (const v of versions) {
      const dir = join(NETFX, v)
      const cands = readdirSync(dir)
        .filter((f) => /\.(dll|exe)$/i.test(f))
        .slice(0, 40)
      for (const c of cands) {
        const p = join(dir, c)
        try {
          if (statSync(p).size < MIN_BYTES) continue
          const r = await parsePe(p, { resources: false, dotnet: true })
          if (r.isDotNet) return p
        } catch {
          /* 继续找 */
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

interface CollectStats {
  x64: number
  x86: number
  otherArch: number
  dll: number
  exe: number
  sys: number
  dotnet: number
  packed: number
  zeroImport: number
}

function newStats(): CollectStats {
  return { x64: 0, x86: 0, otherArch: 0, dll: 0, exe: 0, sys: 0, dotnet: 0, packed: 0, zeroImport: 0 }
}

function tally(stats: CollectStats, r: Awaited<ReturnType<typeof parsePe>>, path: string): void {
  if (r.arch === 'x64') stats.x64++
  else if (r.arch === 'x86') stats.x86++
  else stats.otherArch++
  if (/\.sys$/i.test(path)) stats.sys++
  else if (r.isDll) stats.dll++
  else stats.exe++
  if (r.isDotNet) stats.dotnet++
  if (r.packerSection) stats.packed++
  if (r.imports.length === 0) stats.zeroImport++
}

/** 同一份字节只留一个样本；返回去重后的清单，id 冲突时追加序号 */
function makeId(base: string, taken: Set<string>): string {
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}_${n++}`
  taken.add(id)
  return id
}

async function collect(copy: boolean, max: number): Promise<void> {
  await fs.mkdir(DIR, { recursive: true })
  const t0 = Date.now()
  const targets: { path: string; covers: string; size: number }[] = []

  // 按组采集：每组覆盖一类 PE 形态，组间共享全局字节预算
  const perGroup: { covers: string; picked: number }[] = []
  let spent = 0
  for (const g of GROUPS) {
    if (spent >= GLOBAL_BUDGET) {
      console.log(`! 全局字节预算 ${Math.round(GLOBAL_BUDGET / MB)} MB 用尽，后续组跳过`)
      break
    }
    const picked = scanGroup(g)
    if (picked.length === 0) continue
    perGroup.push({ covers: g.covers, picked: picked.length })
    for (const p of picked) {
      targets.push({ path: p.path, covers: g.covers, size: p.size })
      spent += p.size
    }
  }
  // .NET 汇编（CLI 头与 AssemblyRef）—— 靠解析确认，不能用文件名猜
  const dotnet = await findDotNet()
  if (dotnet) targets.push({ path: dotnet, covers: '.NET 汇编 · CLR 头与 AssemblyRef', size: 0 })

  if (perGroup.length > 0) {
    console.log('采集分组：')
    for (const g of perGroup) console.log(`  · ${g.covers} — ${g.picked} 个`)
  }

  if (targets.length === 0) {
    console.error('未找到任何可用样本（非 Windows 环境？）')
    process.exit(1)
  }

  // 全局上限：用于「先跑一小批验证采集链路本身」，等间隔抽取以保持体积分布
  if (max > 0 && targets.length > max) {
    const stride = Math.ceil(targets.length / max)
    const trimmed = targets.filter((_, i) => i % stride === 0).slice(0, max)
    console.log(`\n--max ${max}：从 ${targets.length} 个候选等间隔抽 ${trimmed.length} 个`)
    targets.length = 0
    targets.push(...trimmed)
  }

  const entries: SampleEntry[] = []
  const byHash = new Map<string, string>()
  const ids = new Set<string>()
  const stats = newStats()
  let skippedDup = 0
  let skippedErr = 0

  for (const t of targets) {
    const stem = basename(t.path).replace(/\.[^.]+$/, '')
    let hash: string
    try {
      hash = await sha256File(t.path)
    } catch (e) {
      skippedErr++
      console.log(`  跳过 ${t.path}: ${(e as Error).message}`)
      continue
    }
    const dupOf = byHash.get(hash)
    if (dupOf) {
      skippedDup++
      console.log(`  = 同一份字节（与 ${dupOf} 相同），跳过 ${basename(t.path)}`)
      continue
    }

    let r: Awaited<ReturnType<typeof parsePe>>
    try {
      r = await parsePe(t.path)
    } catch (e) {
      skippedErr++
      byHash.set(hash, basename(t.path))
      console.log(`  解析失败 ${basename(t.path)}: ${(e as Error).message}`)
      continue
    }
    byHash.set(hash, basename(t.path))

    const ext = /\.([^./]+)$/.exec(basename(t.path))?.[1] ?? 'bin'
    const entry: SampleEntry = {
      id: makeId(`sample_${stem.replace(/[^a-z0-9]+/gi, '_')}_${hash.slice(0, 8)}`, ids),
      source: t.path,
      covers: t.covers,
      sha256: hash,
      sizeBytes: t.size,
      expect: {
        parseStatus: r.parseStatus,
        arch: r.arch,
        isDll: r.isDll,
        isDotNet: r.isDotNet,
        importsAtLeast: r.imports.length > 0 ? Math.max(1, Math.floor(r.imports.length * 0.8)) : 0,
        hasDelayImports: r.delayImports.length > 0,
        hasVersionRes: !!r.fileVersion,
        hasExports: r.hasExports,
        packerSection: r.packerSection
      },
      capturedAt: new Date().toISOString(),
      host: `${process.platform} ${process.arch} ${osRelease()}`
    }
    if (copy) entry.storedName = `${entry.id}.${ext}`
    entries.push(entry)
    tally(stats, r, t.path)

    if (copy) {
      await fs.mkdir(FILES, { recursive: true })
      await fs.copyFile(t.path, join(FILES, entry.storedName!))
    }
  }

  const manifest = {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    note:
      '样本文件本身不入库（版权/体积），仅清单入库；用 npm run samples:collect 在本机重建。' +
      '去重按内容哈希（同名不同字节各自成样本），取样按体积分层（不牺牲形态分布）',
    count: entries.length,
    stats,
    samples: entries
  }
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8')
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(
    `\n清单已写入 ${MANIFEST}（${entries.length} 个样本${copy ? '，并已复制文件副本' : ''}）` +
      ` ｜ 耗时 ${secs}s ｜ 候选体积 ${Math.round(spent / MB)} MB`
  )
  console.log(
    `形态分布：x64 ${stats.x64} · x86 ${stats.x86} · 其它 ${stats.otherArch} ｜ ` +
      `DLL ${stats.dll} · EXE ${stats.exe} · SYS ${stats.sys} ｜ .NET ${stats.dotnet} · 加壳 ${stats.packed} · 零导入 ${stats.zeroImport}`
  )
  if (skippedDup > 0) console.log(`内容重复跳过 ${skippedDup} 个（不同目录里的同一份字节）`)
  if (skippedErr > 0) console.log(`读入/解析失败跳过 ${skippedErr} 个`)
  if (stats.packed === 0) {
    console.log('提示：本机未采集到加壳样本（packerSection 均为空）。加壳识别仍由单测覆盖，样本库侧暂缺。')
  }
  if (entries.length < 100) {
    console.log(`提示：样本数 ${entries.length} < 100，可在装有更多第三方软件的机器上采集以补足（G3 目标 ≥100）。`)
  }
}

async function verify(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error('清单不存在，请先执行 npm run samples:collect')
    process.exit(1)
  }
  const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8')) as {
    samples: SampleEntry[]
  }
  let pass = 0
  let drift = 0
  let missing = 0
  let hashMismatch = 0
  const issues: string[] = []

  for (const s of manifest.samples) {
    // 留存文件名优先（--copy 时同名样本各有自己的落盘名），旧清单则回退 basename
    const local = join(FILES, s.storedName ?? basename(s.source))
    const path = existsSync(local) ? local : s.source
    if (!existsSync(path)) {
      missing++
      console.log(`  ? ${basename(s.source)} — 本机不存在，跳过`)
      continue
    }
    // 清单里的哈希对不上说明这份样本已不是采集时的那份字节（Windows 更新 / 副本被覆盖），
    // 此时比对解析结果没有意义，单独计一类而不是混进「解析器漂移」。
    const hash = await sha256File(path)
    if (hash !== s.sha256) {
      hashMismatch++
      console.log(`  ~ ${basename(s.source)} — 字节已变化（哈希不符），不计入漂移`)
      continue
    }
    const r = await parsePe(path)
    const problems: string[] = []
    if (r.parseStatus !== s.expect.parseStatus) problems.push(`parseStatus ${s.expect.parseStatus} → ${r.parseStatus}`)
    if (r.arch !== s.expect.arch) problems.push(`arch ${s.expect.arch} → ${r.arch}`)
    if (r.isDll !== s.expect.isDll) problems.push('isDll 变化')
    if (r.isDotNet !== s.expect.isDotNet) problems.push('isDotNet 变化')
    if (r.imports.length < s.expect.importsAtLeast) {
      problems.push(`导入数下降 ${s.expect.importsAtLeast} → ${r.imports.length}`)
    }
    if (s.expect.hasDelayImports && r.delayImports.length === 0) problems.push('延迟导入丢失')
    if (s.expect.hasVersionRes && !r.fileVersion) problems.push('版本资源丢失')
    if (s.expect.hasExports !== undefined && r.hasExports !== s.expect.hasExports) {
      problems.push(`导出表判定变化 ${s.expect.hasExports} → ${r.hasExports}`)
    }
    if ((s.expect.packerSection ?? null) !== (r.packerSection ?? null)) {
      problems.push(`加壳判定变化 ${s.expect.packerSection ?? '无'} → ${r.packerSection ?? '无'}`)
    }

    if (problems.length === 0) {
      pass++
    } else {
      drift++
      console.log(`  ✘ ${basename(s.source)} — ${problems.join('；')}`)
      issues.push(`${basename(s.source)}: ${problems.join('；')}`)
    }
  }

  console.log(`\n结果：通过 ${pass} · 漂移 ${drift} · 缺失 ${missing} · 字节已变 ${hashMismatch}`)
  if (drift > 0) {
    console.log('\n漂移说明：同机重复出现即解析器回归（样本字节已变的项单独计为「字节已变」，不算回归）。')
    console.log(issues.map((i) => `  - ${i}`).join('\n'))
    process.exit(2)
  }
}

const cmd = process.argv[2] ?? 'collect'
const copy = process.argv.includes('--copy')
const maxArg = process.argv.findIndex((a) => a === '--max')
const max = maxArg >= 0 ? Number(process.argv[maxArg + 1]) || 0 : Number(process.env.SG_SAMPLES_MAX ?? 0)

// 打包为 CJS，不能用顶层 await
async function main(): Promise<void> {
  if (cmd === 'collect') await collect(copy, max)
  else if (cmd === 'verify') await verify()
  else {
    console.error(`未知命令：${cmd}（可用：collect / verify）`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('样本库操作失败：', e)
  process.exit(1)
})
