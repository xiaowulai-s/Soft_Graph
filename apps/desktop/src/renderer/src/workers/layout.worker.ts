/**
 * 布局计算 Worker
 * 对应技术设计方案 4.2「图谱布局计算在 Web Worker 中执行，主线程只做绘制」
 * 以及 5.4.2「布局计算置于 Web Worker，主线程只接收坐标并绘制，保证交互不掉帧」
 */

import { layoutGraph, type LayoutInputEdge, type LayoutInputNode, type LayoutMode } from '@graph-core/layout'

interface Req {
  id: number
  nodes: LayoutInputNode[]
  edges: LayoutInputEdge[]
  mode: LayoutMode
}

self.onmessage = (e: MessageEvent<Req>): void => {
  const { id, nodes, edges, mode } = e.data
  try {
    const result = layoutGraph(nodes, edges, mode)
    ;(self as unknown as Worker).postMessage({ id, ok: true, ...result })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message })
  }
}
