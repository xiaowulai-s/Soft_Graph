/**
 * v3.3 P2-1 相似图片盘点（借鉴 Czkawka）：主进程 aHash（平均哈希）+ 汉明距离分组。
 * 使用 Electron nativeImage 解码缩放到 8×8 灰度 —— 零外部依赖。
 * hint 级盘点：只列出分组，删除走系统回收站（shell.trashItem），决定权在用户。
 */
import { nativeImage, type NativeImage } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface SimilarGroup {
  hash: string
  images: { path: string; sizeBytes: number }[]
}

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp'])
const MAX_FILE = 20 * 1024 * 1024
const MAX_FILES = 1500
const HAMMING_THRESHOLD = 8

function aHash(img: NativeImage): string | null {
  try {
    const small = img.resize({ width: 9, height: 8 })
    const { width, height } = small.getSize()
    const buf = small.toBitmap() // BGRA
    const px: number[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        px.push((buf[i] * 299 + buf[i + 1] * 587 + buf[i + 2] * 114) / 1000)
      }
    }
    px.pop() // 9×8 → 72 → 弃最后一个，取 8×8=64 比较位
    const avg = px.reduce((a, b) => a + b, 0) / px.length
    let hash = ''
    for (let i = 0; i < 64; i++) hash += px[i] > avg ? '1' : '0'
    return hash
  } catch {
    return null
  }
}

function hamming(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

export async function findSimilarImages(
  roots: string[],
  opts: { maxDepth?: number } = {}
): Promise<SimilarGroup[]> {
  const maxDepth = opts.maxDepth ?? 4
  const files: { path: string; size: number }[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
      } else if (IMG_EXT.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) {
        try {
          const st = await stat(full)
          if (st.size >= 100 * 1024 && st.size <= MAX_FILE) files.push({ path: full, size: st.size })
        } catch {
          /* ignore */
        }
      }
    }
  }

  for (const root of roots) await walk(root, 0)
  if (files.length < 2) return []

  const hashed: { path: string; size: number; hash: string }[] = []
  for (const f of files) {
    try {
      const img = nativeImage.createFromPath(f.path)
      if (img.isEmpty()) continue
      const h = aHash(img)
      if (h) hashed.push({ ...f, hash: h })
    } catch {
      /* 解码失败跳过 */
    }
  }

  // 并查集式分组：汉明距离 ≤ 阈值归为同组
  const parent = hashed.map((_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      if (hamming(hashed[i].hash, hashed[j].hash) <= HAMMING_THRESHOLD) {
        const a = find(i)
        const b = find(j)
        if (a !== b) parent[b] = a
      }
    }
  }

  const groups = new Map<number, { path: string; sizeBytes: number }[]>()
  for (let i = 0; i < hashed.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push({ path: hashed[i].path, sizeBytes: hashed[i].size })
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2) // 只留真正「相似 ≥2 张」的组
    .sort((a, b) => b.length - a.length)
    .map((images) => ({ hash: images[0].path, images }))
}
