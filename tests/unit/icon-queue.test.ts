/**
 * 图标按需提取队列（v3.0.0 · A2）
 *
 * 这个队列存在的意义只有一个：**把「N 次图标请求」折成「1 次 PowerShell 调用」**。
 * 因此用例重点全在「聚合」这件事上 —— 去重是否真的生效、防抖是否真的聚批、
 * 提取失败后能不能重试（失败一次就永久放弃会比慢更糟）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IconQueue, type IconRequestLike } from '../../apps/desktop/src/main/services/icon-queue'

/** 记录每次 extract 收到的请求，并可控地返回「已落盘」的 hash */
function makeHost(opts: { sources?: Record<string, string[]>; fail?: boolean | (() => boolean); extractDelayMs?: number } = {}) {
  const calls: IconRequestLike[][] = []
  const ready: string[][] = []
  const sources = opts.sources ?? {}
  const host = {
    resolveSources: (hash: string): string[] | null => sources[hash] ?? null,
    extract: async (reqs: IconRequestLike[]): Promise<string[]> => {
      calls.push(reqs.map((r) => ({ hash: r.hash, sources: [...r.sources] })))
      if (opts.extractDelayMs) await new Promise((r) => setTimeout(r, opts.extractDelayMs))
      const fail = typeof opts.fail === 'function' ? opts.fail() : opts.fail
      if (fail) throw new Error('PS 失败')
      return reqs.map((r) => r.hash)
    },
    onReady: (hashes: string[]): void => {
      ready.push([...hashes])
    }
  }
  return { host, calls, ready }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('图标队列 · 聚批与去重', () => {
  it('防抖窗口内的多个请求聚成一批', async () => {
    const { host, calls } = makeHost({ sources: { a: ['x.exe'], b: ['y.exe'], c: ['z.exe'] } })
    const q = new IconQueue(host, { debounceMs: 10 })
    try {
      q.request('a')
      q.request('b')
      q.request('c')
      assert.equal(q.pendingCount, 3)
      assert.equal(calls.length, 0, '防抖未到期不应触发提取')
      await sleep(60)
      assert.equal(calls.length, 1, '三个请求应聚成一次提取')
      assert.deepEqual(calls[0].map((r) => r.hash).sort(), ['a', 'b', 'c'])
      assert.equal(q.pendingCount, 0)
    } finally {
      q.dispose()
    }
  })

  it('同一 hash 重复请求被合并，只提取一次', async () => {
    const { host, calls, ready } = makeHost({ sources: { a: ['x.exe'] } })
    const q = new IconQueue(host, { debounceMs: 10 })
    try {
      assert.equal(q.request('a'), 'queued')
      assert.equal(q.request('a'), 'duplicate')
      assert.equal(q.request('a'), 'duplicate')
      await sleep(60)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].length, 1)
      assert.deepEqual(ready, [['a']])
      assert.equal(q.statsSnapshot().deduped, 2)
    } finally {
      q.dispose()
    }
  })

  it('提取进行中再次请求同一 hash 也被合并（不会排第二遍）', async () => {
    const { host, calls } = makeHost({ sources: { a: ['x.exe'] }, extractDelayMs: 40 })
    const q = new IconQueue(host, { debounceMs: 5 })
    try {
      q.request('a')
      await sleep(20) // 已进入提取中
      assert.equal(q.inflightCount, 1)
      assert.equal(q.request('a'), 'duplicate')
      await sleep(80)
      assert.equal(calls.length, 1, '提取期间不应再排一批')
    } finally {
      q.dispose()
    }
  })

  it('单批上限生效：超出的部分留到下一批，不会丢', async () => {
    const sources: Record<string, string[]> = {}
    for (let i = 0; i < 7; i++) sources[`h${i}`] = ['x.exe']
    const { host, calls } = makeHost({ sources })
    const q = new IconQueue(host, { debounceMs: 5, maxBatch: 3 })
    try {
      q.requestMany(Object.keys(sources))
      await sleep(150)
      assert.equal(calls.length, 3, '7 条按每批 3 条应分 3 批')
      assert.deepEqual(calls.map((c) => c.length), [3, 3, 1])
      assert.equal(q.pendingCount, 0)
      assert.equal(q.statsSnapshot().extracted, 7)
    } finally {
      q.dispose()
    }
  })

  it('requestMany 汇总各类结果', () => {
    const { host } = makeHost({ sources: { a: ['x.exe'], b: ['y.exe'] } })
    const q = new IconQueue(host, { debounceMs: 1000 })
    try {
      const r = q.requestMany(['a', 'b', 'a', 'unknownHash', ''])
      assert.deepEqual(r, { queued: 2, duplicate: 1, unknown: 2, overflow: 0 })
    } finally {
      q.dispose()
    }
  })
})

describe('图标队列 · 边界与容错', () => {
  it('认不出的 hash 不入队（避免为无踪可查的 hash 空跑 PowerShell）', async () => {
    const { host, calls } = makeHost({ sources: {} })
    const q = new IconQueue(host, { debounceMs: 5 })
    try {
      assert.equal(q.request('nope'), 'unknown')
      await sleep(30)
      assert.equal(calls.length, 0)
      assert.equal(q.statsSnapshot().unknown, 1)
    } finally {
      q.dispose()
    }
  })

  it('空 hash 直接不处理', () => {
    const { host } = makeHost({ sources: { a: ['x.exe'] } })
    const q = new IconQueue(host)
    try {
      assert.equal(q.request(''), 'unknown')
      assert.equal(q.pendingCount, 0)
    } finally {
      q.dispose()
    }
  })

  it('队列上限生效：溢出请求被拒绝而不是无限堆积', () => {
    const sources: Record<string, string[]> = {}
    for (let i = 0; i < 10; i++) sources[`h${i}`] = ['x.exe']
    const { host } = makeHost({ sources })
    const q = new IconQueue(host, { debounceMs: 1000, maxPending: 3 })
    try {
      for (let i = 0; i < 10; i++) q.request(`h${i}`)
      assert.equal(q.pendingCount, 3)
      assert.equal(q.statsSnapshot().overflow, 7)
    } finally {
      q.dispose()
    }
  })

  it('提取抛异常不崩，且失败后同一 hash 可以重新入队（重试路径）', async () => {
    let fail = true
    const { host } = makeHost({ sources: { a: ['x.exe'] }, fail: () => fail })
    const q = new IconQueue(host, { debounceMs: 5 })
    try {
      q.request('a')
      await sleep(30)
      assert.equal(q.statsSnapshot().failures, 1)
      assert.equal(q.inflightCount, 0, '失败后必须释放 inflight，否则永远无法重试')
      assert.equal(q.statsSnapshot().extracted, 0)

      // 第二次请求应当被接受（这就是「失败不永久放弃」）
      fail = false
      assert.equal(q.request('a'), 'queued')
      await sleep(30)
      assert.equal(q.statsSnapshot().extracted, 1)
    } finally {
      q.dispose()
    }
  })

  it('onReady 只推本批真正完成的 hash（extract 少回传时不多推）', async () => {
    const ready: string[][] = []
    const host = {
      resolveSources: (h: string) => ['x.exe'].map(() => h),
      // 只回传 a，模拟「b 没有可提取的图标」
      extract: async (): Promise<string[]> => ['a'],
      onReady: (hashes: string[]): void => {
        ready.push([...hashes])
      }
    }
    const q = new IconQueue(host, { debounceMs: 5 })
    try {
      q.requestMany(['a', 'b'])
      await sleep(40)
      assert.deepEqual(ready, [['a']])
    } finally {
      q.dispose()
    }
  })

  it('onReady 抛异常不影响队列状态', async () => {
    const host = {
      resolveSources: (h: string) => [h],
      extract: async (reqs: IconRequestLike[]): Promise<string[]> => reqs.map((r) => r.hash),
      onReady: (): void => {
        throw new Error('渲染层已销毁')
      }
    }
    const q = new IconQueue(host, { debounceMs: 5 })
    try {
      q.request('a')
      await sleep(40)
      assert.equal(q.pendingCount, 0)
      assert.equal(q.inflightCount, 0)
      assert.equal(q.statsSnapshot().extracted, 1)
    } finally {
      q.dispose()
    }
  })

  it('dispose 后不再调度，也不接受新请求', async () => {
    const { host, calls } = makeHost({ sources: { a: ['x.exe'] } })
    const q = new IconQueue(host, { debounceMs: 10 })
    q.request('a')
    q.dispose()
    assert.equal(q.request('a'), 'unknown')
    await sleep(40)
    assert.equal(calls.length, 0)
  })

  it('flush() 可同步驱动一批（测试与退出前冲刷用）', async () => {
    const { host, calls } = makeHost({ sources: { a: ['x.exe'], b: ['y.exe'] } })
    const q = new IconQueue(host, { debounceMs: 100_000 })
    try {
      q.requestMany(['a', 'b'])
      const n = await q.flush()
      assert.equal(n, 2)
      assert.equal(calls.length, 1)
      assert.equal(q.pendingCount, 0)
      // 空队列 flush 返回 0，不空跑
      assert.equal(await q.flush(), 0)
    } finally {
      q.dispose()
    }
  })

  it('统计快照反映聚批效果（batchSizes 用于诊断）', async () => {
    const sources: Record<string, string[]> = {}
    for (let i = 0; i < 5; i++) sources[`h${i}`] = ['x.exe']
    const { host } = makeHost({ sources })
    const q = new IconQueue(host, { debounceMs: 5, maxBatch: 3 })
    try {
      q.requestMany(Object.keys(sources))
      await sleep(150)
      const s = q.statsSnapshot()
      assert.equal(s.batches, 2)
      assert.deepEqual(s.batchSizes, [3, 2])
      assert.equal(s.extracted, 5)
      assert.equal(s.requested, 5)
    } finally {
      q.dispose()
    }
  })
})
