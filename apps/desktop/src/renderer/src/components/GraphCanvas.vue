<script setup lang="ts">
/**
 * 依赖图谱画布
 * 对应技术设计方案 5.4（布局 / 渲染性能策略 / 交互规范）与 8.2 图谱视图设计要点
 *
 * 渲染策略（5.4.2）：
 *   ≤ 1500 节点   → SVG，DOM 事件直连，文本清晰
 *   1500 ~ 8000   → Canvas 2D，视口裁剪 + 标签 LOD（缩放 < 0.6 隐藏标签）
 *   > 8000        → Canvas + 强制聚合（聚合在 graph-core 完成，此处只负责绘制）
 *
 * 边一律使用直线段，符合需求「通过直线连接外围关联的依赖文件」，不使用贝塞尔曲线。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { GraphEdge, GraphModel, GraphNode } from '@shared/types'
import { formatBytes, initialsOf, nameToHsl, isSharedRuntime } from '@shared/util'
import HoverCard from './HoverCard.vue'
import LayoutWorker from '../workers/layout.worker?worker'

const props = defineProps<{
  model: GraphModel | null
  icon: string | null
  loading: boolean
  loadingText: string
  searchTerm: string
  minConfidence: number
  hiddenKinds: string[]
  layoutMode: 'radial' | 'force' | 'cluster'
}>()

const emit = defineEmits<{
  (e: 'drilldown', node: GraphNode): void
  (e: 'expand', node: GraphNode): void
  (e: 'reset'): void
  (e: 'copy', text: string): void
  (e: 'reveal', path: string): void
  (e: 'context', payload: { node: GraphNode; x: number; y: number }): void
  (e: 'toggle-kind', kind: string): void
  (e: 'stats', payload: { visible: number; mode: 'svg' | 'canvas' }): void
}>()

// ───────────────── 视口与变换 ─────────────────

const host = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const vw = ref(1000)
const vh = ref(700)
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)

const SVG_LIMIT = 1500
const LABEL_LOD = 0.6

const positions = shallowRef<Record<string, { x: number; y: number }>>({})
const layoutBusy = ref(false)
const layoutInfo = ref('')

const hoverId = ref<string | null>(null)
const pinnedId = ref<string | null>(null)
const mouse = ref({ x: 0, y: 0 })

// ───────────────── 节点过滤 ─────────────────

const visibleNodes = computed<GraphNode[]>(() => {
  const m = props.model
  if (!m) return []
  const hidden = new Set(props.hiddenKinds)
  const term = props.searchTerm.trim().toLowerCase()
  const filtered = m.nodes.filter((n) => {
    if (n.type === 'software') return true
    if (n.type === 'file' && n.file) {
      // 「共享运行库」是图例中的独立一档（伪类型），与节点配色保持同一判定，
      // 否则图例上的该项点了没有任何效果
      if (hidden.has(kindOfFile(n.file))) return false
    }
    if (n.type === 'group' && hidden.has('group')) return false
    if (term) {
      const hay = (n.file?.fullPath ?? n.label).toLowerCase()
      if (!hay.includes(term)) return false
    }
    return true
  })
  return filtered
})

// ───────────────── 渐进渲染（M4/D1） ─────────────────
// 大图（> PROGRESSIVE_THRESHOLD）先画 T0/T1/T2，T3 间接依赖分批补上，
// 让用户「先看到骨架，再看到细节」，而不是盯着空白画布等一次性渲染。

const PROGRESSIVE_THRESHOLD = 3000
const REVEAL_BATCH = 800

const revealing = ref(false)
const revealCount = ref<number | null>(null) // null = 已全量
let revealTimer: ReturnType<typeof setTimeout> | null = null

/** 过滤后按层级排序：T0/T1/T2 在前，T3 在后（渐进渲染的批次顺序） */
const orderedNodes = computed<GraphNode[]>(() => {
  const all = visibleNodes.value
  if (all.length <= PROGRESSIVE_THRESHOLD) return all
  const early: GraphNode[] = []
  const late: GraphNode[] = []
  for (const n of all) {
    if (n.type === 'group' || n.tier <= 2 || n.type === 'software') early.push(n)
    else late.push(n)
  }
  return [...early, ...late]
})

const progressive = computed(() => orderedNodes.value.length > PROGRESSIVE_THRESHOLD)

/** 渐进生效时按 revealCount 截断 */
const renderNodes = computed<GraphNode[]>(() => {
  const all = orderedNodes.value
  if (!progressive.value || revealCount.value === null) return all
  return all.slice(0, Math.min(revealCount.value, all.length))
})

function stopReveal(): void {
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  revealing.value = false
}

/** 模型/过滤条件变化后重置渐进状态；完成后恢复全量 */
watch(
  () => [props.model, props.searchTerm, props.hiddenKinds],
  () => {
    stopReveal()
    if (progressive.value) {
      const earlyCount = orderedNodes.value.findIndex((n) => n.tier === 3 && n.type === 'file')
      revealCount.value = earlyCount < 0 ? null : Math.max(PROGRESSIVE_THRESHOLD, earlyCount)
      if (revealCount.value !== null && revealCount.value < orderedNodes.value.length) {
        revealing.value = true
        const step = (): void => {
          if (!revealing.value) return
          revealCount.value = Math.min((revealCount.value ?? 0) + REVEAL_BATCH, orderedNodes.value.length)
          draw()
          if (revealCount.value >= orderedNodes.value.length) {
            revealing.value = false
            revealCount.value = null
            return
          }
          revealTimer = setTimeout(step, 120)
        }
        revealTimer = setTimeout(step, 120)
      }
    } else {
      revealCount.value = null
    }
  },
  { immediate: true, deep: true }
)

onBeforeUnmount(() => stopReveal())

/** 图例分类键：missing / runtime / 具体文件类型 */
function kindOfFile(f: NonNullable<GraphNode['file']>): string {
  if (f.missing) return 'missing'
  if (isSharedRuntime(f.name)) return 'runtime'
  return f.kind
}

const edgeByTarget = computed(() => {
  const m = new Map<string, GraphEdge>()
  for (const e of props.model?.edges ?? []) m.set(e.target, e)
  return m
})

const visibleEdges = computed<GraphEdge[]>(() => {
  const ids = new Set(renderNodes.value.map((n) => n.id))
  return (props.model?.edges ?? []).filter((e) => {
    if (!ids.has(e.source) || !ids.has(e.target)) return false
    return e.confidence >= props.minConfidence
  })
})

const renderMode = computed<'svg' | 'canvas'>(() => (renderNodes.value.length > SVG_LIMIT ? 'canvas' : 'svg'))

const nodeById = computed(() => new Map(renderNodes.value.map((n) => [n.id, n])))

// 悬停时相关链路高亮，其余降透明度至 30%（5.4.3 交互规范）
const activeId = computed(() => pinnedId.value ?? hoverId.value)

const relatedIds = computed(() => {
  const id = activeId.value
  if (!id) return null
  const set = new Set<string>([id])
  for (const e of visibleEdges.value) {
    if (e.source === id) set.add(e.target)
    if (e.target === id) set.add(e.source)
  }
  return set
})

// ───────────────── 颜色（8.5 视觉规范） ─────────────────

function nodeColor(n: GraphNode): string {
  if (n.type === 'software') return 'var(--node-exe)'
  if (n.type === 'group') {
    const p = n.policy
    if (p === 'missing') return 'var(--node-missing)'
    if (p === 'shared_runtime') return 'var(--node-runtime)'
    if (p === 'plugin') return 'var(--node-plugin)'
    if (p === 'system') return 'var(--node-system)'
    return 'var(--node-system)'
  }
  const f = n.file
  if (!f) return 'var(--node-system)'
  if (f.missing) return 'var(--node-missing)'
  if (isSharedRuntime(f.name)) return 'var(--node-runtime)'
  if (isSystemPath(f.fullPath)) return 'var(--node-system)'
  if (f.kind === 'exe') return 'var(--node-exe)'
  if (f.kind === 'dll' || f.kind === 'ocx') return 'var(--node-dll)'
  if (f.kind === 'plugin') return 'var(--node-plugin)'
  return 'var(--node-dll)'
}

/** 系统目录判定：仅用于配色降级，不参与图例分类（图例按「共享运行库」语义划分） */
function isSystemPath(p: string): boolean {
  return /^[a-z]:\\windows\\/i.test(p)
}

/** Canvas 需要真实色值，从 CSS 变量解析 */
const cssColors: Record<string, string> = {}
function resolveColor(v: string): string {
  if (!v.startsWith('var(')) return v
  const name = v.slice(4, -1).trim()
  if (cssColors[name]) return cssColors[name]
  const c = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
  cssColors[name] = c
  return c
}

// ───────────────── 布局（Worker） ─────────────────

let worker: Worker | null = null
let reqId = 0

function ensureWorker(): Worker {
  if (!worker) {
    worker = new LayoutWorker()
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data as {
        id: number
        ok: boolean
        positions?: Record<string, { x: number; y: number }>
        iterations?: number
        approximate?: boolean
        ms?: number
        error?: string
      }
      if (d.id !== reqId) return
      layoutBusy.value = false
      if (!d.ok || !d.positions) {
        layoutInfo.value = `布局失败：${d.error ?? '未知错误'}`
        return
      }
      positions.value = d.positions
      layoutInfo.value = d.approximate
        ? `近似布局 · ${d.ms}ms`
        : `力学收敛 ${d.iterations} 次 · ${d.ms}ms`
      void nextTick(() => {
        fitToView()
        draw()
      })
    }
  }
  return worker
}

function runLayout(): void {
  const m = props.model
  if (!m || m.nodes.length === 0) {
    positions.value = {}
    return
  }
  // 缓存命中：模型已带坐标则直接复用（5.4.1 收敛后冻结坐标并缓存）
  const hasCached = m.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')
  if (hasCached && props.layoutMode === 'radial') {
    const pos: Record<string, { x: number; y: number }> = {}
    for (const n of m.nodes) pos[n.id] = { x: n.x!, y: n.y! }
    positions.value = pos
    layoutInfo.value = '复用缓存坐标'
    void nextTick(() => {
      fitToView()
      draw()
    })
    return
  }

  layoutBusy.value = true
  layoutInfo.value = '布局计算中…'
  const id = ++reqId
  ensureWorker().postMessage({
    id,
    mode: props.layoutMode,
    nodes: m.nodes.map((n) => ({
      id: n.id,
      tier: n.tier,
      radius: n.radius,
      sector: n.type === 'file' ? (edgeByTarget.value.get(n.id)?.type ?? 'data') : 'center'
    })),
    edges: m.edges.map((e) => ({ source: e.source, target: e.target }))
  })
}

watch(() => [props.model, props.layoutMode], runLayout, { immediate: false })

// ───────────────── 视图适配 ─────────────────

function fitToView(): void {
  const pos = positions.value
  const nodes = renderNodes.value
  if (nodes.length === 0) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const p = pos[n.id]
    if (!p) continue
    minX = Math.min(minX, p.x - n.radius)
    minY = Math.min(minY, p.y - n.radius)
    maxX = Math.max(maxX, p.x + n.radius)
    maxY = Math.max(maxY, p.y + n.radius)
  }
  if (!Number.isFinite(minX)) return
  const pad = 70
  const w = Math.max(maxX - minX, 1)
  const h = Math.max(maxY - minY, 1)
  const k = Math.min((vw.value - pad * 2) / w, (vh.value - pad * 2) / h, 1.4)
  scale.value = Math.max(0.2, Math.min(4, k))
  tx.value = vw.value / 2 - ((minX + maxX) / 2) * scale.value
  ty.value = vh.value / 2 - ((minY + maxY) / 2) * scale.value
}

function focusNode(id: string): void {
  const p = positions.value[id]
  if (!p) return
  scale.value = Math.max(scale.value, 1.15)
  tx.value = vw.value / 2 - p.x * scale.value
  ty.value = vh.value / 2 - p.y * scale.value
  pinnedId.value = id
  draw()
}

defineExpose({ fitToView, focusNode, exportPng })

// ───────────────── 交互：缩放 / 平移（带惯性阻尼） ─────────────────

let panning = false
let panStart = { x: 0, y: 0, tx: 0, ty: 0 }
let velocity = { x: 0, y: 0 }
let lastMove = { x: 0, y: 0, t: 0 }
let inertiaRaf = 0

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const rect = host.value!.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const next = Math.max(0.2, Math.min(4, scale.value * factor)) // 缩放 0.2x ~ 4x
  // 以鼠标位置为锚点缩放
  tx.value = mx - ((mx - tx.value) * next) / scale.value
  ty.value = my - ((my - ty.value) * next) / scale.value
  scale.value = next
  draw()
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  cancelInertia()
  panning = true
  panStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
  lastMove = { x: e.clientX, y: e.clientY, t: performance.now() }
  host.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  const rect = host.value!.getBoundingClientRect()
  mouse.value = { x: e.clientX, y: e.clientY }

  if (panning) {
    tx.value = panStart.tx + (e.clientX - panStart.x)
    ty.value = panStart.ty + (e.clientY - panStart.y)
    const now = performance.now()
    const dt = Math.max(now - lastMove.t, 1)
    velocity = { x: ((e.clientX - lastMove.x) / dt) * 16, y: ((e.clientY - lastMove.y) / dt) * 16 }
    lastMove = { x: e.clientX, y: e.clientY, t: now }
    draw()
    return
  }

  if (renderMode.value === 'canvas') {
    const id = pickAt(e.clientX - rect.left, e.clientY - rect.top)
    if (id !== hoverId.value) {
      hoverId.value = id
      draw()
    }
  }
}

function onPointerUp(e: PointerEvent): void {
  if (!panning) return
  panning = false
  host.value?.releasePointerCapture(e.pointerId)
  startInertia()
}

function startInertia(): void {
  const decay = 0.9
  const step = (): void => {
    velocity.x *= decay
    velocity.y *= decay
    if (Math.abs(velocity.x) < 0.15 && Math.abs(velocity.y) < 0.15) {
      inertiaRaf = 0
      return
    }
    tx.value += velocity.x
    ty.value += velocity.y
    draw()
    inertiaRaf = requestAnimationFrame(step)
  }
  cancelInertia()
  inertiaRaf = requestAnimationFrame(step)
}

function cancelInertia(): void {
  if (inertiaRaf) cancelAnimationFrame(inertiaRaf)
  inertiaRaf = 0
  velocity = { x: 0, y: 0 }
}

/** Canvas 模式的命中拾取：只在可见节点内做最近邻查找 */
function pickAt(sx: number, sy: number): string | null {
  const wx = (sx - tx.value) / scale.value
  const wy = (sy - ty.value) / scale.value
  let best: string | null = null
  let bestD = Infinity
  for (const n of renderNodes.value) {
    const p = positions.value[n.id]
    if (!p) continue
    const dx = p.x - wx
    const dy = p.y - wy
    const d = dx * dx + dy * dy
    const r = n.radius + 5
    if (d <= r * r && d < bestD) {
      bestD = d
      best = n.id
    }
  }
  return best
}

// ───────────────── 交互：点击 / 双击 / 右键 ─────────────────

function onNodeEnter(n: GraphNode): void {
  if (pinnedId.value) return
  hoverId.value = n.id
}

function onNodeLeave(): void {
  if (pinnedId.value) return
  hoverId.value = null
}

function onNodeClick(n: GraphNode, e: MouseEvent): void {
  e.stopPropagation()
  pinnedId.value = pinnedId.value === n.id ? null : n.id
  hoverId.value = n.id
}

function onNodeDblClick(n: GraphNode, e: MouseEvent): void {
  e.stopPropagation()
  if (n.type === 'group') {
    emit('expand', n)
    return
  }
  if (n.type === 'file') emit('drilldown', n)
}

function onBackgroundDblClick(): void {
  pinnedId.value = null
  hoverId.value = null
  emit('reset')
  fitToView()
  draw()
}

function onCanvasClick(e: MouseEvent): void {
  if (renderMode.value !== 'canvas') return
  const rect = host.value!.getBoundingClientRect()
  const id = pickAt(e.clientX - rect.left, e.clientY - rect.top)
  pinnedId.value = id && pinnedId.value !== id ? id : null
  draw()
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  const rect = host.value!.getBoundingClientRect()
  const id = renderMode.value === 'canvas' ? pickAt(e.clientX - rect.left, e.clientY - rect.top) : hoverId.value
  if (!id) return
  const n = nodeById.value.get(id)
  if (!n) return
  emit('context', { node: n, x: e.clientX, y: e.clientY })
}

// ───────────────── Canvas 绘制 ─────────────────

function draw(): void {
  emit('stats', { visible: renderNodes.value.length, mode: renderMode.value })
  if (renderMode.value !== 'canvas') return
  const cv = canvasEl.value
  if (!cv) return
  const dpr = window.devicePixelRatio || 1
  if (cv.width !== vw.value * dpr || cv.height !== vh.value * dpr) {
    cv.width = Math.round(vw.value * dpr)
    cv.height = Math.round(vh.value * dpr)
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, vw.value, vh.value)
  ctx.translate(tx.value, ty.value)
  ctx.scale(scale.value, scale.value)

  const pos = positions.value
  const rel = relatedIds.value
  // 视口裁剪：每帧只绘制可见区域内的节点与边
  const pad = 80 / scale.value
  const view = {
    x0: -tx.value / scale.value - pad,
    y0: -ty.value / scale.value - pad,
    x1: (vw.value - tx.value) / scale.value + pad,
    y1: (vh.value - ty.value) / scale.value + pad
  }
  const inView = (p: { x: number; y: number }): boolean =>
    p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1

  // 批量绘制：同色同宽的直线合并为单条 path，减少绘制调用
  const buckets = new Map<string, GraphEdge[]>()
  for (const e of visibleEdges.value) {
    const a = pos[e.source]
    const b = pos[e.target]
    if (!a || !b) continue
    if (!inView(a) && !inView(b)) continue
    const dim = rel ? (rel.has(e.source) && rel.has(e.target) ? 0 : 1) : 0
    const w = e.confidence >= 0.75 ? 2 : 1
    const key = `${e.missing ? 'm' : 'n'}|${w}|${dim}`
    const arr = buckets.get(key) ?? []
    arr.push(e)
    buckets.set(key, arr)
  }

  const cMiss = resolveColor('var(--node-missing)')
  const cEdge = resolveColor('var(--node-system)')

  for (const [key, arr] of buckets) {
    const [kind, w, dim] = key.split('|')
    ctx.beginPath()
    ctx.lineWidth = Number(w) / Math.max(scale.value, 0.6)
    ctx.strokeStyle = kind === 'm' ? cMiss : cEdge
    ctx.globalAlpha = dim === '1' ? 0.12 : kind === 'm' ? 0.85 : 0.42
    ctx.setLineDash(kind === 'm' ? [5 / scale.value, 4 / scale.value] : [])
    for (const e of arr) {
      const a = pos[e.source]
      const b = pos[e.target]
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y) // 直线段，不使用贝塞尔
    }
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  const showLabel = scale.value >= LABEL_LOD
  ctx.font = `${11 / scale.value}px var(--sans)`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const cText = resolveColor('var(--text-2)')

  for (const n of renderNodes.value) {
    const p = pos[n.id]
    if (!p || !inView(p)) continue
    const dim = rel && !rel.has(n.id)
    ctx.globalAlpha = dim ? 0.3 : 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, n.radius, 0, Math.PI * 2)
    ctx.fillStyle = resolveColor(nodeColor(n))
    ctx.fill()
    if (n.id === activeId.value) {
      ctx.lineWidth = 2.5 / scale.value
      ctx.strokeStyle = resolveColor('var(--text)')
      ctx.stroke()
    }
    if (showLabel && !dim && (n.type !== 'file' || n.radius > 12 || scale.value > 1)) {
      ctx.fillStyle = cText
      const label = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label
      ctx.fillText(label, p.x, p.y + n.radius + 3 / scale.value)
    }
  }
  ctx.globalAlpha = 1
  ctx.restore()
}

// ───────────────── 导出 PNG（FR-07） ─────────────────

async function exportPng(): Promise<string | null> {
  const w = vw.value
  const h = vh.value
  const cv = document.createElement('canvas')
  const dpr = 2
  cv.width = w * dpr
  cv.height = h * dpr
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = resolveColor('var(--bg)')
  ctx.fillRect(0, 0, w, h)
  ctx.translate(tx.value, ty.value)
  ctx.scale(scale.value, scale.value)

  const pos = positions.value
  ctx.strokeStyle = resolveColor('var(--node-system)')
  ctx.globalAlpha = 0.45
  ctx.beginPath()
  for (const e of visibleEdges.value) {
    const a = pos[e.source]
    const b = pos[e.target]
    if (!a || !b) continue
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  ctx.lineWidth = 1 / scale.value
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.font = `${11 / scale.value}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const n of renderNodes.value) {
    const p = pos[n.id]
    if (!p) continue
    ctx.beginPath()
    ctx.arc(p.x, p.y, n.radius, 0, Math.PI * 2)
    ctx.fillStyle = resolveColor(nodeColor(n))
    ctx.fill()
    ctx.fillStyle = resolveColor('var(--text-2)')
    ctx.fillText(n.label.slice(0, 24), p.x, p.y + n.radius + 3 / scale.value)
  }
  return cv.toDataURL('image/png')
}

// ───────────────── 尺寸监听 ─────────────────

let ro: ResizeObserver | null = null

onMounted(() => {
  const el = host.value!
  const sync = (): void => {
    vw.value = el.clientWidth
    vh.value = el.clientHeight
    draw()
  }
  sync()
  ro = new ResizeObserver(sync)
  ro.observe(el)
  runLayout()
})

onBeforeUnmount(() => {
  ro?.disconnect()
  worker?.terminate()
  worker = null
  cancelInertia()
})

watch(renderNodes, () => draw())
watch([scale, tx, ty], () => draw())

// ───────────────── 悬停对象 ─────────────────

const hoverNode = computed(() => (activeId.value ? nodeById.value.get(activeId.value) ?? null : null))
const hoverEdge = computed(() => (activeId.value ? edgeByTarget.value.get(activeId.value) ?? null : null))

const LEGEND: { kind: string; label: string; color: string }[] = [
  { kind: 'exe', label: '主程序', color: 'var(--node-exe)' },
  { kind: 'dll', label: 'DLL', color: 'var(--node-dll)' },
  { kind: 'plugin', label: '插件', color: 'var(--node-plugin)' },
  { kind: 'runtime', label: '共享运行库', color: 'var(--node-runtime)' },
  { kind: 'missing', label: '缺失依赖', color: 'var(--node-missing)' },
  { kind: 'group', label: '聚合分组', color: 'var(--node-system)' }
]

const centerNode = computed(() => renderNodes.value.find((n) => n.type === 'software') ?? null)
</script>

<template>
  <div
    ref="host"
    class="gc"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick.self="onBackgroundDblClick"
    @click="onCanvasClick"
    @contextmenu="onContextMenu"
  >
    <!-- SVG 渲染路径（≤1500 节点）：DOM 事件直连，便于实现悬停与选中 -->
    <svg v-if="renderMode === 'svg'" class="gc-svg" :width="vw" :height="vh">
      <g :transform="`translate(${tx},${ty}) scale(${scale})`">
        <g class="edges">
          <line
            v-for="e in visibleEdges"
            :key="e.id"
            :x1="positions[e.source]?.x ?? 0"
            :y1="positions[e.source]?.y ?? 0"
            :x2="positions[e.target]?.x ?? 0"
            :y2="positions[e.target]?.y ?? 0"
            :stroke="e.missing ? 'var(--node-missing)' : 'var(--node-system)'"
            :stroke-width="(e.confidence >= 0.75 ? 2 : 1) / scale"
            :stroke-dasharray="e.missing ? `${5 / scale} ${4 / scale}` : undefined"
            :opacity="relatedIds ? (relatedIds.has(e.source) && relatedIds.has(e.target) ? 0.9 : 0.12) : e.missing ? 0.85 : 0.4"
          />
        </g>
        <g class="nodes">
          <g
            v-for="n in renderNodes"
            :key="n.id"
            :transform="`translate(${positions[n.id]?.x ?? 0},${positions[n.id]?.y ?? 0})`"
            :opacity="relatedIds && !relatedIds.has(n.id) ? 0.3 : 1"
            class="gc-node"
            @mouseenter="onNodeEnter(n)"
            @mouseleave="onNodeLeave"
            @click="onNodeClick(n, $event)"
            @dblclick="onNodeDblClick(n, $event)"
          >
            <!-- 中心软件节点：直径 96px + 品牌色光晕（8.2） -->
            <template v-if="n.type === 'software'">
              <circle :r="n.radius + 14" :fill="nodeColor(n)" opacity="0.14" />
              <circle :r="n.radius + 6" :fill="nodeColor(n)" opacity="0.22" />
              <circle :r="n.radius" fill="var(--panel)" :stroke="nodeColor(n)" :stroke-width="2.5 / scale" />
              <image
                v-if="icon"
                :href="icon"
                :x="-n.radius * 0.62"
                :y="-n.radius * 0.62"
                :width="n.radius * 1.24"
                :height="n.radius * 1.24"
                preserveAspectRatio="xMidYMid meet"
              />
              <text
                v-else
                text-anchor="middle"
                dominant-baseline="central"
                :font-size="n.radius * 0.62"
                :fill="nameToHsl(n.label)"
                font-weight="700"
              >
                {{ initialsOf(n.label) }}
              </text>
            </template>

            <!-- 聚合节点：方形以形状二次区分（8.5 避免仅依赖颜色） -->
            <template v-else-if="n.type === 'group'">
              <rect
                :x="-n.radius"
                :y="-n.radius"
                :width="n.radius * 2"
                :height="n.radius * 2"
                :rx="5"
                :fill="nodeColor(n)"
                :opacity="n.policy === 'missing' ? 0.9 : 0.72"
                :stroke="n.id === activeId ? 'var(--text)' : 'none'"
                :stroke-width="2.5 / scale"
              />
              <text
                text-anchor="middle"
                dominant-baseline="central"
                :font-size="Math.max(9, n.radius * 0.6)"
                fill="#fff"
                font-weight="700"
              >
                +{{ n.collapsedCount }}
              </text>
            </template>

            <!-- 文件节点 -->
            <template v-else>
              <circle
                :r="n.radius"
                :fill="nodeColor(n)"
                :stroke="n.id === activeId ? 'var(--text)' : 'none'"
                :stroke-width="2.5 / scale"
              />
              <circle
                v-if="n.file?.missing"
                :r="n.radius * 0.42"
                fill="var(--bg)"
              />
            </template>

            <!-- 标签：缩放过小时自动隐藏（LOD） -->
            <text
              v-if="scale >= LABEL_LOD && (n.type !== 'file' || n.radius > 12 || scale > 1.1)"
              text-anchor="middle"
              :y="n.radius + 11 / scale"
              :font-size="11 / scale"
              fill="var(--text-2)"
              class="gc-label"
            >
              {{ n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label }}
            </text>
            <text
              v-if="n.type === 'software'"
              text-anchor="middle"
              :y="n.radius + 26 / scale"
              :font-size="10 / scale"
              fill="var(--text-2)"
            >
              {{ n.software?.version }}
            </text>
          </g>
        </g>
      </g>
    </svg>

    <!-- Canvas 渲染路径（>1500 节点） -->
    <canvas
      v-else
      ref="canvasEl"
      class="gc-canvas"
      :style="{ width: vw + 'px', height: vh + 'px' }"
    />

    <!-- 图例：常驻左下角，点击类型可快速筛选（8.2） -->
    <div class="gc-legend">
      <div
        v-for="l in LEGEND"
        :key="l.kind"
        class="gc-legend-item"
        :class="{ off: hiddenKinds.includes(l.kind) }"
        :title="hiddenKinds.includes(l.kind) ? '点击显示' : '点击隐藏'"
        @click.stop="emit('toggle-kind', l.kind)"
      >
        <span class="dot" :style="{ background: l.color }" />
        {{ l.label }}
      </div>
    </div>

    <!-- 渲染状态 -->
    <div class="gc-meta">
      <span>{{ renderMode === 'svg' ? 'SVG' : 'Canvas' }} · {{ renderNodes.length }}/{{ orderedNodes.length }} 节点 · {{ visibleEdges.length }} 边{{ revealing ? '（渐进渲染中…）' : '' }}</span>
      <span v-if="layoutInfo" class="dim">· {{ layoutInfo }}</span>
      <span class="dim">· {{ Math.round(scale * 100) }}%</span>
      <span v-if="model" class="dim">· 体积 {{ formatBytes(model.stats.totalSizeBytes) }}</span>
    </div>

    <!-- 悬停详情浮层 -->
    <HoverCard
      v-if="hoverNode && hoverNode.type !== 'software'"
      :node="hoverNode"
      :edge="hoverEdge"
      :x="mouse.x"
      :y="mouse.y"
      :vw="vw"
      :vh="vh"
      :pinned="!!pinnedId"
      @copy="emit('copy', $event)"
      @reveal="emit('reveal', $event)"
      @focus="focusNode"
      @close="pinnedId = null"
    />

    <!-- 加载与空态 -->
    <div v-if="loading || layoutBusy" class="gc-mask">
      <div class="gc-spinner" />
      <div class="gc-mask-text">{{ loading ? loadingText : '布局计算中…' }}</div>
    </div>
    <div v-else-if="!model" class="gc-empty">
      <div class="gc-empty-icon">◎</div>
      <div>从左侧选择一个软件，查看它的依赖文件图谱</div>
      <div class="dim" style="margin-top: 6px; font-size: 11.5px">
        中心为软件图标，外围直线连接其依赖文件；鼠标悬停文件节点可查看完整路径
      </div>
    </div>
    <div v-else-if="renderNodes.length <= 1" class="gc-empty">
      <div class="gc-empty-icon">∅</div>
      <div>当前筛选条件下没有可显示的依赖节点</div>
      <div class="dim" style="margin-top: 6px; font-size: 11.5px">试试降低置信度阈值，或在图例中恢复被隐藏的类型</div>
    </div>
  </div>
</template>

<style scoped>
.gc {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  cursor: grab;
  background:
    radial-gradient(circle at 50% 46%, color-mix(in srgb, var(--node-exe) 7%, transparent), transparent 62%),
    var(--bg);
}
.gc:active {
  cursor: grabbing;
}
.gc-svg,
.gc-canvas {
  position: absolute;
  inset: 0;
  display: block;
}
.gc-node {
  cursor: pointer;
}
.gc-label {
  pointer-events: none;
}
.gc-legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 7px 9px;
  font-size: 11px;
  backdrop-filter: blur(6px);
}
.gc-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--text);
  transition: opacity 0.12s;
}
.gc-legend-item.off {
  opacity: 0.35;
  text-decoration: line-through;
}
.gc-legend-item .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.gc-meta {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  gap: 5px;
  font-size: 11px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px 9px;
  backdrop-filter: blur(6px);
}
.gc-mask,
.gc-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  color: var(--text-2);
  font-size: 13px;
  text-align: center;
  padding: 0 40px;
}
.gc-empty {
  background: transparent;
  pointer-events: none;
}
.gc-empty-icon {
  font-size: 44px;
  opacity: 0.28;
  line-height: 1;
}
.gc-spinner {
  width: 26px;
  height: 26px;
  border: 2.5px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: sg-spin 0.8s linear infinite;
}
.gc-mask-text {
  font-size: 12px;
}
</style>
