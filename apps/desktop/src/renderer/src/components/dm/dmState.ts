/**
 * dmState.ts —— DiskMirror 风格 4 页的共享状态层
 *
 * 只做「读现有 IPC + 归一化」，不新建任何主进程能力：
 *   backup:tasks / backup:drives / backup:state / backup:log / backup:progress
 *   audit:list / junkSummary / listSoftware / getSettings
 *
 * 设计取舍（方案里已如实标注）：
 *  - BackupRunState 没有 total/totalBytes/speed → 进度分母取 preview 缓存，
 *    取不到时 UI 走 indeterminate；速度按 bytes ÷ 已用时估算。
 *  - SoftGraph 没有 pending 重试队列实体 → 由 BackupRunState.errors 聚合。
 *  - BackupLogEntry 没有 added/updated/deleted 分项计数 → 运行记录表用
 *    copied/skipped/errors/bytes 填能填的列，其余列显示「—」。
 */
import { computed, ref } from 'vue'
import type {
  AppSettings,
  AuditEntry,
  BackupDriveInfo,
  BackupLogEntry,
  BackupPreviewResult,
  BackupRunState,
  BackupTask,
  JunkSummary,
  SoftwareItem
} from '@shared/types'
import { formatBytes } from '@shared/util'
import { createThrottle, showSummary, startMotion, stopMotion, trackPhase } from './dmMotion'

export type DmTab = 'dm-dashboard' | 'dm-groups' | 'dm-settings'
export type DmLevel = 'info' | 'success' | 'warn' | 'error'

export const DM_TABS: { key: DmTab; label: string; hint: string }[] = [
  { key: 'dm-dashboard', label: '仪表盘', hint: '全局状态与 12 个模块概览' },
  { key: 'dm-groups', label: '备份同步', hint: '任务 · 活动 · 日志 · 拓扑' },
  { key: 'dm-settings', label: '设置', hint: '参数与通知' }
]

/**
 * v6.2.3 侧栏平铺列表：不再区分「主 Tab / 工具」两组，
 * 13 个入口按功能域排序，设置固定最末。顺序由 @shared/nav 的 DM_FLAT_ORDER 锁定并单测校验。
 */
export interface DmNavItem {
  key: string
  label: string
  hint: string
}
export const DM_NAV: DmNavItem[] = [
  { key: 'dm-dashboard', label: '仪表盘', hint: '全局状态与 12 个模块概览' },
  { key: 'graph', label: '软件图谱', hint: '装了什么 · 依赖关系' },
  { key: 'junk', label: '垃圾清理', hint: '19 类规则扫描审阅' },
  { key: 'upgrade', label: '软件升级', hint: 'winget 可升级列表' },
  { key: 'manifest', label: '装机清单', hint: '导出 CSV / winget 脚本' },
  { key: 'registry', label: '注册表残留', hint: '卸载表死条目清理' },
  { key: 'startup', label: '自启动管理', hint: 'Run / 启动文件夹 启停' },
  { key: 'treemap', label: '空间树图', hint: '目录占用可视化' },
  { key: 'images', label: '相似图片', hint: 'aHash 分组查重' },
  { key: 'schedule', label: '定时调度', hint: '静默清理计划与状态' },
  { key: 'market', label: '插件市场', hint: '浮窗插件安装更新' },
  { key: 'dm-groups', label: '备份同步', hint: '任务 · 活动 · 日志 · 拓扑' },
  { key: 'dm-settings', label: '设置', hint: '参数与通知' }
]

export function isDmTab(v: string): v is DmTab {
  return DM_TABS.some((t) => t.key === v)
}

// ── 原始数据 ──
export const dmTasks = ref<BackupTask[]>([])
export const dmDrives = ref<BackupDriveInfo[]>([])
export const dmRunStates = ref<Record<string, BackupRunState>>({})
export const dmBackupLogs = ref<BackupLogEntry[]>([])
export const dmAudit = ref<AuditEntry[]>([])
export const dmJunk = ref<JunkSummary | null>(null)
export const dmSoftware = ref<SoftwareItem[]>([])
export const dmSettings = ref<AppSettings | null>(null)
export const dmVersion = ref('—')

/** 每个任务最近一次 preview 的文件总数（进度条分母） */
export const dmPreviewTotals = ref<Record<string, number>>({})


// ── 总仪表盘：12 个模块的概览数据（全部来自现成 IPC，不改主进程） ──
export interface DmOverview {
  software: number
  portable: number
  recent: number
  junkItems: number
  junkBytes: number
  junkRules: number
  junkLastAt: number
  startupTotal: number
  startupEnabled: number
  winget: number | null
  registryBackups: number
  treemapScanned: boolean
  similarGroups: number | null
  similarBytes: number
  backupEnabled: boolean
  backupMinutes: number
  junkScheduleOn: boolean
  junkHours: number
  backupTasks: number
  backupLastAt: number | null
  backupErrors: number
  plugins: number
  floatOn: boolean
  version: string
  theme: string
  audits: number
  quarantine: number
  loaded: boolean
}

export const dmOverview = ref<DmOverview>({
  software: 0, portable: 0, recent: 0,
  junkItems: 0, junkBytes: 0, junkRules: 0, junkLastAt: 0,
  startupTotal: 0, startupEnabled: 0,
  winget: null, registryBackups: 0,
  treemapScanned: false, similarGroups: null, similarBytes: 0,
  backupEnabled: false, backupMinutes: 30, junkScheduleOn: false, junkHours: 24,
  backupTasks: 0, backupLastAt: null, backupErrors: 0,
  plugins: 0, floatOn: false,
  version: '—', theme: 'light', audits: 0, quarantine: 0,
  loaded: false
})

/** 启动拉一次 + 60 秒轮询：只取本地轻查询，不触发全盘扫描或联网 */
export async function refreshOverview(): Promise<void> {
  const [rules, schedInfo, startups, regBackups, plugins, floatSettings, quarantine, recent] =
    await Promise.all([
      safe(window.api.junkRules(), [] as { id: string }[]),
      safe(
        window.api.junkScheduleInfo(),
        null as { lastRunAt: number; lastCleaned: number; lastFreedBytes: number } | null
      ),
      safe(window.api.startupList(), [] as { enabled?: boolean }[]),
      safe(window.api.registryBackups(), [] as unknown[]),
      safe(window.api.floatPlugins(), [] as unknown[]),
      safe(window.api.floatGetSettings(), null as { enabled?: boolean } | null),
      safe(window.api.quarantineCount(), 0),
      safe(window.api.dashRecent(), [] as unknown[])
    ])
  const st = dmSettings.value
  const states = Object.values(dmRunStates.value)
  const last = Math.max(0, ...dmTasks.value.map((t) => t.lastRunAt || 0))
  dmOverview.value = {
    ...dmOverview.value, // 保留 winget / similar / treemap 的按需扫描结果
    software: dmSoftware.value.length,
    portable: dmSoftware.value.filter((x) => (x as { isPortable?: boolean }).isPortable).length,
    recent: recent.length,
    junkItems: dmJunk.value?.totalCount ?? 0,
    junkBytes: dmJunk.value?.totalBytes ?? 0,
    junkRules: rules.length,
    junkLastAt: schedInfo?.lastRunAt ?? 0,
    startupTotal: startups.length,
    startupEnabled: startups.filter((x) => x.enabled).length,
    registryBackups: regBackups.length,
    backupEnabled: !!st?.backupSchedule?.enabled,
    backupMinutes: Math.round((st?.backupSchedule?.intervalHours ?? 0.5) * 60),
    junkScheduleOn: !!st?.junkSchedule?.enabled,
    junkHours: st?.junkSchedule?.intervalHours ?? 24,
    backupTasks: dmTasks.value.length,
    backupLastAt: last || null,
    backupErrors: states.reduce((n, x) => n + (x.errors?.length ?? 0), 0),
    plugins: plugins.length,
    floatOn: !!floatSettings?.enabled,
    version: dmVersion.value,
    theme: st?.theme ?? 'light',
    audits: dmAudit.value.length,
    quarantine,
    loaded: true
  }
}

/** 重数据按需扫描（winget 可能联网、相似图片全盘哈希、树图目录遍历），用户点卡片按钮才跑 */
export async function scanOverview(kind: 'winget' | 'images' | 'treemap'): Promise<void> {
  if (kind === 'winget') {
    const list = await safe(window.api.wingetList(), [] as unknown[])
    dmOverview.value = { ...dmOverview.value, winget: list.length }
  } else if (kind === 'images') {
    const groups = await safe(window.api.imagesSimilar(), [] as { images?: { sizeBytes?: number }[] }[])
    const bytes = groups.reduce(
      (n, g) => n + (g.images ?? []).slice(1).reduce((m, i) => m + (i.sizeBytes ?? 0), 0),
      0
    )
    dmOverview.value = { ...dmOverview.value, similarGroups: groups.length, similarBytes: bytes }
  } else {
    const d = dmDrives.value[0]
    if (d) await safe(window.api.diskTreemap({ root: d.letter + String.fromCharCode(92), depth: 2 }), { ok: false, error: '' })
    dmOverview.value = { ...dmOverview.value, treemapScanned: true }
  }
}

// ── Toast ──
export interface DmToastItem {
  id: number
  level: DmLevel
  title: string
  message: string
}
export const dmToasts = ref<DmToastItem[]>([])
let toastSeq = 0
export function pushDmToast(level: DmLevel, title: string, message: string): void {
  const id = ++toastSeq
  dmToasts.value.push({ id, level, title, message })
  window.setTimeout(() => {
    dmToasts.value = dmToasts.value.filter((t) => t.id !== id)
  }, 5000)
}

// ── 拉取 ──
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p
  } catch {
    return fallback
  }
}

let refreshing = false
export async function refreshDm(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const [tasks, drives, states, logs, audit, junk, software, settings] = await Promise.all([
      safe(window.api.backupTasks(), [] as BackupTask[]),
      safe(window.api.backupDrives(), [] as BackupDriveInfo[]),
      safe(window.api.backupState(), {} as Record<string, BackupRunState>),
      safe(window.api.backupLog(), [] as BackupLogEntry[]),
      safe(window.api.auditRecent(), [] as AuditEntry[]),
      safe(window.api.junkSummary(), null as JunkSummary | null),
      safe(window.api.listSoftware(), [] as SoftwareItem[]),
      safe(window.api.getSettings(), null as AppSettings | null)
    ])
    dmTasks.value = tasks ?? []
    dmDrives.value = drives ?? []
    dmRunStates.value = states ?? {}
    dmBackupLogs.value = (logs ?? []).slice().sort((a, b) => b.ts - a.ts)
    dmAudit.value = (audit ?? []).slice().sort((a, b) => b.ts - a.ts)
    dmJunk.value = junk
    dmSoftware.value = software ?? []
    if (settings) dmSettings.value = settings
  } finally {
    refreshing = false
  }
}

async function loadVersion(): Promise<void> {
  try {
    const info = (await window.api.appInfo()) as unknown as { version?: string; appVersion?: string }
    dmVersion.value = info?.version ?? info?.appVersion ?? '—'
  } catch {
    dmVersion.value = '—'
  }
}

let timer: number | undefined
let overviewTimer: number | undefined
let offProgress: (() => void) | null = null
let offPreviewProgress: (() => void) | null = null
let started = false

export function startDmState(): void {
  if (started) return
  started = true
  void refreshDm().then(() => void refreshOverview())
  void loadVersion()
  // 100ms 合并逐文件推送；running → done 的瞬间弹出汇总浮层
  const applyProgress = createThrottle<BackupRunState>((s) => {
    dmRunStates.value = { ...dmRunStates.value, [s.taskId]: s }
    if (trackPhase(s) === 'finished') showSummary(s, taskName(s.taskId))
    if (s.phase === 'done' || s.phase === 'error' || s.phase === 'stopped') void refreshDm()
  })
  offProgress = window.api.onBackupProgress(applyProgress)
  startMotion()
  // 预览期间每 400ms 上报一次扫描进度，用于常驻进度条
  offPreviewProgress = window.api.onBackupPreviewProgress((p) => {
    dmPreviewProgress.value = p
  })
  timer = window.setInterval(() => void refreshDm(), 10000)
  overviewTimer = window.setInterval(() => void refreshOverview(), 60000)
}

export function stopDmState(): void {
  stopMotion()
  offProgress?.()
  offProgress = null
  offPreviewProgress?.()
  offPreviewProgress = null
  if (timer) window.clearInterval(timer)
  if (overviewTimer) window.clearInterval(overviewTimer)
  timer = undefined
  overviewTimer = undefined
  started = false
}

// ── 派生数据 ──

export function taskName(id: string): string {
  return dmTasks.value.find((t) => t.id === id)?.name || (id || '全局')
}

export function taskTarget(task: BackupTask): string {
  const first = task?.mappings?.[0]
  return first?.to || (task?.driveLetter ? `${task.driveLetter}:\\` : task?.volumeLabel || '目标路径未解析')
}

export function taskSource(task: BackupTask): string {
  return task?.mappings?.[0]?.from || '—'
}

const PHASE_META: Record<BackupRunState['phase'], { text: string; cls: string }> = {
  running: { text: '同步中', cls: '' },
  paused: { text: '已暂停', cls: 'err' },
  done: { text: '就绪', cls: 'ok' },
  stopped: { text: '已停用', cls: 'mute' },
  error: { text: '已暂停', cls: 'err' }
}

export function groupStatus(taskId: string): { text: string; cls: string } {
  const st = dmRunStates.value[taskId]
  if (!st) return { text: '未就绪', cls: 'mute' }
  return PHASE_META[st.phase] ?? { text: '未就绪', cls: 'mute' }
}

export const dmBusyCount = computed(
  () => Object.values(dmRunStates.value).filter((s) => s.phase === 'running').length
)
export const dmActiveStates = computed(() =>
  Object.values(dmRunStates.value).filter((s) => ['running', 'paused'].includes(s.phase))
)
export const dmReadyCount = computed(
  () => Object.values(dmRunStates.value).filter((s) => s.phase === 'done').length
)

/** 失败队列：由 BackupRunState.errors 聚合 */
export interface DmPendingItem {
  id: string
  groupId: string
  relPath: string
  op: string
  attempts: number
  reason: string
}
export const dmPendingItems = computed<DmPendingItem[]>(() => {
  const out: DmPendingItem[] = []
  for (const [taskId, st] of Object.entries(dmRunStates.value)) {
    for (const [i, err] of (st.errors ?? []).entries()) {
      out.push({
        id: `${taskId}:${i}`,
        groupId: taskId,
        relPath: err,
        op: 'COPY',
        attempts: 1,
        reason: err
      })
    }
  }
  return out
})

/** 全站事件流：备份日志 + 清理审计 */
export interface DmEvent {
  id: string
  ts: number
  level: DmLevel
  kind: string
  path: string
  message: string
  groupId: string
}
const ACTION_META: Record<BackupLogEntry['action'], { level: DmLevel; kind: string; trigger: string }> = {
  run: { level: 'info', kind: 'sync', trigger: '手动触发' },
  pause: { level: 'warn', kind: 'pause', trigger: '手动暂停' },
  resume: { level: 'info', kind: 'resume', trigger: '恢复' },
  stop: { level: 'warn', kind: 'stop', trigger: '手动停止' },
  done: { level: 'success', kind: 'done', trigger: '同步完成' },
  error: { level: 'error', kind: 'error', trigger: '失败' },
  'device-lost': { level: 'warn', kind: 'device', trigger: '设备拔出' },
  'device-back': { level: 'info', kind: 'device', trigger: '设备接入' }
}
export const TRIGGER_TEXT = (a: BackupLogEntry['action']): string => ACTION_META[a]?.trigger ?? a

export const dmEvents = computed<DmEvent[]>(() => {
  const out: DmEvent[] = []
  for (const [i, l] of dmBackupLogs.value.entries()) {
    const meta = ACTION_META[l.action]
    out.push({
      id: `b:${l.ts}:${i}`,
      ts: l.ts,
      level: meta?.level ?? 'info',
      kind: meta?.kind ?? l.action,
      path: taskTarget(dmTasks.value.find((t) => t.id === l.taskId) ?? ({} as BackupTask)),
      message: l.detail,
      groupId: l.taskId
    })
  }
  for (const [i, a] of dmAudit.value.entries()) {
    out.push({
      id: `a:${a.ts}:${i}`,
      ts: a.ts,
      level: a.results.some((r) => !r.ok) ? 'warn' : 'success',
      kind: a.action,
      path: a.results[0]?.path ?? '—',
      message: `${a.action} · ${a.results.length} 项 · 释放 ${formatBytes(a.freedBytes)}`,
      groupId: '清理审计'
    })
  }
  return out.sort((a, b) => b.ts - a.ts)
})

/** 最近同步记录：done/error 日志 + 对应运行态统计 */
export interface DmRunRow {
  id: string
  startedAt: number
  groupId: string
  trigger: string
  added: number
  updated: number | null
  deleted: number | null
  skipped: number
  failed: number
  bytes: number
}
export const dmRunRows = computed<DmRunRow[]>(() =>
  dmBackupLogs.value
    .filter((l) => l.action === 'done' || l.action === 'error')
    .slice(0, 8)
    .map((l, i) => {
      const st = dmRunStates.value[l.taskId]
      return {
        id: `${l.ts}:${i}`,
        startedAt: st?.startedAt ?? l.ts,
        groupId: l.taskId,
        trigger: TRIGGER_TEXT(l.action),
        added: st?.copied ?? 0,
        updated: null,
        deleted: null,
        skipped: st?.skipped ?? 0,
        failed: st?.errors?.length ?? 0,
        bytes: st?.bytes ?? 0
      }
    })
)

/** 顶栏进度摘要 */
export const dmProgressSummary = computed(() => {
  const active = dmActiveStates.value
  if (!active.length) return ''
  const total = active.reduce((s, x) => s + x.copied + x.skipped + x.conflicts, 0)
  return total ? `${total} 个文件` : '正在扫描…'
})

export function fmtTime(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'
}
export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}
export function elapsedText(startedAt?: number): string {
  if (!startedAt) return '—'
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}
export function sizeText(bytes: number): string {
  return formatBytes(bytes, 1)
}


// ── 审阅式同步：预览差异 → 展示 → 确认后执行（复用 v6.2 backupExecute 通道） ──

export interface DmSyncPlan {
  taskId: string
  name: string
  result?: BackupPreviewResult
  error?: string
}
/** 主进程预览进度（taskId / 已扫描文件数 / 当前路径） */
export const dmPreviewProgress = ref<{ taskId: string; files: number; current?: string } | null>(null)

export const dmSyncPlans = ref<DmSyncPlan[]>([])
export const dmSyncPreparing = ref(false)
export const dmSyncExecuting = ref(false)

/**
 * 所有预览的唯一入口（深度校验 / 立即同步 / 组卡片预览都走这里）。
 * checkOnly=true 只汇总差异不弹确认框；否则列出差异供确认后执行。
 */
export async function prepareSync(taskIds: string[], opts?: { checkOnly?: boolean }): Promise<void> {
  if (dmSyncPreparing.value || dmSyncExecuting.value) {
    pushDmToast('info', '预览进行中', '请等待当前预览完成后再操作')
    return
  }
  if (!taskIds.length) return
  dmSyncPreparing.value = true
  dmPreviewProgress.value = null
  pushDmToast('info', '正在预览差异', `正在扫描 ${taskIds.length} 个映射组，上方进度条会显示实时进度`)
  const plans: DmSyncPlan[] = []
  const totals = { ...dmPreviewTotals.value }
  let cancelledAny = false
  let busyRejected = false
  try {
    for (const id of taskIds) {
      const name = taskName(id)
      try {
        const r = await window.api.backupPreview(id)
        if (r.cancelled) { cancelledAny = true; continue }
        if (!r.ok || !r.result) {
          // 「预览已在进行中」不是失败，给用户中性提示，不塞进错误清单
          if ((r.error ?? '').includes('预览已在进行中')) {
            busyRejected = true
            continue
          }
          plans.push({ taskId: id, name, error: r.error ?? '预览未完成' })
          continue
        }
        plans.push({ taskId: id, name, result: r.result })
        totals[id] = r.result.add + r.result.update + r.result.same
      } catch (e) {
        plans.push({ taskId: id, name, error: (e as Error).message })
      }
    }
    dmPreviewTotals.value = totals

    if (busyRejected && !plans.length) {
      pushDmToast('info', '预览进行中', '请等待当前预览完成后再操作')
      dmSyncPlans.value = []
      return
    }
    if (!plans.length) {
      pushDmToast(
        cancelledAny ? 'info' : 'warn',
        cancelledAny ? '预览已取消' : '预览未返回结果',
        cancelledAny ? '已停止当前扫描' : '预览未产生结果，请重试'
      )
      return
    }

    const ok = plans.filter((x) => x.result)
    if (opts?.checkOnly) {
      const add = ok.reduce((n, x) => n + (x.result?.add ?? 0), 0)
      const update = ok.reduce((n, x) => n + (x.result?.update ?? 0), 0)
      const extra = ok.reduce((n, x) => n + (x.result?.deleteExtra ?? 0), 0)
      const failed = plans.length - ok.length
      pushDmToast(
        failed ? 'warn' : 'info',
        '深度校验',
        `已校验 ${ok.length} 组 · 新增 ${add} · 更新 ${update} · 目标多出 ${extra}${failed ? ` · 未完成 ${failed} 组` : ''}`
      )
      dmSyncPlans.value = []
      return
    }

    const changed = plans.filter(
      (x) => x.result && x.result.add + x.result.update + x.result.deleteExtra > 0
    )
    const failed = plans.filter((x) => x.error).length
    if (!changed.length && !failed) {
      pushDmToast('success', '无需同步', '所有文件均一致，没有需要同步的差异项')
      dmSyncPlans.value = []
      return
    }
    dmSyncPlans.value = plans
    pushDmToast('info', '差异已列出', `${changed.length} 组有差异，请在确认框中审阅后执行`)
  } finally {
    dmSyncPreparing.value = false
    dmPreviewProgress.value = null
  }
}

/** 取消当前预览（进度条上的按钮） */
export async function cancelPreview(): Promise<void> {
  const id = dmPreviewProgress.value?.taskId ?? dmTasks.value[0]?.id
  if (!id) return
  await window.api.backupCancelPreview(id)
  pushDmToast('info', '正在取消预览', '正在停止当前扫描…')
}

export function cancelSync(): void {
  dmSyncPlans.value = []
}

/** 确认后只对「确实要写入」的任务执行；deleteExtras:false = 只增改不删 */
export async function confirmSync(): Promise<void> {
  if (dmSyncExecuting.value) return
  const targets = dmSyncPlans.value.filter(
    (p) => p.result && !p.error && p.result.add + p.result.update > 0
  )
  dmSyncExecuting.value = true
  const started: string[] = []
  const failed: string[] = []
  try {
    for (const p of targets) {
      try {
        const r = await window.api.backupExecute(p.taskId, { deleteExtras: false })
        if (r.ok) started.push(p.name)
        else failed.push(`${p.name}：${r.error ?? '未知原因'}`)
      } catch (e) {
        failed.push(`${p.name}：${(e as Error).message}`)
      }
    }
    pushDmToast(
      failed.length ? 'warn' : 'info',
      failed.length ? '部分同步未启动' : '已开始同步',
      failed.length
        ? `已启动 ${started.length} 组 · ${failed.join('；')}`
        : `已启动 ${started.length} 组：${started.join('、')}`
    )
    dmSyncPlans.value = []
    await refreshDm()
  } finally {
    dmSyncExecuting.value = false
  }
}
