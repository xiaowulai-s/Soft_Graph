/**
 * 通用工具与路径判定测试
 * 覆盖 glob 匹配（垃圾规则引擎的核心）、路径归一、文件类型归类、共享运行库识别、格式化。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  globToRegExp,
  matchAny,
  formatBytes,
  formatDuration,
  extName,
  baseName,
  dirName,
  classifyKind,
  isSharedRuntime,
  initialsOf,
  nameToHsl,
  clamp,
  hash32
} from '@shared/util'

describe('globToRegExp / matchAny', () => {
  it('* 不跨目录分隔符', () => {
    const re = globToRegExp('*.log')
    assert.equal(re.test('a.log'), true)
    assert.equal(re.test('dir\\a.log'), false)
  })

  it('** 跨目录', () => {
    const re = globToRegExp('**\\*.dmp')
    assert.equal(re.test('a\\b\\c\\x.dmp'), true)
    assert.equal(re.test('x.dmp'), true)
  })

  it('? 匹配单个非分隔符字符', () => {
    const re = globToRegExp('a?c.txt')
    assert.equal(re.test('abc.txt'), true)
    assert.equal(re.test('ac.txt'), false)
  })

  it('{a,b} 多选', () => {
    const re = globToRegExp('*.{log,dmp,tmp}')
    assert.equal(re.test('x.log'), true)
    assert.equal(re.test('x.dmp'), true)
    assert.equal(re.test('x.exe'), false)
  })

  it('正则元字符被转义（不会把 . 当通配）', () => {
    const re = globToRegExp('a.txt')
    assert.equal(re.test('a.txt'), true)
    assert.equal(re.test('aXtxt'), false)
  })

  it('匹配大小写不敏感（Windows 语义）', () => {
    assert.equal(globToRegExp('*.LOG').test('A.log'), true)
  })

  it('matchAny 空模式列表视为全匹配', () => {
    assert.equal(matchAny('anything', []), true)
    assert.equal(matchAny('anything', undefined), true)
  })

  it('matchAny 命中任一即通过', () => {
    const pats = [globToRegExp('*.log'), globToRegExp('*.dmp')]
    assert.equal(matchAny('x.dmp', pats), true)
    assert.equal(matchAny('x.exe', pats), false)
  })

  it('垃圾规则里的真实用例', () => {
    const exclude = globToRegExp('**\\index-dir\\*')
    assert.equal(exclude.test('C:\\x\\Cache\\index-dir\\f_000001'), true)
    const thumb = globToRegExp('thumbcache_*.db')
    assert.equal(thumb.test('thumbcache_1280.db'), true)
    assert.equal(thumb.test('iconcache_16.db'), false)
  })
})

describe('路径工具', () => {
  it('extName', () => {
    assert.equal(extName('C:\\a\\b.DLL'), 'dll')
    assert.equal(extName('C:\\a\\noext'), '')
    assert.equal(extName('C:\\a\\.gitignore'), '')
  })
  it('baseName / dirName', () => {
    assert.equal(baseName('C:\\a\\b\\c.exe'), 'c.exe')
    assert.equal(dirName('C:\\a\\b\\c.exe'), 'C:\\a\\b')
  })
})

describe('classifyKind —— 决定图谱节点配色', () => {
  const cases: [string, string][] = [
    ['a.exe', 'exe'],
    ['a.dll', 'dll'],
    ['a.sys', 'dll'],
    ['a.ocx', 'ocx'],
    ['a.ini', 'config'],
    ['a.json', 'config'],
    ['a.png', 'resource'],
    ['a.ttf', 'resource'],
    ['a.node', 'plugin'],
    ['a.pyd', 'plugin'],
    ['a.dat', 'data']
  ]
  for (const [file, kind] of cases) {
    it(`${file} → ${kind}`, () => assert.equal(classifyKind(`C:\\x\\${file}`), kind))
  }
})

describe('isSharedRuntime —— 决定是否单独成组', () => {
  const shared = [
    'msvcp140.dll',
    'vcruntime140_1.dll',
    'ucrtbase.dll',
    'api-ms-win-crt-runtime-l1-1-0.dll',
    'mscoree.dll',
    'coreclr.dll',
    'Qt5Core.dll',
    'icudt72.dll',
    'libstdc++-6.dll',
    'd3dcompiler_47.dll',
    'python313.dll'
  ]
  for (const n of shared) {
    it(`识别为共享运行库：${n}`, () => assert.equal(isSharedRuntime(n), true))
  }

  const specific = ['myapp.dll', 'chrome_100_percent.pak', 'libdisp.dll', 'ug.dll', 'a.dat']
  for (const n of specific) {
    it(`不误判为共享运行库：${n}`, () => assert.equal(isSharedRuntime(n), false))
  }
})

describe('格式化', () => {
  it('formatBytes', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(1024), '1.00 KB')
    assert.equal(formatBytes(1536, 1), '1.5 KB')
    assert.equal(formatBytes(1024 ** 3), '1.00 GB')
    assert.equal(formatBytes(-1), '—')
    assert.equal(formatBytes(Number.NaN), '—')
  })

  it('formatDuration', () => {
    assert.equal(formatDuration(500), '500ms')
    assert.equal(formatDuration(1500), '1.5s')
    assert.equal(formatDuration(65_000), '1m5s')
  })
})

describe('图标兜底与稳定性', () => {
  it('initialsOf 取中文首字', () => {
    assert.equal(initialsOf('微信'), '微')
  })
  it('initialsOf 取英文词首字母', () => {
    assert.equal(initialsOf('Google Chrome'), 'GC')
    assert.equal(initialsOf('notepad'), 'NO')
  })
  it('initialsOf 空值兜底', () => {
    assert.equal(initialsOf('   '), '?')
    assert.equal(initialsOf(''), '?')
  })
  it('nameToHsl 对同一名称稳定，不同名称分散', () => {
    assert.equal(nameToHsl('Chrome'), nameToHsl('Chrome'))
    const hues = new Set([...Array(40).keys()].map((i) => nameToHsl('app' + i)))
    assert.ok(hues.size > 20, '色相分布过于集中')
  })
  it('hash32 稳定且非负', () => {
    assert.equal(hash32('abc'), hash32('abc'))
    assert.ok(hash32('abc') >= 0)
  })
})

describe('clamp', () => {
  it('边界', () => {
    assert.equal(clamp(5, 0, 10), 5)
    assert.equal(clamp(-1, 0, 10), 0)
    assert.equal(clamp(99, 0, 10), 10)
  })
})
