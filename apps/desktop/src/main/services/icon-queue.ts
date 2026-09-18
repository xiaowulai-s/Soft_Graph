/**
 * 图标按需提取队列（v3.0.0 · A2）
 *
 * 背景：v2.0.0 是在扫描 `done` 之后对**全部**软件一次性提取图标。
 * 这本身不阻塞主流程，但带来两个问题：
 *   1. 用户只看前几屏，却要为全部软件付一次 PowerShell 调用（约 250ms 起）；
 *   2. 渲染层取图标是**逐个串行 IPC**（见 App.vue::loadIcons），250 个软件
 *      就是 250 次往返 + 250 次整体重渲染 —— 这才是图标体验的真正瓶颈。
 *
 * 因此这里做**聚批按需提取**：
 *   未命中磁盘缓存的图标请求先入队（按 hash 去重）→ 防抖窗口结束（默认 250ms）
 *   → 一次 PowerShell 处理整批 → 落盘 → 把就绪的 hash 回调出去。
 *
 * 为什么不做常驻 worker / 提高并发：
 *   图标提取走 PowerShell + System.Drawing，单次调用**本来就能批量处理任意条数**，
 *   聚批已经把进程启动成本摊薄到可忽略；再加常驻池收益有限而复杂度显著上升。
 *
 * 本文件不依赖 electron 与 fs（IO 与提取都由 host 注入），因此可直接单测。
 */

/** 单个提取请求：hash + 候选来源（按优先级） */
export interface IconRequestLike {
  hash: string
  sources: string[]
}

export interface IconQueueHost {
  /** 查一个 hash 的候选来源；返回 null / 空数组表示「不认识这个 hash」，不入队 */
  resolveSources(hash: string): string[] | null
  /** 执行批量提取，返回**确实已落盘**的 hash 列表 */
  extract(reqs: IconRequestLike[]): Promise<string[]>
  /** 一批提取完成后的回调（只含本批新就绪的 hash） */
  onReady(hashes: string[]): void
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface IconQueueOptions {
  /** 防抖窗口：把这段时间内的请求聚成一批 */
  debounceMs?: number
  /** 单批上限：避免一次请求几百个图标时把 PowerShell 调用拖得过长 */
  maxBatch?: number
  /** 队列上限：极端情况下（渲染层异常狂发）保护内存 */
  maxPending?: number
}

export type IconRequestResult = 'queued' | 'duplicate' | 'unknown' | 'overflow'

export interface IconQueueStats {
  /** 收到的请求次数（含重复） */
  requested: number
  /** 因重复入队被合并掉的数量 */
  deduped: number
  /** 已执行的提取批次 */
  batches: number
  /** 每批提取数量的历史（供诊断观察聚批效果） */
  batchSizes: number[]
  /** 累计成功落盘的图标数（extract 回传的去重合计） */
  extracted: number
  /** 不认识 hash / 无候选来源的次数 */
  unknown: number
  /** 队列满被拒的次数 */
  overflow: number
  /** 提取抛异常的次数 */
  failures: number
}

const DEFAULTS = { debounceMs: 250, maxBatch: 400, maxPending: 2000 }

export class IconQueue {
  /** hash → 候选来源（待提取） */
  private queue = new Map<string, string[]>()
  /** 正在提取中的 hash：期间重复请求应被合并，而不是再排一次 */
  private inflight = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  /** 串行化 flush：两个批次同时跑会让 PowerShell 调用重叠，反而更慢 */
  private flushing = false
  private readonly opts: Required<IconQueueOptions>
  private stats: IconQueueStats = {
    requested: 0,
    deduped: 0,
    batches: 0,
    batchSizes: [],
    extracted: 0,
    unknown: 0,
    overflow: 0,
    failures: 0
  }

  constructor(
    private host: IconQueueHost,
    opts: IconQueueOptions = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  /**
   * 请求某个 hash 的图标。
   * 调用方（IPC handler）应**先查磁盘缓存**，只有未命中才走到这里。
   */
  request(hash: string): IconRequestResult {
    if (!hash) return 'unknown'
    if (this.disposed) return 'unknown'
    this.stats.requested++

    if (this.queue.has(hash) || this.inflight.has(hash)) {
      this.stats.deduped++
      return 'duplicate'
    }
    if (this.queue.size >= this.opts.maxPending) {
      this.stats.overflow++
      return 'overflow'
    }

    const sources = this.host.resolveSources(hash)
    if (!sources || sources.length === 0) {
      this.stats.unknown++
      return 'unknown'
    }

    this.queue.set(hash, sources)
    this.schedule()
    return 'queued'
  }

  /** 批量请求（渲染层一次给一批 hash 时用），返回各类结果计数 */
  requestMany(hashes: string[]): { queued: number; duplicate: number; unknown: number; overflow: number } {
    const out = { queued: 0, duplicate: 0, unknown: 0, overflow: 0 }
    for (const h of hashes ?? []) out[this.request(h)]++
    return out
  }

  private schedule(): void {
    if (this.disposed || this.timer || this.flushing) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.opts.debounceMs)
    // 队列定时器不应拖住进程退出
    this.timer.unref?.()
  }

  /**
   * 立即执行一批（测试与「窗口关闭前冲刷」用）。
   * 返回本批成功落盘的数量。
   */
  async flush(): Promise<number> {
    if (this.disposed || this.flushing) return 0
    if (this.queue.size === 0) return 0

    const entries = [...this.queue.entries()].slice(0, this.opts.maxBatch)
    for (const [hash] of entries) {
      this.queue.delete(hash)
      this.inflight.add(hash) // 提取期间重复请求会被合并
    }

    this.flushing = true
    this.stats.batches++
    this.stats.batchSizes.push(entries.length)
    if (this.stats.batchSizes.length > 50) this.stats.batchSizes.shift()

    try {
      const done = await this.host.extract(entries.map(([hash, sources]) => ({ hash, sources })))
      const ready = [...new Set(done ?? [])].filter((h) => this.inflight.has(h))
      this.stats.extracted += ready.length
      if (ready.length > 0) {
        try {
          this.host.onReady(ready)
        } catch {
          /* 推送失败不影响后续批次 */
        }
      }
      this.host.log?.('图标批次完成', { requested: entries.length, ready: ready.length })
      return ready.length
    } catch (e) {
      this.stats.failures++
      this.host.log?.('图标批次失败', { requested: entries.length, error: (e as Error).message })
      return 0
    } finally {
      for (const [hash] of entries) this.inflight.delete(hash)
      this.flushing = false
      // 本批之外还剩（超过 maxBatch）或期间又来了新请求 → 继续排下一批
      if (this.queue.size > 0) this.schedule()
    }
  }

  get pendingCount(): number {
    return this.queue.size
  }

  get inflightCount(): number {
    return this.inflight.size
  }

  /** 诊断快照（诊断包 / 单测用） */
  statsSnapshot(): IconQueueStats & { pending: number; inflight: number } {
    return { ...this.stats, batchSizes: [...this.stats.batchSizes], pending: this.queue.size, inflight: this.inflight.size }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queue.clear()
    this.inflight.clear()
  }
}
