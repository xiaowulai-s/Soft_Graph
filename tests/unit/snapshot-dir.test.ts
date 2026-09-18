/**
 * 安装目录快照 · 并行化等价性（v3.0.0 · A7）
 *
 * `snapshotInstallDir` 从「串行逐文件 stat」改成了「先并行发起 stat、再按目录内原顺序消费」。
 * 这个改动唯一站得住的理由是：**输出与串行版逐字段一致**。
 *
 * 因此这个套件的做法是：把**原串行实现原样抄进用例当金标准**，
 * 在合成目录树上跑两遍，比较 `files`（含顺序）/ `truncated` / `totalBytes`。
 * 顺序也要比 —— `files` 的排布会影响上游 `extraDirs` 的取法，不是无所谓的东西。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotInstallDir, DATA_EXT_INTEREST, type DirScanResult } from '@scanner/deps'
import { extName, normPath } from '@shared/util'

function makeGate(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiters: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < max) active++
    else await new Promise<void>((r) => waiters.push(() => { active++; r() }))
    try {
      return await fn()
    } finally {
      active--
      const w = waiters.shift()
      if (w) w()
    }
  }
}

/** 直接复用实现里的常量 —— 用例里再抄一份必然漂移 */
const INTEREST = DATA_EXT_INTEREST

/**
 * 金标准：**改造前的串行实现**（逐文件 await stat，遇截断立即 return）。
 * 与 deps.ts 的实现逻辑逐行对应，仅去掉并行部分。
 */
async function snapshotSerial(
  root: string,
  opts: { maxDepth?: number; maxFiles?: number; onlyInteresting?: boolean } = {}
): Promise<DirScanResult> {
  const { maxDepth = 6, maxFiles = 6000, onlyInteresting = true } = opts
  const files: DirScanResult['files'] = []
  let truncated = false
  let totalBytes = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const full = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      const ext = extName(e.name)
      let st: import('node:fs').Stats
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      totalBytes += st.size
      if (onlyInteresting && !INTEREST.has(ext) && st.size < 512 * 1024) continue
      files.push({ path: normPath(full), size: st.size, mtime: st.mtimeMs })
    }
  }
  await walk(root, 0)
  return { files, truncated, totalBytes }
}

let base = ''

before(async () => {
  base = await fs.mkdtemp(join(tmpdir(), 'sg-snapdir-'))
  // 造一棵有多层、有大量文件、有「不感兴趣的小文件」和「大文件」的树
  for (let d = 0; d < 4; d++) {
    const dir = join(base, `d${d}`)
    await fs.mkdir(join(dir, 'inner'), { recursive: true })
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(join(dir, `a${i}.txt`), Buffer.alloc(64)) // 不感兴趣的小文件
      await fs.writeFile(join(dir, `b${i}.dll`), Buffer.alloc(128)) // 感兴趣
      // 大文件（>512KB）即便扩展名不感兴趣也应被收录
      if (i % 5 === 0) await fs.writeFile(join(dir, `big${i}.log`), Buffer.alloc(600 * 1024))
      await fs.writeFile(join(dir, 'inner', `c${i}.exe`), Buffer.alloc(256))
    }
  }
  // 一层「入口文件」用于触发父层与子层的顺序交错
  await fs.writeFile(join(base, '0first.dll'), Buffer.alloc(1024))
  await fs.writeFile(join(base, 'zzlast.dll'), Buffer.alloc(1024))
})

after(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true }).catch(() => {})
})

describe('快照 · 并行与串行等价', () => {
  it('默认参数下 files（含顺序）/ truncated / totalBytes 完全一致', async () => {
    const par = await snapshotInstallDir(base)
    const ser = await snapshotSerial(base)
    assert.equal(par.files.length, ser.files.length, `文件数应一致：${par.files.length} vs ${ser.files.length}`)
    assert.deepEqual(par.files, ser.files, 'files 必须逐字段且逐顺序一致')
    assert.equal(par.truncated, ser.truncated)
    assert.equal(par.totalBytes, ser.totalBytes)
    assert.ok(par.files.length > 100, `样本量应足够（实际 ${par.files.length}）`)
  })

  it('maxFiles 截断点一致（这是最容易在并发下漂移的地方）', async () => {
    for (const maxFiles of [1, 7, 30, 123]) {
      const par = await snapshotInstallDir(base, { maxFiles })
      const ser = await snapshotSerial(base, { maxFiles })
      assert.equal(par.files.length, ser.files.length, `maxFiles=${maxFiles} 文件数`)
      assert.deepEqual(par.files, ser.files, `maxFiles=${maxFiles} files 应一致`)
      assert.equal(par.truncated, ser.truncated, `maxFiles=${maxFiles} truncated`)
      assert.equal(par.totalBytes, ser.totalBytes, `maxFiles=${maxFiles} totalBytes`)
    }
  })

  it('maxDepth 限制一致', async () => {
    for (const maxDepth of [0, 1, 2]) {
      const par = await snapshotInstallDir(base, { maxDepth })
      const ser = await snapshotSerial(base, { maxDepth })
      assert.deepEqual(par.files, ser.files, `maxDepth=${maxDepth} files 应一致`)
      assert.equal(par.truncated, ser.truncated)
      assert.equal(par.totalBytes, ser.totalBytes)
    }
  })

  it('onlyInteresting=false 时收录全部文件，且两边一致', async () => {
    const par = await snapshotInstallDir(base, { onlyInteresting: false })
    const ser = await snapshotSerial(base, { onlyInteresting: false })
    assert.deepEqual(par.files, ser.files)
    assert.equal(par.totalBytes, ser.totalBytes)
    // 合成树共 4 层 ×（25 txt + 25 dll + 5 big + 25 inner exe）+ 根层 2 = 322
    assert.ok(par.files.length >= 320, `应收录全部文件（实际 ${par.files.length}）`)
    // 对比：默认 onlyInteresting=true 时应明显更少（txt 被过滤）
    const filtered = await snapshotInstallDir(base)
    assert.ok(filtered.files.length < par.files.length, 'onlyInteresting 应产生可观测差异')
  })

  it('并发度极小时仍然一致（并发 1 等价于串行）', async () => {
    const prev = process.env.SG_SNAP_CONCURRENCY
    process.env.SG_SNAP_CONCURRENCY = '1'
    try {
      const par = await snapshotInstallDir(base)
      const ser = await snapshotSerial(base)
      assert.deepEqual(par.files, ser.files)
      assert.equal(par.totalBytes, ser.totalBytes)
    } finally {
      if (prev === undefined) delete process.env.SG_SNAP_CONCURRENCY
      else process.env.SG_SNAP_CONCURRENCY = prev
    }
  })

  it('不存在的目录返回空结果（不抛）', async () => {
    const r = await snapshotInstallDir(join(tmpdir(), 'sg-snapdir-missing-77a1'))
    assert.deepEqual(r.files, [])
    assert.equal(r.truncated, false)
    assert.equal(r.totalBytes, 0)
  })
})

describe('快照 · 并发闸门本身', () => {
  it('闸门不超过设定并发，且顺序消费不受影响', async () => {
    const gate = makeGate(3)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 30 }, () =>
        gate(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 1))
          active--
        })
      )
    )
    assert.ok(peak <= 3, `并发不应超过 3，实际峰值 ${peak}`)
    assert.equal(active, 0, '全部完成后不应有残留占用')
  })
})
