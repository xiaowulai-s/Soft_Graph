/**
 * v4.1 S2：磁盘目录占用树扫描（服务端聚合，供 treemap 渲染）。
 * 限制：最大节点 2000 / 最大深度 4，避免扫爆系统目录。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { TreemapItem } from '@shared/squarify'

export interface DiskTreeNode {
  name: string
  path: string
  sizeBytes: number
  isDir: boolean
  children?: DiskTreeNode[]
}

const MAX_NODES = 2000
const MAX_DEPTH = 4

export async function scanDirTree(
  root: string,
  depth = 2
): Promise<{ ok: boolean; node?: DiskTreeNode; error?: string }> {
  let nodes = 0
  const d = Math.min(depth, MAX_DEPTH)

  async function walk(dir: string, curDepth: number, name: string): Promise<DiskTreeNode> {
    nodes++
    const node: DiskTreeNode = { name, path: dir, sizeBytes: 0, isDir: true }
    if (curDepth >= d || nodes > MAX_NODES) return node
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return node
    }
    const children: DiskTreeNode[] = []
    let total = 0
    for (const e of entries) {
      if (nodes > MAX_NODES) break
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (/^\$recycle\.bin$|^system volume information$/i.test(e.name)) continue
        const child = await walk(full, curDepth + 1, e.name)
        children.push(child)
        total += child.sizeBytes
      } else {
        let sz = 0
        try {
          sz = (await fs.stat(full)).size
        } catch {
          /* ignore */
        }
        total += sz
        if (sz > 0) children.push({ name: e.name, path: full, sizeBytes: sz, isDir: false })
      }
    }
    children.sort((a, b) => b.sizeBytes - a.sizeBytes)
    node.children = children
    node.sizeBytes = total
    return node
  }

  try {
    const st = await fs.stat(root)
    if (!st.isDirectory()) {
      return { ok: false, error: '不是目录' }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const node = await walk(root, 0, root)
  return { ok: true, node }
}

/** 展开为 TreemapItem 列表（当前层级：目录 + 直接文件，按大小降序） */
export function nodeToItems(node: DiskTreeNode): TreemapItem[] {
  return (node.children ?? [])
    .map((c) => ({ name: c.name, sizeBytes: c.sizeBytes, path: c.path, isDir: c.isDir }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
}
