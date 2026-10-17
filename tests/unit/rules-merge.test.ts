/**
 * ensureRules 升级合并（GC-14/15 场景）：老规则文件遮蔽内置新规则的问题
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRules, type AppPaths } from '../../apps/desktop/src/main/services/env'

function fakePaths(root: string): AppPaths {
  return {
    root,
    rulesFile: join(root, 'rules', 'junk-rules.json'),
    communityRulesFile: join(root, 'rules', 'community-rules.json'),
    userRulesFile: join(root, 'rules', 'user-rules.json'),
    settingsFile: join(root, 'settings.json'),
    dbFile: join(root, 'monitor.db'),
    quarantineDir: join(root, 'Quarantine'),
    pluginDir: join(root, 'plugins'),
    iconsDir: join(root, 'icons'),
    cacheDir: join(root, 'cache'),
    logsDir: join(root, 'logs'),
    apiSetCacheFile: join(root, 'cache', 'apiset-map.json')
  } as unknown as AppPaths
}

function builtin15(): unknown {
  return {
    schemaVersion: 1,
    updatedAt: '2026-10-16',
    rules: [
      { id: 'GC-01', name: '系统临时文件', description: 'x', risk: 'low', defaultSelected: true, match: { roots: ['%TEMP%'], patterns: ['*'] } },
      { id: 'GC-14', name: 'AI 工具缓存', description: 'x', risk: 'medium', defaultSelected: false, match: { roots: ['%USERPROFILE%\\.cache\\huggingface\\hub'], patterns: ['*'] } },
      { id: 'GC-15', name: 'AI 模型库盘点', description: 'x', risk: 'hint', defaultSelected: false, algorithm: 'bigfile', match: { roots: ['%USERPROFILE%\\.ollama\\models'], patterns: ['*'] } }
    ]
  }
}

async function readIds(file: string): Promise<string[]> {
  const j = JSON.parse(await readFile(file, 'utf8')) as { rules: { id: string }[] }
  return j.rules.map((r) => r.id)
}

describe('ensureRules 分区模型（v3.2 A1）', () => {
  it('首次运行：内置不落盘，创建社区区/用户区骨架', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-merge-'))
    const paths = fakePaths(dir)
    const out = await ensureRules(paths, builtin15())
    assert.equal(out, paths.communityRulesFile)
    const community = JSON.parse(await readFile(paths.communityRulesFile, 'utf8')) as { rules: unknown[] }
    assert.equal(community.rules.length, 0)
    await rm(dir, { recursive: true, force: true })
  })

  it('旧合并文件迁移：[社区] 规则迁入社区区，旧文件改名 .legacy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-merge-'))
    const paths = fakePaths(dir)
    await mkdir(join(paths.root, 'rules'), { recursive: true })
    const legacy = {
      schemaVersion: 1,
      rules: [
        { id: 'GC-01', name: '回收站' },
        { id: 'GC-101', name: '[社区] Trae Cache' },
        { id: 'GC-102', name: '[社区] Foo Bar' }
      ]
    }
    await writeFile(paths.rulesFile, JSON.stringify(legacy), 'utf8')
    await ensureRules(paths, builtin15())
    const community = JSON.parse(await readFile(paths.communityRulesFile, 'utf8')) as { rules: { name?: string }[] }
    assert.equal(community.rules.length, 2)
    assert.ok(community.rules.every((r) => r.name?.startsWith('[社区]')))
    await rm(dir, { recursive: true, force: true })
  })

  it('幂等：重复调用不重复迁移', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-merge-'))
    const paths = fakePaths(dir)
    await mkdir(join(paths.root, 'rules'), { recursive: true })
    const legacy = { schemaVersion: 1, rules: [{ id: 'GC-101', name: '[社区] Trae Cache' }] }
    await writeFile(paths.rulesFile, JSON.stringify(legacy), 'utf8')
    await ensureRules(paths, builtin15())
    const before = await readFile(paths.communityRulesFile, 'utf8')
    await ensureRules(paths, builtin15())
    const after = await readFile(paths.communityRulesFile, 'utf8')
    assert.equal(before, after)
    await rm(dir, { recursive: true, force: true })
  })

  it('旧文件损坏：迁移失败不崩溃，骨架照常创建', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-merge-'))
    const paths = fakePaths(dir)
    await mkdir(join(paths.root, 'rules'), { recursive: true })
    await writeFile(paths.rulesFile, '{{{ broken', 'utf8')
    await ensureRules(paths, builtin15())
    assert.ok(existsSync(paths.communityRulesFile))
    await rm(dir, { recursive: true, force: true })
  })
})
