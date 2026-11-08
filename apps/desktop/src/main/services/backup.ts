/**
 * N1 备份同步 v2（v6.2）—— 审阅式镜像备份。
 *
 * v1 的教训（全部真机踩坑）：
 *  1. PS 5.1 不支持 `??` 运算符 —— drives() 的 CIM 脚本用了 PS7 语法，
 *     解析直接报错 → 设备列表永远为空（「插入 U 盘检测不到」的根因）。
 *     **铁律：所有内嵌 PS 脚本只写 PowerShell 5.1 兼容语法。**
 *  2. v1 只增不改不删 + 冲突静默跳过 —— 对「镜像已有目录」场景完全不可用
 *     （旧文件永远不更新，还堆冲突）。v2 改为审阅式：
 *     preview 出 新增/更新/目标多出 三区 → 用户选策略 → 单向覆盖 + 审阅删除。
 *
 * 路径映射（用户定稿，两种都要）：
 *  - explicit（默认）：任务里显式指定「源 → 目标」映射对，如 D:\Demo → E:\Demo；
 *    兼容手动拷贝习惯，目标路径完全由用户掌控。
 *  - mirror：盘符镜像，源 D:\work\app → 目标盘 X:\D\work\app 自动映射。
 *
 * 安全边界：
 *  - 执行只写「目标映射根」之内（resolveTargetPath 越界拦截）；
 *  - 「目标多出」的删除必须用户在预览报告里确认后才执行；
 *  - 定时无人值守运行用安全策略：只新增+更新覆盖，绝不删除。
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, dirname, relative, isAbsolute, resolve, basename } from 'node:path'
import type { BackupDriveInfo, BackupLogEntry, BackupPreviewResult, BackupRunState, BackupTask } from '@shared/types'

const LOG_CAP = 200
const DEVICE_POLL_MS = 5_000
/** 预览采样上限：每区最多返回的明细条数（全量统计仍计算） */
const SAMPLE_CAP = 200

/** v6.2 默认排除目录名（备份开发文件夹必须跳过这些，否则拷不完） */
export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '__pycache__', '.gradle', '.idea', '.vscode', '.cache', 'cache', '.next', '.nuxt'
]

// ───────────────── 纯函数（单测锁定） ─────────────────

export type FileAction = 'add' | 'update' | 'same'

/**
 * 同步决策：
 *   目标无 → add；双方一致（size+mtime ±2s）→ same；
 *   目标有但不同 → update（源为准单向覆盖，经预览审阅）。
 * 「源无目标有」属 delete-extra，由预览的 extras 扫描单独归类。
 */
export function decideFile(
  targetExists: boolean,
  srcSize: number,
  srcMtimeMs: number,
  targetSize: number,
  targetMtimeMs: number
): FileAction {
  if (!targetExists) return 'add'
  if (targetSize === srcSize && Math.abs(targetMtimeMs - srcMtimeMs) < 2000) return 'same'
  return 'update'
}

/** 排除判定：相对路径任一段命中排除名单即跳过 */
export function isExcluded(relPath: string, excludeDirs: readonly string[]): boolean {
  const lower = relPath.toLowerCase()
  for (const ex of excludeDirs) {
    const e = ex.toLowerCase().replace(/^[\\/]+|[\\/]+$/g, '')
    if (!e) continue
    if (lower === e || lower.startsWith(e + '/') || lower.startsWith(e + '\\')) return true
    if (lower.includes('\\' + e + '\\') || lower.includes('/' + e + '/')) return true
  }
  return false
}

/** 目标路径拼装与越界校验（v2 双模式） */
export function resolveTargetPath(
  targetRoot: string,
  taskName: string,
  sourceRoot: string,
  filePath: string,
  mode: 'explicit' | 'mirror' = 'explicit'
): { ok: boolean; path?: string; reason?: string } {
  const rel = relative(resolve(sourceRoot), resolve(filePath))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: '源路径越出源根目录' }
  if (mode === 'mirror') {
    // 盘符镜像：源 D:\work\app\x.ts → 目标根\D\work\app\x.ts
    const srcRoot = resolve(sourceRoot)
    const drive = srcRoot.slice(0, 2) // "D:"
    const rest = srcRoot.slice(3) // "work\app"
    const mirrorRel = drive[0] + (rest ? '\\' + rest : '')
    return { ok: true, path: join(targetRoot, mirrorRel, rel) }
  }
  // explicit：目标 = 显式 to 目录 + 相对路径
  return { ok: true, path: join(targetRoot, rel) }
}

// ───────────────── 服务 ─────────────────

interface StoreLike {
  getKv(k: string): string | null
  setKv(k: string, v: string): void
}

export interface PreviewEntry {
  path: string
  sizeBytes: number
  targetPath: string
}

export interface PreviewInternal {
  taskId: string
  add: number
  update: number
  deleteExtra: number
  same: number
  bytesToAdd: number
  sampleAdds: PreviewEntry[]
  sampleUpdates: PreviewEntry[]
  sampleExtras: PreviewEntry[]
  errors: string[]
  at: number
}

export class BackupService {
  private states = new Map<string, BackupRunState>()
  private cancelled = new Set<string>()
  private paused = new Set<string>()
  private deviceWatch = new Map<string, ReturnType<typeof setInterval>>()
  private onProgress: ((s: BackupRunState) => void) | null = null
  /** 预览结果缓存（taskId → 预览），执行前校验 freshness */
  private previews = new Map<string, PreviewInternal>()
  private previewCancelled = new Set<string>()
  private onPreviewProgress: ((p: { taskId: string; files: number }) => void) | null = null

  constructor(
    private store: StoreLike,
    private psJson: <T>(script: string, timeoutMs?: number) => Promise<T>
  ) {}

  setProgressSink(fn: (s: BackupRunState) => void): void {
    this.onProgress = fn
  }

  setPreviewProgressSink(fn: (p: { taskId: string; files: number }) => void): void {
    this.onPreviewProgress = fn
  }

  cancelPreview(id: string): void {
    this.previewCancelled.add(id)
  }

  // ── 驱动器（PS 5.1 兼容！禁用 ?? 等 PS7 语法） ──

  async drives(): Promise<BackupDriveInfo[]> {
    try {
      const rows = await this.psJson<{ letter: string; label: string; total: number; free: number; dtype: number }[]>(
        `
$out = New-Object System.Collections.ArrayList
try {
  $disks = Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction Stop
  foreach ($d in $disks) {
    $sz = 0.0; if ($d.Size) { $sz = [double]$d.Size }
    $fr = 0.0; if ($d.FreeSpace) { $fr = [double]$d.FreeSpace }
    [void]$out.Add([pscustomobject]@{
      letter = [string]$d.DeviceID
      label = [string]$d.VolumeName
      total = $sz
      free = $fr
      dtype = [int]$d.DriveType
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

  // ── 任务 CRUD（v2 数据结构，自动迁移 v1） ──

  tasks(): BackupTask[] {
    try {
      const raw = this.store.getKv('backup:tasks')
      const list = raw ? (JSON.parse(raw) as BackupTask[]) : []
      return list.map((t) => this.migrateTask(t))
    } catch {
      return []
    }
  }

  /** v1 任务（volumeLabel+sources）→ v2；无盘符可落时降级为盘符镜像（兜底避免 to 空被校验拒死） */
  private migrateTask(t: BackupTask): BackupTask {
    const legacy = t as BackupTask & { sources?: string[] }
    if (!t.mappings && legacy.sources?.length) {
      const root = t.driveLetter ? t.driveLetter + '\\' : ''
      if (root) {
        t.mappings = legacy.sources.map((s: string) => ({ from: s, to: join(root, t.name.replace(/[\\/:*?"<>|]/g, '_')) }))
        t.mode = 'explicit'
      } else {
        t.mappings = legacy.sources.map((s: string) => ({ from: s }))
        t.mode = 'mirror'
      }
    }
    return t
  }

  private saveTasks(list: BackupTask[]): void {
    this.store.setKv('backup:tasks', JSON.stringify(list))
  }

  saveTask(input: Partial<BackupTask> & { name: string }): { ok: boolean; id?: string; error?: string } {
    const name = (input.name ?? '').trim()
    if (!name || name.length > 60) return { ok: false, error: '任务名必填且 ≤60 字符' }
    const mode = input.mode === 'mirror' ? 'mirror' : 'explicit'
    const mappings = (input.mappings ?? []).filter((m) => m.from && isAbsolute(m.from))
    if (mappings.length === 0) return { ok: false, error: '至少一个有效的源目录（绝对路径）' }
    if (mappings.length > 20) return { ok: false, error: '源目录最多 20 个' }
    for (const m of mappings) {
      if (mode === 'explicit' && !(m.to && isAbsolute(m.to))) return { ok: false, error: `显式映射需要目标路径：${m.from}` }
    }
    const tos = mappings.map((m) => resolve(m.to || '').toLowerCase())
    for (let i = 0; i < tos.length; i++) {
      for (let j = 0; j < tos.length; j++) {
        if (i !== j && tos[j].startsWith(tos[i] + '\\')) return { ok: false, error: '目标目录存在嵌套，会导致重复拷贝' }
      }
    }
    // 镜像模式的目标盘不能是某个源目录所在盘（自己拷自己）
    const excludeDirs = (input.excludeDirs ?? []).slice(0, 50)
    const list = this.tasks()
    const finalId = input.id ?? ''
    const res = (() => {
      if (finalId) {
        const i = list.findIndex((t) => t.id === finalId)
        if (i < 0) return { ok: false as const, error: '任务不存在' }
        list[i] = { ...list[i], name, mode, mappings, excludeDirs, driveLetter: input.driveLetter, volumeLabel: input.volumeLabel ?? '', lastRunAt: list[i].lastRunAt }
        this.saveTasks(list)
        return { ok: true as const, id: finalId }
      }
      const id = `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      list.push({
        id,
        name,
        mode,
        mappings,
        excludeDirs,
        driveLetter: input.driveLetter,
        volumeLabel: input.volumeLabel ?? '',
        createdAt: Date.now()
      })
      this.saveTasks(list)
      return { ok: true as const, id }
    })()
    // 任务变更后旧预览失效（必须重新预览）
    if (res.ok) this.previews.delete(res.id!)
    return res
  }

  deleteTask(id: string): { ok: boolean; error?: string } {
    const list = this.tasks()
    const i = list.findIndex((t) => t.id === id)
    if (i < 0) return { ok: false, error: '任务不存在' }
    const st = this.states.get(id)
    if (st && (st.phase === 'running' || st.phase === 'paused')) return { ok: false, error: '任务正在运行，先停止再删除' }
    list.splice(i, 1)
    this.saveTasks(list)
    this.previews.delete(id)
    return { ok: true }
  }

  // ── 预览（审阅式核心） ──

  async preview(id: string): Promise<{ ok: boolean; error?: string; result?: BackupPreviewResult; cancelled?: boolean }> {
    const task = this.tasks().find((t) => t.id === id)
    if (!task) return { ok: false, error: '任务不存在' }
    const targetRoot = await this.resolveTargetRoot(task)
    if (!targetRoot) {
      this.addLog(id, 'error', `目标盘未接入（卷标「${task.volumeLabel || task.driveLetter}」）`)
      return { ok: false, error: `目标盘未接入（卷标「${task.volumeLabel || task.driveLetter}」）` }
    }
    const excludeDirs = [...DEFAULT_EXCLUDE_DIRS, ...(task.excludeDirs ?? [])]
    const counts = { add: 0, update: 0, deleteExtra: 0, same: 0 }
    const samples = { add: [] as PreviewEntry[], update: [] as PreviewEntry[], targetExtras: [] as PreviewEntry[] }
    let bytesToAdd = 0
    const errors: string[] = []
    this.previewCancelled.delete(id)
    let seen = 0
    let lastTick = 0
    const tick = (): boolean => {
      // 返回 false 表示已取消；每 800 个文件上报一次进度
      seen++
      const now = Date.now()
      if (now - lastTick > 300) {
        lastTick = now
        try {
          this.onPreviewProgress?.({ taskId: id, files: seen })
        } catch {
          /* ignore */
        }
      }
      return !this.previewCancelled.has(id)
    }

    for (const m of task.mappings) {
      if (!existsSync(m.from)) {
        errors.push(`源目录不存在：${m.from}`)
        continue
      }
      const targetBase = task.mode === 'explicit' && m.to ? resolve(m.to) : targetRoot
      const counter = { n: 0 }
      const r = await this.previewDir(task, m.from, m.from, targetBase, targetRoot, excludeDirs, counts, samples, errors, counter, tick)
      if (!r) return { ok: false, cancelled: true, error: '预览已取消' }
      bytesToAdd += counter.n
      if (task.mode === 'explicit' ? existsSync(targetBase) : true) {
        const r2 = await this.previewExtras(task, m.from, targetBase, targetRoot, excludeDirs, counts, samples, errors, tick)
        if (!r2) return { ok: false, cancelled: true, error: '预览已取消' }
      }
    }

    const result: BackupPreviewResult = {
      taskId: id,
      add: counts.add,
      update: counts.update,
      deleteExtra: counts.deleteExtra,
      same: counts.same,
      bytesToAdd,
      sampleAdds: samples.add,
      sampleUpdates: samples.update,
      sampleExtras: samples.targetExtras,
      errors,
      at: Date.now()
    }
    this.previews.set(id, {
      taskId: id,
      add: counts.add,
      update: counts.update,
      deleteExtra: counts.deleteExtra,
      same: counts.same,
      bytesToAdd,
      sampleAdds: samples.add,
      sampleUpdates: samples.update,
      sampleExtras: samples.targetExtras,
      errors,
      at: result.at
    })
    this.addLog(id, 'run', `预览完成 —— 新增 ${counts.add} / 更新 ${counts.update} / 目标多出 ${counts.deleteExtra} / 一致 ${counts.same}`)
    return { ok: true, result }
  }

  private async previewDir(
    task: BackupTask,
    sourceRoot: string,
    dir: string,
    targetBase: string,
    mirrorFallbackRoot: string,
    excludeDirs: readonly string[],
    counts: { add: number; update: number; deleteExtra: number; same: number },
    samples: { add: PreviewEntry[]; update: PreviewEntry[]; targetExtras: PreviewEntry[] },
    errors: string[],
    bytesCounter: { n: number },
    tick: () => boolean
  ): Promise<boolean> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      errors.push(`读取失败 ${dir}：${(e as Error).message}`)
      return true
    }
    const targetRoot = task.mode === 'explicit' ? targetBase : mirrorFallbackRoot
    for (const e of entries) {
      if (!tick()) return false
      const full = join(dir, e.name)
      if (e.isSymbolicLink()) continue // 防循环、防拷出盘外
      const relFromSrc = relative(sourceRoot, full)
      if (isExcluded(relFromSrc, excludeDirs)) continue
      if (e.isDirectory()) {
        const r = await this.previewDir(task, sourceRoot, full, targetBase, mirrorFallbackRoot, excludeDirs, counts, samples, errors, bytesCounter, tick)
        if (!r) return false
        continue
      }
      if (!e.isFile()) continue
      const tp = resolveTargetPath(targetRoot, task.name, sourceRoot, full, task.mode === 'mirror' ? 'mirror' : 'explicit')
      if (!tp.ok || !tp.path) {
        errors.push(`${full}：${tp.reason}`)
        continue
      }
      try {
        const srcStat = await fs.stat(full)
        let tgtStat: import('node:fs').Stats | null = null
        try {
          tgtStat = await fs.stat(tp.path)
        } catch {
          tgtStat = null
        }
        const action = decideFile(!!tgtStat, srcStat.size, srcStat.mtimeMs, tgtStat?.size ?? 0, tgtStat?.mtimeMs ?? 0)
        if (action === 'add') {
          counts.add++
          bytesCounter.n += srcStat.size
          if (samples.add.length < SAMPLE_CAP) samples.add.push({ path: full, sizeBytes: srcStat.size, targetPath: tp.path })
        } else if (action === 'update') {
          counts.update++
          if (samples.update.length < SAMPLE_CAP) samples.update.push({ path: full, sizeBytes: srcStat.size, targetPath: tp.path })
        } else {
          counts.same++
        }
      } catch (err) {
        errors.push(`${full}：${(err as Error).message}`)
      }
    }
    return true
  }

  /** 目标多出：目标树里有、源里没有的文件（审阅后删除候选） */
  private async previewExtras(
    task: BackupTask,
    sourceRoot: string,
    targetBase: string,
    mirrorFallbackRoot: string,
    excludeDirs: readonly string[],
    counts: { add: number; update: number; deleteExtra: number; same: number },
    samples: { add: PreviewEntry[]; update: PreviewEntry[]; targetExtras: PreviewEntry[] },
    errors: string[],
    tick: () => boolean
  ): Promise<boolean> {
    const walk = async (dir: string): Promise<boolean> => {
      if (!tick()) return false
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        errors.push(`读取目标失败 ${dir}：${(e as Error).message}`)
        return true
      }
      for (const e of entries) {
        if (!tick()) return false
        const full = join(dir, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) {
          const r = await walk(full)
          if (!r) return false
          continue
        }
        if (!e.isFile()) continue
        const srcPath = this.extraSourcePath(task, sourceRoot, targetBase, mirrorFallbackRoot, full)
        if (!srcPath) continue
        if (isExcluded(relative(sourceRoot, srcPath) || '', excludeDirs)) continue
        if (!existsSync(srcPath)) {
          counts.deleteExtra++
          if (samples.targetExtras.length < SAMPLE_CAP) {
            let sz = 0
            try {
              sz = (await fs.stat(full)).size
            } catch {
              /* ignore */
            }
            samples.targetExtras.push({ path: full, sizeBytes: sz, targetPath: srcPath })
          }
        }
      }
      return true
    }
    return walk(targetBase)
  }

  /** 反查目标文件对应的源路径；越界返回 null */
  private extraSourcePath(task: BackupTask, sourceRoot: string, targetBase: string, mirrorRoot: string, targetFile: string): string | null {
    if (task.mode === 'explicit') {
      const rel = relative(resolve(targetBase), resolve(targetFile))
      if (!rel || rel.startsWith('..')) return null
      return join(sourceRoot, rel)
    }
    const relFromTargetRoot = relative(resolve(mirrorRoot), resolve(targetFile))
    if (!relFromTargetRoot || relFromTargetRoot.startsWith('..')) return null
    const norm = relFromTargetRoot.replace(/^[\\/]/, '')
    if (norm.length < 3) return null
    return join(norm.slice(0, 1) + ':', norm.slice(3))
  }

  // ── 执行 ──

  async run(id: string, opts?: { deleteExtras?: boolean; requireFreshPreview?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const task = this.tasks().find((t) => t.id === id)
    if (!task) return { ok: false, error: '任务不存在' }
    const cur = this.states.get(id)
    if (cur && cur.phase === 'running') return { ok: false, error: '任务已在运行' }
    const targetRoot = await this.resolveTargetRoot(task)
    if (!targetRoot) {
      this.addLog(id, 'error', `目标盘未接入（卷标「${task.volumeLabel || task.driveLetter}」）`)
      return { ok: false, error: `目标盘未接入（卷标「${task.volumeLabel || task.driveLetter}」）` }
    }
    if (opts?.requireFreshPreview && !this.previews.has(id)) {
      return { ok: false, error: '请先执行「预览差异」再开始备份' }
    }
    const deleteExtras = opts?.deleteExtras ?? false

    // 容量预检：预览统计的新增字节 × 1.05 余量 + 100MB 底线，不足直接拒绝
    if (opts?.requireFreshPreview) {
      const pv = this.previews.get(id)
      if (pv && pv.bytesToAdd > 0) {
        const drives = await this.drives()
        const d = drives.find((x) => targetRoot.toLowerCase().startsWith(x.letter.toLowerCase()))
        const need = pv.bytesToAdd * 1.05 + 100 * 1024 * 1024
        if (d && d.freeBytes < need) {
          this.addLog(id, 'error', `目标盘空间不足：需约 ${formatBytes(pv.bytesToAdd)}，剩余 ${formatBytes(d.freeBytes)}`)
          return { ok: false, error: `目标盘空间不足：需约 ${formatBytes(pv.bytesToAdd)}，剩余 ${formatBytes(d.freeBytes)}` }
        }
      }
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
    this.addLog(id, 'run', `开始备份（${task.mode === 'mirror' ? '盘符镜像' : '显式映射'}${deleteExtras ? ' · 含审阅删除' : ''}）`)

    this.startDeviceWatch(task)
    void this.execute(task, targetRoot, deleteExtras).catch((e) => {
      st.phase = 'error'
      st.finishedAt = Date.now()
      this.push({ ...st })
      this.addLog(id, 'error', (e as Error).message)
      this.stopDeviceWatch(id)
    })
    return { ok: true }
  }

  /** 定时无人值守：只新增+更新覆盖，绝不删除；不要求预览 */
  async scheduledRun(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.run(id, { deleteExtras: false, requireFreshPreview: false })
  }

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

  /** 任务主体：按排除规则同步（add + update 单向覆盖；deleteExtras 时删目标多出） */
  private async execute(task: BackupTask, targetRoot: string, deleteExtras: boolean): Promise<void> {
    const st = this.states.get(task.id)!
    const excludeDirs = [...DEFAULT_EXCLUDE_DIRS, ...(task.excludeDirs ?? [])]
    const errors: string[] = []

    for (const m of task.mappings) {
      if (this.cancelled.has(task.id)) break
      if (!existsSync(m.from)) {
        st.errors.push(`源目录不存在：${m.from}`)
        continue
      }
      const targetBase = task.mode === 'explicit' && m.to ? resolve(m.to) : targetRoot
      await this.syncDir(task, m.from, m.from, targetBase, targetRoot, excludeDirs, st, errors)
      if (deleteExtras && existsSync(targetBase) && !this.cancelled.has(task.id)) {
        await this.deleteExtras(task, m.from, targetBase, targetRoot, excludeDirs, st, errors)
      }
    }

    this.stopDeviceWatch(task.id)
    st.finishedAt = Date.now()
    if (this.cancelled.has(task.id)) {
      st.phase = 'stopped'
      this.addLog(task.id, 'stop', `已停止 —— 拷贝 ${st.copied} / 跳过 ${st.skipped} / 删除多出 ${st.conflicts}`)
    } else if (st.phase === 'paused') {
      this.addLog(task.id, 'pause', `拔盘暂停 —— 拷贝 ${st.copied} / 跳过 ${st.skipped}`)
      return
    } else {
      st.phase = 'done'
      const t2 = this.tasks().find((t) => t.id === task.id)
      if (t2) {
        t2.lastRunAt = Date.now()
        this.saveTasks(this.tasks().map((t) => (t.id === task.id ? t2 : t)))
      }
      this.addLog(task.id, 'done', `完成 —— 拷贝 ${st.copied} 个 / ${formatBytes(st.bytes)}，跳过 ${st.skipped}，删除多出 ${st.conflicts}${st.errors.length ? `，错误 ${st.errors.length}` : ''}`)
    }
    this.push({ ...st })
  }

  private async syncDir(
    task: BackupTask,
    sourceRoot: string,
    dir: string,
    targetBase: string,
    mirrorFallbackRoot: string,
    excludeDirs: readonly string[],
    st: BackupRunState,
    errors: string[]
  ): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      errors.push(`读取失败 ${dir}：${(e as Error).message}`)
      return
    }
    const targetRoot = task.mode === 'explicit' ? targetBase : mirrorFallbackRoot
    for (const e of entries) {
      while (this.paused.has(task.id) && !this.cancelled.has(task.id)) {
        await new Promise((r) => setTimeout(r, 2_000))
      }
      if (this.cancelled.has(task.id)) return

      const full = join(dir, e.name)
      const relFromSrc = relative(sourceRoot, full)
      if (isExcluded(relFromSrc, excludeDirs)) continue
      if (e.isDirectory()) {
        await this.syncDir(task, sourceRoot, full, targetBase, mirrorFallbackRoot, excludeDirs, st, errors)
        continue
      }
      if (!e.isFile()) continue

      const tp = resolveTargetPath(targetRoot, task.name, sourceRoot, full, task.mode === 'mirror' ? 'mirror' : 'explicit')
      if (!tp.ok || !tp.path) {
        errors.push(`${full}：${tp.reason}`)
        continue
      }
      try {
        const srcStat = await fs.stat(full)
        let tgtStat: import('node:fs').Stats | null = null
        try {
          tgtStat = await fs.stat(tp.path)
        } catch {
          tgtStat = null
        }
        const decision = decideFile(!!tgtStat, srcStat.size, srcStat.mtimeMs, tgtStat?.size ?? 0, tgtStat?.mtimeMs ?? 0)
        if (decision === 'same') {
          st.skipped++
          continue
        }
        st.current = full
        const dst = longPath(tp.path)
        await fs.mkdir(longPath(dirname(tp.path)), { recursive: true })
        await fs.copyFile(longPath(full), dst)
        await fs.utimes(dst, srcStat.atime, srcStat.mtime)
        st.copied++
        st.bytes += srcStat.size
        this.push({ ...st })
      } catch (err) {
        errors.push(`${full}：${(err as Error).message}`)
        if (errors.length > 100) {
          this.addLog(task.id, 'error', '错误过多（>100），任务中止')
          this.cancelled.add(task.id)
          return
        }
      }
    }
  }

  /** 审阅删除：删除目标树里源中不存在的文件（仅显式确认 deleteExtras 后调用） */
  private async deleteExtras(
    task: BackupTask,
    sourceRoot: string,
    targetBase: string,
    mirrorFallbackRoot: string,
    excludeDirs: readonly string[],
    st: BackupRunState,
    errors: string[]
  ): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      if (this.cancelled.has(task.id)) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        errors.push(`读取目标失败 ${dir}：${(e as Error).message}`)
        return
      }
      for (const e of entries) {
        while (this.paused.has(task.id) && !this.cancelled.has(task.id)) {
          await new Promise((r) => setTimeout(r, 2_000))
        }
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          await walk(full)
          try {
            const rest = await fs.readdir(full)
            if (rest.length === 0) await fs.rmdir(full)
          } catch {
            /* ignore */
          }
          continue
        }
        if (!e.isFile()) continue
        const srcPath = this.extraSourcePath(task, sourceRoot, targetBase, mirrorFallbackRoot, full)
        if (!srcPath) continue
        if (isExcluded(relative(sourceRoot, srcPath) || '', excludeDirs)) continue
        if (!existsSync(srcPath)) {
          try {
            await fs.unlink(full)
            st.conflicts++ // 复用计数：删除多出数
          } catch (err) {
            errors.push(`删除失败 ${full}：${(err as Error).message}`)
          }
        }
      }
    }
    await walk(targetBase)
  }

  // ── 通用 ──

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

/** Windows 长路径（>240 字符）加 \\?\ 前缀，避免 MAX_PATH 限制 */
function longPath(p: string): string {
  return p.length > 240 && !p.startsWith('\\\\?\\') ? '\\\\?\\' + p : p
}
