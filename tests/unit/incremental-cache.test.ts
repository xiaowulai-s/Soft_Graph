/**
 * 增量扫描缓存 · 分支补测（v3.0.0 · G2）
 *
 * incremental.ts 覆盖率仅 28.8%，而它是「二次扫描 −65%」的支撑：
 * 缓存一旦误判为「可复用」，用户就会看到过期结果。这里钉死：
 *   1. 缓存读写往返与损坏容错（版本不符 / 坏 JSON / 文件不存在 → 空缓存）
 *   2. TTL 边界（正好到期、超时、updatedAt=0）
 *   3. signaturesEqual 的四种不等价情形（含「目录集合相同但某目录签名变了」）
 *   4. refreshItems：已删除的文件必须被剔除（否则用户会删一个不存在的文件）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  emptyCache,
  loadCache,
  saveCache,
  isCacheUsable,
  signaturesEqual,
  refreshItems,
  planUsnInvalidation,
  CACHE_VERSION,
  CACHE_TTL_MS,
  type CacheFile
} from '@junk/incremental'

const tmpFile = (tag: string) => join(tmpdir(), `sg-inc-${tag}-${randomBytes(4).toString('hex')}.json`)

const sig = (dirs: Record<string, string>, entryCount = 0) => ({
  dirs,
  dirCount: Object.keys(dirs).length,
  entryCount
})

describe('缓存读写与容错', () => {
  it('空缓存结构固定', () => {
    const c = emptyCache()
    assert.equal(c.version, CACHE_VERSION)
    assert.equal(c.updatedAt, 0)
    assert.deepEqual(c.rules, {})
    assert.deepEqual(c.volumes, {})
  })

  it('save → load 往返一致，且 save 会刷新 updatedAt', async () => {
    const f = tmpFile('round')
    const c: CacheFile = {
      version: CACHE_VERSION,
      updatedAt: 1,
      rules: { GC12: { signature: sig({ 'c:\\a': '1:2' }, 2), items: [], scannedAt: 5, misses: 0 } } as never,
      volumes: { 'C:': '0x123' }
    }
    await saveCache(f, c)
    assert.ok(c.updatedAt > 1, 'save 应刷新 updatedAt')
    const back = await loadCache(f)
    assert.equal(back.version, CACHE_VERSION)
    assert.deepEqual(back.volumes, { 'C:': '0x123' })
    await fs.rm(f, { force: true })
  })

  it('文件不存在 / 坏 JSON / 版本不符 → 一律返回空缓存而不是抛异常', async () => {
    const missing = await loadCache(tmpFile('missing'))
    assert.deepEqual(missing, emptyCache())

    const bad = tmpFile('bad')
    await fs.writeFile(bad, '{ 这不是 json', 'utf8')
    assert.deepEqual(await loadCache(bad), emptyCache())

    const oldVer = tmpFile('old')
    await fs.writeFile(oldVer, JSON.stringify({ version: 999, updatedAt: Date.now(), rules: {} }), 'utf8')
    assert.deepEqual(await loadCache(oldVer), emptyCache())

    await Promise.all([fs.rm(bad, { force: true }), fs.rm(oldVer, { force: true })])
  })

  it('写入失败不抛异常（目录不存在时静默降级）', async () => {
    await saveCache(join(tmpdir(), 'no-such-dir-sg', 'x.json'), emptyCache())
  })
})

describe('isCacheUsable · TTL 边界', () => {
  const now = 1_000_000_000_000

  it('版本不符直接不可用', () => {
    assert.equal(isCacheUsable({ ...emptyCache(), version: 0, updatedAt: now - 1 }, now), false)
  })

  it('updatedAt 为 0（从未写入）不可用', () => {
    assert.equal(isCacheUsable({ ...emptyCache(), updatedAt: 0 }, now), false)
  })

  it('刚写入可用；接近 TTL 仍可用；超过 TTL 不可用', () => {
    assert.equal(isCacheUsable({ ...emptyCache(), updatedAt: now - 1 }, now), true)
    assert.equal(isCacheUsable({ ...emptyCache(), updatedAt: now - (CACHE_TTL_MS - 1) }, now), true)
    assert.equal(isCacheUsable({ ...emptyCache(), updatedAt: now - CACHE_TTL_MS }, now), false)
    assert.equal(isCacheUsable({ ...emptyCache(), updatedAt: now - CACHE_TTL_MS - 1 }, now), false)
  })
})

describe('signaturesEqual · 等价判定', () => {
  const a = sig({ 'c:\\a': '111:3', 'c:\\b': '222:0' }, 3)

  it('完全相同的签名等价', () => {
    assert.equal(signaturesEqual(a, sig({ 'c:\\a': '111:3', 'c:\\b': '222:0' }, 3)), true)
  })

  it('目录数量不同 → 不等价', () => {
    assert.equal(signaturesEqual(a, sig({ 'c:\\a': '111:3' }, 2)), false)
  })

  it('某目录签名变化（mtime 或条目数）→ 不等价', () => {
    assert.equal(signaturesEqual(a, sig({ 'c:\\a': '111:4', 'c:\\b': '222:0' }, 3)), false)
    assert.equal(signaturesEqual(a, sig({ 'c:\\a': '999:3', 'c:\\b': '222:0' }, 3)), false)
  })

  it('目录集合不同（改名）→ 不等价', () => {
    assert.equal(signaturesEqual(a, sig({ 'c:\\a': '111:3', 'c:\\c': '222:0' }, 3)), false)
  })

  it('entryCount 不同 → 不等价（防并发计数漏算）', () => {
    assert.equal(signaturesEqual(a, sig({ 'c:\\a': '111:3', 'c:\\b': '222:0' }, 9)), false)
  })
})

describe('USN 变更记录级增量 · 策略判定', () => {
  it('readJournal 不可用（未提权）→ 一律退回签名比对', () => {
    // 关键：未提权时记录必然为空，绝不能因此判定「无变更」而复用
    const p = planUsnInvalidation({ available: false, records: [] })
    assert.equal(p.mode, 'fallback')
  })

  it('提权 + 0 条记录 → 整卷无变更，可整体复用', () => {
    const p = planUsnInvalidation({ available: true, records: [] })
    assert.equal(p.mode, 'reuse-all')
    assert.equal(p.count, 0)
  })

  it('提权 + 变更条数在阈值内 → partial（名字集合小写化）', () => {
    const p = planUsnInvalidation({
      available: true,
      records: [{ name: 'A.TMP' }, { name: 'b.log' }, { name: 'A.TMP' }]
    })
    assert.equal(p.mode, 'partial')
    assert.equal(p.count, 3)
    assert.deepEqual([...p.names].sort(), ['a.tmp', 'b.log'])
  })

  it('变更条数超过阈值 → 退回签名比对（反查代价大于遍历）', () => {
    const records = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.tmp` }))
    assert.equal(planUsnInvalidation({ available: true, records, maxRecords: 20 }).mode, 'fallback')
    assert.equal(planUsnInvalidation({ available: true, records, maxRecords: 100 }).mode, 'partial')
  })
})

describe('refreshItems · 命中项刷新', () => {
  it('已不存在的文件被剔除，存在的刷新体积与时间', async () => {
    const f = tmpFile('item')
    await fs.writeFile(f, 'x'.repeat(2048), 'utf8')
    const before = await fs.stat(f)

    const items = [
      { fullPath: f, sizeBytes: 1, mtime: 0 } as never,
      { fullPath: join(tmpdir(), 'sg-definitely-not-here.tmp'), sizeBytes: 5, mtime: 0 } as never
    ]
    const out = await refreshItems(items, { cancelled: false })
    assert.equal(out.length, 1, '不存在的文件应被剔除')
    assert.equal(out[0].fullPath, f)
    assert.equal(out[0].sizeBytes, 2048)
    assert.ok(out[0].mtime >= Math.floor(before.mtimeMs) - 1)
    await fs.rm(f, { force: true })
  })

  it('取消信号立即中止，返回已处理部分', async () => {
    const out = await refreshItems(
      [{ fullPath: 'C:\\no\\such\\a.tmp', sizeBytes: 1, mtime: 0 } as never],
      { cancelled: true }
    )
    assert.equal(out.length, 0)
  })

  it('空输入返回空数组', async () => {
    assert.deepEqual(await refreshItems([]), [])
  })
})
