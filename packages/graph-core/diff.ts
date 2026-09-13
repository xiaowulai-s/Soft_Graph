/**
 * 依赖 Diff（v2.0.0 M4/D3）
 *
 * 回答用户最关心的问题：「软件更新之后，它有没有引入新的组件？」
 *
 * 对比对象是两次图谱快照的**文件依赖集**（按 fullPath 归一化对齐）：
 *   - added    本次有、上次没有 —— 最需要关注的（新引入的 DLL）
 *   - removed  上次有、本次没有 —— 可能是更新移除或路径变化
 *   - changed  两边都有但置信度漂移 ≥ 0.05（证据变化）
 *
 * 纯函数、无 IO，快照的持久化由 Store（kv）负责。
 */

import { normKey } from '../shared/util'
import type { FileNode, GraphModel, GraphSnapshot, GraphDiff, DiffChanged } from '../shared/types'

export type { GraphSnapshot, GraphDiff } from '../shared/types'

/** 从图谱模型提取快照（只有 file 节点参与 diff；聚合节点的子节点一并纳入） */
export function snapshotFromModel(model: GraphModel): GraphSnapshot {
  const files: GraphSnapshot['files'] = {}
  // 同一 target 的多条边取最高置信度（Map 索引，避免 O(N×E) 扫描）
  const edgeMax = new Map<string, number>()
  for (const e of model.edges) {
    const cur = edgeMax.get(e.target)
    if (cur === undefined || e.confidence > cur) edgeMax.set(e.target, e.confidence)
  }
  // inheritedConf：聚合节点的子节点在折叠态没有自己的边，继承聚合边的置信度，
  // 保证「折叠态 vs 展开态」的快照一致（否则会产生假 diff）
  const walk = (nodes: GraphModel['nodes'], inheritedConf?: number): void => {
    for (const n of nodes) {
      const ownConf = edgeMax.get(n.id)
      if (n.children?.length) walk(n.children, ownConf ?? inheritedConf)
      const f = n.file
      if (!f) continue
      const key = normKey(f.fullPath)
      const conf = ownConf ?? inheritedConf ?? 0
      const prev = files[key]
      if (!prev || conf > prev.confidence) {
        files[key] = { name: f.name, confidence: conf }
      }
    }
  }
  walk(model.nodes)
  return { builtAt: Date.now(), files }
}

const CONFIDENCE_DRIFT = 0.05

export function diffSnapshots(prev: GraphSnapshot, curr: GraphSnapshot): GraphDiff {
  const added: GraphDiff['added'] = []
  const removed: GraphDiff['removed'] = []
  const changed: DiffChanged[] = []

  for (const [key, cur] of Object.entries(curr.files)) {
    const old = prev.files[key]
    if (!old) {
      added.push({ path: key, name: cur.name, confidence: cur.confidence })
    } else if (Math.abs(cur.confidence - old.confidence) >= CONFIDENCE_DRIFT) {
      changed.push({ path: key, name: cur.name, from: old.confidence, to: cur.confidence })
    }
  }
  for (const [key, old] of Object.entries(prev.files)) {
    if (!curr.files[key]) {
      removed.push({ path: key, name: old.name, confidence: old.confidence })
    }
  }

  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
  return {
    added: added.sort(byName),
    removed: removed.sort(byName),
    changed: changed.sort(byName),
    fromAt: prev.builtAt,
    toAt: curr.builtAt
  }
}

/** diff 结果是否为空（UI 决定是否展示「无变化」） */
export function diffIsEmpty(d: GraphDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0
}

/** 供 UI 的文件节点补全（新增项在当前模型里是真实存在的 FileNode） */
export function fileNodesOf(model: GraphModel, paths: string[]): FileNode[] {
  const keys = new Set(paths.map(normKey))
  const out: FileNode[] = []
  const walk = (nodes: GraphModel['nodes']): void => {
    for (const n of nodes) {
      if (n.children?.length) walk(n.children)
      if (n.file && keys.has(normKey(n.file.fullPath))) out.push(n.file)
    }
  }
  walk(model.nodes)
  return out
}
