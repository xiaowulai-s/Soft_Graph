/**
 * 增量扫描：目录水位签名缓存（v2.0.0 M2 / A5，同时是 B1 USN 的降级与过渡）
 *
 * 实测依据（本机 D:\下载，5353 目录 / 39770 文件）：
 *   完整遍历（readdir + 逐文件 stat）  8.82 s
 *   仅 readdir（不 stat 文件）          1.33 s
 * → 约 85% 的耗时来自逐文件 stat。
 *
 * 因此增量的正确做法是：**每次仍走一遍 readdir（便宜），用目录签名判断是否
 * 发生变化，未变化则复用上次结果，只对少量命中项重新 stat 刷新大小**。
 *
 * 正确性边界（写死在代码里，不可配置）：
 *   1. 目录签名 = 目录 mtimeMs + 条目数。NTFS 下「目录内新建/删除/重命名」
 *      会更新目录 mtime，因此签名相同 ⇒ 该层的文件集合未变。
 *   2. 深层变化由子目录自己的签名捕获（我们仍递归计算每一层签名）。
 *   3. **不跳过递归**：readdir 必须走全树，否则无法发现深层变化。
 *      本缓存节省的是「逐文件 stat + 模式匹配 + 算法级处理（如重复文件哈希）」。
 *   4. 命中项仍会逐个重新 stat，保证展示的体积/修改时间是最新的。
 *   5. 缓存带 TTL，超时后强制全量，作为兜底。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { JunkItem } from '../shared/types'
import { isScannable, SKIP_DIR_NAMES } from '../shared/safety'
import type { CompiledRule } from './engine'

/** 目录签名：`<mtimeMs>:<条目数>` */
export type DirSignatures = Record<string, string>

export interface RuleSignature {
  dirs: DirSignatures
  dirCount: number
  entryCount: number
}

export interface RuleCache {
  sig: RuleSignature
  items: JunkItem[]
  /** 写入时间戳（ms） */
  at: number
  /**
   * 连续未命中次数（M2/B1）。抖动目录（Temp / 着色器缓存）会让签名反复变化，
   * 此时「采签名 → 发现不匹配 → 仍要全量扫」等于白付一次签名遍历（GC-12 实测
   * 10s）。连续 2 次未命中即熔断：该规则短期内不再尝试签名复用，只保留
   * 成本极低的卷哨兵；强制重扫会重置熔断。
   */
  missStreak?: number
  /** 熔断中：跳过签名比对（卷哨兵仍生效） */
  disabled?: boolean
}

/** 规则 id → 缓存 */
export type ScanCache = Record<string, RuleCache>

export const CACHE_VERSION = 1
/** 缓存有效期：默认 3 天，超时强制全量重扫 */
export const CACHE_TTL_MS = 3 * 86_400_000

export interface CacheFile {
  version: number
  updatedAt: number
  rules: ScanCache
  /**
   * 卷级 USN 哨兵（M2/B1）：卷号 → 上次扫描时的 nextUsn。
   * nextUsn 未变 ⇒ 该卷无任何写入 ⇒ 连目录签名遍历都可跳过。
   */
  volumes?: Record<string, string>
}

/** 空缓存 */
export function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, updatedAt: 0, rules: {}, volumes: {} }
}

/**
 * 卷级哨兵：采集各卷当前的 nextUsn（M2/B1）。
 * 失败（非 NTFS / 无权限 / 无 fsutil）时返回空对象，上层按「未知」处理 —— 即照常走签名比对。
 */
export async function collectVolumeUsns(volumes: Iterable<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  try {
    const { queryJournal } = await import('./usn')
    const list = [...new Set([...volumes].filter(Boolean))]
    await Promise.all(
      list.map(async (v) => {
        const info = await queryJournal(v)
        if (info?.nextUsn) out[info.volume] = info.nextUsn
      })
    )
  } catch {
    /* ignore */
  }
  return out
}

export async function loadCache(file: string): Promise<CacheFile> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as CacheFile
    if (raw?.version !== CACHE_VERSION) return emptyCache()
    return raw
  } catch {
    return emptyCache()
  }
}

export async function saveCache(file: string, cache: CacheFile): Promise<void> {
  cache.updatedAt = Date.now()
  try {
    await fs.writeFile(file, JSON.stringify(cache), 'utf8')
  } catch {
    /* 缓存写失败不影响扫描结果 */
  }
}

/** 缓存是否仍然有效（版本 + TTL） */
export function isCacheUsable(c: CacheFile, now = Date.now()): boolean {
  if (c.version !== CACHE_VERSION) return false
  if (!c.updatedAt) return false
  return now - c.updatedAt < CACHE_TTL_MS
}

// ───────────────── 目录签名采集（只读 readdir + 目录 stat） ─────────────────

/**
 * 采集规则根目录下所有目录的签名。
 * 并发遍历（IO 等待重叠），但只做 readdir + 目录 stat，不 stat 文件。
 */
export async function collectSignatures(
  rule: CompiledRule,
  signal?: { cancelled: boolean }
): Promise<RuleSignature> {
  const dirs: DirSignatures = {}
  let entryCount = 0

  const raw = Number(process.env.SG_WALK_CONCURRENCY ?? 8)
  const CONCURRENCY = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 8
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < CONCURRENCY) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((r) => waiters.push(() => { active++; r() }))
  }
  const release = (): void => {
    active--
    const w = waiters.shift()
    if (w) w()
  }

  const queue: { dir: string; depth: number }[] = []
  for (const root of rule.roots) queue.push({ dir: root, depth: 0 })

  async function one(dir: string, depth: number): Promise<void> {
    if (signal?.cancelled) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    let st: import('node:fs').Stats | null = null
    try {
      st = await fs.stat(dir)
    } catch {
      st = null
    }
    dirs[dir.toLowerCase()] = `${st ? Math.round(st.mtimeMs) : 0}:${entries.length}`
    if (depth > rule.maxDepth) return

    for (const e of entries) {
      if (signal?.cancelled) return
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      // 必须与 walkRule 用同一套剪枝，否则签名遍历会扫到根本不会进入的目录
      // （实测未剪枝时 GC-12 要走 77261 个目录 / 18s，比它自己的完整扫描还慢）
      if (SKIP_DIR_NAMES.has(e.name.toLowerCase())) continue
      if (!isScannable(full)) continue
      entryCount++
      queue.push({ dir: full, depth: depth + 1 })
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const t = queue.shift()
      if (!t) {
        if (active === 0) return
        await new Promise<void>((r) => setImmediate(r))
        continue
      }
      await acquire()
      try {
        await one(t.dir, t.depth)
      } finally {
        release()
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, queue.length || 1)) }, () => worker()))
  return { dirs, dirCount: Object.keys(dirs).length, entryCount }
}

/** 签名完全一致（目录集合与每个目录的签名都相同） */
export function signaturesEqual(a: RuleSignature, b: RuleSignature): boolean {
  if (a.dirCount !== b.dirCount || a.entryCount !== b.entryCount) return false
  const ka = Object.keys(a.dirs)
  if (ka.length !== Object.keys(b.dirs).length) return false
  for (const k of ka) if (a.dirs[k] !== b.dirs[k]) return false
  return true
}

// ───────────────── 命中项刷新 ─────────────────

/**
 * 重新 stat 缓存项：刷新体积与修改时间，并丢弃已不存在的文件。
 * 保证「复用缓存」不会让用户看到过期的大小或已被删除的文件。
 */
export async function refreshItems(items: JunkItem[], signal?: { cancelled: boolean }): Promise<JunkItem[]> {
  const out: JunkItem[] = []
  const CHUNK = 16
  for (let i = 0; i < items.length; i += CHUNK) {
    if (signal?.cancelled) break
    const chunk = items.slice(i, i + CHUNK)
    const res = await Promise.all(
      chunk.map(async (it) => {
        try {
          const st = await fs.stat(it.fullPath)
          return { ...it, sizeBytes: st.size, mtime: st.mtimeMs }
        } catch {
          return null
        }
      })
    )
    for (const r of res) if (r) out.push(r)
  }
  return out
}
