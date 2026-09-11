/** 验证用户库目录解析修复：GC-11 / GC-12 的根目录应指向真实数据目录 */
import { loadRulesSync, setShellFolderMap } from '@junk/engine'
import { resolveUserShellFolders, pruneMissing } from '@junk/shellfolders'
import rulesJson from '../packages/rules/junk-rules.json'

async function main(): Promise<void> {
  console.log('=== 1. 解析用户库目录（注册表 User Shell Folders） ===')
  const map = await resolveUserShellFolders()
  if (!map) {
    console.log('  解析失败（注册表/PS 不可用），将退回同义名猜测')
  } else {
    for (const [k, v] of Object.entries(map)) console.log(`  ${k.padEnd(10)} → ${v}`)
    const pruned = pruneMissing(map)
    console.log(`\n  过滤不存在的条目后：${JSON.stringify(pruned, null, 2)}`)
    setShellFolderMap(pruned)
  }

  console.log('\n=== 2. 修正后的规则根目录 ===')
  const rs = loadRulesSync(rulesJson as never)
  for (const id of ['GC-01', 'GC-04', 'GC-07', 'GC-09', 'GC-11', 'GC-12']) {
    const r = rs.rules.find((x) => x.id === id)!
    console.log(`  ${id} ${r.name}`)
    for (const root of r.roots) console.log(`      ${root}`)
  }
}

main().catch((e) => {
  console.error('验证失败：', e)
  process.exit(1)
})
