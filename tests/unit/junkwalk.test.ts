/**
 * walkRule 并发遍历单元测试（v2.0.0 M1 / A 线）
 *
 * 覆盖点：
 * - 递归收集正确性（并发版与串行版结果必须完全一致）
 * - maxDepth / patterns / minSizeBytes / maxAgeDays 过滤
 * - 取消信号立即停止
 * - 根目录不存在 / 根目录直接指向文件
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { walkRule, loadRulesSync, type CompiledRule, type WalkStats, type WalkHit } from '@junk/engine'

let root = ''

async function makeTree(): Promise<string> {
  const base = join(tmpdir(), 'sg-walktest-' + randomBytes(4).toString('hex'))
  // 结构：
  //   a/1.txt (10B)        命中
  //   a/b/2.txt (200B)     命中（深度 2）
  //   a/b/c/3.txt (300B)   深度 3，maxDepth=2 时不命中
  //   a/skip/4.txt         目录名在 SKIP_DIR_NAMES 时不命中（用 node_modules 不在列表，改用深链验证）
  //   a/5.log              不匹配 *.txt
  //   top.txt (1KB)        根直接命中
  await fs.mkdir(join(base, 'a', 'b', 'c'), { recursive: true })
  await fs.mkdir(join(base, 'a', 'empty'))
  await fs.writeFile(join(base, 'a', '1.txt'), 'x'.repeat(10))
  await fs.writeFile(join(base, 'a', 'b', '2.txt'), 'x'.repeat(200))
  await fs.writeFile(join(base, 'a', 'b', 'c', '3.txt'), 'x'.repeat(300))
  await fs.writeFile(join(base, 'a', '5.log'), 'x')
  await fs.writeFile(join(base, 'top.txt'), 'x'.repeat(1024))
  return base
}

function compile(rootDir: string, extra: Record<string, unknown> = {}): CompiledRule {
  const rs = loadRulesSync({
    schemaVersion: 1,
    updatedAt: '',
    rules: [
      {
        id: 'GC-TEST',
        name: '测试',
        description: '',
        risk: 'low',
        defaultSelected: false,
        match: { roots: [rootDir], patterns: ['*.txt'], maxDepth: 3, ...extra }
      }
    ]
  })
  return rs.rules[0]
}

async function collect(rule: CompiledRule, signal?: { cancelled: boolean }): Promise<{ hits: WalkHit[]; stats: WalkStats }> {
  const hits: WalkHit[] = []
  const stats: WalkStats = { scanned: 0, denied: 0 }
  await walkRule(rule, (h) => hits.push(h), stats, signal)
  hits.sort((x, y) => (x.path < y.path ? -1 : 1))
  return { hits, stats }
}

describe('walkRule 并发遍历', () => {
  it('递归收集：深度、模式匹配、根文件命中', async () => {
    root = await makeTree()
    try {
      const { hits } = await collect(compile(root))
      const names = hits.map((h) => h.path.split('\\').pop())
      // maxDepth=3：a/1.txt(1) a/b/2.txt(2) a/b/c/3.txt(3) + top.txt 都在深度内
      assert.ok(names.includes('1.txt'), '应命中 a/1.txt')
      assert.ok(names.includes('2.txt'), '应命中 a/b/2.txt')
      assert.ok(names.includes('3.txt'), '应命中 a/b/c/3.txt')
      assert.ok(names.includes('top.txt'), '应命中根文件 top.txt')
      assert.ok(!names.includes('5.log'), '不应命中 .log')
      assert.equal(hits.length, 4)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('并发 1 与并发 8 的结果完全一致（顺序无关比较）', async () => {
    root = await makeTree()
    try {
      const saved = process.env.SG_WALK_CONCURRENCY
      process.env.SG_WALK_CONCURRENCY = '1'
      const serial = await collect(compile(root))
      if (saved === undefined) delete process.env.SG_WALK_CONCURRENCY
      else process.env.SG_WALK_CONCURRENCY = saved
      const par = await collect(compile(root))
      process.env.SG_WALK_CONCURRENCY = saved
      assert.deepEqual(
        par.hits.map((h) => h.path),
        serial.hits.map((h) => h.path)
      )
      assert.equal(par.stats.scanned, serial.stats.scanned)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('maxDepth 截断深层文件', async () => {
    root = await makeTree()
    try {
      const { hits } = await collect(compile(root, { maxDepth: 1 }))
      const names = hits.map((h) => h.path.split('\\').pop())
      assert.ok(names.includes('1.txt'))
      assert.ok(!names.includes('2.txt'), '深度 2 应被 maxDepth=1 截断')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('minSizeBytes 与 maxAgeDays 过滤', async () => {
    root = await makeTree()
    try {
      const { hits } = await collect(compile(root, { minSizeBytes: 1000 }))
      assert.ok(hits.every((h) => h.size >= 1000))
      // maxAgeDays=3650：全部刚创建的文件都不满足「足够老」
      const { hits: old } = await collect(compile(root, { maxAgeDays: 3650 }))
      assert.equal(old.length, 0, '新文件不应通过 maxAgeDays 过滤')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('取消信号立即停止', async () => {
    root = await makeTree()
    try {
      const signal = { cancelled: false }
      // 预先用一个失败的根让遍历开始后再取消不太可控；这里验证「已取消」直接空结果
      signal.cancelled = true
      const { hits } = await collect(compile(root), signal)
      assert.equal(hits.length, 0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('根目录不存在不抛错、根指向文件时单文件判定', async () => {
    const ghost = join(tmpdir(), 'sg-walktest-ghost-' + randomBytes(4).toString('hex'))
    const { hits } = await collect(compile(ghost))
    assert.equal(hits.length, 0)
    assert.ok(!existsSync(ghost))

    root = await makeTree()
    try {
      const fileRoot = join(root, 'top.txt')
      const { hits: fh } = await collect(compile(fileRoot))
      assert.equal(fh.length, 1)
      assert.ok(fh[0].path.endsWith('top.txt'))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
