/**
 * 增量扫描缓存（v2.0.0 M2 / A5）单元测试
 *
 * 正确性要求（不可妥协）：
 *   1. 目录签名未变 → 复用结果，但体积/修改时间必须重新 stat（不能展示过期数据）
 *   2. 目录内新增/删除文件 → 签名变化 → 必须全量重扫，新文件必须出现、已删文件必须消失
 *   3. 缓存文件本身可持久化与回读
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { loadRulesSync } from '@junk/engine'
import { scanJunk } from '@junk/scanner'
import {
  collectSignatures,
  signaturesEqual,
  refreshItems,
  emptyCache,
  isCacheUsable,
  saveCache,
  loadCache,
  CACHE_TTL_MS
} from '@junk/incremental'

function ruleOf(root: string) {
  return loadRulesSync({
    schemaVersion: 1,
    updatedAt: '',
    rules: [
      {
        id: 'GC-TEST',
        name: '测试',
        description: '',
        risk: 'low',
        defaultSelected: false,
        match: { roots: [root], patterns: ['*.tmp'], maxDepth: 3 }
      }
    ]
  }).rules[0]
}

async function makeTree(): Promise<string> {
  const base = join(tmpdir(), 'sg-inc-' + randomBytes(4).toString('hex'))
  await fs.mkdir(join(base, 'sub'), { recursive: true })
  await fs.writeFile(join(base, 'a.tmp'), 'x'.repeat(100))
  await fs.writeFile(join(base, 'b.log'), 'y')
  await fs.writeFile(join(base, 'sub', 'c.tmp'), 'z'.repeat(300))
  return base
}

describe('增量扫描缓存（M2/A5）', () => {
  it('签名采集：目录集合与条目数正确', async () => {
    const base = await makeTree()
    try {
      const sig = await collectSignatures(ruleOf(base))
      assert.equal(sig.dirCount, 2, '根 + sub 两层')
      assert.ok(Object.keys(sig.dirs).length === 2)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('新增文件 → 签名变化；仅写内容 → 签名不变（目录 mtime 语义）', async () => {
    const base = await makeTree()
    try {
      const rule = ruleOf(base)
      const s1 = await collectSignatures(rule)
      // 修改已有文件内容：目录 mtime 与条目数都不变
      await fs.writeFile(join(base, 'a.tmp'), 'x'.repeat(900))
      const s2 = await collectSignatures(rule)
      assert.equal(signaturesEqual(s1, s2), true, '仅内容变化不应使签名失效')

      // 新增文件：条目数变化 + 目录 mtime 更新
      await fs.writeFile(join(base, 'd.tmp'), 'n')
      const s3 = await collectSignatures(rule)
      assert.equal(signaturesEqual(s2, s3), false, '新增文件必须使签名失效')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('refreshItems：刷新体积并剔除已删除的文件', async () => {
    const base = await makeTree()
    try {
      const items = [
        {
          id: 'j1',
          categoryId: 'GC-TEST',
          fullPath: join(base, 'a.tmp'),
          name: 'a.tmp',
          sizeBytes: 1,
          mtime: 0,
          risk: 'low' as const
        },
        {
          id: 'j2',
          categoryId: 'GC-TEST',
          fullPath: join(base, 'ghost.tmp'),
          name: 'ghost.tmp',
          sizeBytes: 5,
          mtime: 0,
          risk: 'low' as const
        }
      ]
      const out = await refreshItems(items)
      assert.equal(out.length, 1, '已不存在的文件应被剔除')
      assert.equal(out[0].sizeBytes, 100, '体积应刷新为实际值')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('端到端：第二次扫描复用缓存，新增文件后缓存失效并命中新文件', async () => {
    const base = await makeTree()
    try {
      const ruleSet = loadRulesSync({
        schemaVersion: 1,
        updatedAt: '',
        rules: [
          {
            id: 'GC-TEST',
            name: '测试',
            description: '',
            risk: 'low',
            defaultSelected: false,
            match: { roots: [base], patterns: ['*.tmp'], maxDepth: 3 }
          }
        ]
      })
      const ctx = { knownNames: new Set<string>(), knownPublishers: new Set<string>(), knownDirs: new Set<string>(), excludes: [] }

      const r1 = await scanJunk(ruleSet, ctx, {})
      assert.deepEqual(
        r1.items.map((i) => i.fullPath).sort(),
        [join(base, 'a.tmp'), join(base, 'sub', 'c.tmp')].sort()
      )
      assert.deepEqual(r1.reusedRules, [], '首次扫描不应有复用')

      // 第二次：无变化 → 复用
      const r2 = await scanJunk(ruleSet, ctx, { cache: r1.cache })
      assert.deepEqual(r2.reusedRules, ['GC-TEST'], '第二次应复用缓存')
      assert.equal(r2.summary.categories[0].cached, true)
      assert.equal(
        r2.items.find((i) => i.fullPath.endsWith('a.tmp'))?.sizeBytes,
        100,
        '复用的条目体积应与首次一致'
      )

      // 新增文件 → 缓存失效，新文件必须被扫出来
      await fs.writeFile(join(base, 'new.tmp'), 'm'.repeat(50))
      const r3 = await scanJunk(ruleSet, ctx, { cache: r2.cache })
      assert.deepEqual(r3.reusedRules, [], '变更后不应复用')
      assert.ok(r3.items.some((i) => i.fullPath.endsWith('new.tmp')), '新文件必须出现在结果中')

      // 删除文件 → 后续扫描不应再包含它
      await fs.unlink(join(base, 'a.tmp'))
      const r4 = await scanJunk(ruleSet, ctx, { cache: r3.cache })
      assert.ok(!r4.items.some((i) => i.fullPath.endsWith('a.tmp')), '已删除的文件不应再出现')
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('熔断：连续 2 次签名不匹配后不再尝试签名比对（避免白付遍历）', async () => {
    const base = await makeTree()
    try {
      const ruleSet = loadRulesSync({
        schemaVersion: 1,
        updatedAt: '',
        rules: [
          {
            id: 'GC-TEST',
            name: '测试',
            description: '',
            risk: 'low',
            defaultSelected: false,
            match: { roots: [base], patterns: ['*.tmp'], maxDepth: 3 }
          }
        ]
      })
      const ctx = { knownNames: new Set<string>(), knownPublishers: new Set<string>(), knownDirs: new Set<string>(), excludes: [] }

      const r1 = await scanJunk(ruleSet, ctx, {})
      assert.equal(r1.cache.rules['GC-TEST'].missStreak ?? 0, 0, '首次扫描未命中计数应为 0')
      assert.ok(!r1.cache.rules['GC-TEST'].disabled, '首次扫描不应熔断')

      // 第 2 次：目录变化 → 未命中 1 次
      await fs.writeFile(join(base, 'x1.tmp'), 'a')
      const r2 = await scanJunk(ruleSet, ctx, { cache: r1.cache })
      assert.equal(r2.cache.rules['GC-TEST'].missStreak, 1, '未命中应累计为 1')
      assert.ok(!r2.cache.rules['GC-TEST'].disabled, '1 次未命中不应熔断')

      // 第 3 次：再次变化 → 累计 2 次 → 熔断
      await fs.writeFile(join(base, 'x2.tmp'), 'b')
      const r3 = await scanJunk(ruleSet, ctx, { cache: r2.cache })
      assert.equal(r3.cache.rules['GC-TEST'].missStreak, 2)
      assert.equal(r3.cache.rules['GC-TEST'].disabled, true, '连续 2 次未命中应熔断')

      // 第 4 次：熔断生效 → 不再采签名（仍全量扫），结果依然正确
      await fs.writeFile(join(base, 'x3.tmp'), 'c')
      const r4 = await scanJunk(ruleSet, ctx, { cache: r3.cache })
      assert.ok(r4.items.some((i) => i.fullPath.endsWith('x3.tmp')), '熔断后仍必须扫出新文件')
      assert.equal(r4.cache.rules['GC-TEST'].disabled, true, '熔断状态应延续')

      // 强制重扫 → 重置熔断
      const r5 = await scanJunk(ruleSet, ctx, { cache: r4.cache, force: true })
      assert.equal(r5.cache.rules['GC-TEST'].disabled, false, '强制重扫应重置熔断')
      assert.equal(r5.cache.rules['GC-TEST'].missStreak, 0)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it('缓存文件可持久化与回读；TTL 过期后不可用', async () => {
    const file = join(tmpdir(), `sg-cache-${randomBytes(4).toString('hex')}.json`)
    const c = emptyCache()
    c.updatedAt = Date.now()
    await saveCache(file, c)
    const back = await loadCache(file)
    assert.equal(back.version, c.version)
    assert.equal(isCacheUsable(back), true)

    const stale = { ...back, updatedAt: Date.now() - CACHE_TTL_MS - 1000 }
    assert.equal(isCacheUsable(stale), false, '超过 TTL 的缓存不可用')
    await fs.rm(file, { force: true }).catch(() => {})
  })
})
