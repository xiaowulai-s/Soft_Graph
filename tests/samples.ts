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

  // x64 系统可执行文件（导入表丰富、有延迟导入）
  for (const p of pick(SYS, 2, (f) => /^explorer\.exe$/i.test(f)).concat(
    pick(S32, 3, (f) => /^(notepad|cmd|calc|mspaint)\.exe$/i.test(f))
  )) {
    targets.push({ path: p, covers: 'x64 可执行文件 · 导入表与延迟导入' })
  }
  // x64 系统 DLL（含 API Set 引用）
  for (const p of pick(S32, 6, (f) => /^(kernel32|user32|gdi32|combase|kernelbase|ntdll|advapi32)\.dll$/i.test(f))) {
    targets.push({ path: p, covers: 'x64 系统 DLL · KnownDLLs / API Set' })
  }
  // 共享运行库（VC++ 运行时，WinSxS 重定向相关）
  for (const p of pick(S32, 4, (f) => /^(msvcp|msvcr|vcruntime|ucrtbase)/i.test(f))) {
    targets.push({ path: p, covers: '共享运行库 · WinSxS/清单依赖' })
  }
  // x86 样本（WOW64 路径重定向）
  for (const p of pick(WOW, 4, (f) => /\.(dll|exe)$/i.test(f))) {
    targets.push({ path: p, covers: 'x86 模块 · WOW64 位数处理' })
  }
  // .NET 汇编（CLI 头与 AssemblyRef）
  const dotnet = await findDotNet()
  if (dotnet) targets.push({ path: dotnet, covers: '.NET 汇编 · CLR 头与 AssemblyRef' })

  if (targets.length === 0) {
    console.error('未找到任何可用样本（非 Windows 环境？）')
    process.exit(1)
  }

  const entries: SampleEntry[] = []
  const seen = new Set<string>()

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
