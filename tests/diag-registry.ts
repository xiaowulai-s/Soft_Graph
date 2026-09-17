/**
 * 诊断：注册表卸载残留扫描（只读，不做任何删除）
 *
 *   node scripts/run-ts.mjs tests/diag-registry.ts
 */
import { enumerateUninstallKeys, classifyResidues, isRegistryKeyAllowed } from '@junk/registry'

async function main(): Promise<void> {
  const t0 = Date.now()
  const entries = await enumerateUninstallKeys()
  console.log(`枚举 Uninstall 键：${entries.length} 个 · ${Date.now() - t0}ms`)

  const byHive = entries.reduce<Record<string, number>>((acc, e) => {
    const k = `${e.hive}/${e.view}`
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})
  console.log('分布：', JSON.stringify(byHive))

  // 白名单自检：枚举出来的键必须全部通过白名单（否则删除通道会拒掉它们）
  const notAllowed = entries.filter((e) => !isRegistryKeyAllowed(e.keyPath))
  console.log(`白名单自检：${entries.length - notAllowed.length}/${entries.length} 通过`)
  for (const e of notAllowed.slice(0, 3)) console.log(`  ⚠ 未通过：${e.keyPath}`)

  const residues = classifyResidues(entries)
  console.log(`\n判定为残留：${residues.length} 个`)
  const byRisk = residues.reduce<Record<string, number>>((acc, r) => {
    acc[r.risk] = (acc[r.risk] || 0) + 1
    return acc
  }, {})
  console.log('风险分布：', JSON.stringify(byRisk))
  for (const r of residues.slice(0, 10)) {
    console.log(`  [${r.risk}] ${r.displayName || '(无名称)'} — ${r.reasons.join('；')}`)
  }
  console.log('\n（本脚本只读：不备份、不删除）')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
