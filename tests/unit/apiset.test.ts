/**
 * API Set 动态映射（M2/B5）单元测试
 *
 * 验证：
 *   1. 加载器探测能拿到真实宿主，且宿主文件存在
 *   2. 缓存可持久化并复用
 *   3. resolveDll 的 API set 分支：虚拟标记 + 映射到宿主 + 未命中时不误报缺失
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { platform } from 'node:os'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { loadApiSetSchema, resolveApiSets, listApiSetNames, resetApiSetCache } from '@scanner/apiset'
import { resolveDll, isApiSetName, mapApiSet, buildPathDirs } from '@scanner/dllresolve'

const ON_WIN = platform() === 'win32'

describe('API Set 动态映射（M2/B5）', () => {
  it('列出磁盘上的 API set 名字（非空且形如 api-ms-win-*）', async () => {
    if (!ON_WIN) return
    const names = await listApiSetNames()
    assert.ok(names.length > 0, '应能从 System32/Downlevel 枚举到 API set 名字')
    assert.ok(names.every((n) => /^(api-ms-win-|ext-ms-)/i.test(n)))
  })

  it('加载器探测：宿主解析成功且宿主文件真实存在', async () => {
    if (!ON_WIN) return
    resetApiSetCache()
    const cacheFile = join(tmpdir(), `sg-apiset-t-${randomBytes(4).toString('hex')}.json`)
    try {
      const schema = await loadApiSetSchema(cacheFile)
      assert.ok(schema, '应能建立 API set 映射')
      assert.ok(schema!.entries > 0)
      const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
      let checked = 0
      for (const [, host] of [...schema!.map].slice(0, 10)) {
        const ok = await fs.stat(join(sys, host)).then(() => true).catch(() => false)
        assert.ok(ok, `宿主 DLL 应存在：${host}`)
        checked++
      }
      assert.ok(checked > 0)
    } finally {
      await fs.rm(cacheFile, { force: true }).catch(() => {})
    }
  })

  it('缓存文件写入后可回读（新会话不必重复探测）', async () => {
    if (!ON_WIN) return
    resetApiSetCache()
    const cacheFile = join(tmpdir(), `sg-apiset-c-${randomBytes(4).toString('hex')}.json`)
    try {
      const first = await loadApiSetSchema(cacheFile)
      assert.ok(first)
      const size = await fs.stat(cacheFile).then((s) => s.size).catch(() => 0)
      assert.ok(size > 0, '应写入缓存文件')
      // 模拟新会话
      resetApiSetCache()
      const second = await loadApiSetSchema(cacheFile)
      assert.equal(second?.entries, first!.entries)
    } finally {
      await fs.rm(cacheFile, { force: true }).catch(() => {})
    }
  })

  it('按需补探：磁盘无占位文件的名字也能解析出宿主', async () => {
    if (!ON_WIN) return
    resetApiSetCache()
    const cacheFile = join(tmpdir(), `sg-apiset-o-${randomBytes(4).toString('hex')}.json`)
    try {
      const names = ['api-ms-win-core-file-l1-1-0.dll', 'api-ms-win-power-base-l1-1-0.dll']
      const map = await resolveApiSets(names, cacheFile)
      for (const n of names) {
        assert.ok(map.get(n), `${n} 应被解析出宿主`)
        assert.ok(/\.dll$/.test(map.get(n)!))
      }
    } finally {
      await fs.rm(cacheFile, { force: true }).catch(() => {})
    }
  })

  it('resolveDll：API set 节点标记为虚拟且映射到宿主', async () => {
    if (!ON_WIN) return
    resetApiSetCache()
    const cacheFile = join(tmpdir(), `sg-apiset-r-${randomBytes(4).toString('hex')}.json`)
    try {
      await loadApiSetSchema(cacheFile)
      const ctx = {
        arch: 'x64' as const,
        appDir: join(tmpdir(), 'sg-no-such-app'),
        known: new Set<string>(),
        pathDirs: buildPathDirs()
      }
      const r = resolveDll('api-ms-win-core-processthreads-l1-1-0.dll', ctx)
      assert.equal(r.virtual, true, 'API set 应标记为虚拟 DLL')
      assert.notEqual(r.resolvedName.toLowerCase(), 'api-ms-win-core-processthreads-l1-1-0.dll', '应映射到宿主名')
      assert.ok(r.fullPath.length > 0 && r.fullPath.toLowerCase().endsWith('.dll'))
    } finally {
      await fs.rm(cacheFile, { force: true }).catch(() => {})
    }
  })

  it('isApiSetName / mapApiSet 基本语义', () => {
    assert.equal(isApiSetName('api-ms-win-core-file-l1-1-0.dll'), true)
    assert.equal(isApiSetName('ext-ms-win-ntuser-window-l1-1-0.dll'), true)
    assert.equal(isApiSetName('kernel32.dll'), false)
    // 静态表兜底（未加载动态映射时也应给出候选宿主）
    const host = mapApiSet('api-ms-win-crt-runtime-l1-1-0.dll')
    assert.ok(host && /\.dll$/i.test(host))
  })
})
