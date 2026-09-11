/**
 * 图谱构建器
 * 对应技术设计方案 5.3（图谱数据模型 / 分组策略）与 5.4.1（径向分层布局）
 *
 * 分组策略要点（原文）：为避免图谱被系统 DLL 淹没，kernel32、user32 等高频系统依赖
 * 默认折叠为单个「系统依赖」聚合节点；共享运行库单独成组，因为它们恰恰是
 * 用户最关心的「能不能删」对象。
 */

import type {
  DependencyEdge,
  FileNode,
  GraphEdge,
  GraphModel,
  GraphNode,
  GroupPolicy,
  SoftwareItem
} from '../shared/types'
import { isSharedRuntime, normKey, isSubPath, clamp } from '../shared/util'

/** 层级半径表，对齐设计文档 5.4.1 */
export const TIER_RADIUS: Record<number, number> = { 0: 0, 1: 180, 2: 340, 3: 480 }

/** 置信度阈值策略（7.1） */
export const CONF_STRONG = 0.75
export const CONF_WEAK = 0.5

export interface BuildOptions {
  /** 折叠系统依赖为聚合节点 */
  collapseSystem?: boolean
  /** 折叠共享运行库 */
  collapseSharedRuntime?: boolean
  /** T3 间接依赖折叠 */
  collapseTier3?: boolean
  /** 已展开的聚合节点 id */
  expanded?: Set<string>
  /** 节点上限，超过则强制聚合（5.4.2） */
  maxNodes?: number
}

function nodeRadiusBySize(size: number): number {
  // 文件节点直径 24~36px（按体积微调）→ 半径 12~18
  if (size <= 0) return 12
  const r = 12 + clamp(Math.log10(size) - 3, 0, 3) * 2
  return Math.round(r * 10) / 10
}

const SYSROOT = normKey(process.env.SystemRoot || 'C:\\Windows')

function classifyGroup(f: FileNode, sw: SoftwareItem, confidence: number): GroupPolicy | null {
  if (f.missing) return 'missing'
  if (isSharedRuntime(f.name)) return 'shared_runtime'
  const p = normKey(f.fullPath)
  const inSystem = p.startsWith(SYSROOT + '\\')
  if (inSystem) return 'system'
  if (f.kind === 'plugin') return 'plugin'
  if (confidence < CONF_WEAK) return 'other'
  if ((f.kind === 'config' || f.kind === 'data') && sw.installPath && !isSubPath(f.fullPath, sw.installPath))
    return 'user_data'
  return null
}

/** 判定文件所属层级 */
function classifyTier(
  f: FileNode,
  edge: DependencyEdge,
  sw: SoftwareItem
): 1 | 2 | 3 {
  // T1：主程序与核心模块 —— 位于安装目录（或其 bin 层）内的可执行模块
  const isModule = f.kind === 'exe' || f.kind === 'dll' || f.kind === 'ocx'
  const inInstall = sw.installPath ? isSubPath(f.fullPath, sw.installPath) : false
  if (inInstall && isModule) return 1
  // T2：直接依赖（导入表命中）
  if (edge.evidence.includes('E2') || edge.evidence.includes('E4') || edge.evidence.includes('E5')) return 2
  if (edge.evidence.includes('E3')) return 2
  if (inInstall) return 2
  // T3：其余（间接 / 弱证据 / 目录归属外围）
  return 3
}

export function buildGraph(
  sw: SoftwareItem,
  files: Map<string, FileNode>,
  deps: DependencyEdge[],
  stats: { parsedOk: number; parseFailed: number; totalBytes: number; buildMs: number; fromCache?: boolean },
  opts: BuildOptions = {}
): GraphModel {
  const {
    collapseSystem = true,
    collapseSharedRuntime = false,
    collapseTier3 = true,
    expanded = new Set<string>(),
    maxNodes = 8000
  } = opts

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  // ── 中心节点 T0 ──
  const center: GraphNode = {
    id: sw.id,
    type: 'software',
    label: sw.name,
    tier: 0,
    radius: 48, // 图标 96px
    software: sw
  }
  nodes.push(center)

  // ── 分桶 ──
  interface Entry {
    file: FileNode
    edge: DependencyEdge
    tier: 1 | 2 | 3
    group: GroupPolicy | null
  }
  const entries: Entry[] = []
  for (const e of deps) {
    const f = files.get(e.targetId)
    if (!f) continue
    const tier = classifyTier(f, e, sw)
    const group = classifyGroup(f, sw, e.confidence)
    entries.push({ file: f, edge: e, tier, group })
  }

  const groupBuckets = new Map<GroupPolicy, Entry[]>()
  const direct: Entry[] = []

  for (const en of entries) {
    let shouldGroup = false
    if (en.group === 'system' && collapseSystem) shouldGroup = true
    if (en.group === 'shared_runtime' && collapseSharedRuntime) shouldGroup = true
    if (en.group === 'missing') shouldGroup = true // 缺失依赖聚合，但默认展开显示
    if (en.group === 'other') shouldGroup = true
    if (en.group === 'user_data') shouldGroup = true
    if (en.group === 'plugin' && (groupBuckets.get('plugin')?.length ?? 0) > 40) shouldGroup = true
    if (en.tier === 3 && collapseTier3) shouldGroup = true

    if (shouldGroup) {
      const key: GroupPolicy = en.group ?? 'other'
      const arr = groupBuckets.get(key) || []
      arr.push(en)
      groupBuckets.set(key, arr)
    } else {
      direct.push(en)
    }
  }

  const pushFileNode = (en: Entry, tierOverride?: 1 | 2 | 3): void => {
    const tier = tierOverride ?? en.tier
    nodes.push({
      id: en.file.id,
      type: 'file',
      label: en.file.name,
      tier,
      radius: nodeRadiusBySize(en.file.sizeBytes),
      file: en.file
    })
    edges.push({
      id: `${sw.id}->${en.file.id}`,
      source: sw.id,
      target: en.file.id,
      type: en.edge.type,
      confidence: en.edge.confidence,
      evidence: en.edge.evidence,
      missing: en.file.missing
    })
  }

  // 直连节点（按置信度降序，保证重要节点优先入图）
  direct.sort((a, b) => b.edge.confidence - a.edge.confidence)
  for (const en of direct) {
    if (nodes.length >= maxNodes) break
    pushFileNode(en)
  }

  // ── 聚合节点 ──
  const groupOrder: GroupPolicy[] = ['missing', 'shared_runtime', 'plugin', 'system', 'user_data', 'other']
  const groupCounts: Record<string, number> = {}

  for (const policy of groupOrder) {
    const bucket = groupBuckets.get(policy)
    if (!bucket || bucket.length === 0) continue
    groupCounts[policy] = bucket.length

    const groupId = `grp_${sw.id}_${policy}`
    const isExpanded = expanded.has(groupId)

    // 缺失依赖始终展开（红色告警必须直接可见，FR-16）
    const forceExpand = policy === 'missing' && bucket.length <= 40

    if (isExpanded || forceExpand) {
      bucket.sort((a, b) => b.edge.confidence - a.edge.confidence)
      for (const en of bucket.slice(0, 600)) {
        if (nodes.length >= maxNodes) break
        pushFileNode(en, policy === 'missing' ? 2 : en.tier)
      }
      if (bucket.length > 600) {
        nodes.push({
          id: groupId + '_rest',
          type: 'group',
          label: `其余 ${bucket.length - 600} 项`,
          tier: 3,
          radius: 22,
          policy,
          collapsedCount: bucket.length - 600
        })
        edges.push({
          id: `${sw.id}->${groupId}_rest`,
          source: sw.id,
          target: groupId + '_rest',
          type: 'binds',
          confidence: 0.4,
          evidence: ['E1']
        })
      }
    } else {
      const totalBytes = bucket.reduce((s, e) => s + e.file.sizeBytes, 0)
      nodes.push({
        id: groupId,
        type: 'group',
        label: GROUP_LABEL_LOCAL[policy],
        tier: policy === 'other' || policy === 'user_data' ? 3 : 2,
        radius: clamp(20 + Math.log10(bucket.length + 1) * 8, 20, 40),
        policy,
        collapsedCount: bucket.length,
        children: bucket.map((en) => ({
          id: en.file.id,
          type: 'file' as const,
          label: en.file.name,
          tier: en.tier,
          radius: nodeRadiusBySize(en.file.sizeBytes),
          file: en.file
        })),
        // 供 UI 展示聚合体积
        x: undefined,
        y: undefined
      })
      edges.push({
        id: `${sw.id}->${groupId}`,
        source: sw.id,
        target: groupId,
        type: 'binds',
        confidence: Math.max(...bucket.map((e) => e.edge.confidence)),
        evidence: [...new Set(bucket.flatMap((e) => e.edge.evidence))],
        missing: policy === 'missing'
      })
      // 体积信息塞进 label 由前端渲染，避免额外字段
      void totalBytes
    }
  }

  const fileNodes = nodes.filter((n) => n.type === 'file')
  const missingCount = fileNodes.filter((n) => n.file?.missing).length + (groupCounts['missing'] ?? 0) * 0

  return {
    softwareId: sw.id,
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      fileCount: entries.length,
      missingCount: entries.filter((e) => e.file.missing).length,
      parsedOk: stats.parsedOk,
      parseFailed: stats.parseFailed,
      totalSizeBytes: stats.totalBytes,
      buildMs: stats.buildMs,
      fromCache: stats.fromCache ?? false,
      groups: groupCounts
    }
  }
}

const GROUP_LABEL_LOCAL: Record<GroupPolicy, string> = {
  system: '系统依赖',
  shared_runtime: '共享运行库',
  plugin: '插件与扩展',
  user_data: '用户数据',
  missing: '缺失依赖',
  other: '其他关联'
}
