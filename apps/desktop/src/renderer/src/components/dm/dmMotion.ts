/**
 * dmMotion.ts —— 备份「同步演出」的动效状态层。
 *
 * 职责：两档（vivid / calm）持久化、100ms 状态节流、rAF 帧率采样、
 *       自动降级（窗口隐藏 / 交互空闲 / 掉帧）、完成汇总浮层状态。
 * 不依赖 dmState，避免循环引用；由 App.vue 在挂载时 startMotion()。
 */
import { computed, ref } from 'vue'
import type { BackupRunState } from '@shared/types'
import { createThrottle } from '@shared/throttle'

export { createThrottle } from '@shared/throttle'

export type MotionMode = 'vivid' | 'calm'

export interface DmSummary {
  taskId: string
  name: string
  copied: number
  skipped: number
  bytes: number
  failed: number
  startedAt?: number
  finishedAt?: number
  ts: number
}

/** 用户选择的档位（默认 vivid） */
export const motionMode = ref<MotionMode>('vivid')
/** 自动降级中（掉帧 / 后台 / 空闲） */
export const motionAutoCalm = ref(false)
/** 实测帧率 */
export const motionFps = ref(60)
/** 完成汇总浮层队列（同一时刻只显示最新一条） */
export const dmSummary = ref<DmSummary | null>(null)

export const effectiveMode = computed<MotionMode>(() =>
  motionMode.value === 'calm' || motionAutoCalm.value ? 'calm' : 'vivid'
)
export const isVivid = computed(() => effectiveMode.value === 'vivid')
/** 窗口是否在前台：决定汇总浮层是否弹出（不受交互空闲影响） */
export const isWindowActive = computed(() => !documentHidden.value)

const documentHidden = ref(false)
let raf = 0
let frames = 0
let winStart = 0
let lowWindows = 0
let started = false
let onVis: (() => void) | null = null

function refreshDowngrade(): void {
  const shouldCalm = documentHidden.value || lowWindows >= 2
  if (motionAutoCalm.value !== shouldCalm) motionAutoCalm.value = shouldCalm
}

function sample(ts: number): void {
  frames++
  if (!winStart) winStart = ts
  const span = ts - winStart
  if (span >= 1000) {
    const fps = Math.round((frames * 1000) / span)
    motionFps.value = fps
    frames = 0
    winStart = ts
    if (fps < 45) lowWindows = Math.min(3, lowWindows + 1)
    else if (fps >= 55) lowWindows = 0
    refreshDowngrade()
  }
  raf = window.requestAnimationFrame(sample)
}

export async function loadMotion(): Promise<void> {
  try {
    const s = await window.api.getSettings()
    motionMode.value = s.motionMode === 'calm' ? 'calm' : 'vivid'
  } catch {
    motionMode.value = 'vivid'
  }
}

export async function setMotionMode(m: MotionMode): Promise<void> {
  motionMode.value = m
  // 用户主动切换时清掉「掉帧」降级计数，避免立刻又被压回克制档
  lowWindows = 0
  refreshDowngrade()
  try {
    await window.api.setSettings({ motionMode: m })
  } catch {
    /* 设置失败不阻塞界面切换 */
  }
}

export function startMotion(): void {
  if (started) return
  started = true
  void loadMotion()
  documentHidden.value = document.hidden
  onVis = () => {
    documentHidden.value = document.hidden
    refreshDowngrade()
  }
  document.addEventListener('visibilitychange', onVis)
  raf = window.requestAnimationFrame(sample)
}

export function stopMotion(): void {
  if (!started) return
  started = false
  if (onVis) document.removeEventListener('visibilitychange', onVis)
  if (raf) window.cancelAnimationFrame(raf)
  onVis = null
  raf = 0
}

/** 上一次运行状态（用于检测 running → done 的完成瞬间） */
const prevPhase = new Map<string, BackupRunState['phase']>()
export function trackPhase(s: BackupRunState): 'started' | 'finished' | null {
  const prev = prevPhase.get(s.taskId)
  prevPhase.set(s.taskId, s.phase)
  if (prev !== 'running' && s.phase === 'running') return 'started'
  if (prev === 'running' && (s.phase === 'done' || s.phase === 'stopped' || s.phase === 'error'))
    return 'finished'
  return null
}

export function showSummary(s: BackupRunState, name: string): void {
  if (!isWindowActive.value) return
  dmSummary.value = {
    taskId: s.taskId,
    name,
    copied: s.copied,
    skipped: s.skipped,
    bytes: s.bytes,
    failed: s.errors?.length ?? 0,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt ?? Date.now(),
    ts: Date.now()
  }
}

export function dismissSummary(): void {
  dmSummary.value = null
}
