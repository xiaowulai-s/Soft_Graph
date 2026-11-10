/**
 * 数据目录互斥锁（v6.2.4 · 防多实例互踩）
 *
 * 背景：Electron 的 requestSingleInstanceLock() 以 userData 目录为作用域。
 * 用独立 --user-data-dir 启动的调试/第二实例会拿到自己的锁而正常启动，
 * 但 resolvePaths() 默认仍指向同一份 %LOCALAPPDATA%\SoftGraph ——
 * 两个实例各自持有内存态（SettingsStore / sql.js 内存库），周期性 flush
 * 会把磁盘快照互相覆盖（settings.json 曾被写空、backupSchedule 丢失）。
 *
 * 这把锁以「数据目录」为作用域，补上单实例锁的缺口：
 *   - 独占创建（'wx'）成功 → 持锁
 *   - 已存在 → 读 pid 探活：存活则拒绝启动；死亡（崩溃残留）则接管
 *   - 退出时释放（仅当锁仍是自己的，避免误删接管者的锁）
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface DataLockResult {
  ok: boolean
  /** 拒绝启动时：当前持锁进程的 pid */
  holderPid?: number
}

function lockFileOf(root: string): string {
  return join(root, 'data.lock')
}

function serialize(pid: number): string {
  return JSON.stringify({ pid, startedAt: Date.now() })
}

/** 信号 0 只探活：存活返回 true；ESRCH（进程不存在）返回 false；其余错误按存活处理 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 尝试持有数据目录锁。
 * - 拿到/接管 → { ok: true }
 * - 另一活跃实例持锁 → { ok: false, holderPid }
 * - 除 EEXIST 外的 IO 异常不阻塞启动（锁是防护，不能变成可用性问题）
 */
export async function acquireDataLock(root: string): Promise<DataLockResult> {
  if (!root) return { ok: true }
  const file = lockFileOf(root)
  await fs.mkdir(root, { recursive: true }).catch(() => {})
  try {
    const fh = await fs.open(file, 'wx')
    await fh.writeFile(serialize(process.pid), 'utf8')
    await fh.close()
    return { ok: true }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: true }
  }
  // 锁文件已存在 → 检查持有者
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: number }
    const pid = Number(raw?.pid)
    if (pid && pid !== process.pid && pidAlive(pid)) {
      return { ok: false, holderPid: pid }
    }
  } catch {
    /* 锁文件损坏/非 JSON → 视为残留，接管 */
  }
  await fs.writeFile(file, serialize(process.pid), 'utf8').catch(() => {})
  return { ok: true }
}

/** 释放数据目录锁（仅当锁仍是自己的 pid，防止误删接管者的锁） */
export async function releaseDataLock(root: string): Promise<void> {
  if (!root) return
  const file = lockFileOf(root)
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: number }
    if (Number(raw?.pid) === process.pid) await fs.unlink(file)
  } catch {
    /* 无锁 / 读失败 / 已被删除：无需处理 */
  }
}
