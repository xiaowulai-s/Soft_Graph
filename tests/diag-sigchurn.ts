/**
 * 诊断：连续两次采集 GC-12 的目录签名，列出发生变化的目录。
 * 用于判断「增量不命中」是环境真实写入，还是签名设计问题。
 */
import { loadRulesSync, setShellFolderMap } from '@junk/engine'
import { resolveUserShellFolders, pruneMissing } from '@junk/shellfolders'
import { collectSignatures } from '@junk/incremental'
import rulesJson from '@rules/junk-rules.json'

async function main(): Promise<void> {
  const map = await resolveUserShellFolders()
  if (map) setShellFolderMap(pruneMissing(map))
  const rs = loadRulesSync(rulesJson as never)
  for (const id of ['GC-11', 'GC-12']) {
    const rule = rs.rules.find((r) => r.id === id)!
    console.log(`\n=== ${id} 根目录: ${rule.roots.join(' | ')} ===`)
    const t0 = Date.now()
    const a = await collectSignatures(rule)
    const t1 = Date.now()
    const b = await collectSignatures(rule)
    const t2 = Date.now()
    console.log(`  签名采集两次：${t1 - t0}ms / ${t2 - t1}ms · 目录 ${a.dirCount} vs ${b.dirCount}`)
    const diff: string[] = []
    for (const k of Object.keys(a.dirs)) {
      if (a.dirs[k] !== b.dirs[k]) diff.push(k)
    }
    for (const k of Object.keys(b.dirs)) {
      if (!(k in a.dirs)) diff.push(k + ' (新增)')
    }
    console.log(`  变化目录 ${diff.length} 个（前 8）：`)
    for (const d of diff.slice(0, 8)) console.log(`    ${d}  ${a.dirs[d]} → ${b.dirs[d] ?? '-'}`)
  }
  process.exit(0)
}
void main()
