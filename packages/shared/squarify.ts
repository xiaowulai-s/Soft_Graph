/**
 * v4.1 S2：Squarified Treemap 布局（纯函数，无依赖）。
 * 算法：Bruls, Huizing & van Wijk 的 squarified treemap 简化实现。
 */

export interface TreemapItem {
  name: string
  sizeBytes: number
  /** 原始路径（文件叶子/目录），供下钻与操作 */
  path: string
  isDir: boolean
}

export interface TreemapRect {
  item: TreemapItem
  x: number
  y: number
  w: number
  h: number
}

/** 最差纵横比（用于行内判优） */
function worst(row: number[], w: number, total: number, area: number): number {
  let worstRatio = 0
  let side = w
  const sum = row.reduce((a, b) => a + b, 0)
  const scale = (area * side) / (total || 1)
  const thickness = scale / (sum || 1)
  for (const v of row) {
    const len = v / (thickness || 1)
    const ratio = Math.max(len / (thickness || 1), (thickness || 1) / (len || 1))
    if (Number.isFinite(ratio) && ratio > worstRatio) worstRatio = ratio
    side = w
  }
  return worstRatio
}

/**
 * Squarified 布局。
 * @param items 已按 sizeBytes 降序
 */
export function squarify(items: TreemapItem[], width: number, height: number): TreemapRect[] {
  const rects: TreemapRect[] = []
  const valid = items.filter((i) => i.sizeBytes > 0)
  if (valid.length === 0 || width <= 0 || height <= 0) return rects

  const total = valid.reduce((a, b) => a + b.sizeBytes, 0)
  const area = width * height

  interface State {
    idx: number
    x: number
    y: number
    w: number
    h: number
  }
  const st: State = { idx: 0, x: 0, y: 0, w: width, h: height }
  let row: TreemapItem[] = []

  const layoutRow = (horizontal: boolean): void => {
    const sum = row.reduce((a, b) => a + b.sizeBytes, 0)
    const frac = sum / (total || 1)
    if (horizontal) {
      const rw = st.w * frac
      let cy = st.y
      for (const it of row) {
        const rh = (it.sizeBytes / (sum || 1)) * st.h
        rects.push({ item: it, x: st.x, y: cy, w: rw, h: rh })
        cy += rh
      }
      st.x += rw
      st.w -= rw
    } else {
      const rh = st.h * frac
      let cx = st.x
      for (const it of row) {
        const rw = (it.sizeBytes / (sum || 1)) * st.w
        rects.push({ item: it, x: cx, y: st.y, w: rw, h: rh })
        cx += rw
      }
      st.y += rh
      st.h -= rh
    }
    row = []
  }

  while (st.idx < valid.length) {
    const horizontal = st.w >= st.h
    const side = horizontal ? st.h : st.w
    const it = valid[st.idx]
    const rowSum = row.reduce((a, b) => a + b.sizeBytes, 0) + it.sizeBytes
    // 该行在当前边上的厚度
    const thickness = (rowSum / total) * area / (horizontal ? st.h : st.w)
    const worstNew = Math.max(
      ...[...row, it].map((v) => {
        const len = (v.sizeBytes / rowSum) * side
        return Math.max(thickness / (len || 1), len / (thickness || 1))
      })
    )
    const worstOld = row.length
      ? Math.max(
          ...row.map((v) => {
            const len = (v.sizeBytes / (row.reduce((a, b) => a + b.sizeBytes, 0) || 1)) * side
            return Math.max(thickness / (len || 1), len / (thickness || 1))
          })
        )
      : 0
    if (row.length === 0 || worstNew <= worstOld) {
      row.push(it)
      st.idx++
    } else {
      layoutRow(horizontal)
    }
  }
  if (row.length) layoutRow(st.w >= st.h)
  return rects
}
