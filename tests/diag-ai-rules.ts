/** GC-14/GC-15 验证：规则加载 → 安全层零误伤 → 本机真实扫描 */
import rulesJson from '@rules/junk-rules.json'
import { loadRulesSync, expandRoots } from '@junk/engine'
import { guardPath, isScannable } from '@shared/safety'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scanJunk, type JunkScanContext } from '@junk/scanner'

async function main(): Promise<void> {
  // 1) 引擎加载（含 schema 校验）
  const rs = loadRulesSync(rulesJson as never)
  console.log(`规则加载: ${rs.rules.length} 条（期望 15）`)
  const g14 = rs.rules.find((r) => r.id === 'GC-14')
  const g15 = rs.rules.find((r) => r.id === 'GC-15')
  if (!g14 || !g15) throw new Error('GC-14/GC-15 未加载')
  console.log(`GC-14 risk=${g14.risk} defaultSelected=${g14.defaultSelected}`)
  console.log(`GC-15 risk=${g15.risk} algorithm=${g15.algorithm} minSize=${g15.raw.match?.minSizeBytes}`)

  // 2) 展开的根与其子项必须通过安全层（防误伤）
  let bad = 0
  for (const [label, rule] of [['GC-14', g14], ['GC-15', g15]] as const) {
    for (const root of rule.raw.match?.roots ?? []) {
      for (const expanded of expandRoots(root)) {
        const exists = existsSync(expanded)
        const probe = join(expanded, 'probe-file.tmp')
        const gp = guardPath(probe)
        const sc = isScannable(probe)
        if (!gp.allowed || !sc) {
          bad++
          console.log(`  ❌ ${label} 子项被拦: ${probe} guard=${gp.reason ?? 'ok'} scannable=${sc}`)
        } else if (exists) {
          console.log(`  ✓ ${label} ${expanded}（本机存在，安全层放行）`)
        }
      }
    }
  }
  console.log(bad === 0 ? '✅ 新规则根子项全部通过安全层' : `❌ ${bad} 处被拦`)

  // 3) 本机真实扫描这两条规则
  const ctx: JunkScanContext = {
    knownNames: new Set(),
    knownPublishers: new Set(),
    knownDirs: new Set(),
    excludes: []
  }
  const t0 = Date.now()
  const out = await scanJunk(rs, ctx, { categoryIds: ['GC-14', 'GC-15'], force: true })
  const found = out.items.filter((i) => i.categoryId === 'GC-14' || i.categoryId === 'GC-15')
  const by = new Map<string, { n: number; bytes: number }>()
  for (const i of found) {
    const b = by.get(i.categoryId) ?? { n: 0, bytes: 0 }
    b.n++
    b.bytes += i.sizeBytes
    by.set(i.categoryId, b)
  }
  for (const [id, v] of by) console.log(`${id}: ${v.n} 项 · ${(v.bytes / 1024 / 1024).toFixed(1)} MB`)
  if (!by.size) console.log('（本机未安装相关 AI 工具或目录为空 —— 正常情况之一）')
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log('AI-RULES-CHECK-DONE')
}

main().catch((e) => {
  console.error('FAIL:', (e as Error).message)
  process.exit(1)
})
