/**
 * 验证 B4：COM 索引磁盘缓存（跨进程）+ E6 证据产出
 *
 *   node scripts/run-ts.mjs tests/diag-comcache.ts build   # 首次构建并落盘
 *   node scripts/run-ts.mjs tests/diag-comcache.ts load    # 新进程读磁盘缓存
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadComIndex, setComIndexCachePath, resolveDependencies } from '@scanner/deps'
import { discoverSoftware } from '@scanner/software'
import { buildGraph } from '@graph-core/build'

const FILE = join(tmpdir(), 'sg-com-index-stable.json')
const mode = process.argv[2] ?? 'build'

async function main(): Promise<void> {
  setComIndexCachePath(FILE)

  const t0 = Date.now()
  const idx = await loadComIndex()
  const ms = Date.now() - t0
  const size = await fs.stat(FILE).then((s) => s.size).catch(() => 0)
  console.log(
    `[${mode}] 加载 ${(ms / 1000).toFixed(2)}s · 条目 ${idx.size} · 磁盘 ${(size / 1024 / 1024).toFixed(2)}MB`
  )

  if (mode === 'load') {
    // 新进程应几乎零成本（磁盘解析）
    console.log(ms < 1500 ? '✅ 磁盘缓存命中，加载远快于重建（1.6s）' : '⚠️ 疑似未命中磁盘缓存')
  }

  // E6 证据产出：扫前若干个有主程序的软件
  const items = await discoverSoftware({})
  const targets = items.filter((i) => i.mainExe).slice(0, 6)
  let e6Total = 0
  let maxMs = 0
  for (const t of targets) {
    const r = await resolveDependencies(t, {
      maxDepth: 2,
      enableComEvidence: true,
      enableShortcutEvidence: true
    })
    const e6 = r.edges.filter((e) => e.evidence?.includes('E6')).length
    e6Total += e6
    const t1 = Date.now()
    buildGraph(t, r.files, r.edges, {
      parsedOk: r.stats.parsedOk,
      parseFailed: r.stats.parseFailed
    } as never)
    maxMs = Math.max(maxMs, Date.now() - t1)
    console.log(`   ${t.name.slice(0, 28).padEnd(30)} 边 ${String(r.edges.length).padStart(4)} · E6 ${e6}`)
  }
  console.log(`E6 边合计 ${e6Total} · 图谱构建最大 ${maxMs}ms（目标 ≤3s）`)
  console.log(e6Total > 0 ? '✅ E6 证据已产出' : '⚠️ 这批软件无 COM 依赖（换目标再看）')
  process.exit(0)
}
void main()
