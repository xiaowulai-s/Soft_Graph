/**
 * N1 备份同步（v5.3）—— 开发文件夹 → 移动硬盘 的增量备份。
 *
 * 安全边界（高责任功能，docs/15 明确约定）：
 *   **只增不改不删** —— 目标端已有文件一律不覆盖：同尺寸同修改时间 → skip；
 *   存在但不同 → conflict 跳过并记录。首版不做删除同步，目标端永远不会被删改。
 *
 * 设备语义：
 *   目标盘按卷标识别（备用盘符），运行中每 5s 探活 —— 拔盘 → paused(device-lost)，
 *   插回 → 自动续传（device-back 日志）。目标端路径由主进程拼装，
 *   相对路径越界（../ 逃逸）在 resolveTargetPath 拦截。
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, dirname, relative, isAbsolute, resolve } from 'node:path'
import type { BackupDriveInfo, BackupLogEntry, BackupRunState, BackupTask } from '@shared/types'

/** kv 容量上限：日志最多保留条数 */
const LOG_CAP = 200
const DEVICE_POLL_MS = 5_000

// ───────────────── 纯函数（单测锁定） ─────────────────

/**
 * 单文件处置决策（只增不改不删）：
 *   目标不存在 → copy；目标存在且 size+mtime 一致 → skip；
 *   目标存在但不同 → conflict（绝不覆盖）。
 */
export function decideFile(
  targetExists: boolean,
  srcSize: number,
  srcMtimeMs: number,
  targetSize: number,
  targetMtimeMs: number
): 'copy' | 'skip' | 'conflict' {
  if (!targetExists) return 'copy'
  if (targetSize === srcSize && Math.abs(targetMtimeMs - srcMtimeMs) < 2000) return 'skip'
  return 'conflict'
}

/**
 * 目标路径拼装与越界校验：
 *   targetRoot/<taskName>/<相对 srcRoot 的路径>；
 *   相对路径以 .. 开头（源在源根之外、符号链接逃逸）→ ok:false。
 */
export function resolveTargetPath(
  targetRoot: string,
  taskName: string,
  sourceRoot: string,
  filePath: string
): { ok: boolean; path?: string; reason?: string } {
  const rel = relative(resolve(sourceRoot), resolve(filePath))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: '源路径越出源根目录' }
  const safeName = taskName.replace(/[\\/:*?"<>|]/g, '_').replace(/\.{2,}/g, '_')
  return { ok: true, path: join(targetRoot, safeName, rel) }
}

// ───────────────── 服务 ─────────────────

interface StoreLike {
  getKv(k: string): string | null
  setKv(k: string, v: string): void
}

export class BackupService {
  private states = new Map<string, BackupRunState>()
  private cancelled = new Set<string>()
  private paused = new Set<string>()
  private deviceWatch = new Map<string, ReturnType<typeof setInterval>>()
  private onProgress: ((s: BackupRunState) => void) | null = null

  constructor(
    private store: StoreLike,
    private psJson: <T>(script: string, timeoutMs?: number) => Promise<T>
  ) {}

  /** 进度推送回调（index.ts 接 webContents 广播） */
  setProgressSink(fn: (s: BackupRunState) => void): void {
    this.onProgress = fn
  }

  // ── 驱动器 ──

  async drives(): Promise<BackupDriveInfo[]> {
    try {
      const rows = await this.psJson<{ letter: string; label: string; total: number; free: number; dtype: number }[]>(
        `
$out = New-Object System.Collections.ArrayList
try {
  $disks = Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction Stop
  foreach ($d in $disks) {
    [void]$out.Add([pscustomobject]@{
      letter = [string]$d.DeviceID
      label = [string]$d.VolumeName
      total = [double]($d.Size ?? 0)
      free = [double]($d.FreeSpace ?? 0)
      dtype = [int]($d.DriveType ?? 0)
    })
  }
} catch { }
Write-SgJson @($out)
`,
        15_000
      )
      const arr = Array.isArray(rows) ? rows : []
      return arr
        .filter((r) => r && typeof r.letter === 'string' && /^[A-Z]:$/.test(r.letter))
        .map((r) => ({ letter: r.letter, label: r.label ?? '', totalBytes: Number(r.total) || 0, freeBytes: Number(r.free) || 0, driveType: Number(r.dtype) || 0 }))
    } catch {
      return []
    }
  }

  // ── 任务 CRUD ──

  tasks(): BackupTask[] {
    try {
      const raw = this.store.getKv('backup:tasks')
      return raw ? (JSON.parse(raw) as BackupTask[]) : []
    } catch {
      return []
    }
  }

  private saveTasks(list: BackupTask[]): void {
    this.store.setKv('backup:tasks', JSON.stringify(list))
  }

  saveTask(input: Partial<BackupTask> & { name: string; sources: string[] }): { ok: boolean; id?: string; error?: string } {
    const name = input.name.trim()
    if (!name || name.length > 60) return { ok: false, error: '任务名必填且 ≤60 字符' }
    const sources = input.sources.filter((s) => s && isAbsolute(s))
    if (sources.length === 0) return { ok: false, error: '至少一个绝对路径的源目录' }
    if (sources.length > 20) return { ok: false, error: '源目录最多 20 个' }
    if (!input.volumeLabel && !input.driveLetter) return { ok: false, error: '需要目标卷标或盘符' }
    const list = this.tasks()
    if (input.id) {
      const i = list.findIndex((t) => t.id === input.id)
      if (i < 0) return { ok: false, error: '任务不存在' }
      list[i] = { ...list[i], name, sources, volumeLabel: input.volumeLabel ?? '', driveLetter: input.driveLetter, lastRunAt: list[i].lastRunAt }
      this.saveTasks(list)
      return { ok: true, id: input.id }
    }
    const id = `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    list.push({ id, name, sources, volumeLabel: input.volumeLabel ?? '', driveLetter: input.driveLetter, createdAt: Date.now() })
    this.saveTasks(list)
    return { ok: true, id }
  }

  deleteTask(id: string): { ok: boolean; error?: string } {
    const list = this.tasks()
    const i = list.findIndex((t) => t.id === id)
    if (i < 0) return { ok: false, error: '任务不存在' }
    const st = this.states.get(id)
    if (st && (st.phase === 'running' || st.phase === 'paused')) return { ok: false, error: '任务正在运行，先停止再删除' }
    list.splice(i, 1)
    this.saveTasks(list)
    return { ok: true }
  }

  // ── 运行控制 ──

  stateOf(id: string): BackupRunState | null {
    return this.states.get(id) ?? null
  }

  allStates(): Record<string, BackupRunState> {
    const out: Record<string, BackupRunState> = {}
    for (const [k, v] of this.states) out[k] = v
    return out
  }

  private push(st: BackupRunState): void {
    this.states.set(st.taskId, st)
    try {
      this.onProgress?.(st)
    } catch {
      /* 渲染层不在了不影响任务 */
    }
  }

  log(): BackupLogEntry[] {
    try {
      const raw = this.store.getKv('backup:log')
      return raw ? (JSON.parse(raw) as BackupLogEntry[]) : []
    } catch {
      return []
    }
  }

  private addLog(taskId: string, action: BackupLogEntry['action'], detail: string): void {
    const list = this.log()
    list.unshift({ ts: Date.now(), taskId, action, detail })
    this.store.setKv('backup:log', JSON.stringify(list.slice(0, LOG_CAP)))
  }

  /** 目标盘解析：卷标优先，盘符兜底；返回盘根（如 "E:\"）或 null */
  private async resolveTargetRoot(task: BackupTask): Promise<string | null> {
    const drives = await this.drives()
    if (task.volumeLabel) {
      const hit = drives.find((d) => d.label && d.label.toLowerCase() === task.volumeLabel.toLowerCase())
      if (hit) return hit.letter + '\\'
    }
    if (task.driveLetter) {
      const hit = drives.find((d) => d.letter.toLowerCase() === task.driveLetter!.toLowerCase())
      if (hit) return hit.letter + '\\'
    }
    return null
  }

  async run(id: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.tasks().find((t) => t.id === id)
    if (!task) return { ok: false, error: '任务不存在' }
    const cur = this.states.get(id)
    if (cur && cur.phase === 'running') return { ok: false, error: '任务已在运行' }

    const targetRoot = await this.resolveTargetRoot(task)
    if (!targetRoot) {
      this.addLog(id, 'error', `目标盘未接入（卷标「${task.volumeLabel || task.driveLetter}」）—— 插入移动硬盘后重试`)
      return { ok: false, error: `目标盘未接入（卷标「${task.volumeLabel || task.driveLetter}」）` }
    }

    this.cancelled.delete(id)
    this.paused.delete(id)
    const st: BackupRunState = {
      taskId: id,
      phase: 'running',
      reason: '',
      copied: 0,
      skipped: 0,
      conflicts: 0,
      bytes: 0,
      errors: [],
      startedAt: Date.now()
    }
    this.push(st)
    this.addLog(id, 'run', `开始备份 → ${targetRoot}${task.name}`)

    // 设备探活：拔盘暂停、插回续传
    this.startDeviceWatch(task)

    // 任务主体异步跑，立即返回（UI 靠进度推送观察）
    void this.execute(task, targetRoot).catch((e) => {
      st.phase = 'error'
      st.finishedAt = Date.now()
      this.push({ ...st })
      this.addLog(id, 'error', (e as Error).message)
      this.stopDeviceWatch(id)
    })
    return { ok: true }
  }

  /** 设备探活：运行中每 5s 检查目标盘；消失 → 暂停，回来 → 续传 */
  private startDeviceWatch(task: BackupTask): void {
    this.stopDeviceWatch(task.id)
    const timer = setInterval(async () => {
      const st = this.states.get(task.id)
      if (!st || (st.phase !== 'running' && st.phase !== 'paused')) {
        this.stopDeviceWatch(task.id)
        return
      }
      const present = (await this.resolveTargetRoot(task)) !== null
      if (!present && st.phase === 'running') {
        this.paused.add(task.id)
        st.phase = 'paused'
        st.reason = 'device-lost'
        this.push({ ...st })
        this.addLog(task.id, 'device-lost', '目标盘已移除 —— 任务自动暂停，插回后自动续传')
      } else if (present && st.phase === 'paused' && st.reason === 'device-lost') {
        this.paused.delete(task.id)
        st.phase = 'running'
        st.reason = ''
        this.push({ ...st })
        this.addLog(task.id, 'device-back', '目标盘已接入 —— 自动续传')
      }
    }, DEVICE_POLL_MS)
    this.deviceWatch.set(task.id, timer)
  }

  private stopDeviceWatch(id: string): void {
    const t = this.deviceWatch.get(id)
    if (t) clearInterval(t)
    this.deviceWatch.delete(id)
  }

  pause(id: string): { ok: boolean; error?: string } {
    const st = this.states.get(id)
    if (!st || st.phase !== 'running') return { ok: false, error: '任务不在运行中' }
    this.paused.add(id)
    return { ok: true }
  }

  async resume(id: string): Promise<{ ok: boolean; error?: string }> {
    const st = this.states.get(id)
    if (!st || st.phase !== 'paused') return { ok: false, error: '任务不在暂停态' }
    const task = this.tasks().find((t) => t.id === id)
    if (!task) return { ok: false, error: '任务不存在' }
    if (st.reason === 'device-lost' && (await this.resolveTargetRoot(task)) === null) {
      return { ok: false, error: '目标盘仍未接入' }
    }
    this.paused.delete(id)
    this.addLog(id, 'resume', '手动续传')
    return { ok: true }
  }

  stop(id: string): { ok: boolean; error?: string } {
    const st = this.states.get(id)
    if (!st || (st.phase !== 'running' && st.phase !== 'paused')) return { ok: false, error: '任务不在运行中' }
    this.cancelled.add(id)
    this.paused.delete(id)
    return { ok: true }
  }

  /** 任务主体：逐源目录 → 逐文件 增量拷贝（只增不改不删） */
  private async execute(task: BackupTask, targetRoot: string): Promise<void> {
    const st = this.states.get(task.id)!
    for (const src of task.sources) {
      if (this.cancelled.has(task.id)) break
      if (!existsSync(src)) {
        st.errors.push(`源目录不存在：${src}`)
        continue
      }
      await this.copyDir(task, src, src, targetRoot, st)
    }
    this.stopDeviceWatch(task.id)
    st.finishedAt = Date.now()
    if (this.cancelled.has(task.id)) {
      st.phase = 'stopped'
      this.addLog(task.id, 'stop', `已停止 —— 拷贝 ${st.copied} / 跳过 ${st.skipped} / 冲突 ${st.conflicts}`)
    } else if (st.phase === 'paused') {
      // 拔盘暂停：保持 paused，由设备探活或手动续传恢复
      this.addLog(task.id, 'pause', `拔盘暂停 —— 拷贝 ${st.copied} / 跳过 ${st.skipped} / 冲突 ${st.conflicts}`)
      return
    } else {
      st.phase = 'done'
      const task2 = this.tasks().find((t) => t.id === task.id)
      if (task2) {
        task2.lastRunAt = Date.now()
        this.saveTasks(this.tasks().map((t) => (t.id === task.id ? task2 : t)))
      }
      this.addLog(task.id, 'done', `完成 —— 拷贝 ${st.copied} 个 / ${formatBytes(st.bytes)}，跳过 ${st.skipped}，冲突 ${st.conflicts}${st.errors.length ? `，错误 ${st.errors.length}` : ''}`)
    }
    this.push({ ...st })
  }

  private async copyDir(task: BackupTask, sourceRoot: string, dir: string, targetRoot: string, st: BackupRunState): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      st.errors.push(`读取失败 ${dir}：${(e as Error).message}`)
      return
    }
    for (const e of entries) {
      // 拔盘 / 手动暂停：等待恢复（每 2s 检查），取消则直接返回
      while (this.paused.has(task.id) && !this.cancelled.has(task.id)) {
        await new Promise((r) => setTimeout(r, 2_000))
      }
      if (this.cancelled.has(task.id)) return

      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await this.copyDir(task, sourceRoot, full, targetRoot, st)
        continue
      }
      if (!e.isFile()) continue

      const target = resolveTargetPath(targetRoot, task.name, sourceRoot, full)
      if (!target.ok || !target.path) {
        st.errors.push(`${full}：${target.reason}`)
        continue
      }
      try {
        const srcStat = await fs.stat(full)
        let tgtStat: import('node:fs').Stats | null = null
        try {
          tgtStat = await fs.stat(target.path)
        } catch {
          tgtStat = null
        }
        const decision = decideFile(!!tgtStat, srcStat.size, srcStat.mtimeMs, tgtStat?.size ?? 0, tgtStat?.mtimeMs ?? 0)
        if (decision === 'skip') {
          st.skipped++
          continue
        }
        if (decision === 'conflict') {
          // 只增不改不删：目标已存在且不同 —— 不覆盖，记冲突
          st.conflicts++
          continue
        }
        st.current = full
        await fs.mkdir(dirname(target.path), { recursive: true })
        await fs.copyFile(full, target.path)
        // 保留修改时间，让下一次增量比对稳定
        await fs.utimes(target.path, srcStat.atime, srcStat.mtime)
        st.copied++
        st.bytes += srcStat.size
        this.push({ ...st })
      } catch (err) {
        st.errors.push(`${full}：${(err as Error).message}`)
        if (st.errors.length > 100) {
          this.addLog(task.id, 'error', '错误过多（>100），任务中止')
          this.cancelled.add(task.id)
          return
        }
      }
    }
  }
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
