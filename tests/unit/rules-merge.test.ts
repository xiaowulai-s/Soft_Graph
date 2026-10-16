/**
 * ensureRules 升级合并（GC-14/15 场景）：老规则文件遮蔽内置新规则的问题
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRules, type AppPaths } from '../../apps/desktop/src/main/services/env'

function fakePaths(root: string): AppPaths {
  return {
    root,
    rulesFile: join(root, 'rules', 'junk-rules.json'),
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

describe('ensureRules 升级合并', () => {
  it('全新安装：直接落盘内置规则', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sg-rules-'))
    try {
      const f = await ensureRules(fakePaths(root), builtin15())
      assert.ok(f)
      assert.deepEqual(await readIds(f), ['GC-01', 'GC-14', 'GC-15'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('老版本文件（13 类遮蔽）：只追加缺失的 GC-14/15，保留用户自定义', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sg-rules-'))
    try {
      const p = fakePaths(root)
      const oldRules = {
        schemaVersion: 1,
        updatedAt: '2026-09-11',
        rules: [
          // 用户自定义过的 GC-01（改了名字，模拟用户编辑）
          { id: 'GC-01', name: '我的临时文件（自定义）', description: 'x', risk: 'low', defaultSelected: true, match: { roots: ['%TEMP%'], patterns: ['*'] } },
          { id: 'GC-02', name: '回收站', description: 'x', risk: 'low', defaultSelected: true, match: { roots: ['%SG_DRIVES%\\$Recycle.Bin'], patterns: ['*'] } }
        ]
      }
      await mkdir(join(root, 'rules'), { recursive: true })
      await writeFile(p.rulesFile, JSON.stringify(oldRules, null, 2), 'utf8')

      await ensureRules(p, builtin15())
      const ids = await readIds(p.rulesFile)
      assert.equal(ids.length, 4, `应为 2 旧 + 2 新 = 4，实际 ${ids.length}`)
      assert.ok(ids.includes('GC-14') && ids.includes('GC-15'), '应追加缺失规则')

      // 用户自定义内容原样保留
      const j = JSON.parse(await readFile(p.rulesFile, 'utf8')) as { rules: { id: string; name: string }[] }
      const g1 = j.rules.find((r) => r.id === 'GC-01')
      assert.equal(g1?.name, '我的临时文件（自定义）', '用户自定义不得被覆盖')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('幂等：重复调用不再追加', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sg-rules-'))
    try {
      const p = fakePaths(root)
      await ensureRules(p, builtin15())
      const after1 = await readIds(p.rulesFile)
      await ensureRules(p, builtin15())
      const after2 = await readIds(p.rulesFile)
      assert.deepEqual(after1, after2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('本地文件损坏：不合并也不崩溃（返回原路径）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sg-rules-'))
    try {
      const p = fakePaths(root)
      await mkdir(join(root, 'rules'), { recursive: true })
      await writeFile(p.rulesFile, '{ 残缺 JSON', 'utf8')
      const f = await ensureRules(p, builtin15())
      assert.ok(f)
      // 残缺文件保持原样（交由在线更新兜底）
      const raw = await readFile(p.rulesFile, 'utf8')
      assert.match(raw, /残缺/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
