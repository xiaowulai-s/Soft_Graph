/**
 * 便携目录扫描缓存（v3.0.0 · A3）
 *
 * 这一层是「纯优化」——冷路径本来就达标。所以用例的重点**不是收益，而是正确性**：
 * 四条失效判据（目录 mtime / 条目数 / 主 exe 路径与 mtime / manual 标记）
 * 必须逐条生效，任何一条漏掉都会让用户看到「改了东西但扫描结果没变」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PORTABLE_CACHE_TTL_MS,
  PORTABLE_CACHE_VERSION,
  emptyPortableCache,
  installedFingerprintOf,
  isPortableCacheUsable,
  loadPortableCache,
  portableEntryMatches,
  probePortableDir,
  prunePortableCache,
  rememberPortableEntry,
  savePortableCache,
  type PortableCacheFile,
  type PortableDirEntry,
  type PortableDirProbe
} from '@scanner/portable-cache'
import type { PortableCandidate } from '@scanner/software'

const cand: PortableCandidate = {
  dir: 'D:\\Tools\\App',
  mainExe: 'D:\\Tools\\App\\app.exe',
  score: 75,
  evidence: ['自包含', '无卸载项'],
  name: 'App',
  version: '1.0.0',
  publisher: 'Vendor',
  sizeBytes: 1234
}

const probe = (over: Partial<PortableDirProbe> = {}): PortableDirProbe => ({
  dirMtime: 1000,
  entryCount: 5,
  mainExe: 'd:\\tools\\app\\app.exe',
  mainExeMtime: 2000,
  manual: false,
  ...over
})

/** 造一个「恰好与 probe() 匹配」的条目 */
function entry(over: Partial<PortableDirEntry> = {}): PortableDirEntry {
  return {
    dirMtime: 1000,
    entryCount: 5,
    mainExe: 'd:\\tools\\app\\app.exe',
    mainExeMtime: 2000,
    manual: false,
    at: Date.now(),
    cand,
    ...over
  }
}

describe('便携缓存 · 已安装集合指纹', () => {
  it('集合内容相同则指纹相同（与顺序无关）', () => {
    const a = installedFingerprintOf(['C:\\A', 'C:\\B'])
    const b = installedFingerprintOf(['C:\\B', 'C:\\A'])
    assert.equal(a, b)
  })

  it('大小写与斜杠差异归一（同一目录不因写法不同误判为变化）', () => {
    assert.equal(installedFingerprintOf(['C:\\Program Files\\A']), installedFingerprintOf(['c:/program files/a']))
  })

  it('多一个/少一个软件即指纹不同（这条决定缓存是否整体作废）', () => {
    const a = installedFingerprintOf(['C:\\A', 'C:\\B'])
    const b = installedFingerprintOf(['C:\\A'])
    assert.notEqual(a, b)
  })

  it('空集合也能得到稳定指纹', () => {
    assert.equal(installedFingerprintOf([]), installedFingerprintOf([]))
    assert.equal(installedFingerprintOf([]).length, 16)
  })
})

describe('便携缓存 · 整体可用性', () => {
  const fp = 'abc123'
  const fresh = (): PortableCacheFile => ({
    version: PORTABLE_CACHE_VERSION,
    updatedAt: Date.now(),
    installedFingerprint: fp,
    dirs: {}
  })

  it('版本一致 + 指纹一致 + 未过期 → 可用', () => {
    assert.equal(isPortableCacheUsable(fresh(), fp), true)
  })

  it('版本不符 → 不可用（结构可能已变）', () => {
    assert.equal(isPortableCacheUsable({ ...fresh(), version: 99 }, fp), false)
  })

  it('指纹不符 → 整体作废（装/卸软件会翻转「无卸载项」判定）', () => {
    assert.equal(isPortableCacheUsable(fresh(), 'other'), false)
  })

  it('从未写入过（updatedAt=0）→ 不可用', () => {
    assert.equal(isPortableCacheUsable({ ...fresh(), updatedAt: 0 }, fp), false)
  })

  it('超过 TTL → 不可用', () => {
    const c = fresh()
    assert.equal(isPortableCacheUsable(c, fp, Date.now() + PORTABLE_CACHE_TTL_MS + 1), false)
  })

  it('null / undefined → 不可用', () => {
    assert.equal(isPortableCacheUsable(null, fp), false)
  })
})

describe('便携缓存 · 单条目失效判据（四条缺一不可）', () => {
  it('完全一致 → 命中', () => {
    assert.equal(portableEntryMatches(entry(), probe()), true)
  })

  it('目录 mtime 变 → 不命中', () => {
    assert.equal(portableEntryMatches(entry(), probe({ dirMtime: 1001 })), false)
  })

  it('条目数变 → 不命中（mtime 精度不足时的第二道闸）', () => {
    assert.equal(portableEntryMatches(entry(), probe({ entryCount: 6 })), false)
  })

  it('主 exe 被原地覆写（目录 mtime 不变、exe mtime 变）→ 不命中', () => {
    // 这是 A5 踩过的同一个坑：改写文件内容不会更新目录 mtime
    assert.equal(portableEntryMatches(entry(), probe({ mainExeMtime: 2001 })), false)
  })

  it('主 exe 换成了别的文件 → 不命中', () => {
    assert.equal(portableEntryMatches(entry(), probe({ mainExe: 'd:\\tools\\app\\other.exe' })), false)
  })

  it('上次的主 exe 已不在目录里（probe 给空）→ 不命中', () => {
    assert.equal(portableEntryMatches(entry(), probe({ mainExe: '', mainExeMtime: 0 })), false)
  })

  it('manual 标记与缓存时不一致 → 不命中（+100 分是权重最大的特征）', () => {
    assert.equal(portableEntryMatches(entry({ manual: false }), probe({ manual: true })), false)
    assert.equal(portableEntryMatches(entry({ manual: true }), probe({ manual: false })), false)
    // 两边都为 true 时仍然命中
    assert.equal(portableEntryMatches(entry({ manual: true }), probe({ manual: true })), true)
  })

  it('TTL 过期 → 不命中', () => {
    const e = entry({ at: Date.now() - PORTABLE_CACHE_TTL_MS - 1 })
    assert.equal(portableEntryMatches(e, probe()), false)
  })

  it('条目缺失 / 脏数据 → 不命中（不抛异常）', () => {
    assert.equal(portableEntryMatches(undefined, probe()), false)
    assert.equal(portableEntryMatches({} as PortableDirEntry, probe()), false)
    assert.equal(portableEntryMatches(entry({ mainExe: '' }), probe()), false)
  })
})

describe('便携缓存 · 写入与往返', () => {
  it('remember 之后能立刻命中（写入口径与判定口径一致）', () => {
    const c = emptyPortableCache('fp')
    rememberPortableEntry(c, 'D:\\Tools\\App', probe(), cand)
    const e = c.dirs['d:\\tools\\app']
    assert.ok(e, 'key 应是 normKey(dir)')
    assert.equal(portableEntryMatches(e, probe()), true)
    assert.equal(e.cand.name, 'App')
  })

  it('手动标记状态被记录（保证下次能发现不一致）', () => {
    const c = emptyPortableCache('fp')
    rememberPortableEntry(c, 'D:\\Tools\\App', probe({ manual: true }), cand)
    assert.equal(c.dirs['d:\\tools\\app'].manual, true)
  })

  it('prune 清掉过期条目，保留新鲜条目', () => {
    const c = emptyPortableCache('fp')
    rememberPortableEntry(c, 'D:\\Old', probe(), cand, Date.now() - PORTABLE_CACHE_TTL_MS - 1)
    rememberPortableEntry(c, 'D:\\New', probe(), cand)
    const removed = prunePortableCache(c)
    assert.equal(removed, 1)
    assert.equal(c.dirs['d:\\old'], undefined)
    assert.ok(c.dirs['d:\\new'])
  })

  it('load / save 往返：文件损坏或指纹不符时退化为空缓存（不抛）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-portcache-'))
    try {
      const file = join(dir, 'portable-scan.json')
      const c = emptyPortableCache('fpA')
      rememberPortableEntry(c, 'D:\\Tools\\App', probe(), cand)
      await savePortableCache(file, c)
      assert.ok(c.updatedAt > 0, 'save 应刷新 updatedAt')

      const back = await loadPortableCache(file, 'fpA')
      assert.ok(back.dirs['d:\\tools\\app'], '同指纹应读回条目')
      assert.equal(isPortableCacheUsable(back, 'fpA'), true)

      // 指纹变化 → 条目被清空（整体作废）
      const invalidated = await loadPortableCache(file, 'fpB')
      assert.deepEqual(invalidated.dirs, {})
      assert.equal(invalidated.installedFingerprint, 'fpB')

      // 文件损坏 → 空缓存
      await writeFile(file, '{ 这不是 JSON', 'utf8')
      const broken = await loadPortableCache(file, 'fpA')
      assert.deepEqual(broken.dirs, {})

      // 文件不存在 → 空缓存
      const missing = await loadPortableCache(join(dir, 'nope.json'), 'fpA')
      assert.deepEqual(missing.dirs, {})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('便携缓存 · 目录观测量采集', () => {
  it('目录不存在时返回 null（调用方据此作废条目）', async () => {
    const p = await probePortableDir(join(tmpdir(), 'sg-portcache-missing-9f2e'), 'D:\\nope\\a.exe')
    assert.equal(p, null)
  })

  it('真实目录：条目数与 mtime 被采到，主 exe 仍在时给出其 mtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-portprobe-'))
    try {
      await writeFile(join(dir, 'app.exe'), 'x')
      await writeFile(join(dir, 'readme.txt'), 'y')
      const exe = join(dir, 'app.exe')
      const p = await probePortableDir(dir, exe)
      assert.ok(p)
      assert.equal(p!.entryCount, 2)
      assert.ok(p!.dirMtime > 0)
      assert.ok(p!.mainExe.length > 0, '主 exe 还在，应回传路径')
      assert.ok(p!.mainExeMtime > 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('上次的主 exe 已被删除 → probe 回传空路径（判定为不匹配）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-portprobe2-'))
    try {
      await writeFile(join(dir, 'readme.txt'), 'y')
      const p = await probePortableDir(dir, join(dir, 'gone.exe'))
      assert.ok(p)
      assert.equal(p!.mainExe, '')
      assert.equal(p!.mainExeMtime, 0)
      assert.equal(p!.entryCount, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
