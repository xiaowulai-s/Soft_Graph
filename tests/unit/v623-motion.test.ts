/**
 * v6.2.3 同步演出：状态节流单测。
 * 锁住「100ms 窗口内高频推送只应用最后一次 + 尾部补一次」的行为，
 * 避免逐文件 BackupRunState 推送把渲染打满。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createThrottle } from '../../packages/shared/throttle'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('createThrottle', () => {
  it('窗口内 50 次推送只应用最后一次，并在窗口结束时补一次', async () => {
    const seen: number[] = []
    const push = createThrottle<number>((v) => seen.push(v), 60)
    for (let i = 0; i < 50; i++) push(i)
    assert.equal(seen.length, 1, '首次调用应立即应用')
    assert.equal(seen[0], 0)
    await wait(90)
    assert.deepEqual(seen, [0, 49], '尾部应只补一次且为最新值')
  })

  it('超过间隔的推送立即应用，不产生额外尾部', async () => {
    const seen: number[] = []
    const push = createThrottle<number>((v) => seen.push(v), 50)
    push(1)
    await wait(70)
    push(2)
    await wait(70)
    assert.deepEqual(seen, [1, 2])
  })

  it('不同值类型（含 0 / false）不会被误判为无待处理项', async () => {
    const seen: number[] = []
    const push = createThrottle<number>((v) => seen.push(v), 40)
    push(7)
    push(0)
    await wait(70)
    assert.deepEqual(seen, [7, 0])
  })
})
