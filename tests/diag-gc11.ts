/**
 * 诊断：重复文件分类（GC-11）耗时与 A4 分级效果
 *
 * v2.0.0 基线：GC-11 = 9.7s（并发遍历后）。v3.0.0 A4 在采样与全文件哈希之间
 * 插入扩展采样并并发化哈希，本脚本给出实测对比数字。
 *
 *   node scripts/run-ts.mjs tests/diag-gc11.ts
 */
import rulesJson from '@rules/junk-rules.json'
import { loadRulesSync } from '@junk/engine'
import { scanJunk } from '@junk/scanner'

function formatBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${u[i]}`
}

async function main(): Promise<void> {
  const ruleSet = loadRulesSync(rulesJson as never)
  const rule = ruleSet.rules.find((r) => r.id === 'GC-11')
  if (!rule) {
    console.error('规则集中没有 GC-11')
    process.exit(1)
  }
  console.log(`根目录：${rule.roots.join(' | ')}`)
  console.log(`并发度 SG_DUP_CONCURRENCY=${process.env.SG_DUP_CONCURRENCY ?? 8} · 扩展采样段数=${process.env.SG_DUP_SAMPLE_SEGMENTS ?? 16}`)

  const ctx = { knownNames: new Set<string>(), knownPublishers: new Set<string>(), knownDirs: new Set<string>(), excludes: [] }

  for (const pass of [1, 2]) {
    const t0 = Date.now()
    const res = await scanJunk({ schemaVersion: 1, updatedAt: '', rules: [rule], warnings: [] }, ctx, {})
    const ms = Date.now() - t0
    const c = res.summary.categories[0]
    console.log(`第 ${pass} 轮：${(ms / 1000).toFixed(2)}s · ${c?.count ?? 0} 项 · ${formatBytes(c?.sizeBytes ?? 0)}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
