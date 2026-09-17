/**
 * 垃圾扫描模块 JunkScanner
 * 对应技术设计方案 5.5（垃圾分类规则库 / 风险分级 / 重复文件识别算法）
 */

import { promises as fs, createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { JunkCategorySummary, JunkItem, JunkSummary, RiskLevel } from '../shared/types'
import { baseName, normKey, normPath, uid, mapPool } from '../shared/util'
import { isOneClickEligible } from '../shared/safety'
import { walkRule, quickDirSize, looksOrphan, type CompiledRule, type RuleSet, type WalkStats } from './engine'
import {
  collectSignatures,
  collectVolumeUsns,
  emptyCache,
  isCacheUsable,
  refreshItems,
  signaturesEqual,
  collectUsnChangeCounts,
  CACHE_VERSION,
  type CacheFile,
  type RuleCache
} from './incremental'
import { volumeOf } from './usn'

export interface JunkScanContext {
  /** 已安装软件名（GC-08 孤儿目录判定） */
  knownNames: Set<string>
  knownPublishers: Set<string>
  /** 已安装软件目录（GC-08） */
  knownDirs: Set<string>
  /** 用户排除路径 */
  excludes: string[]
}

export interface JunkScanOptions {
  categoryIds?: string[]
  onProgress?: (phase: string, percent: number, current: string, found: number) => void
  signal?: { cancelled: boolean }
  /** 增量缓存（M2/A5）：提供则可与上次签名比对，未变化的规则直接复用结果 */
  cache?: CacheFile
  /** 强制全量重扫（忽略增量缓存） */
  force?: boolean
  /**
   * 每条规则完成后回传缓存快照（M2/C2）。
   * 供 worker 落盘，使进程崩溃后重启能跳过已完成的规则（崩溃续扫）。
   */
  onRuleCache?: (cache: CacheFile) => void
}

export interface JunkScanResult {
  scanId: string
  items: JunkItem[]
  summary: JunkSummary
  /** 更新后的缓存（调用方负责持久化） */
  cache: CacheFile
  /** 本次复用了缓存的规则 id */
  reusedRules: string[]
  /**
   * 复用来源：volume = 卷哨兵未变（连签名都跳过）；
   * usn = 卷有写入但 USN 变更记录为 0 条（第 2 级，需提权）；
   * signature = 目录签名未变
   */
  reuseSource: Record<string, 'volume' | 'usn' | 'signature'>
}

function itemId(path: string, categoryId: string): string {
  return 'j_' + createHash('sha1').update(categoryId + '|' + normKey(path)).digest('hex').slice(0, 16)
}

// ───────────────── 重复文件识别（5.5.3） ─────────────────

const SAMPLE = 64 * 1024

/**
 * 分段采样哈希：把文件均分成 segments 段，每段取头部 64KB 参与哈希。
 * segments=3 即 v2.0.0 的头/中/尾三采样。
 *
 * A4（v3.0.0）：第三级「全文件 SHA-256」是重复文件分类的绝对开销大头 ——
 * 候选里绝大多数只是「大小相同 + 三段采样相同」的巧合或同版本文件，
 * 却要各自把整个文件读一遍。因此在两者之间插入一级扩展采样（默认 16 段），
 * 用 1MB 的读取量把全文件哈希的候选压下去；只有扩展采样也相同才读全文件。
 *
 * 采样位置固定而非随机：同一对文件在两轮扫描里必须得到相同结果，
 * 否则增量缓存会出现「上一轮判重复、这一轮不判」的抖动。
 */
async function sampleHash(path: string, size: number, segments = 3): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const h = createHash('sha1')
    h.update(String(size))
    const n = Math.max(1, Math.floor(segments))
    const offsets: number[] = []
    if (size <= SAMPLE * n) {
      offsets.push(0)
    } else {
      for (let i = 0; i < n; i++) offsets.push(Math.floor((size / n) * i))
      offsets.push(size - SAMPLE) // 尾部必采：相当多文件只在末尾有差异
    }
    const buf = Buffer.allocUnsafe(SAMPLE)
    for (const off of offsets) {
      const len = Math.min(SAMPLE, size - off)
      if (len <= 0) continue
      const { bytesRead } = await fh.read(buf, 0, len, Math.max(0, off))
      h.update(buf.subarray(0, bytesRead))
    }
    return h.digest('hex')
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 全文件 SHA-256 复核 */
async function fullHash(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const h = createHash('sha256')
    const rs = createReadStream(path, { highWaterMark: 1024 * 1024 })
    rs.on('data', (c) => h.update(c))
    rs.on('end', () => resolve(h.digest('hex')))
    rs.on('error', () => resolve(null))
  })
}

interface DupCandidate {
  path: string
  size: number
  mtime: number
  depth: number
}

/**
 * 四级过滤（v3.0.0 A4：在采样与全文件哈希之间插入扩展采样）：
 *   1. 按文件大小分组，只保留文件数 ≥ 2 的分组；
 *   2. 三段采样哈希（头/中/尾）全同才进入下一轮；
 *   3. **扩展采样**（默认 16 段）全同才进入下一轮 —— 用 1MB 读取换掉整文件读取；
 *   4. 全文件 SHA-256 完全一致才判定为重复。
 * 分组内默认保留「修改时间最早 + 路径层级最浅」的一份。
 *
 * 第 2、3 级的逐文件哈希走 mapPool 并发（默认 8）：这是纯 IO + CPU 混合负载，
 * 串行执行时磁盘与 CPU 轮流空闲。
 */
export async function findDuplicates(
  rule: CompiledRule,
  signal?: { cancelled: boolean },
  onTick?: (phase: string, cur: string, n: number) => void
): Promise<JunkItem[]> {
  const maxCandidates = Number(rule.options.maxCandidates ?? 60000)
  const bySize = new Map<number, DupCandidate[]>()
  const stats: WalkStats = { scanned: 0, denied: 0 }

  await walkRule(
    rule,
    (hit) => {
      if (hit.isDir) return
      if (bySize.size > maxCandidates) return
      const arr = bySize.get(hit.size) || []
      arr.push({
        path: hit.path,
        size: hit.size,
        mtime: hit.mtime,
        depth: hit.path.split('\\').length
      })
      bySize.set(hit.size, arr)
    },
    stats,
    signal,
    (cur, n) => onTick?.('重复文件：建立大小分组', cur, n)
  )

  // 第一级：大小相同是必要条件
  const groups = [...bySize.values()].filter((g) => g.length >= 2)
  const out: JunkItem[] = []
  let processed = 0

  const rawConc = Number(process.env.SG_DUP_CONCURRENCY ?? 8)
  const CONC = Number.isFinite(rawConc) && rawConc >= 1 ? Math.floor(rawConc) : 8
  const EXT_SEGMENTS = Number(process.env.SG_DUP_SAMPLE_SEGMENTS ?? 16)

  for (const group of groups) {
    if (signal?.cancelled) break
    processed++
    if (processed % 20 === 0) onTick?.('重复文件：采样哈希', group[0]?.path ?? '', out.length)

    // 第二级：三段采样哈希（并发）
    const bySample = new Map<string, DupCandidate[]>()
    const sampleResults = await mapPool(group, CONC, (c) => sampleHash(c.path, c.size, 3))
    group.forEach((c, i) => {
      const sh = sampleResults[i]
      if (!sh) return
      const arr = bySample.get(sh) || []
      arr.push(c)
      bySample.set(sh, arr)
    })

    for (const sameSample of bySample.values()) {
      if (sameSample.length < 2) continue
      if (signal?.cancelled) break

      // 第三级（A4 新增）：扩展采样 —— 先用 1MB 级采样把候选压到最小，
      // 避免为「只是碰巧三段相同」的文件各读一遍全文件
      const byExt = new Map<string, DupCandidate[]>()
      const extResults = await mapPool(
        sameSample,
        CONC,
        (c) => sampleHash(c.path, c.size, Number.isFinite(EXT_SEGMENTS) && EXT_SEGMENTS >= 1 ? EXT_SEGMENTS : 16)
      )
      sameSample.forEach((c, i) => {
        const eh = extResults[i]
        if (!eh) return
        const arr = byExt.get(eh) || []
        arr.push(c)
        byExt.set(eh, arr)
      })

      for (const sameExt of byExt.values()) {
        if (sameExt.length < 2) continue
        if (signal?.cancelled) break

        // 第四级：全文件 SHA-256 复核（并发）
        const byFull = new Map<string, DupCandidate[]>()
        const fullResults = await mapPool(sameExt, CONC, (c) => fullHash(c.path))
        sameExt.forEach((c, i) => {
          const fh = fullResults[i]
          if (!fh) return
          const arr = byFull.get(fh) || []
          arr.push(c)
          byFull.set(fh, arr)
        })

        for (const [digest, dups] of byFull) {
          if (dups.length < 2) continue
          // 保留：修改时间最早 + 路径层级最浅
          const sorted = [...dups].sort((a, b) => a.mtime - b.mtime || a.depth - b.depth)
          const groupId = 'dup_' + digest.slice(0, 12)
          sorted.forEach((c, i) => {
            out.push({
              id: itemId(c.path, rule.id),
              categoryId: rule.id,
              fullPath: c.path,
              name: baseName(c.path),
              sizeBytes: c.size,
              mtime: c.mtime,
              risk: rule.risk,
              groupId,
              keep: i === 0
            })
          })
        }
      }
    }
  }
  return out
}

// ───────────────── 超大文件（GC-12） ─────────────────

async function findBigFiles(
  rule: CompiledRule,
  signal?: { cancelled: boolean },
  onTick?: (phase: string, cur: string, n: number) => void
): Promise<JunkItem[]> {
  const topN = Number(rule.options.topN ?? 200)
  const found: { path: string; size: number; mtime: number }[] = []
  const stats: WalkStats = { scanned: 0, denied: 0 }
  await walkRule(
    rule,
    (hit) => {
      if (hit.isDir) return
      found.push({ path: hit.path, size: hit.size, mtime: hit.mtime })
    },
    stats,
    signal,
    (cur, n) => onTick?.('超大文件扫描', cur, n)
  )
  found.sort((a, b) => b.size - a.size)
  return found.slice(0, topN).map((f) => ({
    id: itemId(f.path, rule.id),
    categoryId: rule.id,
    fullPath: f.path,
    name: baseName(f.path),
    sizeBytes: f.size,
    mtime: f.mtime,
    risk: rule.risk
  }))
}

// ───────────────── 失效快捷方式（GC-13） ─────────────────

async function findDeadLinks(
  rule: CompiledRule,
  signal?: { cancelled: boolean },
  onTick?: (phase: string, cur: string, n: number) => void
): Promise<JunkItem[]> {
  const lnks: { path: string; size: number; mtime: number }[] = []
  const stats: WalkStats = { scanned: 0, denied: 0 }
  await walkRule(
    rule,
    (hit) => {
      if (!hit.isDir) lnks.push({ path: hit.path, size: hit.size, mtime: hit.mtime })
    },
    stats,
    signal,
    (cur, n) => onTick?.('快捷方式检查', cur, n)
  )
  if (lnks.length === 0) return []

  // 通过 PowerShell 批量读取 .lnk 目标（COM WScript.Shell）
  let targets: Record<string, string> = {}
  try {
    const { psJson } = await import('../scanner/psbridge')
    const { promises: fsp } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const inPath = join(tmpdir(), `sg-lnk-${uid()}.json`)
    await fsp.writeFile(inPath, JSON.stringify(lnks.map((l) => l.path)), 'utf8')
    try {
      targets = await psJson<Record<string, string>>(
        String.raw`
$paths = Get-Content -LiteralPath $env:SG_IN -Raw -Encoding UTF8 | ConvertFrom-Json
$sh = New-Object -ComObject WScript.Shell
$map = @{}
foreach ($p in $paths) {
  try { $s = $sh.CreateShortcut($p); $map[$p] = [string]$s.TargetPath } catch { $map[$p] = '' }
}
Write-SgJson $map
`,
        { timeoutMs: 120_000, env: { SG_IN: inPath } }
      )
    } finally {
      fsp.unlink(inPath).catch(() => {})
    }
  } catch {
    return []
  }

  const out: JunkItem[] = []
  for (const l of lnks) {
    if (signal?.cancelled) break
    const t = targets[l.path] ?? targets[normPath(l.path)]
    if (t === undefined) continue
    // 目标为空（指向 CLSID / UWP）不判定为失效，避免误删
    if (!t || !/^[a-zA-Z]:\\/.test(t)) continue
    let exists = true
    try {
      await fs.access(t)
    } catch {
      exists = false
    }
    if (!exists) {
      out.push({
        id: itemId(l.path, rule.id),
        categoryId: rule.id,
        fullPath: l.path,
        name: baseName(l.path),
        sizeBytes: l.size,
        mtime: l.mtime,
        risk: rule.risk
      })
    }
  }
  return out
}

// ───────────────── 卸载残留（GC-08） ─────────────────

async function findOrphans(
  rule: CompiledRule,
  ctx: JunkScanContext,
  signal?: { cancelled: boolean },
  onTick?: (phase: string, cur: string, n: number) => void
): Promise<JunkItem[]> {
  const maxDirBytes = Number(rule.options.maxDirBytes ?? 200 * 1024 * 1024)
  const out: JunkItem[] = []

  for (const root of rule.roots) {
    if (signal?.cancelled) break
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (signal?.cancelled) break
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const full = join(root, e.name)
      onTick?.('卸载残留检测', full, out.length)

      // 已收录软件的目录直接跳过
      if (ctx.knownDirs.has(normKey(full))) continue
      if (!looksOrphan(e.name, ctx.knownNames, ctx.knownPublishers)) continue

      let st: import('node:fs').Stats
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }

      // 空目录 → 直接判定残留
      let inner: string[] = []
      try {
        inner = await fs.readdir(full)
      } catch {
        continue
      }
      if (inner.length === 0) {
        out.push({
          id: itemId(full, rule.id),
          categoryId: rule.id,
          fullPath: normPath(full),
          name: e.name,
          sizeBytes: 0,
          mtime: st.mtimeMs,
          risk: rule.risk,
          isDir: true
        })
        continue
      }

      // 非空但体积不大、且近 180 天无修改 → 视为疑似孤儿
      const age = Date.now() - st.mtimeMs
      if (age < 180 * 86_400_000) continue
      const size = await quickDirSize(full, signal, 20_000)
      if (size > maxDirBytes) continue
      out.push({
        id: itemId(full, rule.id),
        categoryId: rule.id,
        fullPath: normPath(full),
        name: e.name,
        sizeBytes: size,
        mtime: st.mtimeMs,
        risk: rule.risk,
        isDir: true
      })
    }
  }
  return out
}

// ───────────────── 主扫描流程 ─────────────────

export async function scanJunk(
  ruleSet: RuleSet,
  ctx: JunkScanContext,
  opts: JunkScanOptions = {}
): Promise<JunkScanResult> {
  const { categoryIds, onProgress, signal } = opts
  const t0 = Date.now()
  const scanId = uid('scan_')

  const cache: CacheFile = opts.cache ?? emptyCache()
  const cacheUsable = !opts.force && isCacheUsable(cache)
  const reusedRules: string[] = []
  const reuseSource: Record<string, 'volume' | 'usn' | 'signature'> = {}

  const active = ruleSet.rules.filter((r) => !categoryIds || categoryIds.length === 0 || categoryIds.includes(r.id))
  const allItems: JunkItem[] = []
  const categories: JunkCategorySummary[] = []
  let scannedFiles = 0

  const excludeKeys = ctx.excludes.map(normKey)
  const excluded = (p: string): boolean => {
    const k = normKey(p)
    return excludeKeys.some((e) => e && (k === e || k.startsWith(e + '\\')))
  }

  // ── 卷级 USN 哨兵（M2/B1）──
  // nextUsn 是卷级写入计数：两次扫描之间完全相同 ⇒ 该卷无任何写入。
  // 命中的话连目录签名遍历都能跳过，是比 A5 更快的一层。
  const allVolumes = new Set<string>()
  for (const r of active) for (const root of r.roots) {
    const v = volumeOf(root)
    if (v) allVolumes.add(v)
  }
  const currentUsns = await collectVolumeUsns(allVolumes)
  const prevUsns = cache.volumes ?? {}

  // ── USN 变更记录（B1 第 2 级，需管理员权限）──
  // 只对「哨兵已变化」的卷查询：未变化的卷在快路径 1 就复用了，不必再付 fsutil 代价。
  // 未提权时 readJournal 返回 needsElevation，这里得到 available=false，
  // 上层不会据此复用 —— 行为与 v2.0.0 完全一致。
  const changedVolumes = [...allVolumes].filter((v) => currentUsns[v] && prevUsns[v] && currentUsns[v] !== prevUsns[v])
  const usnChanges = process.env.SG_USN_LEVEL2 === '0' ? null : await collectUsnChangeCounts(changedVolumes, prevUsns)
  const volumeUnchanged = (rule: CompiledRule): boolean => {
    const vs = new Set<string>()
    for (const root of rule.roots) {
      const v = volumeOf(root)
      if (v) vs.add(v)
    }
    if (vs.size === 0) return false
    for (const v of vs) {
      const now = currentUsns[v]
      // 取不到当前值 → 视为未知，必须走签名比对
      if (!now || !prevUsns[v] || now !== prevUsns[v]) return false
    }
    return true
  }

  for (let i = 0; i < active.length; i++) {
    if (signal?.cancelled) break
    const rule = active[i]
    const base = (i / active.length) * 100
    const span = 100 / active.length
    onProgress?.(`扫描：${rule.name}`, base, rule.roots[0] ?? '', allItems.length)

    let items: JunkItem[] = []
    const stats: WalkStats = { scanned: 0, denied: 0 }
    let cachedHit = false

    const tick = (phase: string, cur: string, n: number): void => {
      onProgress?.(`${rule.name} · ${phase}`, base + span * 0.6, cur, allItems.length + n)
    }

    // ── 增量快路径 1：卷哨兵未变（M2/B1）──
    // 整卷零写入 ⇒ 直接复用，连目录签名都不用采
    if (cacheUsable && cache.rules[rule.id] && volumeUnchanged(rule)) {
      items = await refreshItems(cache.rules[rule.id].items, signal)
      cachedHit = true
      reusedRules.push(rule.id)
      reuseSource[rule.id] = 'volume'
      // 命中即解除熔断（卷重新安静下来了）
      cache.rules[rule.id].missStreak = 0
      cache.rules[rule.id].disabled = false
      onProgress?.(`${rule.name} · 卷无变更，复用`, base + span * 0.9, '', allItems.length + items.length)
    }
    const entry = cache.rules[rule.id]

    // ── 增量快路径 1.5：USN 变更记录级（M2/B1 第 2 级，需提权）──
    // 卷哨兵变了只说明「有写入」，写入可能是文件内容覆写、日志滚动等不产生
    // 文件增删的动作。此时若 readJournal 报告该卷 0 条变更记录，则缓存完全有效，
    // 连目录签名遍历都可以省掉（签名遍历是二次扫描的主要开销）。
    // 未提权时 readJournal 不可用，这里会静默跳过 —— 行为与 v2.0.0 一致。
    if (!cachedHit && cacheUsable && entry && usnChanges) {
      const vols = rule.roots.map(volumeOf).filter(Boolean)
      const allQuiet =
        vols.length > 0 &&
        vols.every((v) => {
          const c = usnChanges[v]
          return c && c.available && c.count === 0
        })
      if (allQuiet) {
        items = await refreshItems(entry.items, signal)
        cachedHit = true
        reusedRules.push(rule.id)
        reuseSource[rule.id] = 'usn'
        entry.missStreak = 0
        entry.disabled = false
        onProgress?.(`${rule.name} · USN 无变更，复用`, base + span * 0.9, '', allItems.length + items.length)
      }
    }

    // ── 增量快路径 2：目录签名未变（M2/A5）──
    // 签名采集本身只做 readdir + 目录 stat（实测约为完整遍历的 15% 成本）
    //
    // 熔断：若该规则连续 2 次签名不匹配（目录抖动，如 Temp / 着色器缓存），
    // 则不再尝试签名复用 —— 否则每轮都要白付一次签名遍历（GC-12 实测约 10s，
    // 比直接全量扫还慢）。
    const sigCheckAllowed = !entry?.disabled
    let sig = null as Awaited<ReturnType<typeof collectSignatures>> | null
    if (!cachedHit && cacheUsable && entry && sigCheckAllowed) {
      try {
        sig = await collectSignatures(rule, signal)
        const prev = cache.rules[rule.id]
        if (signaturesEqual(sig, prev.sig)) {
          items = await refreshItems(prev.items, signal)
          cachedHit = true
          reusedRules.push(rule.id)
          reuseSource[rule.id] = 'signature'
          prev.missStreak = 0
          onProgress?.(`${rule.name} · 复用增量缓存`, base + span * 0.9, '', allItems.length + items.length)
        } else {
          // 签名不匹配：累计未命中；连续 2 次即熔断，避免持续白付签名遍历
          prev.missStreak = (prev.missStreak ?? 0) + 1
          if (prev.missStreak >= 2) prev.disabled = true
        }
      } catch {
        sig = null
        cachedHit = false
      }
    }

    if (!cachedHit) {
      try {
        switch (rule.algorithm) {
          case 'duplicate':
            items = await findDuplicates(rule, signal, tick)
            break
          case 'bigfile':
            items = await findBigFiles(rule, signal, tick)
            break
          case 'deadlink':
            items = await findDeadLinks(rule, signal, tick)
            break
          case 'orphan':
            items = await findOrphans(rule, ctx, signal, tick)
            break
          default: {
            const acc: JunkItem[] = []
            await walkRule(
              rule,
              (hit) => {
                acc.push({
                  id: itemId(hit.path, rule.id),
                categoryId: rule.id,
                fullPath: hit.path,
                name: baseName(hit.path),
                sizeBytes: hit.size,
                mtime: hit.mtime,
                risk: rule.risk,
                isDir: hit.isDir
              })
            },
            stats,
            signal,
            (cur, n) => tick('遍历', cur, acc.length)
          )
          items = acc
        }
      }
    } catch {
      items = []
    }
    } // end if (!cachedHit)

    items = items.filter((it) => !excluded(it.fullPath))
    // 去重：规则的多个根目录可能相互重叠（例如 %USERPROFILE% 与 %SG_DOCUMENTS%
    // 在未重定向的机器上会指向同一处），必须按路径去重，否则同一文件会被统计两次
    const seenPath = new Set<string>()
    items = items.filter((it) => {
      const k = normKey(it.fullPath)
      if (seenPath.has(k)) return false
      seenPath.add(k)
      return true
    })
    scannedFiles += stats.scanned

    // 重复文件中「保留的那一份」不计入可释放体积
    const releasable = items.filter((it) => !it.keep)
    categories.push({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      risk: rule.risk,
      defaultSelected: rule.defaultSelected,
      sizeBytes: releasable.reduce((s, it) => s + it.sizeBytes, 0),
      count: items.length,
      denied: stats.denied > 0 && items.length === 0 ? true : undefined,
      cached: cachedHit
    })
    allItems.push(...items)

    // 更新缓存：签名未变则沿用旧签名，否则写入本次结果
    if (!signal?.cancelled) {
      if (!cachedHit) {
        try {
          const s = sig ?? (await collectSignatures(rule, signal))
          const prevEntry = cache.rules[rule.id]
          const nextEntry: RuleCache = {
            sig: s,
            items,
            at: Date.now(),
            // 熔断状态在重扫后延续（抖动未消失前不再尝试签名比对）；
            // 强制重扫是用户的明确意图 → 重置熔断，重新尝试一次
            missStreak: opts.force ? 0 : (prevEntry?.missStreak ?? 0),
            disabled: opts.force ? false : (prevEntry?.disabled ?? false)
          }
          cache.rules[rule.id] = nextEntry
        } catch {
          /* 签名采集失败：清除该规则的缓存，下次全量 */
          delete cache.rules[rule.id]
        }
      } else if (cache.rules[rule.id]) {
        cache.rules[rule.id].items = items
        cache.rules[rule.id].at = Date.now()
      }
      // 单规则完成即回传（崩溃续扫的落盘点）
      try {
        opts.onRuleCache?.(cache)
      } catch {
        /* 回调失败不影响扫描 */
      }
    }
    onProgress?.(`完成：${rule.name}`, base + span, '', allItems.length)
  }

  cache.version = CACHE_VERSION
  cache.updatedAt = Date.now()
  // 基线必须取「扫描结束时」的值：取扫描开始时会把整轮扫描的窗口算进差异里，
  // 使哨兵几乎永不命中（实测 GC-11 在 D 盘、D 盘静止可命中，却因基线过宽而落空）
  const endUsns = await collectVolumeUsns(allVolumes)
  cache.volumes = Object.keys(endUsns).length ? endUsns : prevUsns
  const totalBytes = categories.reduce((s, c) => s + c.sizeBytes, 0)
  const oneClickBytes = categories
    .filter((c) => isOneClickEligible(c.risk, c.defaultSelected))
    .reduce((s, c) => s + c.sizeBytes, 0)

  return {
    scanId,
    items: allItems,
    summary: {
      scanId,
      totalBytes,
      totalCount: allItems.length,
      oneClickBytes,
      categories,
      scanMs: Date.now() - t0,
      scannedFiles
    },
    cache,
    reusedRules,
    reuseSource
  }
}

export const RISK_ORDER: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1, hint: 0 }
