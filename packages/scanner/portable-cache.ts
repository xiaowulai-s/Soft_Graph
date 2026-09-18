/**
 * 便携软件目录扫描缓存（v3.0.0 · A3）
 *
 * 目标：**应用内二次扫描提速**。冷路径已达标（4.46s ≤ 6s），所以这一层是纯优化，
 * 正确性优先于收益。
 *
 * ── 省掉的是哪两笔开销 ──
 * `scorePortableDir` 的成本分布：
 *   1. `readdir`（便宜，必须保留 —— 它同时是签名的一部分）
 *   2. `fs.access(W_OK)`（便宜）
 *   3. `readPeMeta(mainExe)` —— **要打开并读 PE 文件**（可能几 MB）← 省掉
 *   4. 命中项的 `dirSize(dir, 2, 3000)` —— **最多 3000 次 stat** ← 省掉
 *
 * 因此命中路径只做 3 次系统调用级别的检查：`readdir` + `stat(dir)` + `stat(mainExe)`。
 * 这与 A5（垃圾增量）的口径一致 —— **不跳过 readdir，只跳过昂贵的部分**，
 * 而不是「靠 mtime 猜内容没变」。
 *
 * ── 四条失效判据（缺一不可）──
 *   1. 目录 mtime 变 / 条目数变 —— 目录内**增删改条目**会更新它
 *   2. 主 exe 路径或它的 mtime 变 —— 文件**原地覆写不改目录 mtime**（A5 踩过的同一坑），
 *      而主 exe 被替换恰恰是最需要重算的情况（名称/版本/发布者都来自它）
 *   3. `manual` 标记与缓存时不一致 —— 手动标记权重 +100，是权重最大的特征，
 *      沿用旧判定会让用户的纠正「看起来没生效」
 *   4. `installedPaths` 指纹变 —— 「无卸载项」特征（+20）依赖已安装集合，
 *      装/卸一个软件就可能翻转判定（这条是**整体作废**，见 isCacheUsable）
 *
 * 另有 TTL（7 天）兜底，覆盖上面没预料到的角落。
 *
 * 已知边界（与 A5 同类，如实记录）：
 *   目录内**文件被原地覆写且体积变化**时，缓存里的 `sizeBytes` 在 TTL 内可能沿用旧值 ——
 *   因为它由 `dirSize` 递归统计，而递归统计正是我们要跳过的开销。
 *   目录 mtime 与 mainExe mtime 都未变时，我们不认为「值得为此重走一遍全目录」。
 *
 * ── 不缓存什么（实测依据，2026-09-18 真机）──
 *   「目录内没有 exe」的情况返回 null，**不进缓存**。因为 `scorePortableDir` 在 readdir 后
 *   立即返回，不读 PE —— 真机实测（D:\Software + E:\Software）这类目录 36 个里占 18 个，
 *   全量 37ms 中它们合计只占约 2ms。为它们引入 null 哨兵条目得不偿失。
 *   同理，「有 exe 但分数不够」的目录**要缓存**：它们会走 readPeMeta，是开销大头 ——
 *   初版漏了这一类，实测命中率只有 30.6%（补上后 50.0%，热扫描 37ms → 2ms）。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { normKey } from '../shared/util'
import type { PortableCandidate } from './software'

export const PORTABLE_CACHE_VERSION = 1
/** 缓存有效期：7 天。便携目录的变更远不如垃圾目录频繁 */
export const PORTABLE_CACHE_TTL_MS = 7 * 86_400_000

/** 单个目录的缓存条目 */
export interface PortableDirEntry {
  /** 目录 mtimeMs（目录内增删条目会更新它） */
  dirMtime: number
  /** 目录直属条目数（与 mtime 互为佐证，防低精度文件系统） */
  entryCount: number
  /** 上次选出的主 exe（normKey 形式） */
  mainExe: string
  /** 主 exe 的 mtimeMs（原地覆写时唯一会变的东西） */
  mainExeMtime: number
  /** 缓存该结果时的手动标记状态 */
  manual: boolean
  /** 写入时间（TTL 判定） */
  at: number
  cand: PortableCandidate
}

export interface PortableCacheFile {
  version: number
  updatedAt: number
  /** 已安装软件路径集合的指纹（变化即整体作废） */
  installedFingerprint: string
  /** normKey(dir) → 条目 */
  dirs: Record<string, PortableDirEntry>
}

/** 命中判定用的当前观测量（由 fs 侧填充） */
export interface PortableDirProbe {
  dirMtime: number
  entryCount: number
  /** 当前目录里是否还存在上次选出的主 exe（不存在则为空串） */
  mainExe: string
  mainExeMtime: number
  manual: boolean
}

export function emptyPortableCache(installedFingerprint = ''): PortableCacheFile {
  return { version: PORTABLE_CACHE_VERSION, updatedAt: 0, installedFingerprint, dirs: {} }
}

/**
 * 已安装软件路径集合的指纹。
 * 排序后再哈希，保证「集合相同但顺序不同」不会误判为变化。
 */
export function installedFingerprintOf(paths: Iterable<string>): string {
  const list = [...new Set([...paths].map(normKey).filter(Boolean))].sort()
  return createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 16)
}

/**
 * 缓存整体是否可用。
 * 指纹不一致 → 整体作废：不做逐条淘汰，因为「无卸载项」特征影响的是**每一个**目录的评分，
 * 逐条判断反而容易出现「有的用了新集合、有的用了旧集合」的不一致状态。
 */
export function isPortableCacheUsable(c: PortableCacheFile | null, fingerprint: string, now = Date.now()): boolean {
  if (!c) return false
  if (c.version !== PORTABLE_CACHE_VERSION) return false
  if (c.installedFingerprint !== fingerprint) return false
  if (!c.updatedAt) return false
  return now - c.updatedAt < PORTABLE_CACHE_TTL_MS
}

/**
 * 单条目是否可复用。纯函数，便于把上面四条判据逐条钉死在用例里。
 */
export function portableEntryMatches(
  e: PortableDirEntry | undefined,
  cur: PortableDirProbe,
  now = Date.now(),
  ttlMs = PORTABLE_CACHE_TTL_MS
): boolean {
  if (!e) return false
  if (now - e.at >= ttlMs) return false
  if (e.manual !== cur.manual) return false
  if (e.dirMtime !== cur.dirMtime) return false
  if (e.entryCount !== cur.entryCount) return false
  // 主 exe 路径必须与上次一致（可能被改名/删除/换了同名兄弟），且其 mtime 未变
  if (!e.mainExe || !cur.mainExe) return false
  if (e.mainExe !== cur.mainExe) return false
  return e.mainExeMtime === cur.mainExeMtime
}

/** 记录一条结果 */
export function rememberPortableEntry(
  cache: PortableCacheFile,
  dir: string,
  cur: PortableDirProbe,
  cand: PortableCandidate,
  now = Date.now()
): void {
  cache.dirs[normKey(dir)] = {
    dirMtime: cur.dirMtime,
    entryCount: cur.entryCount,
    mainExe: cur.mainExe,
    mainExeMtime: cur.mainExeMtime,
    manual: cur.manual,
    at: now,
    cand
  }
}

/** 清掉过期条目，返回清掉的条数（写回前调用，避免缓存文件无限膨胀） */
export function prunePortableCache(cache: PortableCacheFile, now = Date.now()): number {
  let removed = 0
  for (const [k, e] of Object.entries(cache.dirs)) {
    if (!e || now - e.at >= PORTABLE_CACHE_TTL_MS) {
      delete cache.dirs[k]
      removed++
    }
  }
  return removed
}

// ───────────────── IO ─────────────────

export async function loadPortableCache(file: string, fingerprint: string): Promise<PortableCacheFile> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as PortableCacheFile
    if (raw?.version !== PORTABLE_CACHE_VERSION) return emptyPortableCache(fingerprint)
    if (raw.installedFingerprint !== fingerprint) {
      // 已安装集合变了 → 保留文件结构但清空条目（等价于整体作废）
      return { ...emptyPortableCache(fingerprint), updatedAt: raw.updatedAt }
    }
    if (!raw.dirs || typeof raw.dirs !== 'object') return emptyPortableCache(fingerprint)
    return raw
  } catch {
    return emptyPortableCache(fingerprint)
  }
}

export async function savePortableCache(file: string, cache: PortableCacheFile): Promise<void> {
  cache.updatedAt = Date.now()
  try {
    await fs.writeFile(file, JSON.stringify(cache), 'utf8')
  } catch {
    /* 缓存写失败不影响扫描结果 */
  }
}

/**
 * 采集一个目录的当前观测量（命中判定的输入）。
 *
 * `prevMainExe` 允许传原始路径 —— 内部统一归一化后再比对（返回的 `probe.mainExe` 恒为 normKey）。
 * 这一点是刻意的：缓存里存的是 normKey，调用方很容易直接把手头的原始路径丢进来，
 * 而 Windows 盘符/目录大小写不一致时会「明明文件还在却判成不匹配」。
 *
 * 注意这里**故意仍然 readdir**：条目数本身就是签名的一部分，
 * 而且只有 readdir 才能确认「上次选出的主 exe 是否还在」。
 * 真正省掉的是 readPeMeta 与 dirSize。
 */
export async function probePortableDir(dir: string, prevMainExe: string): Promise<PortableDirProbe | null> {
  let entries: import('node:fs').Dirent[]
  let dirMtime = 0
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
    dirMtime = (await fs.stat(dir)).mtimeMs
  } catch {
    return null
  }

  const probe: PortableDirProbe = {
    dirMtime,
    entryCount: entries.length,
    mainExe: '',
    mainExeMtime: 0,
    manual: false
  }

  const want = normKey(prevMainExe)
  if (want) {
    // 上次的主 exe 必须还在这一层（改名 / 删除 / 挪走 → 判定不匹配）
    const found = entries.find((e) => e.isFile() && normKey(join(dir, e.name)) === want)
    if (found) {
      try {
        probe.mainExe = want
        // 用实测到的条目路径去 stat，而不是相信传进来的字符串
        probe.mainExeMtime = (await fs.stat(join(dir, found.name))).mtimeMs
      } catch {
        /* 取不到 mtime 就按不匹配处理 */
        probe.mainExe = ''
        probe.mainExeMtime = 0
      }
    }
  }
  return probe
}
