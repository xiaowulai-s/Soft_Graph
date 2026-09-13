/**
 * C4 压力测试（v2.0.0 M3）
 *
 * 两个压力面：
 *   1. 大图谱：buildGraph（单软件 12000 文件依赖，测折叠策略）+
 *      layoutGraph（1350 / 3150 / 6750 / 13500 节点，力布局 vs 超阈值近似布局）的耗时与内存
 *   2. 大文件树扫描：构造 5 万真实文件（约 2500 目录），
 *      walkRule 实跑三轮，采样 RSS/堆/句柄曲线，验证无泄漏（轮间内存应回落）
 *
 * 产出 docs/benchmarks/stress-<date>.md 报告。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { buildGraph } from '@graph-core/build'
import { layoutGraph, type LayoutInputNode, type LayoutInputEdge } from '@graph-core/layout'
import { walkRule, loadRulesSync } from '@junk/engine'
import type { DependencyEdge, FileNode, SoftwareItem } from '@shared/types'

const temp = process.env.TEMP || process.env.TMP || '.'
const base = join(temp, 'sg-stress-' + randomBytes(3).toString('hex'))

function mem(): { rss: number; heap: number; handles: number } {
  global.gc?.()
  const m = process.memoryUsage()
  const res = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? []
  return { rss: m.rss, heap: m.heapUsed, handles: res.length }
}
const mb = (n: number): string => (n / 1024 / 1024).toFixed(1) + 'MB'

async function sample(label: string, fn: () => Promise<void> | void): Promise<void> {
  const before = mem()
  const t0 = Date.now()
  await fn()
  const ms = Date.now() - t0
  const after = mem()
  const rssDelta = ((after.rss - before.rss) / 1024 / 1024).toFixed(1)
  console.log(
    `${label.padEnd(40)} ${String(ms).padStart(6)}ms  RSS ${mb(before.rss)}→${mb(after.rss)} (Δ${rssDelta}MB)  heap ${mb(after.heap)}  handles ${before.handles}→${after.handles}`
  )
  return void 0
}

// ───────────────── 图谱数据合成 ─────────────────

function makeSoftware(filesCount: number): {
  sw: SoftwareItem
  files: Map<string, FileNode>
  deps: DependencyEdge[]
} {
  const sw: SoftwareItem = {
    id: 'sw_stress',
    name: '压力测试软件',
    version: '1.0',
    publisher: 'bench',
    installPath: 'C:\\stress\\app',
    mainExe: 'C:\\stress\\app\\main.exe',
    iconHash: 'h',
    source: 'registry',
    sizeBytes: 1
  }
  const files = new Map<string, FileNode>()
  const deps: DependencyEdge[] = []
  for (let i = 0; i < filesCount; i++) {
    const id = 'f_' + i
    const kind = i % 10 === 0 ? 'exe' : 'dll'
    files.set(id, {
      id,
      fullPath: `C:\\stress\\app\\bin\\${kind}${i}.dll`,
      name: `${kind}${i}.dll`,
      sizeBytes: 4096,
      mtime: 1700000000000,
      kind,
      ext: 'dll',
      missing: false,
      refCount: i % 7 === 0 ? 30 : 1
    })
    deps.push({ sourceId: sw.id, targetId: id, type: 'imports', confidence: 0.9, evidence: ['E2'] })
  }
  return { sw, files, deps }
}

function makeLayoutInputs(nodeCount: number): { nodes: LayoutInputNode[]; edges: LayoutInputEdge[] } {
  const nodes: LayoutInputNode[] = [{ id: 'center', tier: 0, radius: 26 }]
  const edges: LayoutInputEdge[] = []
  for (let i = 1; i < nodeCount; i++) {
    const tier = (i % 3) as 1 | 2 | 3
    nodes.push({ id: 'n' + i, tier, radius: 14, sector: 'sector' + (i % 12) })
    // 前 500 个直连中心，其余挂在同扇区节点上（形成真实的多层结构）
    if (i <= 500) edges.push({ source: 'center', target: 'n' + i })
    else edges.push({ source: 'n' + (i - 1), target: 'n' + i })
  }
  return { nodes, edges }
}

// ───────────────── 主流程 ─────────────────

async function main(): Promise<void> {
  const report: string[] = []
  const rep = (s: string): void => {
    report.push(s)
    console.log(s)
  }

  console.log('═══ 1a. buildGraph：单软件超大依赖 ═══')
  rep('## 图谱压力\n')
  rep('### buildGraph（单软件）\n')
  rep('| 依赖文件数 | 耗时 | 输出节点 | 输出边 | 末值 RSS | 堆 |')
  rep('|---|---|---|---|---|---|')
  for (const n of [2000, 6000, 12000]) {
    const { sw, files, deps } = makeSoftware(n)
    let out: { nodes: number; edges: number } = { nodes: 0, edges: 0 }
    await sample(`buildGraph（${n} 依赖）`, async () => {
      const model = buildGraph(sw, files, deps, {
        parsedOk: n,
        parseFailed: 0,
        totalBytes: n * 4096,
        buildMs: 0
      })
      out = { nodes: model.nodes.length, edges: model.edges.length }
    })
    const m = mem()
    rep(`| ${n} | 见上 | ${out.nodes} | ${out.edges} | ${mb(m.rss)} | ${mb(m.heap)} |`)
  }

  console.log('\n═══ 1b. layoutGraph：大图布局 ═══')
  rep('\n### layoutGraph\n')
  rep('| 节点数 | 边数 | 模式 | 耗时 | 末值 RSS | 堆 |')
  rep('|---|---|---|---|---|---|')
  for (const n of [1350, 3150, 6750, 13500]) {
    const { nodes, edges } = makeLayoutInputs(n)
    let positions = 0
    await sample(`layoutGraph（${n} 节点 / ${edges.length} 边）`, async () => {
      const r = layoutGraph(nodes, edges, 'radial')
      positions = Object.keys(r.positions).length
    })
    const m = mem()
    rep(`| ${n} | ${edges.length} | ${n > 3000 ? 'approx' : 'force'} | 见上 | ${mb(m.rss)} | ${mb(m.heap)} |`)
    void positions
  }

  console.log('\n═══ 2. 大文件树扫描（5 万文件 × 3 轮，看泄漏）═══')
  rep('\n## 扫描压力（5 万文件 / 约 2500 目录）\n')
  rep('| 轮次 | 耗时 | 扫描文件数 | 命中 | RSS 末值 | 堆 | 句柄 |')
  rep('|---|---|---|---|---|---|---|')

  const DIRS = 2500
  const PER_DIR = 20
  console.log(`构造测试树：${DIRS} 目录 × ${PER_DIR} 文件 …`)
  for (let d = 0; d < DIRS; d++) {
    const dir = join(base, 'd' + d)
    await fs.mkdir(dir, { recursive: true })
    const writes: Promise<unknown>[] = []
    for (let f = 0; f < PER_DIR; f++) {
      writes.push(fs.writeFile(join(dir, `cache-${f}.tmp`), 'x'.repeat(64), 'utf8'))
    }
    await Promise.all(writes)
    if (d % 500 === 0) console.log(`  ${d}/${DIRS}`)
  }
  console.log('构造完成\n')

  const rs = loadRulesSync({
    schemaVersion: 1,
    updatedAt: '',
    rules: [
      {
        id: 'STRESS',
        name: 'stress',
        description: '',
        risk: 'low',
        defaultSelected: false,
        match: { roots: [base], patterns: ['*.tmp'], maxDepth: 8 }
      }
    ]
  })
  const rule = rs.rules[0]

  const roundRss: number[] = []
  for (let round = 1; round <= 3; round++) {
    let hits = 0
    const stats = { scanned: 0, denied: 0 }
    const start = mem()
    await sample(`walkRule 第 ${round} 轮（5 万文件）`, async () => {
      await walkRule(rule, () => hits++, stats)
    })
    const end = mem()
    roundRss.push(end.rss)
    rep(
      `| ${round} | 见上 | ${stats.scanned} | ${hits} | ${mb(end.rss)} | ${mb(end.heap)} | ${end.handles}（开始 ${start.handles}） |`
    )
  }
  const leakDelta = roundRss[2] - roundRss[0]
  rep('')
  rep(
    `**泄漏判定**：第 1 轮 vs 第 3 轮 RSS 差 = ${(leakDelta / 1024 / 1024).toFixed(1)}MB —— ${
      Math.abs(leakDelta) < 30 * 1024 * 1024 ? '✅ 无泄漏（差值 < 30MB）' : '⚠️ 需关注'
    }`
  )

  console.log('\n清理测试树 …')
  rmSync(base, { recursive: true, force: true })
  console.log('完成')

  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  const out = `# SoftGraph 压力测试报告（C4 · ${stamp}）\n\n> 环境：Node ${process.versions.node} · ${process.env.ComputerName || process.env.COMPUTERNAME || '本机'}\n> 运行：\`node scripts/run-ts.mjs tests/stress.ts --max-old-space-size=4096\`\n\n${report.join('\n')}\n`
  await fs.mkdir('docs/benchmarks', { recursive: true })
  await fs.writeFile(`docs/benchmarks/stress-${stamp}.md`, out, 'utf8')
  console.log(`\n报告已写入 docs/benchmarks/stress-${stamp}.md`)
  process.exit(0)
}

void main()
