/**
 * 垃圾扫描 Worker 管理器（M2/C2）
 *
 * 职责：
 *   1. 在 Electron utilityProcess 中运行扫描，主进程只收进度与摘要
 *   2. Worker 崩溃 → 自动重启并**续扫**：已完成的规则由增量缓存复用
 *      （worker 每完成一条规则就落盘缓存，见 junk-scan-worker.ts）
 *   3. 与主进程隔离：扫描期间 UI / 浮窗不受影响；崩溃不影响应用存活
 *
 * 降级：utilityProcess 不可用（非 Electron 环境 / 测试）→ 由调用方走进程内扫描。
 */

import type { JunkSummary } from '@shared/types'

export interface WorkerScanPayload {
  scanId: string
  rulesFile: string
  cachePath: string
  resultPath: string
  categoryIds?: string[]
  force?: boolean
  knownNames: string[]
  knownPublishers: string[]
  knownDirs: string[]
  excludes: string[]
}

export interface WorkerScanResult {
  summary: JunkSummary
  reusedRules: string[]
  reuseSource: Record<string, string>
  /** 结果文件路径（items 在其中，避免大对象过 IPC） */
  resultPath: string
  /** Worker 重启次数（>0 说明发生过崩溃续扫） */
  restarts: number
}

export interface WorkerHooks {
  onProgress?: (phase: string, percent: number, current: string, found: number) => void
  /**
   * 崩溃后是否允许重启续扫（默认允许 1 次）。
   * 第二次仍崩溃则放弃，交由调用方回退到进程内扫描。
   */
  maxRestarts?: number
  /** 等待单次运行的超时（默认 10 分钟） */
  timeoutMs?: number
}

interface UtilityProcessLike {
  postMessage: (m: unknown) => void
  kill: () => boolean
  on: (ev: string, cb: (...args: never[]) => void) => void
  stdout?: NodeJS.ReadableStream | null
}

type ForkFn = (modulePath: string) => UtilityProcessLike

/** 懒加载 electron 的 utilityProcess（非 Electron 环境下不存在） */
function getFork(): ForkFn | null {
  try {
    // 运行时 require，避免打包/测试环境硬依赖
    const electron = require('electron') as { utilityProcess?: { fork: ForkFn } }
    if (electron?.utilityProcess?.fork) return (p) => electron.utilityProcess!.fork(p)
  } catch {
    /* 非 Electron 环境 */
  }
  return null
}

export class JunkScanWorker {
  private proc: UtilityProcessLike | null = null
  private modulePath: string
  /** 扫描结果文件目录 */
  private tmpDir: string

  constructor(modulePath: string, tmpDir: string) {
    this.modulePath = modulePath
    this.tmpDir = tmpDir
  }

  static isSupported(): boolean {
    return getFork() !== null
  }

  /** 当前是否有存活的 Worker */
  get alive(): boolean {
    return this.proc !== null
  }

  dispose(): void {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = null
  }

  private spawn(): UtilityProcessLike {
    const fork = getFork()
    if (!fork) throw new Error('utilityProcess 不可用（非 Electron 环境）')
    const proc = fork(this.modulePath)
    proc.stdout?.resume?.()
    return proc
  }

  /**
   * 运行一次扫描。崩溃时按 maxRestarts 重启续扫。
   */
  async run(payload: WorkerScanPayload, hooks: WorkerHooks = {}): Promise<WorkerScanResult> {
    const maxRestarts = hooks.maxRestarts ?? 1
    let restarts = 0
    for (;;) {
      try {
        const r = await this.runOnce(payload, hooks)
        return { ...r, restarts }
      } catch (e) {
        const err = e as Error & { crashed?: boolean }
        if (!err.crashed || restarts >= maxRestarts) throw e
        restarts++
        // 续扫：缓存已由 worker 逐规则落盘，重启后扫描会自动复用已完成的规则
        hooks.onProgress?.('扫描进程异常退出，正在重启并续扫…', 0, '', 0)
        this.dispose()
      }
    }
  }

  private runOnce(payload: WorkerScanPayload, hooks: WorkerHooks): Promise<Omit<WorkerScanResult, 'restarts'>> {
    return new Promise((resolve, reject) => {
      const proc = this.spawn()
      this.proc = proc
      let settled = false

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this.dispose()
        reject(new Error('扫描超时'))
      }, hooks.timeoutMs ?? 600_000)

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        fn()
      }

      proc.on('message' as never, ((msg: { type?: string } & Record<string, unknown>) => {
        switch (msg?.type) {
          case 'progress':
            hooks.onProgress?.(
              String(msg.phase ?? ''),
              Number(msg.percent ?? 0),
              String(msg.current ?? ''),
              Number(msg.found ?? 0)
            )
            break
          case 'done':
            finish(() =>
              resolve({
                summary: msg.summary as JunkSummary,
                reusedRules: (msg.reusedRules as string[]) ?? [],
                reuseSource: (msg.reuseSource as Record<string, string>) ?? {},
                resultPath: String(msg.resultPath ?? payload.resultPath)
              })
            )
            break
          case 'error':
            finish(() => reject(new Error(String(msg.message ?? 'Worker 扫描失败'))))
            break
          default:
            break
        }
      }) as never)

      // 崩溃 / 被杀：标记 crashed 以便上层重启续扫
      proc.on('exit' as never, (() => {
        if (this.proc === proc) this.proc = null
        const e = new Error('扫描进程异常退出') as Error & { crashed?: boolean }
        e.crashed = true
        finish(() => reject(e))
      }) as never)

      proc.postMessage({ type: 'scan', payload })
    })
  }

  /** 请求取消（Worker 侧在规则边界检查） */
  cancel(): void {
    try {
      this.proc?.postMessage({ type: 'cancel' })
    } catch {
      /* ignore */
    }
  }
}
