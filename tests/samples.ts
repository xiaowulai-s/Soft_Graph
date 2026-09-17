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
 *   npm run samples:collect            采集系统自带样本，写清单（不复制文件）
 *   npm run samples:collect -- --copy  同时把文件复制到 tests/samples/files/
 *   npm run samples:verify             按清单重跑解析并比对（检测解析器回归）
 */
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, statSync, readdirSync } from 'node:fs'
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
  /** 解析期望值（golden）：解析器行为变化时这些值会漂移 */
  expect: {
    parseStatus: string
    arch: string
    isDll: boolean
    isDotNet: boolean
    importsAtLeast: number
    hasDelayImports: boolean
    sxsAtLeast: number
    hasVersionRes: boolean
    /** 是否导出符号（低层模块零导入但仍为 ok 的判定依据） */
    hasExports: boolean
    /** 加壳特征（用于确认加壳识别未回归） */
    packerSection?: string
  }
  capturedAt: string
  host: string
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 从目录中挑选文件，按谓词过滤，限量 */
function pick(dir: string, limit: number, filter: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => filter(f))
      .slice(0, limit)
      .map((f) => join(dir, f))
      .filter((p) => {
        try {
          return statSync(p).size > 8 * 1024
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
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
}

const MB = 1024 * 1024
const DEFAULT_MAX_BYTES = 128 * MB

function envDir(...names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    const v = process.env[n]
    if (v && existsSync(v)) out.push(v)
  }
  return out
}

const PF64 = envDir('ProgramFiles', 'ProgramW6432')
const PF86 = envDir('ProgramFiles(x86)')

const GROUPS: SampleGroup[] = [
  // ── 系统可执行文件：导入表与延迟导入的典型形态
  { dir: SYS, covers: 'x64 可执行文件 · 导入表与延迟导入', limit: 6, pattern: /\.exe$/i, depth: 1, maxBytes: 32 * MB },
  { dir: S32, covers: 'x64 可执行文件 · 导入表与延迟导入', limit: 14, pattern: /\.exe$/i, depth: 0 },

  // ── 系统 DLL：KnownDLLs / API Set 引用密集
  { dir: S32, covers: 'x64 系统 DLL · KnownDLLs / API Set', limit: 26, pattern: /\.dll$/i, depth: 0 },

  // ── 共享运行库：WinSxS 重定向与清单依赖
  { dir: S32, covers: '共享运行库 · WinSxS/清单依赖', limit: 10, pattern: /^(msvcp|msvcr|vcruntime|ucrtbase|mfc|atl)/i, depth: 0 },

  // ── x86 模块：WOW64 位数处理
  { dir: WOW, covers: 'x86 模块 · WOW64 位数处理', limit: 18, pattern: /\.(dll|exe)$/i, depth: 0 },

  // ── 驱动：子系统与导入表形态与用户态不同
  { dir: join(S32, 'drivers'), covers: '内核驱动 · 子系统与导入形态', limit: 10, pattern: /\.sys$/i, depth: 0 },

  // ── WinSxS：并排程序集，路径重定向的极端场景
  { dir: join(SYS, 'WinSxS'), covers: 'WinSxS 并排程序集 · 路径重定向', limit: 12, pattern: /\.(dll|exe)$/i, depth: 2 },

  // ── .NET Framework 汇编：CLR 头与 AssemblyRef
  { dir: NETFX, covers: '.NET Framework 汇编 · CLR 头与 AssemblyRef', limit: 12, pattern: /\.(dll|exe)$/i, depth: 2 },

  // ── 第三方软件：真实世界的加壳 / 混淆 / 大体积形态
  ...PF64.map((d) => ({ dir: d, covers: '第三方软件 x64 · 真实世界形态', limit: 22, pattern: /\.exe$/i, depth: 2, maxBytes: 64 * MB })),
  ...PF86.map((d) => ({ dir: d, covers: '第三方软件 x86 · 真实世界形态', limit: 16, pattern: /\.exe$/i, depth: 2, maxBytes: 64 * MB })),

  // ── 第三方 DLL：依赖解析的主力对象
  ...PF64.map((d) => ({ dir: d, covers: '第三方 DLL · 依赖解析主力', limit: 14, pattern: /\.dll$/i, depth: 2, maxBytes: 64 * MB }))
].filter((g) => existsSync(g.dir)) as SampleGroup[]

/**
 * 按组扫描目录：优先取体积大的（导入表更丰富，分支覆盖更全），
 * 并对每个候选做体积上限过滤。任何权限/IO 异常都静默跳过。
 */
function scanGroup(g: SampleGroup): string[] {
  const maxBytes = g.maxBytes ?? DEFAULT_MAX_BYTES
  const depth = g.depth ?? 0
  const found: { path: string; size: number }[] = []

  const walk = (dir: string, d: number): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (d > 0) walk(p, d - 1)
        continue
      }
      if (!g.pattern.test(name)) continue
      if (st.size < 8 * 1024 || st.size > maxBytes) continue
      found.push({ path: p, size: st.size })
    }
  }

  walk(g.dir, depth)
  // 体积降序：大文件的导入表/资源更完整，回归价值更高
  found.sort((a, b) => b.size - a.size)
  return found.slice(0, g.limit).map((f) => f.path)
}

/** 找到一个 .NET 汇编样本（带 CLR 头） */
async function findDotNet(): Promise<string | null> {
  if (!existsSync(NETFX)) return null
  try {
    const versions = readdirSync(NETFX).filter((v) => /^v\d/.test(v)).sort().reverse()
    for (const v of versions) {
      const dir = join(NETFX, v)
      const cands = readdirSync(dir).filter((f) => /\.(dll|exe)$/i.test(f)).slice(0, 40)
      for (const c of cands) {
        const p = join(dir, c)
        try {
          if (statSync(p).size < 8 * 1024) continue
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

async function collect(copy: boolean): Promise<void> {
  await fs.mkdir(DIR, { recursive: true })
  const targets: { path: string; covers: string }[] = []

  // 按组采集：每组覆盖一类 PE 形态
  const perGroup: { covers: string; picked: number }[] = []
  for (const g of GROUPS) {
    const picked = scanGroup(g)
    if (picked.length > 0) perGroup.push({ covers: g.covers, picked: picked.length })
    for (const p of picked) targets.push({ path: p, covers: g.covers })
  }
  // .NET 汇编（CLI 头与 AssemblyRef）—— 靠解析确认，不能用文件名猜
  const dotnet = await findDotNet()
  if (dotnet) targets.push({ path: dotnet, covers: '.NET 汇编 · CLR 头与 AssemblyRef' })

  if (perGroup.length > 0) {
    console.log('采集分组：')
    for (const g of perGroup) console.log(`  · ${g.covers} — ${g.picked} 个`)
  }

  if (targets.length === 0) {
    console.error('未找到任何可用样本（非 Windows 环境？）')
    process.exit(1)
  }

  const entries: SampleEntry[] = []
  const seen = new Set<string>()
  const stats = { x64: 0, x86: 0, otherArch: 0, dll: 0, exe: 0, sys: 0, dotnet: 0, packed: 0 }

  for (const t of targets) {
    const key = basename(t.path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    let buf: Buffer
    let r: Awaited<ReturnType<typeof parsePe>>
    try {
      buf = await fs.readFile(t.path)
      r = await parsePe(t.path)
    } catch (e) {
      console.log(`  跳过 ${t.path}: ${(e as Error).message}`)
      continue
    }
    const entry: SampleEntry = {
      id: `sample_${key.replace(/[^a-z0-9]+/gi, '_')}`,
      source: t.path,
      covers: t.covers,
      sha256: sha256(buf),
      sizeBytes: buf.length,
      expect: {
        parseStatus: r.parseStatus,
        arch: r.arch,
        isDll: r.isDll,
        isDotNet: r.isDotNet,
        importsAtLeast: r.imports.length > 0 ? Math.max(1, Math.floor(r.imports.length * 0.8)) : 0,
        hasDelayImports: r.delayImports.length > 0,
        sxsAtLeast: 0,
        hasVersionRes: !!r.fileVersion,
        hasExports: r.hasExports,
        packerSection: r.packerSection
      },
      capturedAt: new Date().toISOString(),
      host: `${process.platform} ${process.arch}`
    }
    entries.push(entry)
    if (r.arch === 'x64') stats.x64++
    else if (r.arch === 'x86') stats.x86++
    else stats.otherArch++
    if (/\.sys$/i.test(t.path)) stats.sys++
    else if (r.isDll) stats.dll++
    else stats.exe++
    if (r.isDotNet) stats.dotnet++
    if (r.packerSection) stats.packed++
    console.log(
      `  + ${basename(t.path).padEnd(22)} ${String(r.arch).padEnd(5)} ${r.isDll ? 'DLL' : 'EXE'}` +
        `${r.isDotNet ? ' [.NET]' : ''} imports=${String(r.imports.length).padStart(4)} delay=${r.delayImports.length}`
    )

    if (copy) {
      await fs.mkdir(FILES, { recursive: true })
      await fs.copyFile(t.path, join(FILES, basename(t.path)))
    }
  }

  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    note: '样本文件本身不入库（版权/体积），仅清单入库；用 npm run samples:collect 在本机重建',
    count: entries.length,
    samples: entries
  }
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`\n清单已写入 ${MANIFEST}（${entries.length} 个样本${copy ? '，并已复制文件副本' : ''}）`)
  console.log(
    `形态分布：x64 ${stats.x64} · x86 ${stats.x86} · 其它 ${stats.otherArch} ｜ ` +
      `DLL ${stats.dll} · EXE ${stats.exe} · SYS ${stats.sys} ｜ .NET ${stats.dotnet} · 加壳 ${stats.packed}`
  )
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
  const issues: string[] = []

  for (const s of manifest.samples) {
    const local = join(FILES, basename(s.source))
    const path = existsSync(local) ? local : s.source
    if (!existsSync(path)) {
      missing++
      console.log(`  ? ${basename(s.source)} — 本机不存在，跳过`)
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
      console.log(`  ✔ ${basename(s.source)}`)
    } else {
      drift++
      console.log(`  ✘ ${basename(s.source)} — ${problems.join('；')}`)
      issues.push(`${basename(s.source)}: ${problems.join('；')}`)
    }
  }

  console.log(`\n结果：通过 ${pass} · 漂移 ${drift} · 缺失 ${missing}`)
  if (drift > 0) {
    console.log('\n漂移说明：系统文件会随 Windows 更新变化，属正常；若同机重复出现，则可能是解析器回归。')
    console.log(issues.map((i) => `  - ${i}`).join('\n'))
    process.exit(2)
  }
}

const cmd = process.argv[2] ?? 'collect'
const copy = process.argv.includes('--copy')

// 打包为 CJS，不能用顶层 await
async function main(): Promise<void> {
  if (cmd === 'collect') await collect(copy)
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
