/** B5 最终验证：resolveDll 对 API set 的分支行为（动态映射 vs 静态表） */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDll, buildPathDirs, isApiSetName } from '@scanner/dllresolve'
import { loadApiSetSchema, resetApiSetCache, resolveApiSets } from '@scanner/apiset'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'

async function main(): Promise<void> {
  const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const ctx = { arch: 'x64' as const, appDir: 'C:\\nonexistent-app-dir', known: new Set<string>(), pathDirs: buildPathDirs() }

  const cases = [
    'api-ms-win-core-file-l1-1-0.dll',
    'api-ms-win-core-processthreads-l1-1-0.dll',
    'api-ms-win-crt-runtime-l1-1-0.dll',
    'api-ms-win-core-winrt-l1-1-0.dll',
    'api-ms-win-power-base-l1-1-0.dll'
  ]

  console.log('=== 动态映射加载前（静态表兜底）===')
  for (const c of cases) {
    const r = resolveDll(c, ctx)
    console.log(`  ${c.padEnd(44)} → ${r.resolvedName.padEnd(16)} kind=${r.kind} virtual=${r.virtual} 存在=${r.fullPath ? '是' : '否'}`)
  }

  resetApiSetCache()
  const cacheFile = join(tmpdir(), `sg-apiset-final-${randomBytes(4).toString('hex')}.json`)
  const schema = await loadApiSetSchema(cacheFile)
  await resolveApiSets(cases, cacheFile)
  console.log(`\n=== 动态映射加载后（条目 ${schema?.entries}）===`)
  let resolved = 0
  for (const c of cases) {
    const r = resolveDll(c, ctx)
    const hostOk = r.fullPath ? await fs.stat(r.fullPath).then(() => true).catch(() => false) : false
    if (r.fullPath) resolved++
    console.log(
      `  ${c.padEnd(44)} → ${r.resolvedName.padEnd(16)} kind=${r.kind} virtual=${r.virtual} 宿主存在=${hostOk ? '是' : '否'}`
    )
  }
  console.log(`\n解析到宿主: ${resolved}/${cases.length}`)
  console.log('缓存文件:', await fs.stat(cacheFile).then((s) => `${(s.size / 1024).toFixed(1)}KB`).catch(() => '无'))
  await fs.unlink(cacheFile).catch(() => {})
  console.log('isApiSetName 抽样:', cases.map((c) => isApiSetName(c)).join(','))
  process.exit(0)
}
void main()
