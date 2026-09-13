/**
 * 真机验证增量收益：对两类最贵规则（GC-11 重复文件 / GC-12 超大文件）
 * 连续扫两次，比较全量与增量的耗时与结果一致性。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { loadRulesSync, setShellFolderMap } from '@junk/engine'
import { resolveUserShellFolders, pruneMissing } from '@junk/shellfolders'
import { scanJunk } from '@junk/scanner'
import { formatBytes } from '@shared/util'
import rulesJson from '@rules/junk-rules.json'

async function main(): Promise<void> {
  const map = await resolveUserShellFolders()
  if (map) setShellFolderMap(pruneMissing(map))
  const all = loadRulesSync(rulesJson as never)
  const targets = ['GC-11', 'GC-12']
  const rules = all.rules.filter((r) => targets.includes(r.id))
  const ruleSet = { schemaVersion: 1, updatedAt: '', rules, warnings: [] }
  const ctx = {
    knownNames: new Set<string>(),
    knownPublishers: new Set<string>(),
    knownDirs: new Set<string>(),
    excludes: []
  }

  const cacheFile = join(tmpdir(), `sg-inc-bench-${randomBytes(4).toString('hex')}.json`)
  await fs.writeFile(cacheFile, '{}', 'utf8')

  for (const round of [1, 2, 3]) {
    const { loadCache, saveCache } = await import('@junk/incremental')
    const cache = await loadCache(cacheFile)
    const t0 = Date.now()
    const res = await scanJunk(ruleSet, ctx, { cache })
    const ms = Date.now() - t0
    await saveCache(cacheFile, res.cache)
    console.log(
      `第 ${round} 轮：${(ms / 1000).toFixed(2)}s · ${res.summary.totalCount} 项 · ${formatBytes(res.summary.totalBytes)} · 复用 [${res.reusedRules.map((r) => r + ':' + res.reuseSource[r]).join(',') || '无'}]`
    )
  }
  await fs.rm(cacheFile, { force: true }).catch(() => {})
  process.exit(0)
}
void main()
