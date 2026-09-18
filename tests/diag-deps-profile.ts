/**
 * A7 依赖解析分段计时（v3.0.0）
 *
 * 目的只有一个：**在写并行代码之前，先知道 12.8s 花在哪一段**。
 *
 * 计划文档原本写的是「PE 解析 worker 池并行」，但从代码结构看首要嫌疑不是 PE 解析：
 *   - `snapshotInstallDir` 是**完全串行**的递归 walk，逐文件 `await fs.stat`（≤6000 文件 / 深度 6）
 *   - BFS 内的 `parsePe` 每节点限 40、深度受限，调用次数少
 * 凭印象优化很可能打错靶子，所以先用数字说话。
 *
 *   node scripts/run-ts.mjs tests/diag-deps-profile.ts
 *
 * 产出：`.tmp/deps-profile.json`（UTF-8，含每个软件的分段耗时与占比）
 * 说明：全部只读（读 PE 文件 + 读目录），不修改任何数据。
 */
import { promises as fs } from 'node:fs'
import { resolveDependencies, type ResolveStage } from '@scanner/deps'
import { openDb } from '../apps/desktop/src/main/db/driver'
import { Store } from '../apps/desktop/src/main/db/store'
import { resolvePaths } from '../apps/desktop/src/main/services/env'
import type { SoftwareItem } from '@shared/types'

const OUT = '.tmp/deps-profile.json'
/** 取体积最大的前 N 个软件做样本（大软件才是 A7 的目标）。可用参数覆盖：`… 2 Docker` */
const argN = Number(process.argv[2] ?? '')
const TOP_N = Number.isFinite(argN) && argN > 0 ? Math.floor(argN) : 5
/** 可选：按名字子串过滤（只跑匹配的样本，便于复测单个软件） */
const NAME_FILTER = (process.argv[3] ?? '').toLowerCase()

interface SampleResult {
  name: string
  installPath: string
  sizeBytes: number
  totalMs: number
  stages: Record<string, number>
  /** 各段占「已计入的分段之和」的比例 */
  share: Record<string, number>
  parsedOk: number
  parseFailed: number
  files: number
  edges: number
  snapshotFiles: number
}

async function main(): Promise<void> {
  const paths = resolvePaths()
  const db = await openDb({ file: paths.dbFile, wasmDir: 'node_modules/sql.js/dist' })
  const store = new Store(db)
  store.init()

  const all = store.listSoftware()
  const top = [...all]
    .filter((s) => s.mainExe && s.installPath)
    .filter((s) => !NAME_FILTER || s.name.toLowerCase().includes(NAME_FILTER))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, TOP_N)

  console.log(`已收录软件 ${all.length} 个 · 取样体积最大的 ${top.length} 个\n`)

  const results: SampleResult[] = []

  for (const sw of top) {
    const stages: Partial<Record<ResolveStage, number>> = {}
    const t0 = Date.now()
    let res: Awaited<ReturnType<typeof resolveDependencies>> | null = null
    try {
      res = await resolveDependencies(sw, {
        maxDepth: 2,
        refCounts: new Map(),
        enableComEvidence: true,
        enableShortcutEvidence: true,
        onStage: (stage, ms) => {
          stages[stage] = (stages[stage] ?? 0) + ms
        }
      })
    } catch (e) {
      console.log(`  ✗ ${sw.name}：解析失败 ${(e as Error).message.slice(0, 80)}`)
      continue
    }
    const totalMs = Date.now() - t0

    const sum = Object.values(stages).reduce((a, b) => a + b, 0)
    const share: Record<string, number> = {}
    for (const [k, v] of Object.entries(stages)) share[k] = sum > 0 ? Number((v / sum).toFixed(3)) : 0

    const r: SampleResult = {
      name: sw.name,
      installPath: sw.installPath,
      sizeBytes: sw.sizeBytes,
      totalMs,
      stages: stages as Record<string, number>,
      share,
      parsedOk: res.stats.parsedOk,
      parseFailed: res.stats.parseFailed,
      files: res.files.size,
      edges: res.edges.length,
      snapshotFiles: res.stats.truncated ? -1 : 0
    }
    results.push(r)

    console.log(`── ${sw.name}（${(sw.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB）总计 ${totalMs}ms`)
    const ordered = Object.entries(r.stages).sort((a, b) => b[1] - a[1])
    for (const [k, v] of ordered) {
      const bar = '█'.repeat(Math.max(1, Math.round((share[k] ?? 0) * 30)))
      console.log(`     ${k.padEnd(12)} ${String(v).padStart(6)}ms  ${(share[k] * 100).toFixed(1).padStart(5)}%  ${bar}`)
    }
    console.log(`     → 依赖文件 ${r.files} · 边 ${r.edges} · 解析 ok ${r.parsedOk} / 失败 ${r.parseFailed}\n`)
  }

  await db.close()

  // ── 汇总：按「所有样本的段耗时之和」排序，找出全局大头 ──
  const totals: Record<string, number> = {}
  let grand = 0
  for (const r of results) {
    grand += r.totalMs
    for (const [k, v] of Object.entries(r.stages)) totals[k] = (totals[k] ?? 0) + v
  }
  const stageSum = Object.values(totals).reduce((a, b) => a + b, 0)

  console.log('═══ 汇总（全部样本累加）═══')
  console.log(`  总耗时 ${grand}ms · 分段合计 ${stageSum}ms（差额为未分段的部分：图谱外开销/GC 等）`)
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(6)}ms  ${((v / stageSum) * 100).toFixed(1)}%`)
  }

  const snapshotMs = totals['snapshot'] ?? 0
  const bfsParseMs = totals['bfs-parse'] ?? 0
  const bfsSxsMs = totals['bfs-sxs'] ?? 0
  const bfsWalkMs = totals['bfs-walk'] ?? 0
  const bfsMs = bfsParseMs + bfsSxsMs + bfsWalkMs
  const verdict =
    snapshotMs >= bfsMs * 1.5
      ? '阶段二「安装目录快照」是主要瓶颈 → 优先做快照并发化（与 A6 walkRule 同口径），**不要**做 PE 解析 worker 池'
      : bfsMs >= snapshotMs * 1.5
        ? 'BFS 阶段是主要瓶颈 → 按最大子段决定：SxS 定位（可缓存/并行）或 PE 解析（worker 池）'
        : '两段量级接近 → 先做快照并发化（风险更低），再评估是否还需要动 BFS'
  console.log(`\n结论：${verdict}`)
  console.log(
    `  （snapshot ${snapshotMs}ms vs BFS 合计 ${bfsMs}ms = parse ${bfsParseMs} + sxs ${bfsSxsMs} + walk ${bfsWalkMs}）`
  )

  await fs.mkdir('.tmp', { recursive: true })
  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        node: process.versions.node,
        softwareTotal: all.length,
        samples: results,
        totals,
        stageSum,
        grandTotalMs: grand,
        verdict
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`结论已写入 ${OUT}（UTF-8）`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
