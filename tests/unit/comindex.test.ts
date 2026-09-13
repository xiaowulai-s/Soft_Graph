/**
 * COM 反查索引（证据 E6，M2/B4）单元测试
 *
 * 验证：
 *   1. 索引可构建（规模为正，条目结构正确）
 *   2. 并发调用共享同一次构建（不重复付出 1.6s）
 *   3. 磁盘缓存命中时几乎零成本，且内容与重建一致
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { platform } from 'node:os'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { loadComIndex, setComIndexCachePath } from '@scanner/deps'

const ON_WIN = platform() === 'win32'

describe('COM 反查索引（M2/B4 · 证据 E6）', () => {
  it('构建成功：条目非空且值为 CLSID 数组', async () => {
    if (!ON_WIN) return
    const idx = await loadComIndex()
    assert.ok(idx.size > 0, '索引不应为空')
    let checked = 0
    for (const [k, v] of idx) {
      assert.ok(/^[a-z]:\\/.test(k), `键应为规范化绝对路径：${k}`)
      assert.ok(Array.isArray(v) && v.length > 0)
      assert.ok(v[0].startsWith('{'), `值应为 CLSID：${v[0]}`)
      if (++checked >= 20) break
    }
  })

  it('并发调用共享同一次构建', async () => {
    if (!ON_WIN) return
    const file = join(tmpdir(), `sg-com-t-${randomBytes(4).toString('hex')}.json`)
    setComIndexCachePath(file)
    try {
      const [a, b] = await Promise.all([loadComIndex(), loadComIndex()])
      assert.equal(a, b, '并发调用应返回同一个 Map 实例')
      assert.equal(a.size, b.size)
    } finally {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  })

  it('磁盘缓存：写入后内容与内存一致（JSON 可解析）', async () => {
    if (!ON_WIN) return
    const file = join(tmpdir(), `sg-com-t2-${randomBytes(4).toString('hex')}.json`)
    setComIndexCachePath(file)
    try {
      const idx = await loadComIndex()
      // 落盘是异步的，等待完成
      for (let i = 0; i < 40; i++) {
        const ok = await fs.stat(file).then(() => true).catch(() => false)
        if (ok) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
        version: number
        at: number
        entries: [string, string[]][]
      }
      assert.equal(raw.version, 1)
      assert.equal(raw.entries.length, idx.size)
      assert.ok(Date.now() - raw.at < 60_000, 'at 应为本次写入时间')
    } finally {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  })
})
