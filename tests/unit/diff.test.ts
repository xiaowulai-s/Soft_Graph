/**
 * D3 依赖 Diff 测试：新增 / 消失 / 置信度漂移 / 聚合子节点纳入 / 幂等
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  snapshotFromModel,
  diffSnapshots,
  diffIsEmpty,
  fileNodesOf
} from '@graph-core/diff'
import type { GraphModel, GraphNode, GraphEdge, FileNode } from '@shared/types'

function fileNode(id: string, fullPath: string, confidence: number, tier: 1 | 2 | 3 = 1): { node: GraphNode; edge: GraphEdge; file: FileNode } {
  const file: FileNode = {
    id,
    fullPath,
    name: fullPath.split('\\').pop() ?? id,
    sizeBytes: 100,
    mtime: 0,
    kind: 'dll',
    ext: 'dll',
    missing: false,
    refCount: 1
  }
  const node: GraphNode = { id, type: 'file', label: file.name, tier, radius: 14, file }
  const edge: GraphEdge = { id: `sw|${id}`, source: 'sw', target: id, type: 'imports', confidence, evidence: ['E2'] }
  return { node, edge, file }
}

function model(nodes: GraphNode[], edges: GraphEdge[]): GraphModel {
  return {
    softwareId: 'sw',
    nodes,
    edges,
    stats: { nodeCount: nodes.length, edgeCount: edges.length, fileCount: nodes.length, missingCount: 0, parsedOk: 0, parseFailed: 0, totalSizeBytes: 0, buildMs: 0, fromCache: false, groups: {} }
  }
}

describe('D3 依赖 Diff', () => {
  it('新增 / 消失 / 置信度漂移全部识别', () => {
    const a = fileNode('f1', 'C:\\app\\kept.dll', 0.9)
    const b = fileNode('f2', 'C:\\app\\gone.dll', 0.8)
    const c = fileNode('f3', 'C:\\app\\drift.dll', 0.6)
    const c2 = fileNode('f3', 'C:\\app\\drift.dll', 0.95)
    const d = fileNode('f4', 'C:\\app\\new.dll', 0.7)

    const oldModel = model([a.node, b.node, c.node], [a.edge, b.edge, c.edge])
    const newModel = model([a.node, c2.node, d.node], [a.edge, c2.edge, d.edge])

    const prev = snapshotFromModel(oldModel)
    const curr = snapshotFromModel(newModel)
    const diff = diffSnapshots(prev, curr)

    assert.deepEqual(diff.added.map((x) => x.name), ['new.dll'], '新增')
    assert.deepEqual(diff.removed.map((x) => x.name), ['gone.dll'], '消失')
    assert.deepEqual(
      diff.changed.map((x) => `${x.name}:${x.from.toFixed(2)}→${x.to.toFixed(2)}`),
      ['drift.dll:0.60→0.95'],
      '置信度漂移'
    )
  })

  it('同一路径多条边取最高置信度', () => {
    const a = fileNode('f1', 'C:\\x\\multi.dll', 0.4)
    const model1 = model([a.node], [a.edge, { ...a.edge, id: 'e2', confidence: 0.85 }])
    const snap = snapshotFromModel(model1)
    const key = Object.keys(snap.files)[0]
    assert.equal(snap.files[key].confidence, 0.85)
  })

  it('路径归一化对齐（大小写 / 反斜杠差异不算新增+消失）', () => {
    const a = fileNode('f1', 'C:\\App\\KEEP.dll', 0.9)
    const a2 = fileNode('f1', 'c:\\app\\keep.dll', 0.9)
    const prev = snapshotFromModel(model([a.node], [a.edge]))
    const curr = snapshotFromModel(model([a2.node], [a2.edge]))
    assert.ok(diffIsEmpty(diffSnapshots(prev, curr)), '大小写差异不应产生 diff')
  })

  it('聚合节点的子节点也参与 diff（折叠前后的图谱可比）', () => {
    const inner = fileNode('f1', 'C:\\x\\inner.dll', 0.9)
    const groupNode: GraphNode = {
      id: 'grp',
      type: 'group',
      label: '系统依赖',
      tier: 2,
      radius: 20,
      collapsedCount: 1,
      children: [inner.node]
    }
    const grouped = model([groupNode], [{ ...inner.edge, target: 'grp' }])
    const expanded = model([inner.node], [inner.edge])
    assert.ok(diffIsEmpty(diffSnapshots(snapshotFromModel(grouped), snapshotFromModel(expanded))), '折叠/展开不应产生 diff')
  })

  it('fileNodesOf：按路径补全当前模型中的 FileNode', () => {
    const a = fileNode('f1', 'C:\\x\\a.dll', 0.9)
    const m = model([a.node], [a.edge])
    const out = fileNodesOf(m, ['c:\\X\\A.dll'])
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'a.dll')
  })

  it('空对空 / 幂等', () => {
    const e = model([], [])
    const s = snapshotFromModel(e)
    assert.ok(diffIsEmpty(diffSnapshots(s, s)))
    const a = fileNode('f1', 'C:\\x\\a.dll', 0.9)
    const s2 = snapshotFromModel(model([a.node], [a.edge]))
    const d1 = diffSnapshots(s, s2)
    const d2 = diffSnapshots(s, s2)
    assert.deepEqual(d1, d2)
  })
})
