<script setup lang="ts">
/**
 * 桌面浮窗界面（模块二）
 *
 * 交互职责划分：
 *   贴边判定、滑入滑出动画、窗口位置持久化 → 主进程（float/window.ts，只有它能读屏幕工作区）
 *   鼠标进入/离开、拖拽位移、内容高度上报        → 本组件
 *
 * 「鼠标移入时再次显示」正是靠这里的 mouseenter：窗口隐藏时仍有 peekSize 像素留在屏幕内，
 * 指针触到这条触发条就会命中窗口，本组件即通知主进程滑出。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FloatPluginPayload, FloatSettings } from '@shared/types'

const payloads = ref<FloatPluginPayload[]>([])
const settings = ref<FloatSettings | null>(null)
const state = ref<{ docked: 'left' | 'right' | 'top' | 'none'; hidden: boolean }>({ docked: 'none', hidden: false })
const root = ref<HTMLDivElement | null>(null)

const unsubs: (() => void)[] = []

onMounted(async () => {
  settings.value = await window.api.floatGetSettings()
  payloads.value = await window.api.floatRequestTick()

  unsubs.push(
    window.api.onFloatTick((p) => (payloads.value = p)),
    window.api.onFloatSettingsChanged((s) => (settings.value = s)),
    window.api.onFloatState((s) => (state.value = s))
  )

  // 内容高度自适应：ResizeObserver 上报给主进程调整窗口高度
  if (root.value) {
    const ro = new ResizeObserver(() => reportHeight())
    ro.observe(root.value)
    unsubs.push(() => ro.disconnect())
  }
  reportHeight()
})

onBeforeUnmount(() => {
  for (const u of unsubs) u()
})

let heightTimer: ReturnType<typeof setTimeout> | null = null
function reportHeight(): void {
  if (heightTimer) clearTimeout(heightTimer)
  heightTimer = setTimeout(() => {
    const h = root.value?.scrollHeight ?? 200
    void window.api.floatResize({ height: h })
  }, 60)
}

watch(payloads, reportHeight)
watch(() => settings.value?.compact, reportHeight)

// ───────────────── 鼠标进入 / 离开 ─────────────────

function onEnter(): void {
  void window.api.floatPeek(true)
}
function onLeave(): void {
  if (dragging.value) return
  void window.api.floatPeek(false)
}

// ───────────────── 拖拽 ─────────────────

const dragging = ref(false)
let last = { x: 0, y: 0 }

function onPointerDown(e: PointerEvent): void {
  if (settings.value?.lockPosition) return
  if ((e.target as HTMLElement).closest('.fw-btn')) return
  dragging.value = true
  last = { x: e.screenX, y: e.screenY }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  const dx = e.screenX - last.x
  const dy = e.screenY - last.y
  if (dx === 0 && dy === 0) return
  last = { x: e.screenX, y: e.screenY }
  void window.api.floatDrag({ dx, dy })
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  void window.api.floatDragEnd()
}

// ───────────────── 样式 ─────────────────

const themeClass = computed(() => `t-${settings.value?.theme ?? 'dark'}`)
const compact = computed(() => settings.value?.compact ?? false)

const toneColor: Record<string, string> = {
  normal: 'var(--fw-text)',
  good: '#22c55e',
  warn: '#f59e0b',
  danger: '#ef4444'
}

const ICONS: Record<string, string> = {
  cpu: '▣',
  disk: '◱',
  network: '⇅',
  clock: '◷',
  trash: '⌫',
  graph: '◈',
  process: '☰',
  plugin: '⧉'
}

function icon(name: string): string {
  return ICONS[name] ?? '•'
}

function openMain(): void {
  void window.api.floatOpenMain()
}
</script>

<template>
  <div
    ref="root"
    class="fw"
    :class="[themeClass, { compact, hidden: state.hidden, dragging }]"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- 贴边隐藏时露出的触发条：这是鼠标能重新命中窗口的唯一载体 -->
    <div
      v-if="state.hidden && state.docked !== 'none'"
      class="fw-peek"
      :class="'peek-' + state.docked"
    />

    <div class="fw-panel">
      <header class="fw-head">
        <span class="fw-dot" />
        <span class="fw-title">SoftGraph</span>
        <span v-if="state.docked !== 'none'" class="fw-dock" :title="`已吸附到${state.docked === 'left' ? '左' : state.docked === 'right' ? '右' : '上'}边缘`">
          {{ state.docked === 'left' ? '◀' : state.docked === 'right' ? '▶' : '▲' }}
        </span>
        <button class="fw-btn" title="打开主界面" @click="openMain">◱</button>
      </header>

      <div v-if="payloads.length === 0" class="fw-empty">
        未启用任何插件<br />
        <span class="fw-empty-sub">在主界面「浮窗」设置中勾选显示内容</span>
      </div>

      <section v-for="p in payloads" :key="p.pluginId" class="fw-card">
        <div class="fw-card-h">
          <span class="fw-ico">{{ icon(p.icon) }}</span>
          <span class="fw-card-t">{{ p.title }}</span>
        </div>

        <div v-if="p.error" class="fw-err">{{ p.error }}</div>

        <!-- text 视图：首行大字，其余小字 -->
        <template v-else-if="p.view === 'text'">
          <div class="fw-text-main">{{ p.data[0]?.value ?? '—' }}</div>
          <div v-for="d in p.data.slice(1)" :key="d.label" class="fw-text-sub">{{ d.value }}</div>
        </template>

        <!-- metric 视图：标签 + 值 -->
        <template v-else-if="p.view === 'metric'">
          <div v-for="d in p.data" :key="d.label" class="fw-metric">
            <span class="fw-m-l">{{ d.label }}</span>
            <span class="fw-m-v" :style="{ color: toneColor[d.tone ?? 'normal'] }">{{ d.value }}</span>
          </div>
          <div v-if="p.data.some((d) => d.hint)" class="fw-hint">
            {{ p.data.find((d) => d.hint)?.hint }}
          </div>
        </template>

        <!-- bars 视图：标签 + 值 + 进度条 -->
        <template v-else-if="p.view === 'bars'">
          <div v-for="d in p.data" :key="d.label" class="fw-bar-row">
            <div class="fw-bar-top">
              <span class="fw-m-l">{{ d.label }}</span>
              <span class="fw-m-v" :style="{ color: toneColor[d.tone ?? 'normal'] }">{{ d.value }}</span>
            </div>
            <div class="fw-bar">
              <i
                :style="{
                  width: Math.max(0, Math.min(100, d.ratio ?? 0)) + '%',
                  background: toneColor[d.tone ?? 'normal']
                }"
              />
            </div>
          </div>
        </template>

        <!-- gauge 视图：环形进度 -->
        <template v-else-if="p.view === 'gauge'">
          <div class="fw-gauge">
            <svg width="58" height="58" viewBox="0 0 58 58">
              <circle cx="29" cy="29" r="24" fill="none" stroke="var(--fw-line)" stroke-width="6" />
              <circle
                cx="29"
                cy="29"
                r="24"
                fill="none"
                :stroke="toneColor[p.data[0]?.tone ?? 'normal']"
                stroke-width="6"
                stroke-linecap="round"
                :stroke-dasharray="`${((p.data[0]?.ratio ?? 0) / 100) * 150.8} 150.8`"
                transform="rotate(-90 29 29)"
              />
            </svg>
            <div class="fw-gauge-c">
              <div class="fw-gauge-v">{{ p.data[0]?.value ?? '—' }}</div>
              <div class="fw-gauge-l">{{ p.data[0]?.label ?? '' }}</div>
            </div>
          </div>
        </template>

        <!-- list 视图 -->
        <template v-else>
          <div v-for="d in p.data" :key="d.label" class="fw-li">
            <span class="fw-li-l">{{ d.label }}</span>
            <span class="fw-li-v" :style="{ color: toneColor[d.tone ?? 'normal'] }">{{ d.value }}</span>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style>
.fw {
  --fw-bg: rgba(18, 26, 38, 0.94);
  --fw-card: rgba(255, 255, 255, 0.045);
  --fw-text: #e2e8f0;
  --fw-text-2: #94a3b8;
  --fw-line: rgba(255, 255, 255, 0.1);
  --fw-accent: #4a9eff;
  font-family: 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif;
  color: var(--fw-text);
  user-select: none;
  cursor: move;
  padding: 0;
}
.fw.t-light {
  --fw-bg: rgba(255, 255, 255, 0.95);
  --fw-card: rgba(20, 32, 50, 0.04);
  --fw-text: #1b2430;
  --fw-text-2: #5a6a7d;
  --fw-line: rgba(20, 32, 50, 0.1);
  --fw-accent: #1d6fd4;
}
.fw.t-glass {
  --fw-bg: rgba(24, 34, 48, 0.58);
  --fw-card: rgba(255, 255, 255, 0.07);
}
.fw.t-glass .fw-panel {
  backdrop-filter: blur(16px) saturate(150%);
}
.fw.dragging {
  cursor: grabbing;
}

.fw-panel {
  background: var(--fw-bg);
  border: 1px solid var(--fw-line);
  border-radius: 12px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(10px);
}

.fw-peek {
  position: absolute;
  background: var(--fw-accent);
  opacity: 0.9;
  border-radius: 3px;
  z-index: 2;
}
.fw-peek.peek-left {
  right: 0;
  top: 30%;
  bottom: 30%;
  width: 3px;
}
.fw-peek.peek-right {
  left: 0;
  top: 30%;
  bottom: 30%;
  width: 3px;
}
.fw-peek.peek-top {
  bottom: 0;
  left: 35%;
  right: 35%;
  height: 3px;
}

.fw-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 5px;
  border-bottom: 1px solid var(--fw-line);
}
.fw-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fw-accent);
  flex: none;
}
.fw-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  flex: 1;
  color: var(--fw-text-2);
}
.fw-dock {
  font-size: 9px;
  color: var(--fw-accent);
}
.fw-btn {
  background: transparent;
  border: none;
  color: var(--fw-text-2);
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}
.fw-btn:hover {
  color: var(--fw-accent);
}

.fw-empty {
  font-size: 11px;
  color: var(--fw-text-2);
  text-align: center;
  padding: 14px 6px;
  line-height: 1.7;
}
.fw-empty-sub {
  font-size: 10px;
  opacity: 0.8;
}

.fw-card {
  background: var(--fw-card);
  border-radius: 8px;
  padding: 7px 8px;
}
.fw-card-h {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 5px;
}
.fw-ico {
  font-size: 11px;
  color: var(--fw-accent);
}
.fw-card-t {
  font-size: 10px;
  color: var(--fw-text-2);
  letter-spacing: 0.2px;
}

.fw-err {
  font-size: 10px;
  color: #f59e0b;
  line-height: 1.5;
}

.fw-metric,
.fw-li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.9;
}
.fw-m-l,
.fw-li-l {
  color: var(--fw-text-2);
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fw-m-v,
.fw-li-v {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.fw-bar-row {
  margin-bottom: 5px;
}
.fw-bar-row:last-child {
  margin-bottom: 0;
}
.fw-bar-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.fw-bar {
  height: 4px;
  background: var(--fw-line);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 3px;
}
.fw-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s ease-out;
}

.fw-text-main {
  font-size: 21px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
  line-height: 1.15;
}
.fw-text-sub {
  font-size: 10.5px;
  color: var(--fw-text-2);
  margin-top: 2px;
}

.fw-hint {
  font-size: 9.5px;
  color: var(--fw-text-2);
  opacity: 0.85;
  margin-top: 3px;
}

.fw-gauge {
  position: relative;
  display: flex;
  justify-content: center;
}
.fw-gauge-c {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.fw-gauge-v {
  font-size: 12px;
  font-weight: 700;
}
.fw-gauge-l {
  font-size: 8.5px;
  color: var(--fw-text-2);
}

/* 紧凑模式 */
.fw.compact .fw-panel {
  padding: 6px;
  gap: 4px;
}
.fw.compact .fw-card {
  padding: 5px 6px;
}
.fw.compact .fw-metric,
.fw.compact .fw-li {
  font-size: 10.5px;
  line-height: 1.6;
}
.fw.compact .fw-text-main {
  font-size: 17px;
}
.fw.compact .fw-card-h {
  margin-bottom: 3px;
}
</style>
