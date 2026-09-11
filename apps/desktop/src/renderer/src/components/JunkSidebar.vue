<script setup lang="ts">
/**
 * 垃圾分布侧边栏
 * 对应技术设计方案 8.3 侧边栏垃圾分布
 *   顶部概览：环形图展示各分类占比，中心显示总可释放空间，点击扇区筛选下方列表
 *   分类列表：勾选框、分类名、占用空间、文件数、风险色标、占比进度条
 *   明细抽屉：展开后列出具体文件名、完整路径、大小、修改时间，支持按大小排序、多选
 *   底部操作：「分类删除」与「一键删除」
 *   安全提示：高风险分类旁显示警告图标与说明文字
 */
import { computed, ref, watch } from 'vue'
import type { JunkCategorySummary, JunkItem, JunkSummary, RiskLevel, ScanProgress } from '@shared/types'
import { RISK_LABEL } from '@shared/types'
import { formatBytes, formatTime } from '@shared/util'

const props = defineProps<{
  summary: JunkSummary | null
  scanning: boolean
  progress: ScanProgress | null
}>()

const emit = defineEmits<{
  (e: 'scan'): void
  (e: 'cancel'): void
  (e: 'delete-categories', ids: string[]): void
  (e: 'delete-items', ids: string[]): void
  (e: 'delete-one-click'): void
  (e: 'reveal', path: string): void
  (e: 'copy', text: string): void
  (e: 'open-quarantine'): void
  (e: 'export'): void
}>()

// ───────────────── 勾选状态 ─────────────────

const checked = ref<Set<string>>(new Set())
const expandedId = ref<string | null>(null)
const focusedSector = ref<string | null>(null)

const items = ref<JunkItem[]>([])
const itemTotal = ref(0)
const itemsLoading = ref(false)
const sort = ref<'size' | 'mtime' | 'path'>('size')
const checkedItems = ref<Set<string>>(new Set())
const PAGE = 200
const page = ref(0)

/** 首次拿到扫描结果时，按规则的 defaultSelected 初始化勾选 */
watch(
  () => props.summary,
  (s) => {
    if (!s) return
    if (checked.value.size === 0) {
      const next = new Set<string>()
      for (const c of s.categories) if (c.defaultSelected && c.count > 0) next.add(c.id)
      checked.value = next
    } else {
      // 清理已消失的分类
      const valid = new Set(s.categories.map((c) => c.id))
      checked.value = new Set([...checked.value].filter((id) => valid.has(id)))
    }
    if (expandedId.value) void loadItems(expandedId.value)
  },
  { immediate: true }
)

const categories = computed<JunkCategorySummary[]>(() => {
  const list = props.summary?.categories ?? []
  const filtered = focusedSector.value ? list.filter((c) => c.id === focusedSector.value) : list
  return [...filtered].sort((a, b) => b.sizeBytes - a.sizeBytes)
})

const selectedBytes = computed(() => {
  const s = props.summary
  if (!s) return 0
  return s.categories.filter((c) => checked.value.has(c.id)).reduce((n, c) => n + c.sizeBytes, 0)
})

const selectedCount = computed(() => {
  const s = props.summary
  if (!s) return 0
  return s.categories.filter((c) => checked.value.has(c.id)).reduce((n, c) => n + c.count, 0)
})

const hasHighRiskChecked = computed(() => {
  const s = props.summary
  if (!s) return false
  return s.categories.some((c) => checked.value.has(c.id) && c.risk === 'high')
})

function toggle(id: string): void {
  const next = new Set(checked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checked.value = next
}

function selectAll(on: boolean): void {
  if (!props.summary) return
  checked.value = on ? new Set(props.summary.categories.filter((c) => c.count > 0).map((c) => c.id)) : new Set()
}

// ───────────────── 环形图 ─────────────────

const RISK_COLOR: Record<RiskLevel, string> = {
  low: 'var(--risk-low)',
  medium: 'var(--risk-medium)',
  high: 'var(--risk-high)',
  hint: 'var(--risk-hint)'
}

const PALETTE = [
  '#4a9eff',
  '#22d3ee',
  '#a78bfa',
  '#f59e0b',
  '#22c55e',
  '#ef4444',
  '#64748b',
  '#0ea5e9',
  '#f472b6',
  '#84cc16',
  '#eab308',
  '#14b8a6',
  '#8b5cf6'
]

interface Arc {
  id: string
  name: string
  d: string
  color: string
  percent: number
  size: number
}

const R_OUT = 52
const R_IN = 34
const CX = 62
const CY = 62

const arcs = computed<Arc[]>(() => {
  const s = props.summary
  if (!s || s.totalBytes <= 0) return []
  const list = [...s.categories].filter((c) => c.sizeBytes > 0).sort((a, b) => b.sizeBytes - a.sizeBytes)
  let angle = -Math.PI / 2
  const out: Arc[] = []
  list.forEach((c, i) => {
    const frac = c.sizeBytes / s.totalBytes
    // 极小占比给一个最小可见弧度，否则用户点不到
    const sweep = Math.max(frac * Math.PI * 2, 0.02)
    const a0 = angle
    const a1 = angle + sweep
    angle = a1
    out.push({
      id: c.id,
      name: c.name,
      d: donutArc(CX, CY, R_IN, R_OUT, a0, a1),
      color: PALETTE[i % PALETTE.length],
      percent: frac * 100,
      size: c.sizeBytes
    })
  })
  return out
})

function donutArc(cx: number, cy: number, ri: number, ro: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0
  const x0o = cx + ro * Math.cos(a0)
  const y0o = cy + ro * Math.sin(a0)
  const x1o = cx + ro * Math.cos(a1)
  const y1o = cy + ro * Math.sin(a1)
  const x1i = cx + ri * Math.cos(a1)
  const y1i = cy + ri * Math.sin(a1)
  const x0i = cx + ri * Math.cos(a0)
  const y0i = cy + ri * Math.sin(a0)
  return `M ${x0o} ${y0o} A ${ro} ${ro} 0 ${large} 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${ri} ${ri} 0 ${large} 0 ${x0i} ${y0i} Z`
}

function clickSector(id: string): void {
  focusedSector.value = focusedSector.value === id ? null : id
}

// ───────────────── 明细抽屉 ─────────────────

async function loadItems(categoryId: string, reset = true): Promise<void> {
  itemsLoading.value = true
  if (reset) page.value = 0
  try {
    const res = await window.api.junkItems({
      categoryId,
      offset: page.value * PAGE,
      limit: PAGE,
      sort: sort.value
    })
    items.value = reset ? res.items : [...items.value, ...res.items]
    itemTotal.value = res.total
  } finally {
    itemsLoading.value = false
  }
}

async function toggleExpand(c: JunkCategorySummary): Promise<void> {
  if (expandedId.value === c.id) {
    expandedId.value = null
    items.value = []
    checkedItems.value = new Set()
    return
  }
  expandedId.value = c.id
  checkedItems.value = new Set()
  await loadItems(c.id)
}

watch(sort, () => {
  if (expandedId.value) void loadItems(expandedId.value)
})

async function loadMore(): Promise<void> {
  if (!expandedId.value) return
  page.value++
  await loadItems(expandedId.value, false)
}

function toggleItem(id: string): void {
  const next = new Set(checkedItems.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checkedItems.value = next
}

function allItemsChecked(): boolean {
  return items.value.length > 0 && items.value.every((i) => checkedItems.value.has(i.id) || i.keep)
}

function toggleAllItems(): void {
  if (allItemsChecked()) checkedItems.value = new Set()
  else checkedItems.value = new Set(items.value.filter((i) => !i.keep).map((i) => i.id))
}

const RISK_TIP: Record<RiskLevel, string> = {
  low: '删除不影响系统与软件功能',
  medium: '可能影响软件启动或需重新下载',
  high: '位于系统目录或受保护区域，需高级模式',
  hint: '仅作占用提示，不自动勾选'
}
</script>

<template>
  <aside class="js">
    <!-- 顶部概览 -->
    <header class="js-head">
      <span class="js-title">垃圾分布</span>
      <div class="js-head-act">
        <button v-if="!scanning" class="ghost" title="导出垃圾清单" @click="emit('export')">导出</button>
        <button v-if="!scanning" class="primary" @click="emit('scan')">
          {{ summary ? '重新扫描' : '开始扫描' }}
        </button>
        <button v-else class="danger" @click="emit('cancel')">停止</button>
      </div>
    </header>

    <div v-if="scanning && progress" class="js-progress">
      <div class="js-progress-bar"><i :style="{ width: progress.percent + '%' }" /></div>
      <div class="js-progress-text">
        <span>{{ progress.phase }}</span>
        <span class="dim">{{ progress.found ?? 0 }} 项</span>
      </div>
      <div class="js-progress-cur mono dim">{{ progress.current || '…' }}</div>
    </div>

    <div v-if="!summary && !scanning" class="js-empty">
      <div class="js-empty-icon">◔</div>
      <div>尚未扫描磁盘垃圾</div>
      <div class="dim js-empty-sub">扫描 13 类垃圾，按分类展示占用空间与文件明细</div>
      <button class="primary" style="margin-top: 12px" @click="emit('scan')">开始扫描</button>
    </div>

    <template v-if="summary">
      <!-- 环形图 + 中心总可释放空间 -->
      <div class="js-donut">
        <svg width="124" height="124" viewBox="0 0 124 124">
          <circle :cx="CX" :cy="CY" :r="(R_OUT + R_IN) / 2" fill="none" stroke="var(--border-soft)" :stroke-width="R_OUT - R_IN" />
          <path
            v-for="a in arcs"
            :key="a.id"
            :d="a.d"
            :fill="a.color"
            :opacity="focusedSector && focusedSector !== a.id ? 0.22 : 0.92"
            class="js-arc"
            @click="clickSector(a.id)"
          >
            <title>{{ a.name }} · {{ formatBytes(a.size) }} · {{ a.percent.toFixed(1) }}%</title>
          </path>
        </svg>
        <div class="js-donut-center">
          <div class="js-donut-val">{{ formatBytes(summary.totalBytes) }}</div>
          <div class="js-donut-lbl">总可释放</div>
        </div>
      </div>

      <div class="js-stat">
        <span>{{ summary.totalCount.toLocaleString() }} 个条目</span>
        <span class="dim">·</span>
        <span>扫描 {{ summary.scannedFiles.toLocaleString() }} 文件</span>
        <span class="dim">·</span>
        <span>{{ (summary.scanMs / 1000).toFixed(1) }}s</span>
      </div>
      <div v-if="focusedSector" class="js-filter-tip">
        已按扇区筛选
        <button class="ghost" @click="focusedSector = null">显示全部</button>
      </div>

      <div class="js-toolbar">
        <button class="ghost" @click="selectAll(true)">全选</button>
        <button class="ghost" @click="selectAll(false)">全不选</button>
        <span class="dim js-toolbar-sp">已选 {{ formatBytes(selectedBytes) }}</span>
      </div>

      <!-- 分类列表 -->
      <div class="js-list">
        <div v-for="c in categories" :key="c.id" class="js-cat" :class="{ open: expandedId === c.id }">
          <div class="js-cat-row">
            <input
              type="checkbox"
              :checked="checked.has(c.id)"
              :disabled="c.count === 0"
              @change="toggle(c.id)"
              @click.stop
            />
            <div class="js-cat-main" @click="toggleExpand(c)">
              <div class="js-cat-line1">
                <span class="js-cat-name">{{ c.name }}</span>
                <span v-if="c.risk === 'high'" class="js-warn" :title="RISK_TIP[c.risk]">⚠</span>
                <span class="js-cat-size">{{ formatBytes(c.sizeBytes) }}</span>
              </div>
              <div class="js-cat-line2">
                <span class="js-risk" :style="{ background: RISK_COLOR[c.risk] }" :title="RISK_TIP[c.risk]" />
                <span class="dim">{{ RISK_LABEL[c.risk] }}风险 · {{ c.count }} 项</span>
                <span v-if="c.denied" class="js-denied" title="部分路径需要管理员权限">需提权</span>
                <span class="js-caret">{{ expandedId === c.id ? '▾' : '▸' }}</span>
              </div>
              <div class="js-bar">
                <i
                  :style="{
                    width: summary.totalBytes ? (c.sizeBytes / summary.totalBytes) * 100 + '%' : '0%',
                    background: RISK_COLOR[c.risk]
                  }"
                />
              </div>
            </div>
          </div>

          <!-- 明细抽屉 -->
          <div v-if="expandedId === c.id" class="js-drawer">
            <div v-if="c.description" class="js-desc dim">{{ c.description }}</div>
            <div class="js-drawer-bar">
              <input type="checkbox" :checked="allItemsChecked()" @change="toggleAllItems" />
              <select v-model="sort" @click.stop>
                <option value="size">按大小</option>
                <option value="mtime">按修改时间</option>
                <option value="path">按路径</option>
              </select>
              <span class="dim">{{ items.length }} / {{ itemTotal }}</span>
              <button
                class="ghost js-del-sel"
                :disabled="checkedItems.size === 0"
                @click.stop="emit('delete-items', [...checkedItems])"
              >
                删除选中 {{ checkedItems.size || '' }}
              </button>
            </div>

            <div v-if="itemsLoading && items.length === 0" class="js-drawer-loading dim">加载中…</div>
            <div v-else-if="items.length === 0" class="js-drawer-loading dim">该分类下没有条目</div>

            <ul v-else class="js-items">
              <li v-for="it in items" :key="it.id" class="js-item" :class="{ keep: it.keep }">
                <input
                  type="checkbox"
                  :checked="checkedItems.has(it.id)"
                  :disabled="it.keep"
                  :title="it.keep ? '重复文件分组内建议保留的一份' : ''"
                  @change="toggleItem(it.id)"
                />
                <div class="js-item-body" @click="emit('copy', it.fullPath)">
                  <div class="js-item-name">
                    {{ it.name }}
                    <span v-if="it.isDir" class="badge">目录</span>
                    <span v-if="it.keep" class="badge">保留</span>
                  </div>
                  <div class="js-item-path mono dim" :title="it.fullPath">{{ it.fullPath }}</div>
                  <div class="js-item-meta dim">{{ formatBytes(it.sizeBytes) }} · {{ formatTime(it.mtime) }}</div>
                </div>
                <button class="ghost js-item-go" title="打开所在目录" @click.stop="emit('reveal', it.fullPath)">↗</button>
              </li>
            </ul>

            <button v-if="items.length < itemTotal" class="ghost js-more" @click.stop="loadMore">
              加载更多（剩余 {{ itemTotal - items.length }}）
            </button>
          </div>
        </div>
      </div>

      <!-- 底部操作 -->
      <footer class="js-foot">
        <div v-if="hasHighRiskChecked" class="js-foot-warn">
          ⚠ 已勾选高风险分类，删除时需输入确认文本
        </div>
        <div class="js-foot-sum">
          <span>已选 {{ selectedCount }} 项</span>
          <b>{{ formatBytes(selectedBytes) }}</b>
        </div>
        <div class="js-foot-btns">
          <button :disabled="checked.size === 0" @click="emit('delete-categories', [...checked])">分类删除</button>
          <button class="primary" :disabled="summary.oneClickBytes <= 0" @click="emit('delete-one-click')">
            一键删除
          </button>
        </div>
        <div class="js-foot-tip dim">
          一键删除仅作用于低风险且默认勾选的分类（可释放 {{ formatBytes(summary.oneClickBytes) }}）；
          中高风险分类必须单独确认，此规则不可在设置中关闭。
        </div>
        <button class="ghost js-q" @click="emit('open-quarantine')">查看隔离区 / 还原</button>
      </footer>
    </template>
  </aside>
</template>

<style scoped>
.js {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--border);
  min-width: 0;
}
.js-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.js-title {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
}
.js-head-act {
  display: flex;
  gap: 5px;
}
.js-progress {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.js-progress-bar {
  height: 4px;
  background: var(--border-soft);
  border-radius: 2px;
  overflow: hidden;
}
.js-progress-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.25s;
}
.js-progress-text {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-top: 5px;
}
.js-progress-cur {
  font-size: 10px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.js-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--text-2);
  padding: 0 24px;
  text-align: center;
}
.js-empty-icon {
  font-size: 40px;
  opacity: 0.3;
}
.js-empty-sub {
  font-size: 11.5px;
  line-height: 1.6;
}
.js-donut {
  position: relative;
  display: flex;
  justify-content: center;
  padding: 12px 0 4px;
  flex: none;
}
.js-arc {
  cursor: pointer;
  transition: opacity 0.14s;
}
.js-arc:hover {
  opacity: 1 !important;
}
.js-donut-center {
  position: absolute;
  top: 12px;
  left: 0;
  right: 0;
  height: 124px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.js-donut-val {
  font-size: 14px;
  font-weight: 700;
}
.js-donut-lbl {
  font-size: 10px;
  color: var(--text-2);
  margin-top: 1px;
}
.js-stat {
  display: flex;
  gap: 5px;
  justify-content: center;
  font-size: 11px;
  color: var(--text-2);
  padding-bottom: 8px;
  flex: none;
}
.js-filter-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
  padding-bottom: 7px;
}
.js-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px 8px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.js-toolbar-sp {
  margin-left: auto;
  font-size: 11px;
}
.js-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.js-cat {
  border-bottom: 1px solid var(--border-soft);
}
.js-cat.open {
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}
.js-cat-row {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  align-items: flex-start;
}
.js-cat-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.js-cat-line1 {
  display: flex;
  align-items: center;
  gap: 5px;
}
.js-cat-name {
  font-size: 12.5px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.js-cat-size {
  font-size: 12px;
  font-weight: 600;
  flex: none;
}
.js-warn {
  color: var(--risk-high);
  font-size: 12px;
  flex: none;
}
.js-cat-line2 {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  margin-top: 2px;
}
.js-risk {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.js-denied {
  font-size: 9.5px;
  padding: 1px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--risk-medium) 22%, transparent);
  color: var(--risk-medium);
}
.js-caret {
  margin-left: auto;
  color: var(--text-2);
}
.js-bar {
  height: 3px;
  background: var(--border-soft);
  border-radius: 2px;
  margin-top: 5px;
  overflow: hidden;
}
.js-bar i {
  display: block;
  height: 100%;
  opacity: 0.85;
}
.js-drawer {
  padding: 0 12px 10px 12px;
}
.js-desc {
  font-size: 11px;
  line-height: 1.6;
  padding-bottom: 6px;
}
.js-drawer-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  font-size: 11px;
}
.js-drawer-bar select {
  padding: 2px 4px;
  font-size: 11px;
}
.js-del-sel {
  margin-left: auto;
  padding: 2px 7px;
  font-size: 11px;
}
.js-drawer-loading {
  font-size: 11px;
  padding: 8px 0;
  text-align: center;
}
.js-items {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.js-item {
  display: flex;
  gap: 6px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-soft);
  align-items: flex-start;
}
.js-item:last-child {
  border-bottom: none;
}
.js-item.keep {
  opacity: 0.62;
}
.js-item-body {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.js-item-name {
  font-size: 11.5px;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.js-item-path {
  font-size: 10px;
  line-height: 1.45;
  word-break: break-all;
  max-height: 27px;
  overflow: hidden;
}
.js-item-meta {
  font-size: 10px;
  margin-top: 1px;
}
.js-item-go {
  padding: 1px 5px;
  font-size: 11px;
  flex: none;
}
.js-more {
  width: 100%;
  margin-top: 6px;
  font-size: 11px;
}
.js-foot {
  flex: none;
  border-top: 1px solid var(--border);
  padding: 9px 12px 10px;
  background: var(--panel-2);
}
.js-foot-warn {
  font-size: 11px;
  color: var(--risk-high);
  background: color-mix(in srgb, var(--risk-high) 12%, transparent);
  border-radius: var(--radius-sm);
  padding: 4px 7px;
  margin-bottom: 7px;
}
.js-foot-sum {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 11.5px;
  margin-bottom: 7px;
}
.js-foot-sum b {
  font-size: 14px;
}
.js-foot-btns {
  display: flex;
  gap: 6px;
}
.js-foot-btns button {
  flex: 1;
}
.js-foot-tip {
  font-size: 10px;
  line-height: 1.55;
  margin-top: 7px;
}
.js-q {
  width: 100%;
  margin-top: 7px;
  font-size: 11px;
}
</style>
