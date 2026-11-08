<script setup lang="ts">
/**
 * BackupFlowLine —— 备份过程可视化流动线（v6.2 动效）
 * - 粒子沿源→目标弧线流动，速度随实时速率变化；预览扫描复用同一条线
 * - 当前文件徽标 + 数字缓动滚动；完成时粒子冲入目标端 + 波纹 + 打勾描边 + 彩带
 * - 单 Canvas 按需 rAF；prefers-reduced-motion 降级为静态线
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  mode: 'preview' | 'run'
  source: string
  target: string
  /** run：已拷贝数 */
  copied?: number
  bytes?: number
  /** preview：已扫描数 */
  scanned?: number
  current?: string
  paused?: boolean
  /** 完成庆祝触发器：数值自增即触发一次 */
  celebrate?: number
}>()

const emit = defineEmits<{ (e: 'celebrated'): void }>()

const wrap = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const ctxOk = ref(false)

/** 数字缓动显示 */
const copiedDisp = ref(0)
const bytesDisp = ref(0)
const scannedDisp = ref(0)

const shortCurrent = computed(() => {
  const c = props.current ?? ''
  if (!c) return ''
  return c.length > 52 ? '…' + c.slice(-52) : c
})

const bytesDispText = computed(() => {
  const v = bytesDisp.value
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
})

// ── Canvas 动画 ──
interface Particle {
  t: number
  speed: number
  size: number
  life: number
}
interface Ring {
  r: number
  alpha: number
}
interface Confetti {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  color: string
  life: number
  size: number
}

let raf = 0
let particles: Particle[] = []
let rings: Ring[] = []
let confetti: Confetti[] = []
let lastFrame = 0
let spawnAcc = 0
let lastBytes = 0
let lastBytesTs = 0
let rateEma = 0 // bytes/s
let W = 0
let H = 0
let accent = '#14b8a6'
let accentSoft = 'rgba(20,184,166,0.25)'
let frameCount = 0
let celebrateArmed = props.celebrate ?? 0
let celebrateAt = 0

const reduced =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function readColors(): void {
  if (!wrap.value) return
  const cs = getComputedStyle(wrap.value)
  const a = cs.getPropertyValue('--accent').trim()
  if (a) {
    accent = a
    // 8 位 hex 或 6 位 hex → rgba
    const m = a.match(/^#([0-9a-f]{6})/i)
    if (m) accentSoft = `rgba(${parseInt(m[1].slice(0, 2), 16)},${parseInt(m[1].slice(2, 4), 16)},${parseInt(m[1].slice(4, 6), 16)},0.22)`
  }
}

function bez(t: number, p0: number, c: number, p1: number): number {
  const u = 1 - t
  return u * u * p0 + 2 * u * t * c + t * t * p1
}

function resize(): void {
  const cv = canvas.value
  const el = wrap.value
  if (!cv || !el) return
  const r = el.getBoundingClientRect()
  if (r.width < 40) return
  W = r.width
  H = 76
  const dpr = Math.min(devicePixelRatio || 1, 2)
  cv.width = W * dpr
  cv.height = H * dpr
  cv.style.height = H + 'px'
  const ctx = cv.getContext('2d')
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctxOk.value = true
}

function spawn(pps: number, dt: number): void {
  spawnAcc += pps * dt
  while (spawnAcc >= 1) {
    spawnAcc -= 1
    particles.push({
      t: 0,
      speed: 0.55 + Math.random() * 0.5, // 归一化速度基数
      size: 1.4 + Math.random() * 1.8,
      life: 1
    })
  }
}

function burstConfetti(): void {
  if (reduced) return
  const colors = ['#14b8a6', '#2dd4bf', '#34d399', '#0f6e56', '#5eead4']
  const x = W - 34
  const y = 40
  for (let i = 0; i < 64; i++) {
    const ang = Math.PI * (0.75 + Math.random() * 1.2) // 向左上扇形喷
    const sp = 2.2 + Math.random() * 3.6
    confetti.push({
      x,
      y,
      vx: Math.cos(ang) * sp * (Math.random() > 0.5 ? 1 : -0.4),
      vy: -Math.abs(Math.sin(ang)) * sp,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length],
      life: 1,
      size: 3 + Math.random() * 4
    })
  }
}

function frame(now: number): void {
  raf = 0
  const cv = canvas.value
  const ctx = cv?.getContext('2d')
  if (!cv || !ctx || !W) {
    loopIfActive()
    return
  }
  const dt = Math.min((now - (lastFrame || now)) / 1000, 0.1)
  lastFrame = now
  frameCount++

  if (frameCount % 90 === 0) readColors()

  // 速率估计（仅 run 模式）
  if (props.mode === 'run') {
    const b = props.bytes ?? 0
    const now2 = performance.now()
    if (lastBytesTs && b >= lastBytes) {
      const inst = (b - lastBytes) / Math.max((now2 - lastBytesTs) / 1000, 0.001)
      rateEma = rateEma * 0.9 + inst * 0.1
    }
    lastBytes = b
    lastBytesTs = now2
  }

  // 数字缓动
  const targetCopied = props.copied ?? 0
  const targetScanned = props.scanned ?? 0
  copiedDisp.value += (targetCopied - copiedDisp.value) * Math.min(dt * 8, 1)
  if (Math.abs(targetCopied - copiedDisp.value) < 0.6) copiedDisp.value = targetCopied
  scannedDisp.value += (targetScanned - scannedDisp.value) * Math.min(dt * 8, 1)
  if (Math.abs(targetScanned - scannedDisp.value) < 0.6) scannedDisp.value = targetScanned
  bytesDisp.value += ((props.bytes ?? 0) - bytesDisp.value) * Math.min(dt * 8, 1)

  const active = props.paused ? false : true
  // 粒子生成速率：预览固定中速；运行随速率；暂停时稀疏呼吸
  let pps = 14
  if (props.mode === 'run' && active) {
    pps = Math.max(8, Math.min(70, 8 + Math.log10(rateEma + 1) * 12))
  } else if (props.mode === 'preview') {
    pps = 22
  }
  if (props.paused) pps = 2
  if (active) spawn(pps, dt)

  // 完成庆祝：全部粒子加速冲入
  const finishing = celebrateAt > 0 && now - celebrateAt < 900

  ctx.clearRect(0, 0, W, H)

  const y0 = 42
  const x0 = 30
  const x1 = W - 34
  const cy = 10

  // 基线
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.quadraticCurveTo(W / 2, cy, x1, y0)
  ctx.strokeStyle = accentSoft
  ctx.lineWidth = 1.5
  ctx.stroke()

  // 粒子
  const next: Particle[] = []
  for (const p of particles) {
    if (finishing) p.t += dt * (2.2 + p.speed)
    else p.t += dt * p.speed * (props.paused ? 0.08 : 0.42)
    if (p.t >= 1) {
      // 抵达：目标端脉冲
      rings.push({ r: 3, alpha: 0.5 })
      continue
    }
    next.push(p)
    const px = bez(p.t, x0, W / 2, x1)
    const py = bez(p.t, y0, cy, y0)
    // 拖尾（3 段渐隐残影）
    for (let g = 1; g <= 3; g++) {
      const gt = Math.max(p.t - g * 0.018 * (p.speed + 0.4), 0)
      const gx = bez(gt, x0, W / 2, x1)
      const gy = bez(gt, y0, cy, y0)
      ctx.beginPath()
      ctx.arc(gx, gy, p.size * (1 - g * 0.22), 0, Math.PI * 2)
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.16 * (1 - g / 4) * p.life
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(px, py, p.size, 0, Math.PI * 2)
    ctx.fillStyle = accent
    ctx.shadowColor = accent
    ctx.shadowBlur = 7
    ctx.globalAlpha = 0.9
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
  }
  particles = next.slice(-160)

  // 抵达波纹
  const nr: Ring[] = []
  for (const r of rings) {
    r.r += dt * 34
    r.alpha -= dt * 1.5
    if (r.alpha <= 0) continue
    nr.push(r)
    ctx.beginPath()
    ctx.arc(x1, y0, r.r, 0, Math.PI * 2)
    ctx.strokeStyle = accent
    ctx.globalAlpha = Math.max(r.alpha, 0)
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  rings = nr.slice(-8)

  // 端点节点
  for (const [nx, isTarget] of [
    [x0, false],
    [x1, true]
  ] as [number, boolean][]) {
    ctx.beginPath()
    ctx.arc(nx, y0, 7, 0, Math.PI * 2)
    ctx.fillStyle = isTarget ? accent : 'rgba(128,140,150,0.9)'
    ctx.shadowColor = accent
    ctx.shadowBlur = isTarget && active ? 10 : 3
    ctx.globalAlpha = isTarget ? 0.95 : 0.55
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
  }

  // 彩带
  if (confetti.length) {
    const nc: Confetti[] = []
    for (const c of confetti) {
      c.life -= dt * 1.05
      if (c.life <= 0) continue
      c.vy += dt * 7
      c.x += c.vx
      c.y += c.vy
      c.rot += c.vr
      nc.push(c)
      ctx.save()
      ctx.translate(c.x, c.y)
      ctx.rotate(c.rot)
      ctx.globalAlpha = Math.min(c.life, 1)
      ctx.fillStyle = c.color
      ctx.fillRect(-c.size / 2, -c.size / 4, c.size, c.size / 2)
      ctx.restore()
      ctx.globalAlpha = 1
    }
    confetti = nc
  }

  loopIfActive()
}

function loopIfActive(): void {
  if (reduced) return
  if (!raf) raf = requestAnimationFrame(frame)
}

let ro: ResizeObserver | null = null

onMounted(() => {
  readColors()
  resize()
  ro = new ResizeObserver(() => resize())
  if (wrap.value) ro.observe(wrap.value)
  // 初始数字直接到位
  copiedDisp.value = props.copied ?? 0
  bytesDisp.value = props.bytes ?? 0
  scannedDisp.value = props.scanned ?? 0
  loopIfActive()
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  ro?.disconnect()
})

watch(
  () => [props.mode, props.paused],
  () => loopIfActive()
)

watch(
  () => props.celebrate,
  (v) => {
    if (v && v > celebrateArmed) {
      celebrateArmed = v
      celebrateAt = performance.now()
      burstConfetti()
      loopIfActive()
      emit('celebrated')
    }
  }
)
</script>

<template>
  <div ref="wrap" class="bfl" :class="{ 'bfl-paused': paused }">
    <canvas ref="canvas" class="bfl-cv" />
    <div class="bfl-badge" :title="current">
      <span class="bfl-badge-tag">{{ mode === 'preview' ? '扫描' : '复制' }}</span>
      <span class="mono">{{ current ? shortCurrent : '…' }}</span>
    </div>
    <div class="bfl-stats">
      <template v-if="mode === 'preview'">
        <span>已扫描</span><b class="mono">{{ Math.round(scannedDisp).toLocaleString() }}</b><span>个文件</span>
      </template>
      <template v-else>
        <span>已拷贝</span><b class="mono">{{ Math.round(copiedDisp).toLocaleString() }}</b><span>个 ·</span>
        <b class="mono">{{ bytesDispText }}</b>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bfl {
  position: relative;
  height: 76px;
  margin: 6px 0 2px;
  border: 1px solid var(--border-hair);
  border-radius: var(--radius);
  background:
    radial-gradient(120% 90% at 85% 60%, var(--accent-soft) 0%, transparent 55%),
    var(--surface-2);
  overflow: hidden;
}
.bfl-cv {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 76px;
  pointer-events: none;
}
.bfl-badge {
  position: absolute;
  top: 5px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 72%;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  padding: 1.5px 8px;
  border-radius: 99px;
  background: var(--panel);
  border: 1px solid var(--border-hair);
  box-shadow: var(--shadow-sm);
  white-space: nowrap;
  overflow: hidden;
}
.bfl-badge .mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 9.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
}
.bfl-badge-tag {
  flex: none;
  font-size: 9px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 99px;
  padding: 0 6px;
  line-height: 14px;
}
.bfl-stats {
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 10.5px;
  color: var(--text-2);
  white-space: nowrap;
}
.bfl-stats b {
  color: var(--accent);
  font-weight: 600;
}
.bfl-stats .mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}
.bfl-paused {
  opacity: 0.75;
}
@media (prefers-reduced-motion: reduce) {
  .bfl {
    background: var(--surface-2);
  }
}
</style>
