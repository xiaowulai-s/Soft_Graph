/**
 * v3.1 新功能单元测试：定时清理调度 / winget 解析 / Winapp2 导入
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isScheduleDue, parseWingetUpgradeOutput } from '../../packages/shared/schedule'
import { parseWinapp2, convertSections } from '../../packages/shared/winapp2'
import { loadRulesSync } from '@junk/engine'
import { guardPath, isScannable } from '@shared/safety'

describe('定时清理调度判定', () => {
  const NOW = 1_800_000_000_000
  it('未启用 → 不执行', () => {
    assert.equal(isScheduleDue({ enabled: false, intervalHours: 24 }, 0, NOW).due, false)
  })
  it('从未运行 → 执行', () => {
    assert.equal(isScheduleDue({ enabled: true, intervalHours: 24 }, 0, NOW).due, true)
  })
  it('间隔内 → 不执行；到期 → 执行', () => {
    const s = { enabled: true, intervalHours: 24 }
    const last = NOW - 23 * 3600_000
    assert.equal(isScheduleDue(s, last, NOW).due, false)
    assert.equal(isScheduleDue(s, NOW - 25 * 3600_000, NOW).due, true)
  })
  it('间隔非法（0/负数）→ 不执行', () => {
    assert.equal(isScheduleDue({ enabled: true, intervalHours: 0 }, 0, NOW).due, false)
  })
})

describe('winget upgrade 输出解析', () => {
  it('解析中英文表头数据行，跳过表头与分隔线', () => {
    const sample = [
      '名称                          ID                  版本       可用       源',
      '-----------------------------------------------------------------------',
      'Mozilla Firefox               Mozilla.Firefox     134.0      135.0      winget',
      'Visual Studio Code            Microsoft.VisualStudioCode  1.96.0  1.97.0  winget',
      '  2 升级可用。',
      ''
    ].join('\n')
    const r = parseWingetUpgradeOutput(sample)
    assert.equal(r.length, 2)
    assert.equal(r[0].id, 'Mozilla.Firefox')
    assert.equal(r[0].available, '135.0')
  })
  it('已安装版本 == 可用版本 → 跳过', () => {
    const r = parseWingetUpgradeOutput('Foo  Foo.Bar  1.0  1.0  winget')
    assert.equal(r.length, 0)
  })
})

describe('Winapp2.ini 解析与转换', () => {
  const sample = `
; comment
[Trae Cache]
FileKey1=%LocalAppData%\\Trae\\Cache|*.*|RECURSE
FileKey2=%LocalAppData%\\Trae\\Code Cache|*.js;*.css
ExcludeKey1=FILE|%LocalAppData%\\Trae\\Cache\\|keep.dat

[Empty Section]
RegKey1=Software\\Foo
`
  it('解析：跳过无 FileKey 的节、正确读取 RECURSE 与 exclude', () => {
    const secs = parseWinapp2(sample)
    assert.equal(secs.length, 1)
    assert.equal(secs[0].name, 'Trae Cache')
    assert.equal(secs[0].fileKeys.length, 2)
    assert.equal(secs[0].fileKeys[0].recurse, true)
    assert.equal(secs[0].fileKeys[1].recurse, false)
    assert.deepEqual(secs[0].excludes, ['keep.dat'])
  })
  it('转换：id 顺延、裸 * 改写 *.*、exclude 透传、RECURSE 决定 maxDepth', () => {
    const rules = convertSections(parseWinapp2(sample), 101)
    assert.equal(rules.length, 1)
    const r = rules[0]
    assert.equal(r.id, 'GC-101')
    assert.equal(r.defaultSelected, false)
    assert.equal(r.risk, 'medium')
    assert.ok(r.match.patterns.includes('*.*'), '裸 * 应改写为 *.*')
    assert.equal(r.match.maxDepth, 6)
    assert.ok(r.match.exclude?.includes('keep.dat'))
  })
  it('导入的规则能被引擎编译且通过安全层', () => {
    const rules = convertSections(parseWinapp2(sample), 101)
    const rs = loadRulesSync({ schemaVersion: 1, updatedAt: '', rules } as never)
    assert.equal(rs.rules.length, 1)
    const compiled = rs.rules[0]
    assert.ok(compiled.roots.length > 0)
    for (const root of compiled.roots) {
      const probe = root + '\\probe.tmp'
      assert.ok(guardPath(probe).allowed, `子项被拦: ${probe}`)
      assert.ok(isScannable(probe))
    }
  })
})

describe('v3.2 改进项', () => {
  it('B1 浏览器运行时跳过 GC-17（纯函数）', async () => {
    const { pickBrowserBlockedItems } = await import('../../packages/shared/clean-guard')
    const items = [
      { id: 'a', categoryId: 'GC-17' },
      { id: 'b', categoryId: 'GC-17' },
      { id: 'c', categoryId: 'GC-01' }
    ]
    assert.deepEqual(pickBrowserBlockedItems(items, []).map((x) => x.id), [])
    const blocked = pickBrowserBlockedItems(items, ['chrome.exe'])
    assert.deepEqual(blocked.map((x) => x.id), ['a', 'b'])
    assert.ok(blocked[0].reason.includes('浏览器正在运行'))
  })

  it('A2 语义哈希：换行/键序不敏感，内容变则哈希变', async () => {
    const { semHash } = await import('../../packages/junk/rules-update')
    const a = '{"a":1,"b":2}'
    const a2 = '{\r\n  "b": 2,\r\n  "a": 1\r\n}\r\n'
    assert.equal(semHash(a), semHash(a2), '键序与换行不应影响语义哈希')
    assert.notEqual(semHash(a), semHash('{"a":1,"b":3}'))
  })

  it('B2 引擎编译含用户目录注入（GC-11 扩根后仍安全）', async () => {
    const { loadRulesSync } = await import('@junk/engine')
    const rule = {
      id: 'GC-11', name: '重复文件', description: '', risk: 'medium', defaultSelected: true,
      algorithm: 'duplicate',
      match: { roots: ['%SG_DOWNLOADS%', 'D://Custom//Photos'], patterns: ['*'], maxDepth: 8 }
    }
    const rs = loadRulesSync({ schemaVersion: 1, updatedAt: '', rules: [rule] } as never)
    assert.equal(rs.rules.length, 1)
  })
})

describe('v3.3 空目录检测', () => {
  it('GC-18：命中整树为空的目录，跳过含文件的目录', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'sg-empty-'))
    // empty/with-sub/empty-sub 全空；full/sub 含文件
    await mkdir(join(dir, 'empty', 'with-sub', 'empty-sub'), { recursive: true })
    await mkdir(join(dir, 'full', 'sub'), { recursive: true })
    await writeFile(join(dir, 'full', 'sub', 'f.txt'), 'x')
    const rule = {
      id: 'GC-18', name: '空目录', description: '', risk: 'hint', defaultSelected: false,
      algorithm: 'emptydir',
      match: { roots: [dir], patterns: ['*'], maxDepth: 8 }
    }
    const { scanJunk } = await import('@junk/scanner')
    const rs = loadRulesSync({ schemaVersion: 1, updatedAt: '', rules: [rule] } as never)
    const out = await scanJunk(rs, {
      knownNames: new Set(), knownPublishers: new Set(), knownDirs: new Set(), excludes: []
    }, { categoryIds: ['GC-18'], force: true })
    const paths = out.items.map((i) => i.fullPath.toLowerCase())
    // 只报告「最浅层空树根」：整树删除一次带走，不重复报告树内深层空目录
    assert.equal(paths.length, 1, `应只命中最浅层空树根，实际: ${paths.join(', ')}`)
    assert.ok(paths[0].endsWith('empty'), '应命中空树根 empty')
    assert.ok(!paths.some((x) => x.includes('full')), '含文件的目录不应命中')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('v3.7 空闲窗口', () => {
  it('idleOnly 时空闲 <15 分钟不执行，≥15 分钟执行；关闭开关则忽略', async () => {
    const { isIdleEnough, IDLE_THRESHOLD_SEC } = await import('../../packages/shared/schedule')
    assert.equal(IDLE_THRESHOLD_SEC, 900)
    assert.equal(isIdleEnough(600, true), false)
    assert.equal(isIdleEnough(900, true), true)
    assert.equal(isIdleEnough(10, false), true)
  })
})

describe('v3.7 空闲窗口', () => {
  it('idleOnly 时空闲 <15 分钟不执行，≥15 分钟执行；关闭开关则忽略', async () => {
    const { isIdleEnough, IDLE_THRESHOLD_SEC } = await import('../../packages/shared/schedule')
    assert.equal(IDLE_THRESHOLD_SEC, 900)
    assert.equal(isIdleEnough(600, true), false)
    assert.equal(isIdleEnough(900, true), true)
    assert.equal(isIdleEnough(10, false), true)
  })
})
