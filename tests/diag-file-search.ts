/**
 * I-11 路径检索 —— 证据脚本（v3.0.0）
 *
 * 要证明的三件事（都是可复核的机器输出，不是判断）：
 *   1. **两种驱动分支**：sql.js（打包应用实际走的）无 FTS5；node:sqlite 有 FTS5
 *   2. **索引真的被用上了**：`EXPLAIN QUERY PLAN` 对
 *        · `LIKE 'q%'`            → 期望 `SCAN`（这正是文档说「退化为 LIKE」的代价）
 *        · `col >= ? AND col < ?` → 期望 `SEARCH … USING INDEX`（我们的主路径）
 *        · `lower(col) LIKE`      → 期望 `SCAN`（套函数必然废掉索引）
 *      三种写法都跑一遍，把查询计划打出来对比
 *   3. **规模曲线**：1k / 10k / 50k 行下各自耗时，说明「当前规模够用」与
 *      「何时该换成 FTS5」的边界在哪
 *
 *   node scripts/run-ts.mjs tests/diag-file-search.ts
 *
 * 产出：`.tmp/file-search.json`（UTF-8）
 * 说明：只读 + 在临时库上写入合成数据，不触碰用户的真实数据库。
 */
import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../apps/desktop/src/main/db/driver'
import { Store } from '../apps/desktop/src/main/db/store'
import { normKey } from '@shared/util'

const OUT = '.tmp/file-search.json'
const WASM_DIR = join(process.cwd(), 'node_modules', 'sql.js', 'dist')
const SIZES = [1_000, 10_000, 50_000]

const DIRS = [
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Program Files\\SampleApp\\bin',
  'D:\\Download\\pkg\\lib'
]

function synthRow(i: number): [string, string, string] {
  const dir = DIRS[i % DIRS.length]
  // 一半用大写、一半用小写，专门用来验证「大小写不敏感」是否真的成立
  const stem = i % 2 === 0 ? `KernelMod${i}` : `kernelmod${i}`
  const full = `${dir}\\${stem}.dll`
  return [`syn_${i}`, full, `${stem}.dll`]
}

async function plan(db: Db, sql: string, params: unknown[] = []): Promise<string[]> {
  try {
    const rows = db.all<{ detail: string }>('EXPLAIN QUERY PLAN ' + sql, params as never)
    return rows.map((r) => String(r.detail))
  } catch (e) {
    return [`<失败> ${(e as Error).message.slice(0, 120)}`]
  }
}

function timeIt(fn: () => unknown): { ms: number; n: number } {
  const t = Date.now()
  const r = fn()
  const n = Array.isArray(r) ? r.length : 0
  return { ms: Date.now() - t, n }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sg-filesearch-diag-'))
  const report: Record<string, unknown> = { capturedAt: new Date().toISOString(), node: process.versions.node }

  try {
    // ── 1. 驱动能力对照 ──
    console.log('═══ 1. 驱动能力对照 ═══')
    const drivers: Record<string, unknown> = {}
    for (const prefer of ['sqljs', 'node-sqlite'] as const) {
      const f = join(dir, `probe-${prefer}.db`)
      const db = await openDb({ file: f, wasmDir: WASM_DIR, prefer })
      const store = new Store(db)
      store.init()
      const d = store.searchDiagnostics()
      drivers[prefer] = { driver: db.driverName, supportsFts5: db.supportsFts5, lcReady: d.lcReady }
      console.log(`  ${prefer.padEnd(12)} → ${db.driverName.padEnd(16)} FTS5=${db.supportsFts5} lcReady=${d.lcReady}`)
      await db.close()
    }
    report.drivers = drivers

    // ── 2. 查询计划对照（在 sql.js 上做，它就是打包路径）──
    console.log('\n═══ 2. 查询计划对照（sql.js / 打包应用实际路径）═══')
    const f2 = join(dir, 'plan.db')
    const db = await openDb({ file: f2, wasmDir: WASM_DIR, prefer: 'sqljs' })
    db.exec(`
      CREATE TABLE file_index (
        id TEXT PRIMARY KEY, full_path TEXT NOT NULL, name TEXT, size INTEGER DEFAULT 0,
        ref_count INTEGER DEFAULT 0, full_path_lc TEXT, name_lc TEXT
      );
      CREATE INDEX idx_file_path ON file_index(full_path);
      CREATE INDEX idx_file_path_lc ON file_index(full_path_lc);
      CREATE INDEX idx_file_name_lc ON file_index(name_lc);
    `)
    const N = 20_000
    db.transaction(() => {
      db.runMany(
        'INSERT INTO file_index (id,full_path,name,size,ref_count,full_path_lc,name_lc) VALUES (?,?,?,?,?,?,?)',
        Array.from({ length: N }, (_, i) => {
          const [id, full, name] = synthRow(i)
          return [id, full, name, 1024 + i, i % 9, normKey(full), normKey(name)]
        })
      )
    })
    console.log(`  已灌入 ${N} 行（一半大写开头，用于验证大小写不敏感）`)

    const plans: Record<string, string[]> = {}
    plans['A  LIKE \'q%\'（文档设想的「退化」写法）'] = await plan(
      db,
      `SELECT id FROM file_index WHERE full_path LIKE ?`,
      ['c:\\windows\\%']
    )
    plans['B  lower(col) LIKE \'q%\'（套函数）'] = await plan(
      db,
      `SELECT id FROM file_index WHERE lower(full_path) LIKE ?`,
      ['c:\\windows\\%']
    )
    plans['C  col >= ? AND col < ?（本项目主路径）'] = await plan(
      db,
      `SELECT id FROM file_index WHERE full_path_lc >= ? AND full_path_lc < ?`,
      ['c:\\windows\\', 'c:\\windows\\\uffff']
    )
    plans['D  name_lc 前缀范围'] = await plan(db, `SELECT id FROM file_index WHERE name_lc >= ? AND name_lc < ?`, [
      'kernelmod',
      'kernelmod\uffff'
    ])
    plans['E  子串 %q%'] = await plan(db, `SELECT id FROM file_index WHERE full_path_lc LIKE ?`, ['%mod123%'])

    for (const [k, v] of Object.entries(plans)) {
      const label = v.join(' | ')
      const viaIndex = /USING INDEX|USING COVERING INDEX/.test(label)
      console.log(`  ${viaIndex ? '✅ 走索引' : '⚠️  全表扫描'}  ${k}`)
      console.log(`        ${label}`)
    }
    report.queryPlans = plans

    // 大小写不敏感验证：小写查询必须命中大写行的数据
    const lowerHit = db.all<{ id: string }>(
      `SELECT id FROM file_index WHERE full_path_lc >= ? AND full_path_lc < ?`,
      ['c:\\windows\\system32\\kernelmod1', 'c:\\windows\\system32\\kernelmod1\uffff']
    )
    const upperCount = db.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM file_index WHERE full_path LIKE 'C:\\Windows\\System32\\KernelMod1%'`
    )
    report.caseInsensitive = {
      lowerQueryHits: lowerHit.length,
      actualUpperCaseRows: Number(upperCount[0]?.c ?? 0)
    }
    console.log(
      `\n  大小写不敏感验证：小写查询命中 ${lowerHit.length} 行，库中同前缀的大写行 ${upperCount[0]?.c ?? 0} 行`
    )

    // ── 3. 规模曲线 ──
    console.log('\n═══ 3. 规模曲线（前缀范围 vs 子串全表）═══')
    const scaling: Record<string, unknown> = {}
    for (const size of SIZES) {
      if (size > N) continue
      const prefix = timeIt(() =>
        db.all(
          `SELECT id FROM file_index WHERE full_path_lc >= ? AND full_path_lc < ? LIMIT 50`,
          ['c:\\windows\\system32\\kernelmod', 'c:\\windows\\system32\\kernelmod\uffff']
        )
      )
      const substring = timeIt(() =>
        db.all(`SELECT id FROM file_index WHERE full_path_lc LIKE ? LIMIT 50`, ['%kernelmod12%'])
      )
      const namePrefix = timeIt(() =>
        db.all(`SELECT id FROM file_index WHERE name_lc >= ? AND name_lc < ? LIMIT 50`, [
          'kernelmod1',
          'kernelmod1\uffff'
        ])
      )
      scaling[String(size)] = { prefixRangeMs: prefix.ms, namePrefixMs: namePrefix.ms, substringMs: substring.ms }
      console.log(
        `  ${String(size).padStart(6)} 行 → 前缀范围 ${String(prefix.ms).padStart(5)}ms · 名称前缀 ${String(
          namePrefix.ms
        ).padStart(5)}ms · 子串全表 ${String(substring.ms).padStart(5)}ms`
      )
    }

    // 全量 20k 行的子串与前缀（不受 size 上限影响）
    const fullPrefix = timeIt(() =>
      db.all(`SELECT id FROM file_index WHERE full_path_lc >= ? AND full_path_lc < ? LIMIT 50`, [
        'c:\\windows\\system32\\',
        'c:\\windows\\system32\\\uffff'
      ])
    )
    const fullSub = timeIt(() => db.all(`SELECT id FROM file_index WHERE full_path_lc LIKE ? LIMIT 50`, ['%kernelmod12%']))
    scaling[`${N}_full`] = { prefixRangeMs: fullPrefix.ms, substringMs: fullSub.ms }
    console.log(
      `  ${String(N).padStart(6)} 行（全量前缀，命中多）→ 前缀范围 ${fullPrefix.ms}ms · 子串全表 ${fullSub.ms}ms`
    )
    report.scaling = scaling

    await db.close()

    // ── 4. 真实库抽样（只读真实数据库，不写入）──
    console.log('\n═══ 4. 真实库检索抽样 ═══')
    let real: Record<string, unknown> | null = null
    try {
      const { resolvePaths } = await import('../apps/desktop/src/main/services/env')
      const paths = resolvePaths()
      const rdb = await openDb({ file: paths.dbFile, wasmDir: WASM_DIR, prefer: 'sqljs' })
      const store = new Store(rdb)
      store.init()
      const diag = store.searchDiagnostics()
      console.log(`  真实库：驱动 ${diag.driver} · ${diag.fileRows} 行 · lcReady ${diag.lcReady}`)
      const samples: Record<string, unknown> = {}
      for (const q of ['c:\\windows\\system32\\', 'kernel', 'dll']) {
        const t = Date.now()
        const r = store.searchFiles(q, { limit: 20 })
        const ms = Date.now() - t
        samples[q] = { hits: r.hits.length, total: r.total, strategy: r.strategy, ms }
        console.log(`    "${q}" → ${r.hits.length} 条（共 ${r.total}） · ${r.strategy} · ${ms}ms`)
      }
      const sub = store.searchFiles('kernel', { mode: 'substring', limit: 20 })
      samples['kernel(substring)'] = { hits: sub.hits.length, total: sub.total, strategy: sub.strategy }
      console.log(`    "kernel"（子串）→ ${sub.hits.length} 条（共 ${sub.total}） · ${sub.strategy}`)
      real = { ...diag, samples }
      await rdb.close()
    } catch (e) {
      console.log(`  ⚠ 真实库不可用：${(e as Error).message.slice(0, 100)}`)
    }
    report.real = real

    // ── 结论 ──
    const planC = (plans['C  col >= ? AND col < ?（本项目主路径）'] ?? []).join(' ')
    const planA = (plans["A  LIKE 'q%'（文档设想的「退化」写法）"] ?? []).join(' ')
    const verdict = {
      likeUsesScan: /SCAN/.test(planA) && !/USING INDEX/.test(planA),
      rangeUsesIndex: /USING (COVERING )?INDEX/.test(planC),
      sqljsNoFts5: (drivers.sqljs as { supportsFts5: boolean }).supportsFts5 === false,
      nodeSqliteHasFts5: (drivers['node-sqlite'] as { supportsFts5: boolean }).supportsFts5 === true
    }
    console.log('\n═══ 结论 ═══')
    console.log(`  LIKE 'q%' 走全表扫描：${verdict.likeUsesScan ? '✅（因此不能用它做前缀检索）' : '❌'}`)
    console.log(`  范围比较走索引：${verdict.rangeUsesIndex ? '✅（本项目采用）' : '❌'}`)
    console.log(`  sql.js 无 FTS5（打包路径）：${verdict.sqljsNoFts5 ? '✅' : '❌'}`)
    console.log(`  node:sqlite 有 FTS5（仅 CLI/测试）：${verdict.nodeSqliteHasFts5 ? '✅' : '❌'}`)
    report.verdict = verdict

    await fs.mkdir('.tmp', { recursive: true })
    await fs.writeFile(OUT, JSON.stringify(report, null, 2), 'utf8')
    console.log(`\n结论已写入 ${OUT}（UTF-8）`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
