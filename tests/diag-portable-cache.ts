/**
 * A3 便携目录缓存 —— 真机 A/B 验证（v3.0.0）
 *
 * 要证明三件事，缺一不可：
 *   1. **收益**：二次扫描（签名全命中）真的更快，且知道快在哪
 *   2. **等价**：命中路径与全量路径产出的 SoftwareItem **逐字段一致**
 *      （缓存最危险的失败不是慢，而是「悄悄给出不同的结果」）
 *   3. **失效**：四条判据逐条生效 —— 目录 mtime / 条目数 / 主 exe mtime / manual 标记
 *
 * 分两部分：
 *   A 合成树（tmpdir 内）—— 可控地验证 1/2/3，且**不触碰用户任何真实目录**
 *   B 真实根目录 —— 给出真实命中率与耗时对比（输入两次运行完全一致，因此差值有效）
 *
 *   node scripts/run-ts.mjs tests/diag-portable-cache.ts
 *
 * 产出：`.tmp/portable-cache.json`（UTF-8，含全部数字与逐字段比对结论）
 * 注意：A 部分只在临时目录内创建/修改文件；B 部分**只读**，不做任何写入或 utimes。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanPortable, defaultPortableRoots, type PortableCacheStats } from '@scanner/software'
import {
  emptyPortableCache,
  installedFingerprintOf,
  loadPortableCache,
  prunePortableCache,
  savePortableCache,
  PORTABLE_CACHE_TTL_MS
} from '@scanner/portable-cache'
import { normKey } from '@shared/util'
import type { SoftwareItem } from '@shared/types'

const OUT = '.tmp/portable-cache.json'

/** 逐字段比较两组软件条目，返回差异描述（空数组 = 完全一致） */
function diffItems(a: SoftwareItem[], b: SoftwareItem[]): string[] {
  const diffs: string[] = []
  const keyOf = (i: SoftwareItem): string => i.id
  const mapA = new Map(a.map((i) => [keyOf(i), i]))
  const mapB = new Map(b.map((i) => [keyOf(i), i]))
  if (a.length !== b.length) diffs.push(`条目数不同：${a.length} vs ${b.length}`)
  for (const [k, x] of mapA) {
    const y = mapB.get(k)
    if (!y) {
      diffs.push(`B 缺少条目 ${k}（${x.installPath}）`)
      continue
    }
    for (const f of ['name', 'version', 'publisher', 'installPath', 'mainExe', 'iconHash', 'source'] as const) {
      if (x[f] !== y[f]) diffs.push(`${k}.${f}: "${x[f]}" vs "${y[f]}"`)
    }
    if (x.sizeBytes !== y.sizeBytes) diffs.push(`${k}.sizeBytes: ${x.sizeBytes} vs ${y.sizeBytes}`)
    if (x.portableScore !== y.portableScore) diffs.push(`${k}.portableScore: ${x.portableScore} vs ${y.portableScore}`)
    if ((x.portableEvidence ?? []).join('|') !== (y.portableEvidence ?? []).join('|')) {
      diffs.push(`${k}.portableEvidence: ${(x.portableEvidence ?? []).join('|')} vs ${(y.portableEvidence ?? []).join('|')}`)
    }
    if (x.source !== y.source) diffs.push(`${k}.source: ${x.source} vs ${y.source}`)
  }
  for (const k of mapB.keys()) if (!mapA.has(k)) diffs.push(`A 缺少条目 ${k}`)
  return diffs
}

interface RunResult {
  items: SoftwareItem[]
  ms: number
  stats: PortableCacheStats | null
}

async function runOnce(
  label: string,
  roots: string[],
  installedPaths: Set<string>,
  marks: Map<string, boolean>,
  cache: ReturnType<typeof emptyPortableCache> | null
): Promise<RunResult> {
  // 用 holder 而不是裸局部变量：onStats 是回调，TS 会把裸变量的类型收窄成 never
  const holder: { s: PortableCacheStats | null } = { s: null }
  const t = Date.now()
  const items = await scanPortable(roots, installedPaths, 55, marks, () => {}, {
    cache,
    onStats: (s) => {
      holder.s = s
    }
  })
  const ms = Date.now() - t
  const stats = holder.s
  console.log(
    `  ${label}: ${ms}ms · 命中 ${stats?.hit ?? 0} / 未命中 ${stats?.miss ?? 0}` +
      (stats ? ` · 命中率 ${(stats.hitRate * 100).toFixed(1)}%` : '') +
      ` · 条目 ${items.length}`
  )
  return { items, ms, stats }
}

// ───────────────── A. 合成树：可控验证 ─────────────────

async function partA(): Promise<Record<string, unknown>> {
  console.log('\n═══ A. 合成树（tmpdir，不触碰用户目录）═══')
  const base = await fs.mkdtemp(join(tmpdir(), 'sg-portcache-ab-'))
  const DIRS = 30
  const FILES_PER_DIR = 120
  const roots = [base]

  try {
    // 造 30 个「像便携软件」的目录：app.exe + app.ini + data/（内含 120 个文件）
    for (let i = 0; i < DIRS; i++) {
      const d = join(base, `App${i}`)
      await fs.mkdir(join(d, 'data'), { recursive: true })
      await fs.writeFile(join(d, 'app.exe'), Buffer.from('MZ' + 'x'.repeat(2048)))
      await fs.writeFile(join(d, 'app.ini'), '[main]\nportable=1\n')
      for (let j = 0; j < FILES_PER_DIR; j++) {
        await fs.writeFile(join(d, 'data', `f${j}.bin`), Buffer.alloc(16))
      }
    }

    const emptyMarks = new Map<string, boolean>()
    const installed = new Set<string>()
    const fp = installedFingerprintOf(installed)

    // 冷：空缓存 → 全部未命中
    const coldCache = emptyPortableCache(fp)
    const cold = await runOnce('冷（空缓存）', roots, installed, emptyMarks, coldCache)
    prunePortableCache(coldCache)

    // 写盘再读回：模拟真实「第二次启动应用」
    const cacheFile = join(base, 'portable-scan.json')
    await savePortableCache(cacheFile, coldCache)
    const warmCache = await loadPortableCache(cacheFile, fp)

    // 热：签名全命中
    const warm = await runOnce('热（签名命中）', roots, installed, emptyMarks, warmCache)

    const identity = diffItems(cold.items, warm.items)
    console.log(`  逐字段比对：${identity.length === 0 ? '✅ 完全一致' : `❌ ${identity.length} 处差异`}`)
    for (const d of identity.slice(0, 10)) console.log(`    - ${d}`)

    // ── 失效判据逐条验证 ──
    const checks: Record<string, { hits: number; miss: number; pass: boolean; note: string }> = {}

    // 1) 目录 mtime / 条目数：新增一个文件
    const probeDir = join(base, 'App0')
    await fs.writeFile(join(probeDir, 'newfile.txt'), 'x')
    const afterAdd = await runOnce('失效-新增文件', roots, installed, emptyMarks, warmCache)
    checks['新增文件 → 该目录未命中'] = {
      hits: afterAdd.stats?.hit ?? 0,
      miss: afterAdd.stats?.miss ?? 0,
      pass: (afterAdd.stats?.miss ?? 0) === 1,
      note: `期望 miss=1，实际 miss=${afterAdd.stats?.miss ?? -1}`
    }

    // 2) 主 exe mtime：原地覆写（目录 mtime 不变 —— A5 踩过的同一个坑）
    const exePath = join(base, 'App1', 'app.exe')
    const t0 = Date.now() / 1000 + 5
    await fs.writeFile(exePath, Buffer.from('MZ' + 'y'.repeat(3000)))
    await fs.utimes(exePath, t0, t0)
    const afterOverwrite = await runOnce('失效-原地覆写主 exe', roots, installed, emptyMarks, warmCache)
    checks['原地覆写主 exe（目录 mtime 不变）→ 该目录未命中'] = {
      hits: afterOverwrite.stats?.hit ?? 0,
      miss: afterOverwrite.stats?.miss ?? 0,
      pass: (afterOverwrite.stats?.miss ?? 0) === 1,
      note: `期望 miss=1，实际 miss=${afterOverwrite.stats?.miss ?? -1}`
    }

    // 3) manual 标记翻转（+100 分是权重最大的特征，必须立即生效）
    const manualKey = normKey(join(base, 'App2'))
    const manualMarks = new Map<string, boolean>([[manualKey, true]])
    const afterManual = await runOnce('失效-manual 翻转', roots, installed, manualMarks, warmCache)
    checks['manual 标记变化 → 该目录未命中'] = {
      hits: afterManual.stats?.hit ?? 0,
      miss: afterManual.stats?.miss ?? 0,
      pass: (afterManual.stats?.miss ?? 0) === 1,
      note: `期望 miss=1，实际 miss=${afterManual.stats?.miss ?? -1}`
    }

    // 4) manual 标记不变时仍命中（防止「一开手动就永不全量」的反向错误）
    const manualSame = new Map<string, boolean>([[manualKey, true]])
    const afterManualSame = await runOnce('再扫一次（标记未变）', roots, installed, manualSame, warmCache)
    checks['标记未变 → 恢复全命中'] = {
      hits: afterManualSame.stats?.hit ?? 0,
      miss: afterManualSame.stats?.miss ?? 0,
      pass: (afterManualSame.stats?.hit ?? 0) === DIRS,
      note: `期望 hit=${DIRS}，实际 hit=${afterManualSame.stats?.hit ?? -1}`
    }

    // 5) 条目 TTL：把条目时间往前拨到过期
    for (const e of Object.values(warmCache.dirs)) e.at = Date.now() - PORTABLE_CACHE_TTL_MS - 1
    const afterTtl = await runOnce('失效-TTL 过期', roots, installed, emptyMarks, warmCache)
    checks['TTL 过期 → 全部未命中'] = {
      hits: afterTtl.stats?.hit ?? 0,
      miss: afterTtl.stats?.miss ?? 0,
      pass: (afterTtl.stats?.hit ?? 0) === 0,
      note: `期望 hit=0，实际 hit=${afterTtl.stats?.hit ?? -1}`
    }

    for (const [k, v] of Object.entries(checks)) {
      console.log(`  ${v.pass ? '✅' : '❌'} ${k}（${v.note}）`)
    }

    return {
      dirs: DIRS,
      filesPerDir: FILES_PER_DIR,
      coldMs: cold.ms,
      warmMs: warm.ms,
      speedup: cold.ms > 0 ? Number((cold.ms / Math.max(warm.ms, 1)).toFixed(2)) : null,
      coldStats: cold.stats,
      warmStats: warm.stats,
      identityDiffs: identity,
      invalidationChecks: checks
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

// ───────────────── B. 真实根目录 ─────────────────

async function partB(): Promise<Record<string, unknown>> {
  console.log('\n═══ B. 真实根目录（只读）═══')

  // installedPaths 用已有扫描结果（避免在本脚本里再跑一遍注册表枚举）
  let installedPaths = new Set<string>()
  try {
    const { openDb } = await import('../apps/desktop/src/main/db/driver')
    const { Store } = await import('../apps/desktop/src/main/db/store')
    const { resolvePaths } = await import('../apps/desktop/src/main/services/env')
    const paths = resolvePaths()
    const db = await openDb({ file: paths.dbFile, wasmDir: 'node_modules/sql.js/dist' })
    const store = new Store(db)
    store.init()
    installedPaths = new Set(store.listSoftware().map((s) => normKey(s.installPath)).filter(Boolean))
    console.log(`  已安装软件目录：${installedPaths.size} 个（取自现有数据库）`)
    await db.close()
  } catch (e) {
    console.log(`  ⚠ 读取数据库失败，installedPaths 用空集：${(e as Error).message.slice(0, 80)}`)
  }

  let roots: string[] = []
  try {
    const { resolvePaths } = await import('../apps/desktop/src/main/services/env')
    const paths = resolvePaths()
    const raw = JSON.parse(await fs.readFile(paths.settingsFile, 'utf8')) as { portableRoots?: string[] }
    roots = raw.portableRoots ?? []
  } catch {
    /* 配置不存在 → 用默认探测 */
  }
  const configured = roots.length > 0
  if (!configured) roots = await defaultPortableRoots()
  console.log(`  根目录（${configured ? '用户配置' : '默认探测'}）：${roots.join('、') || '（无）'}`)
  if (roots.length === 0) return { skipped: '没有可扫描的便携根目录' }

  const fp = installedFingerprintOf(installedPaths)
  const marks = new Map<string, boolean>()
  const cacheFile = join(tmpdir(), `sg-portable-real-${Date.now()}.json`)

  try {
    const coldCache = emptyPortableCache(fp)
    const cold = await runOnce('冷（空缓存）', roots, installedPaths, marks, coldCache)
    prunePortableCache(coldCache)
    await savePortableCache(cacheFile, coldCache)

    const warmCache = await loadPortableCache(cacheFile, fp)
    const warm = await runOnce('热（签名命中）', roots, installedPaths, marks, warmCache)

    const identity = diffItems(cold.items, warm.items)
    console.log(`  逐字段比对：${identity.length === 0 ? '✅ 完全一致' : `❌ ${identity.length} 处差异`}`)
    for (const d of identity.slice(0, 10)) console.log(`    - ${d}`)

    return {
      roots: roots.length,
      configuredRoots: configured,
      installedPaths: installedPaths.size,
      coldMs: cold.ms,
      warmMs: warm.ms,
      speedup: cold.ms > 0 ? Number((cold.ms / Math.max(warm.ms, 1)).toFixed(2)) : null,
      coldStats: cold.stats,
      warmStats: warm.stats,
      items: cold.items.length,
      identityDiffs: identity,
      cachedDirs: Object.keys(warmCache.dirs).length,
      note: '两次运行的输入完全一致，因此耗时差值有效；installedPaths 取自现有数据库（非本次枚举）'
    }
  } finally {
    await fs.rm(cacheFile, { force: true }).catch(() => {})
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const a = await partA()
  const b = await partB()

  const aCold = Number(a.coldMs ?? 0)
  const aWarm = Number(a.warmMs ?? 0)
  const allChecks = Object.values((a.invalidationChecks ?? {}) as Record<string, { pass: boolean }>)
  const verdict = {
    identityConsistent:
      ((a.identityDiffs as string[]) ?? []).length === 0 && ((b.identityDiffs as string[]) ?? []).length === 0,
    invalidationAllPass: allChecks.length > 0 && allChecks.every((c) => c.pass),
    warmFaster: aWarm > 0 && aWarm < aCold
  }
  console.log('\n═══ 结论 ═══')
  console.log(`  结果等价（冷/热逐字段一致）：${verdict.identityConsistent ? '✅' : '❌'}`)
  console.log(`  四条失效判据全部生效：${verdict.invalidationAllPass ? '✅' : '❌'}`)
  console.log(`  热扫描更快：${verdict.warmFaster ? `✅ ${aCold}ms → ${aWarm}ms` : `❌ ${aCold}ms → ${aWarm}ms`}`)

  await fs.mkdir('.tmp', { recursive: true })
  await fs.writeFile(
    OUT,
    JSON.stringify({ startedAt, synthetic: a, real: b, verdict }, null, 2),
    'utf8'
  )
  console.log(`\n结论已写入 ${OUT}（UTF-8）`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
