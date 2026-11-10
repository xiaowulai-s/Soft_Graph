/**
 * v6.2.4 数据目录互斥锁单测。
 * 锁住「单持锁 / 活跃持有者拒绝 / 崩溃残留接管 / 自 pid 才释放」四个关键行为，
 * 防止独立 --user-data-dir 的第二实例与真实实例互踩数据目录（flush 覆盖 settings.json）。
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDataLock, releaseDataLock } from '../../apps/desktop/src/main/services/data-lock'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sg-datalock-'))
})

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 沙箱可能拦整目录删除 */
  }
})

describe('acquireDataLock', () => {
  it('空目录首次拿锁成功，锁文件记录当前 pid', async () => {
    const r = await acquireDataLock(dir)
    assert.equal(r.ok, true)
    const raw = JSON.parse(readFileSync(join(dir, 'data.lock'), 'utf8')) as { pid: number }
    assert.equal(raw.pid, process.pid)
  })

  it('另一活跃进程持锁时拒绝启动并返回 holderPid', async () => {
    // 用一个真实存活的子进程模拟「别的实例」
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
    try {
      writeFileSync(join(dir, 'data.lock'), JSON.stringify({ pid: child.pid, startedAt: Date.now() }), 'utf8')
      const r = await acquireDataLock(dir)
      assert.equal(r.ok, false, '应拒绝第二实例')
      assert.equal(r.holderPid, child.pid)
    } finally {
      child.kill()
    }
  })

  it('崩溃残留锁（pid 已死）自动接管', async () => {
    // 先造一个真实 pid 再杀掉 —— 保证「锁里的 pid 一定不存在」，不碰运气挑 pid
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
    const deadPid = child.pid!
    child.kill()
    await new Promise((r) => setTimeout(r, 150))
    writeFileSync(join(dir, 'data.lock'), JSON.stringify({ pid: deadPid, startedAt: 1 }), 'utf8')
    const r = await acquireDataLock(dir)
    assert.equal(r.ok, true, '持锁进程已死应接管')
    const raw = JSON.parse(readFileSync(join(dir, 'data.lock'), 'utf8')) as { pid: number }
    assert.equal(raw.pid, process.pid)
  })

  it('损坏的锁文件视为残留，接管成功', async () => {
    writeFileSync(join(dir, 'data.lock'), 'not-json{{', 'utf8')
    const r = await acquireDataLock(dir)
    assert.equal(r.ok, true)
  })

  it('锁文件中 pid 为自己时不误判拒绝（幂等重入）', async () => {
    await acquireDataLock(dir)
    const again = await acquireDataLock(dir)
    assert.equal(again.ok, true)
  })
})

describe('releaseDataLock', () => {
  it('只释放自己的锁；释放后可重新拿锁', async () => {
    await acquireDataLock(dir)
    await releaseDataLock(dir)
    assert.equal(existsSync(join(dir, 'data.lock')), false, '锁文件应被删除')
    const r = await acquireDataLock(dir)
    assert.equal(r.ok, true)
  })

  it('别人的锁不会被误删', async () => {
    // 与「崩溃残留」用例同款手法：真实 pid 杀掉后写锁，确保 pid 确实不存在
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' })
    const deadPid = child.pid!
    child.kill()
    await new Promise((r) => setTimeout(r, 150))
    writeFileSync(join(dir, 'data.lock'), JSON.stringify({ pid: deadPid, startedAt: 1 }), 'utf8')
    await releaseDataLock(dir)
    assert.equal(existsSync(join(dir, 'data.lock')), true, '不是自己的锁不应删除')
  })
})
