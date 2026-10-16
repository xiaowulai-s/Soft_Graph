/** 排查：GC-11 重复文件 / GC-14/15 AI 规则在本机为何 0 结果（in-process 全链路） */
import rulesJson from '@rules/junk-rules.json'
import { loadRulesSync } from '@junk/engine'
import { scanJunk, type JunkScanContext } from '@junk/scanner'

async function main(): Promise<void> {
  const rs = loadRulesSync(rulesJson as never)
  const ctx: JunkScanContext = {
    knownNames: new Set(),
    knownPublishers: new Set(),
    knownDirs: new Set(),
    excludes: []
  }
  const t0 = Date.now()
  const out = await scanJunk(rs, ctx, { categoryIds: ['GC-11', 'GC-14', 'GC-15'], force: true })
  for (const id of ['GC-11', 'GC-14', 'GC-15']) {
    const items = out.items.filter((i) => i.categoryId === id)
    const bytes = items.reduce((s, i) => s + i.sizeBytes, 0)
    console.log(`${id}: ${items.length} 项 · ${(bytes / 1024 / 1024).toFixed(2)} MB`)
    for (const i of items.slice(0, 5)) console.log(`   ${i.name} · ${(i.sizeBytes / 1024).toFixed(0)} KB`)
  }
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  // 引擎编译后的根目录（展开结果）确认
  for (const id of ['GC-11', 'GC-14']) {
    const r = rs.rules.find((x) => x.id === id)
    console.log(`${id} 展开根: ${r?.roots.join(' | ')}`)
  }
}

main().catch((e) => {
  console.error('FAIL:', (e as Error).stack)
  process.exit(1)
})
