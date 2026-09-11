<script setup lang="ts">
/**
 * 主界面
 * 对应技术设计方案 8.1 整体布局：
 *   经典三栏布局，中间画布占据主要视觉权重，两侧面板均可折叠，画布可全屏。
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type {
  CleanResult,
  DeletePlan,
  GraphModel,
  GraphNode,
  JunkSummary,
  ScanProgress,
  SoftwareItem
} from '@shared/types'
import { formatBytes, formatDuration, formatTime } from '@shared/util'
import SoftwareList from './components/SoftwareList.vue'
import GraphCanvas from './components/GraphCanvas.vue'
import JunkSidebar from './components/JunkSidebar.vue'
import ConfirmDelete from './components/ConfirmDelete.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'

// ───────────────── 状态 ─────────────────

const software = ref<SoftwareItem[]>([])
const icons = ref<Record<string, string | null>>({})
const selected = ref<SoftwareItem | null>(null)
const filter = ref<'all' | 'installed' | 'portable'>('all')

const swScanning = ref(false)
const swProgress = ref<ScanProgress | null>(null)
const lastScanAt = ref<number | null>(null)
const lastScanMs = ref<number | null>(null)
const scannedFiles = ref(0)

const graph = ref<GraphModel | null>(null)
const graphLoading = ref(false)
const graphLoadingText = ref('')
const graphProgress = ref<ScanProgress | null>(null)
const drillStack = ref<string[]>([])

const junkSummary = ref<JunkSummary | null>(null)
const junkScanning = ref(false)
const junkProgress = ref<ScanProgress | null>(null)

const plan = ref<DeletePlan | null>(null)
const executing = ref(false)
const cleanProgress = ref<{ done: number; total: number; current: string } | null>(null)
const cleanResult = ref<CleanResult | null>(null)
const pendingOneClick = ref(false)

const drawerOpen = ref(false)
const drawerTab = ref<'settings' | 'float' | 'quarantine' | 'rules' | 'about'>('settings')
const toast = ref<string | null>(null)
const theme = ref<'dark' | 'light'>('dark')
const allowDirectDelete = ref(false)

// 图谱筛选
const searchTerm = ref('')
const minConfidence = ref(0)
const hiddenKinds = ref<string[]>([])
const layoutMode = ref<'radial' | 'force' | 'cluster'>('radial')

// 面板折叠 / 画布全屏
const leftOpen = ref(true)
const rightOpen = ref(true)
const canvasFull = ref(false)

const canvasRef = ref<InstanceType<typeof GraphCanvas> | null>(null)
const contextMenu = ref<{ node: GraphNode; x: number; y: number } | null>(null)
const renderStats = ref<{ visible: number; mode: 'svg' | 'canvas' }>({ visible: 0, mode: 'svg' })

// ───────────────── 提示 ─────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(msg: string): void {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 2600)
}

// ───────────────── 初始化 ─────────────────

const unsubs: (() => void)[] = []

onMounted(async () => {
  const st = await window.api.getSettings()
  theme.value = st.theme
  allowDirectDelete.value = st.allowDirectDelete
  applyTheme(st.theme)

  software.value = await window.api.listSoftware()
  void loadIcons(software.value)
  junkSummary.value = await window.api.junkSummary()
  if (junkSummary.value) scannedFiles.value = junkSummary.value.scannedFiles

  unsubs.push(
    window.api.onScanProgress((p) => {
      swProgress.value = p
      swScanning.value = p.percent < 100
    }),
    window.api.onSoftwareBatch((batch) => {
      // 批量到达时按 id 去重合并，实现「边扫边画」
      const map = new Map(software.value.map((s) => [s.id, s]))
      for (const b of batch) map.set(b.id, b)
      software.value = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      void loadIcons(batch)
    }),
    window.api.onScanDone((d) => {
      swScanning.value = false
      swProgress.value = null
      lastScanAt.value = Date.now()
      lastScanMs.value = d.ms
      showToast(`软件扫描完成：${d.total} 个软件 · 用时 ${formatDuration(d.ms)}`)
      void (async () => {
        software.value = await window.api.listSoftware()
        void loadIcons(software.value)
      })()
    }),
    window.api.onJunkProgress((p) => {
      junkProgress.value = p
      junkScanning.value = p.percent < 100
      if (p.percent >= 100) {
        void (async () => {
          junkSummary.value = await window.api.junkSummary()
          if (junkSummary.value) {
            scannedFiles.value = junkSummary.value.scannedFiles
            showToast(
              `垃圾扫描完成：可释放 ${formatBytes(junkSummary.value.totalBytes)} · ${junkSummary.value.totalCount} 项`
            )
          }
          junkProgress.value = null
        })()
      }
    }),
    window.api.onCleanProgress((p) => {
      cleanProgress.value = { done: p.done, total: p.total, current: p.current }
    }),
    window.api.onGraphProgress((p) => {
      graphProgress.value = p
      graphLoadingText.value = `${p.phase} · ${p.current}`
    }),
    window.apiExtra.onJunkSummaryChanged((s) => {
      junkSummary.value = s as JunkSummary
    })
  )

  window.addEventListener('keydown', onKey)
  window.addEventListener('click', () => (contextMenu.value = null))
})

onBeforeUnmount(() => {
  for (const u of unsubs) u()
  window.removeEventListener('keydown', onKey)
})

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (canvasFull.value) canvasFull.value = false
    else if (drawerOpen.value) drawerOpen.value = false
    contextMenu.value = null
  }
  if (e.key === 'F11') {
    e.preventDefault()
    canvasFull.value = !canvasFull.value
  }
}

function applyTheme(t: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = t
}

watch(theme, applyTheme)

async function loadIcons(items: SoftwareItem[]): Promise<void> {
  for (const it of items) {
    if (!it.iconHash || it.iconHash in icons.value) continue
    icons.value[it.iconHash] = null
    const d = await window.api.getIcon(it.iconHash)
    icons.value = { ...icons.value, [it.iconHash]: d }
  }
}

// ───────────────── 软件扫描 ─────────────────

async function scanSoftware(): Promise<void> {
  swScanning.value = true
  swProgress.value = { scanId: '', phase: '准备扫描…', percent: 1, current: '', found: 0 }
  await window.api.scanSoftware()
}

async function cancelSoftwareScan(): Promise<void> {
  await window.api.cancelSoftwareScan()
  swScanning.value = false
  swProgress.value = null
  showToast('已停止软件扫描')
}

// ───────────────── 图谱 ─────────────────

async function selectSoftware(it: SoftwareItem, force = false): Promise<void> {
  selected.value = it
  drillStack.value = []
  await buildGraph(it.id, force)
}

async function buildGraph(softwareId: string, force = false): Promise<void> {
  graphLoading.value = true
  graphLoadingText.value = '正在解析依赖关系…'
  graph.value = null
  try {
    graph.value = await window.api.buildGraph({ softwareId, force } as never)
    if (graph.value?.stats.fromCache) showToast(`图谱来自缓存 · ${graph.value.stats.nodeCount} 节点`)
    else if (graph.value)
      showToast(
        `图谱构建完成：${graph.value.stats.fileCount} 个依赖 · 缺失 ${graph.value.stats.missingCount} · 用时 ${formatDuration(
          graph.value.stats.buildMs
        )}`
      )
  } catch (e) {
    showToast(`图谱构建失败：${(e as Error).message}`)
  } finally {
    graphLoading.value = false
    graphProgress.value = null
  }
}

async function refreshGraph(): Promise<void> {
  if (!selected.value) return
  await buildGraph(selected.value.id, true)
}

async function expandGroup(node: GraphNode): Promise<void> {
  if (!selected.value) return
  graphLoading.value = true
  graphLoadingText.value = '展开分组…'
  try {
    graph.value = await window.api.expandGroup({ softwareId: selected.value.id, nodeId: node.id })
  } catch (e) {
    showToast(`展开失败：${(e as Error).message}`)
  } finally {
    graphLoading.value = false
  }
}

/** 双击文件节点：以该节点为新中心（此版本聚焦并提示，避免误导为完整下钻） */
function drilldown(node: GraphNode): void {
  if (!node.file || node.file.missing) return
  canvasRef.value?.focusNode(node.id)
  showToast(`已聚焦 ${node.label}（该文件被 ${node.file.refCount ?? 1} 个软件引用）`)
}

function toggleKind(kind: string): void {
  const i = hiddenKinds.value.indexOf(kind)
  if (i >= 0) hiddenKinds.value = hiddenKinds.value.filter((k) => k !== kind)
  else hiddenKinds.value = [...hiddenKinds.value, kind]
}

async function exportGraphPng(): Promise<void> {
  const data = await canvasRef.value?.exportPng()
  if (!data) return
  const a = document.createElement('a')
  a.href = data
  a.download = `softgraph-${selected.value?.name ?? 'graph'}.png`
  a.click()
  showToast('图谱已导出为 PNG')
}

async function exportGraphReport(): Promise<void> {
  if (!selected.value) return
  try {
    const f = await window.api.exportReport({ kind: 'graph', format: 'html', softwareId: selected.value.id })
    showToast(f ? `依赖清单已导出：${f}` : '导出失败')
  } catch (e) {
    showToast(`导出失败：${(e as Error).message}`)
  }
}

// ───────────────── 垃圾与清理 ─────────────────

async function scanJunk(): Promise<void> {
  junkScanning.value = true
  junkProgress.value = { scanId: '', phase: '准备扫描…', percent: 1, current: '', found: 0 }
  await window.api.scanJunk()
}

async function cancelJunk(): Promise<void> {
  await window.api.cancelJunkScan()
  junkScanning.value = false
  junkProgress.value = null
  showToast('已停止垃圾扫描')
}

async function planCategories(ids: string[]): Promise<void> {
  const all: string[] = []
  for (const id of ids) {
    const r = await window.api.junkItems({ categoryId: id, offset: 0, limit: 100000 })
    all.push(...r.items.filter((i) => !i.keep).map((i) => i.id))
  }
  if (all.length === 0) {
    showToast('所选分类下没有可删除的条目')
    return
  }
  pendingOneClick.value = false
  cleanResult.value = null
  plan.value = await window.api.cleanPlan({ itemIds: all, useQuarantine: true })
}

async function planItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  pendingOneClick.value = false
  cleanResult.value = null
  plan.value = await window.api.cleanPlan({ itemIds: ids, useQuarantine: true })
}

async function planOneClick(): Promise<void> {
  pendingOneClick.value = true
  cleanResult.value = null
  plan.value = await window.api.cleanPlan({ itemIds: [], useQuarantine: true, oneClick: true } as never)
  if (plan.value && plan.value.items.length === 0) {
    showToast('没有符合一键删除条件的低风险条目')
    plan.value = null
  }
}

async function doClean(payload: { useQuarantine: boolean }): Promise<void> {
  if (!plan.value) return
  executing.value = true
  cleanProgress.value = { done: 0, total: plan.value.items.length, current: '' }
  try {
    const r = await window.api.cleanExecute({
      itemIds: plan.value.items.map((i) => i.id),
      useQuarantine: payload.useQuarantine,
      oneClick: pendingOneClick.value
    } as never)
    cleanResult.value = r
    plan.value = null
    junkSummary.value = await window.api.junkSummary()
  } catch (e) {
    showToast(`清理失败：${(e as Error).message}`)
    plan.value = null
  } finally {
    executing.value = false
    cleanProgress.value = null
  }
}

function closeDialog(): void {
  plan.value = null
  cleanResult.value = null
  pendingOneClick.value = false
}

async function exportJunkReport(): Promise<void> {
  try {
    const f = await window.api.exportReport({ kind: 'junk', format: 'html' })
    showToast(f ? `垃圾清单已导出：${f}` : '导出失败')
  } catch (e) {
    showToast(`导出失败：${(e as Error).message}`)
  }
}

// ───────────────── 通用动作 ─────────────────

async function copy(text: string): Promise<void> {
  await window.api.copy(text)
  showToast('已复制到剪贴板')
}

async function reveal(path: string): Promise<void> {
  await window.api.reveal({ path })
}

async function markPortable(payload: { path: string; isPortable: boolean }): Promise<void> {
  await window.api.markPortable(payload)
  showToast(payload.isPortable ? '已标记为便携软件，下次扫描生效' : '已标记为非便携，下次扫描生效')
}

function openDrawer(tab: typeof drawerTab.value): void {
  drawerTab.value = tab
  drawerOpen.value = true
}

async function onThemeChange(t: 'dark' | 'light'): Promise<void> {
  theme.value = t
}

// 右键菜单动作
function ctxAction(kind: 'reveal' | 'copy' | 'focus' | 'hide'): void {
  const n = contextMenu.value?.node
  if (!n) return
  if (kind === 'reveal' && n.file && !n.file.missing) void reveal(n.file.fullPath)
  if (kind === 'copy' && n.file) void copy(n.file.fullPath)
  if (kind === 'focus') canvasRef.value?.focusNode(n.id)
  if (kind === 'hide' && n.file) toggleKind(n.file.missing ? 'missing' : n.file.kind)
  contextMenu.value = null
}

const statusText = computed(() => {
  const parts: string[] = []
  parts.push(`已收录 ${software.value.length} 个软件`)
  if (scannedFiles.value > 0) parts.push(`已扫描 ${scannedFiles.value.toLocaleString()} 个文件`)
  if (junkSummary.value) parts.push(`可释放 ${formatBytes(junkSummary.value.totalBytes)}`)
  if (lastScanMs.value) parts.push(`用时 ${formatDuration(lastScanMs.value)}`)
  if (lastScanAt.value) parts.push(`上次扫描 ${formatTime(lastScanAt.value)}`)
  return parts.join(' · ')
})
</script>

<template>
  <div class="app" :class="{ full: canvasFull }">
    <!-- 顶栏 -->
    <header class="tb">
      <div class="tb-brand">
        <span class="tb-logo">◈</span>
        <span class="tb-name">SoftGraph</span>
      </div>

      <button :disabled="swScanning" @click="scanSoftware">{{ software.length ? '重新扫描' : '扫描软件' }}</button>
      <button :disabled="!selected || graphLoading" @click="refreshGraph">刷新图谱</button>

      <input v-model="searchTerm" class="tb-search" type="search" placeholder="在图谱中搜索文件名或路径…" />

      <div class="tb-group">
        <span class="dim">置信度 ≥</span>
        <input v-model.number="minConfidence" type="range" min="0" max="0.95" step="0.05" class="tb-range" />
        <span class="tb-range-val mono">{{ minConfidence.toFixed(2) }}</span>
      </div>

      <select v-model="layoutMode" title="布局方式">
        <option value="radial">径向分层</option>
        <option value="force">力导向</option>
        <option value="cluster">环形聚类</option>
      </select>

      <span class="tb-sp" />

      <button class="ghost" :disabled="!graph" title="导出 PNG" @click="exportGraphPng">导出图</button>
      <button class="ghost" :disabled="!graph" title="导出依赖清单" @click="exportGraphReport">依赖清单</button>
      <button class="ghost" :title="leftOpen ? '收起软件列表' : '展开软件列表'" @click="leftOpen = !leftOpen">
        {{ leftOpen ? '◧' : '▢' }}
      </button>
      <button class="ghost" :title="rightOpen ? '收起垃圾侧栏' : '展开垃圾侧栏'" @click="rightOpen = !rightOpen">
        {{ rightOpen ? '◨' : '▢' }}
      </button>
      <button class="ghost" :title="canvasFull ? '退出全屏 (Esc)' : '画布全屏 (F11)'" @click="canvasFull = !canvasFull">
        ⤢
      </button>
      <button class="ghost" title="桌面浮窗" @click="openDrawer('float')">浮窗</button>
      <button class="ghost" title="设置" @click="openDrawer('settings')">⚙</button>
    </header>

    <!-- 三栏主体 -->
    <main class="body">
      <div v-if="leftOpen && !canvasFull" class="col-left">
        <SoftwareList
          :items="software"
          :selected-id="selected?.id ?? null"
          :icons="icons"
          :scanning="swScanning"
          :progress="swProgress"
          :filter="filter"
          @select="selectSoftware($event)"
          @scan="scanSoftware"
          @cancel="cancelSoftwareScan"
          @set-filter="filter = $event"
          @reveal="reveal"
          @mark-portable="markPortable"
        />
      </div>

      <div class="col-mid">
        <div v-if="selected" class="mid-head">
          <span class="mid-title">{{ selected.name }}</span>
          <span v-if="selected.version" class="badge">{{ selected.version }}</span>
          <span v-if="selected.publisher" class="dim mid-pub">{{ selected.publisher }}</span>
          <span class="tb-sp" />
          <span v-if="graph" class="mid-stats dim">
            {{ graph.stats.fileCount }} 依赖 ·
            <span :class="graph.stats.missingCount ? 'risk-high' : 'dim'">缺失 {{ graph.stats.missingCount }}</span>
            · 解析 {{ graph.stats.parsedOk }}/{{ graph.stats.parsedOk + graph.stats.parseFailed }}
          </span>
          <button class="ghost" title="打开安装目录" @click="reveal(selected.installPath || selected.mainExe)">
            打开目录
          </button>
        </div>
        <div class="mid-canvas">
          <GraphCanvas
            ref="canvasRef"
            :model="graph"
            :icon="selected ? icons[selected.iconHash] ?? null : null"
            :loading="graphLoading"
            :loading-text="graphLoadingText"
            :search-term="searchTerm"
            :min-confidence="minConfidence"
            :hidden-kinds="hiddenKinds"
            :layout-mode="layoutMode"
            @expand="expandGroup"
            @drilldown="drilldown"
            @reset="searchTerm = ''"
            @copy="copy"
            @reveal="reveal"
            @toggle-kind="toggleKind"
            @context="contextMenu = $event"
            @stats="renderStats = $event"
          />
        </div>
      </div>

      <div v-if="rightOpen && !canvasFull" class="col-right">
        <JunkSidebar
          :summary="junkSummary"
          :scanning="junkScanning"
          :progress="junkProgress"
          @scan="scanJunk"
          @cancel="cancelJunk"
          @delete-categories="planCategories"
          @delete-items="planItems"
          @delete-one-click="planOneClick"
          @reveal="reveal"
          @copy="copy"
          @open-quarantine="openDrawer('quarantine')"
          @export="exportJunkReport"
        />
      </div>
    </main>

    <!-- 状态栏 -->
    <footer class="sb">
      <span>{{ statusText }}</span>
      <span class="tb-sp" />
      <span class="dim">{{ renderStats.mode.toUpperCase() }} 渲染 · {{ renderStats.visible }} 节点可见</span>
    </footer>

    <!-- 图谱右键菜单（5.4.3） -->
    <div
      v-if="contextMenu"
      class="ctx"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <div class="ctx-t mono">{{ contextMenu.node.label }}</div>
      <button :disabled="!contextMenu.node.file || contextMenu.node.file.missing" @click="ctxAction('reveal')">
        打开所在目录
      </button>
      <button :disabled="!contextMenu.node.file" @click="ctxAction('copy')">复制路径</button>
      <button @click="ctxAction('focus')">在图中聚焦</button>
      <button :disabled="!contextMenu.node.file" @click="ctxAction('hide')">隐藏此类节点</button>
    </div>

    <ConfirmDelete
      :plan="plan"
      :executing="executing"
      :progress="cleanProgress"
      :result="cleanResult"
      :allow-direct-delete="allowDirectDelete"
      @confirm="doClean"
      @cancel="executing = false"
      @close="closeDialog"
      @open-quarantine="closeDialog(); openDrawer('quarantine')"
      @reveal="reveal"
    />

    <SettingsDrawer
      :open="drawerOpen"
      :tab="drawerTab"
      @close="drawerOpen = false"
      @set-tab="drawerTab = $event"
      @toast="showToast"
      @theme="onThemeChange"
    />

    <Transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}
.tb {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex: none;
  -webkit-app-region: drag;
}
.tb > * {
  -webkit-app-region: no-drag;
}
.tb-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 6px;
}
.tb-logo {
  color: var(--accent);
  font-size: 15px;
}
.tb-name {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.3px;
}
.tb-search {
  width: 236px;
}
.tb-group {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}
.tb-range {
  width: 84px;
}
.tb-range-val {
  width: 30px;
  font-size: 10.5px;
}
.tb-sp {
  flex: 1;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.col-left {
  width: 268px;
  flex: none;
  min-height: 0;
}
.col-right {
  width: 322px;
  flex: none;
  min-height: 0;
}
.col-mid {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.mid-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  flex: none;
}
.mid-title {
  font-size: 13px;
  font-weight: 600;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mid-pub {
  font-size: 11px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mid-stats {
  font-size: 11px;
}
.mid-canvas {
  flex: 1;
  min-height: 0;
  position: relative;
}
.sb {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px;
  font-size: 11px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  color: var(--text-2);
  flex: none;
}
.ctx {
  position: fixed;
  z-index: 120;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 168px;
}
.ctx-t {
  font-size: 10px;
  color: var(--text-2);
  padding: 3px 6px 5px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 3px;
  word-break: break-all;
}
.ctx button {
  text-align: left;
  background: transparent;
  border-color: transparent;
  font-size: 11.5px;
  padding: 4px 7px;
}
.ctx button:hover:not(:disabled) {
  background: var(--hover);
  border-color: transparent;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 7px 16px;
  font-size: 12px;
  box-shadow: var(--shadow);
  z-index: 300;
  max-width: 72vw;
  text-align: center;
}
</style>
