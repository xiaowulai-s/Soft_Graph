/**
 * 检查「Windows 目录收紧判定」是否误伤既有垃圾规则：
 * 每条规则的每个根目录，探测其子文件能否通过 guardPath 与 isScannable。
 */
import { isScannable, guardPath } from '@shared/safety'
import rulesJson from '@rules/junk-rules.json'
import { loadRulesSync, expandRoots } from '@junk/engine'

const rs = loadRulesSync(rulesJson as never)
let bad = 0
for (const r of rs.rules) {
  for (const root of r.roots) {
    for (const expanded of expandRoots(root)) {
      const g = guardPath(expanded)
      if (!g.allowed) {
        // 根目录本身被禁删是正常的（exact 只禁目录自身）—— 关键看其子项
        console.log('  [根自身被禁] ' + r.id + ' ' + expanded + ' → ' + (g.reason ?? ''))
        continue
      }
      const probe = expanded + '\\probe-file.tmp'
      const gp = guardPath(probe)
      const sc = isScannable(probe)
      if (!gp.allowed || !sc) {
        bad++
        const reason = gp.allowed ? 'isScannable=false' : (gp.reason ?? '')
        console.log('  ✗ ' + r.id + ' 子项被拦: ' + probe + ' → ' + reason)
      }
    }
  }
}
console.log(bad === 0 ? '✅ 全部规则的子项都能通过安全层（收紧无误伤）' : '✗ 共 ' + bad + ' 处误伤')
process.exit(bad === 0 ? 0 : 1)
