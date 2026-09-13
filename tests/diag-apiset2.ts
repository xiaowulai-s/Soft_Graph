/** 验证 B5：加载器探测 API Set 真实宿主 + 与静态表覆盖率对比 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { loadApiSetSchema, listApiSetNames, probeApiSets, resetApiSetCache } from '@scanner/apiset'
import { mapApiSet, isApiSetName } from '@scanner/dllresolve'

async function main(): Promise<void> {
  const t0 = Date.now()
  const names = await listApiSetNames()
  console.log(`枚举到 API set 名字 ${names.length} 个 · ${Date.now() - t0}ms`)
  console.log('样例:', names.slice(0, 3).join(', '))

  const t1 = Date.now()
  const map = await probeApiSets(names.slice(0, 200))
  console.log(`加载器探测前 200 个：${Date.now() - t1}ms · 成功解析 ${map.size}`)
  for (const [k, v] of [...map].slice(0, 6)) console.log(`   ${k} → ${v}`)

  // 全量
  resetApiSetCache()
  const cacheFile = join(process.env.TEMP ?? '.', 'sg-apiset-cache-test.json')
  await fs.unlink(cacheFile).catch(() => {})
  const t2 = Date.now()
  const schema = await loadApiSetSchema(cacheFile)
  console.log(`\n全量加载: ${Date.now() - t2}ms · 条目 ${schema?.entries ?? 0} / 探测 ${schema?.probed ?? 0}`)

  if (schema) {
    // 与静态表对比
    let dynOnly = 0
    let agree = 0
    let conflict = 0
    let staticOnly = 0
    for (const [k, host] of schema.map) {
      const s = mapApiSet(k)
      if (s && s.toLowerCase() !== k) {
        if (s.toLowerCase() === host) agree++
        else conflict++
      } else dynOnly++
    }
    // 静态表有、动态没有的
    for (const n of names) {
      const key = n.toLowerCase()
      if (!schema.map.has(key)) {
        const s = mapApiSet(n)
        if (s && s.toLowerCase() !== key) staticOnly++
      }
    }
    console.log(`动态表 ${schema.map.size} 条：静态表一致 ${agree} · 冲突 ${conflict} · 仅动态可解 ${dynOnly}`)
    console.log(`静态表可解但动态未覆盖：${staticOnly}`)

    // 宿主存在性抽检
    let ok = 0
    let n = 0
    for (const [, host] of schema.map) {
      if (n >= 60) break
      n++
      const p = join(process.env.SystemRoot || 'C:\\Windows', 'System32', host)
      if (await fs.stat(p).then(() => true).catch(() => false)) ok++
    }
    console.log(`宿主 DLL 存在率: ${ok}/${n}`)

    // 缓存命中
    resetApiSetCache()
    const t3 = Date.now()
    const again = await loadApiSetSchema(cacheFile)
    console.log(`缓存命中加载: ${Date.now() - t3}ms · 条目一致: ${again?.entries === schema.entries}`)
    await fs.unlink(cacheFile).catch(() => {})
  }

  console.log('\nisApiSetName 抽样:', names.slice(0, 5).map((n) => `${n}=${isApiSetName(n)}`).join(' '))
  process.exit(0)
}
void main()
