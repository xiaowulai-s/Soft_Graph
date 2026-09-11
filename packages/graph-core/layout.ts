/**
 * 图谱布局算法
 * 对应技术设计方案 7.2 图谱布局算法 / 5.4.1 布局方案
 *
 * 径向分层力模型：
 *   forceRadial（按层设目标半径）+ forceCollide（防重叠）
 *   + 自定义角度分散力（同层节点均匀铺开）+ forceManyBody
 *   收敛后冻结坐标并缓存，二次打开免重算。
 *   节点数 > 3000 时改用近似布局：按 (tier, type) 分桶后均匀铺开，跳过力学迭代。
 */

import {
  forceSimulation,
  forceRadial,
  forceCollide,
  forceManyBody,
  forceLink,
  type Simulation,
  type SimulationNodeDatum
} from 'd3-force'

export const TIER_RADIUS: Record<number, number> = { 0: 0, 1: 180, 2: 340, 3: 480 }

export type LayoutMode = 'radial' | 'force' | 'cluster'

export interface LayoutInputNode {
  id: string
  tier: number
  radius: number
  /** 用于环形聚类布局的分扇区键 */
  sector?: string
}

export interface LayoutInputEdge {
  source: string
  target: string
}

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>
  iterations: number
  approximate: boolean
  ms: number
}

interface SimNode extends SimulationNodeDatum, LayoutInputNode {
  targetAngle?: number
}

const APPROX_THRESHOLD = 3000

/**
 * 自定义力：同层角度分散。
 * 为同一层的节点预分配均匀角度，并按 strength 把节点拉向该角度射线，
 * 避免力导向自然收敛时同层节点扎堆成串。
 */
function angularSpread(nodes: SimNode[], strength: number) {
  // 按层分组并分配目标角度
  const byTier = new Map<number, SimNode[]>()
  for (const n of nodes) {
    if (n.tier === 0) continue
    const arr = byTier.get(n.tier) || []
    arr.push(n)
    byTier.set(n.tier, arr)
  }
  // 层与层之间错开起始角，视觉上更松散
  let tierIndex = 0
  for (const [, arr] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
    const offset = tierIndex * 0.37
    arr.forEach((n, i) => {
      n.targetAngle = (i / arr.length) * Math.PI * 2 + offset
    })
    tierIndex++
  }

  return (alpha: number): void => {
    const k = strength * alpha
    for (const n of nodes) {
      if (n.tier === 0 || n.targetAngle === undefined) continue
      const r = TIER_RADIUS[n.tier] ?? 480
      const tx = Math.cos(n.targetAngle) * r
      const ty = Math.sin(n.targetAngle) * r
      n.vx = (n.vx ?? 0) + (tx - (n.x ?? 0)) * k
      n.vy = (n.vy ?? 0) + (ty - (n.y ?? 0)) * k
    }
  }
}

/** 近似布局：跳过力学迭代，按 (tier, type) 分桶均匀铺开 */
function approximateLayout(nodes: LayoutInputNode[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {}
  const byTier = new Map<number, LayoutInputNode[]>()
  for (const n of nodes) {
    const arr = byTier.get(n.tier) || []
    arr.push(n)
    byTier.set(n.tier, arr)
  }
  for (const [tier, arr] of byTier) {
    if (tier === 0) {
      for (const n of arr) positions[n.id] = { x: 0, y: 0 }
      continue
    }
    const baseR = TIER_RADIUS[tier] ?? 480
    // 同层节点过多时分成多圈，圈距 44px
    const perRing = Math.max(24, Math.floor((2 * Math.PI * baseR) / 34))
    arr.forEach((n, i) => {
      const ring = Math.floor(i / perRing)
      const idxInRing = i % perRing
      const countInRing = Math.min(perRing, arr.length - ring * perRing)
      const r = baseR + ring * 46
      const a = (idxInRing / countInRing) * Math.PI * 2 + ring * 0.28
      positions[n.id] = { x: Math.cos(a) * r, y: Math.sin(a) * r }
    })
  }
  return positions
}

export function layoutGraph(
  inputNodes: LayoutInputNode[],
  inputEdges: LayoutInputEdge[],
  mode: LayoutMode = 'radial'
): LayoutResult {
  const t0 = Date.now()

  if (inputNodes.length > APPROX_THRESHOLD) {
    return {
      positions: approximateLayout(inputNodes),
      iterations: 0,
      approximate: true,
      ms: Date.now() - t0
    }
  }

  const nodes: SimNode[] = inputNodes.map((n) => {
    const r = TIER_RADIUS[n.tier] ?? 480
    // 给初值，收敛更快也更稳定
    const a = Math.random() * Math.PI * 2
    return {
      ...n,
      x: n.tier === 0 ? 0 : Math.cos(a) * r,
      y: n.tier === 0 ? 0 : Math.sin(a) * r,
      fx: n.tier === 0 ? 0 : undefined,
      fy: n.tier === 0 ? 0 : undefined
    }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const links = inputEdges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }))

  const spread = angularSpread(nodes, mode === 'radial' ? 0.35 : 0.08)

  let sim: Simulation<SimNode, undefined>

  if (mode === 'force') {
    // 力导向：关系簇更明显
    sim = forceSimulation(nodes)
      .force('collide', forceCollide<SimNode>((d) => d.radius + 6).iterations(2))
      .force('charge', forceManyBody<SimNode>().strength(-120).distanceMax(600))
      .force(
        'link',
        forceLink<SimNode, { source: string; target: string }>(links)
          .id((d) => d.id)
          .distance(120)
          .strength(0.35)
      )
      .force('radialWeak', forceRadial<SimNode>((d) => (TIER_RADIUS[d.tier] ?? 480) * 0.9, 0, 0).strength(0.15))
      .alphaDecay(0.035)
      .stop()
  } else if (mode === 'cluster') {
    // 环形聚类：按依赖类型分扇区
    const sectors = [...new Set(nodes.map((n) => n.sector || 'default'))]
    const sectorIndex = new Map(sectors.map((s, i) => [s, i]))
    for (const n of nodes) {
      if (n.tier === 0) continue
      const si = sectorIndex.get(n.sector || 'default') ?? 0
      const span = (Math.PI * 2) / Math.max(sectors.length, 1)
      n.targetAngle = si * span + span / 2
    }
    sim = forceSimulation(nodes)
      .force('radial', forceRadial<SimNode>((d) => TIER_RADIUS[d.tier] ?? 480, 0, 0).strength(0.9))
      .force('collide', forceCollide<SimNode>((d) => d.radius + 6).iterations(2))
      .force('charge', forceManyBody<SimNode>().strength(-30).distanceMax(400))
      .alphaDecay(0.045)
      .stop()
    // 扇区聚拢力
    sim.force('sector', (alpha: number) => {
      const k = 0.5 * alpha
      for (const n of nodes) {
        if (n.tier === 0 || n.targetAngle === undefined) continue
        const r = TIER_RADIUS[n.tier] ?? 480
        n.vx = (n.vx ?? 0) + (Math.cos(n.targetAngle) * r - (n.x ?? 0)) * k
        n.vy = (n.vy ?? 0) + (Math.sin(n.targetAngle) * r - (n.y ?? 0)) * k
      }
    })
  } else {
    // 径向分层（默认），完全对齐设计文档 7.2 的力配置
    sim = forceSimulation(nodes)
      .force('radial', forceRadial<SimNode>((d) => TIER_RADIUS[d.tier] ?? 480, 0, 0).strength(0.9))
      .force('collide', forceCollide<SimNode>((d) => d.radius + 6).iterations(2))
      .force('charge', forceManyBody<SimNode>().strength(-30).distanceMax(400))
      .alphaDecay(0.045)
      .stop()
    sim.force('angular', () => {
      /* 占位，实际在 tick 循环里调用 spread，见下 */
    })
  }

  // 手动迭代到收敛（Worker 内同步执行，不阻塞主线程）
  const maxTicks = 400
  let ticks = 0
  while (sim.alpha() > sim.alphaMin() && ticks < maxTicks) {
    if (mode !== 'cluster') spread(sim.alpha())
    sim.tick()
    ticks++
  }
  sim.stop()

  const positions: Record<string, { x: number; y: number }> = {}
  for (const n of nodes) positions[n.id] = { x: Math.round((n.x ?? 0) * 10) / 10, y: Math.round((n.y ?? 0) * 10) / 10 }

  return { positions, iterations: ticks, approximate: false, ms: Date.now() - t0 }
}
