/**
 * v6.2.3 同步演出：通用尾部节流（纯函数，渲染层与 Node 单测共用）。
 * ms 窗口内的高频调用只应用最后一次，窗口结束时补一次；
 * 用于把主进程「每拷贝一个文件就推送一次」的 BackupRunState 合并到 100ms 一次刷新。
 */
export function createThrottle<T>(apply: (value: T) => void, ms = 100): (value: T) => void {
  let last = 0
  let pending: T | undefined
  let hasPending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    timer = undefined
    if (!hasPending) return
    const value = pending as T
    pending = undefined
    hasPending = false
    last = Date.now()
    apply(value)
  }

  return (value: T): void => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      apply(value)
      return
    }
    pending = value
    hasPending = true
    if (timer === undefined) timer = setTimeout(flush, Math.max(0, ms - (now - last)))
  }
}
