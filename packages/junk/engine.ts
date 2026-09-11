/**
 * 垃圾规则引擎
 * 对应技术设计方案 7.4 垃圾规则引擎
 *
 * 引擎特性：环境变量展开、glob 匹配、排除规则、最小体积与最小存在时长过滤。
 * 新增垃圾类型只需改 junk-rules.json，无需改代码。
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { JunkRule, RiskLevel } from '../shared/types'
import { globToRegExp, matchAny, normPath, baseName, normKey } from '../shared/util'
import { isScannable, SKIP_DIR_NAMES } from '../shared/safety'

export interface CompiledRule {
  raw: JunkRule
  id: string
  name: string
  description?: string
  risk: RiskLevel
  defaultSelected: boolean
  algorithm?: JunkRule['algorithm']
  roots: string[]
  patterns: RegExp[]
  exclude: RegExp[]
  maxAgeMs: number
  minSizeBytes: number
  wholeDir: boolean
  maxDepth: number
  options: Record<string, number | string | boolean>
}

/** 环境变量展开，额外支持 %SG_DRIVES% 展开为所有存在的固定盘符 */
export function expandRoots(root: string): string[] {
  if (root.includes('%SG_DRIVES%')) {
    const out: string[] = []
    for (const c of 'CDEFGHIJ') {
      const drive = `${c}:`
      if (!existsSync(drive + '\\')) continue
      out.push(normPath(root.replace('%SG_DRIVES%', drive)))
    }
    return out
  }
  const expanded = root.replace(/%([^%]+)%/g, (_, k: string) => {
    const v = process.env[k] ?? process.env[k.toUpperCase()] ?? ''
    return v
  })
  // 展开失败（环境变量不存在）→ 丢弃该 root，避免产生 "%FOO%\bar" 这种垃圾路径
  if (expanded.includes('%')) return []
  return [normPath(expanded)]
}

export function compileRule(r: JunkRule): CompiledRule {
  const m = r.match ?? { roots: [] }
  const roots = (m.roots || []).flatMap(expandRoots).filter((p) => p.length > 2)
  return {
    raw: r,
    id: r.id,
    name: r.name,
    description: r.description,
    risk: r.risk,
    defaultSelected: r.defaultSelected,
    algorithm: r.algorithm,
    roots: [...new Set(roots)],
    patterns: (m.patterns || ['*']).map(globToRegExp),
    exclude: (m.exclude || []).map(globToRegExp),
    maxAgeMs: (m.maxAgeDays ?? 0) * 86_400_000,
    minSizeBytes: m.minSizeBytes ?? 0,
    wholeDir: m.wholeDir ?? false,
    maxDepth: m.maxDepth ?? 6,
    options: (r.options ?? {}) as Record<string, number | string | boolean>
  }
}

export interface RuleSet {
  schemaVersion: number
  updatedAt: string
  rules: CompiledRule[]
}

export async function loadRules(rulesPath: string): Promise<RuleSet> {
  const raw = JSON.parse(await fs.readFile(rulesPath, 'utf8')) as {
    schemaVersion: number
    updatedAt: string
    rules: JunkRule[]
  }
  return {
    schemaVersion: raw.schemaVersion,
    updatedAt: raw.updatedAt,
    rules: raw.rules.map(compileRule)
  }
}

/** 内置规则（打包后作为兜底，防止规则文件缺失导致完全不可用） */
export function loadRulesSync(rulesJson: {
  schemaVersion: number
  updatedAt: string
  rules: JunkRule[]
}): RuleSet {
  return {
    schemaVersion: rulesJson.schemaVersion,
    updatedAt: rulesJson.updatedAt,
    rules: rulesJson.rules.map(compileRule)
  }
}

export interface WalkHit {
  path: string
  size: number
  mtime: number
  isDir: boolean
}

export interface WalkStats {
  scanned: number
  denied: number
}

/**
 * 按规则遍历目录树并产出命中项。
 * 关键安全约束：每一个候选路径都先过 isScannable（复用 9.1 白名单），
 * 命中受保护路径直接跳过，使 UI 上不会出现「显示了却根本删不掉」的条目。
 */
export async function walkRule(
  rule: CompiledRule,
  onHit: (hit: WalkHit) => void,
  stats: WalkStats,
  signal?: { cancelled: boolean },
  onTick?: (current: string, scanned: number) => void
): Promise<void> {
  const now = Date.now()
  let tickCounter = 0

  const consider = (full: string, size: number, mtime: number, isDir: boolean): void => {
    if (rule.minSizeBytes > 0 && size < rule.minSizeBytes) return
    if (rule.maxAgeMs > 0 && now - mtime < rule.maxAgeMs) return
    onHit({ path: full, size, mtime, isDir })
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (signal?.cancelled) return
    if (depth > rule.maxDepth) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      stats.denied++
      return
    }

    for (const e of entries) {
      if (signal?.cancelled) return
      const full = join(dir, e.name)

      if (++tickCounter % 2000 === 0) onTick?.(full, stats.scanned)

      // 符号链接 / reparse point 一律不跟随（9.1 符号链接防护）
      if (e.isSymbolicLink()) continue

      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name.toLowerCase())) continue
        if (!isScannable(full)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue

      stats.scanned++
      const name = e.name
      if (!matchAny(name, rule.patterns) && !matchAny(full, rule.patterns)) continue
      if (rule.exclude.length && (matchAny(full, rule.exclude) || matchAny(name, rule.exclude))) continue
      if (!isScannable(full)) continue

      let st: import('node:fs').Stats
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      consider(normPath(full), st.size, st.mtimeMs, false)
    }
  }

  for (const root of rule.roots) {
    if (signal?.cancelled) return
    let st: import('node:fs').Stats
    try {
      st = await fs.stat(root)
    } catch {
      continue
    }

    if (st.isFile()) {
      // root 直接指向文件（如 %LOCALAPPDATA%\IconCache.db）
      stats.scanned++
      if (matchAny(baseName(root), rule.patterns) && isScannable(root)) {
        consider(normPath(root), st.size, st.mtimeMs, false)
      }
      continue
    }
    if (!st.isDirectory()) continue

    // wholeDir：整个目录作为一个条目计入（如 Windows.old）
    if (rule.wholeDir) {
      if (!isScannable(root)) continue
      const size = await quickDirSize(root, signal)
      if (size > 0) consider(normPath(root), size, st.mtimeMs, true)
      continue
    }

    onTick?.(root, stats.scanned)
    await walk(root, 0)
  }
}

/** 目录体积快速统计（用于 wholeDir 规则） */
export async function quickDirSize(dir: string, signal?: { cancelled: boolean }, maxFiles = 200_000): Promise<number> {
  let total = 0
  let count = 0
  const stack = [dir]
  while (stack.length) {
    if (signal?.cancelled) break
    const d = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (count > maxFiles) return total
      if (e.isSymbolicLink()) continue
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        count++
        try {
          total += (await fs.stat(full)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total
}

/** 已安装软件目录名集合，供 GC-08 孤儿目录判定使用 */
export function buildKnownNameSet(names: string[]): Set<string> {
  const set = new Set<string>()
  for (const n of names) {
    const k = n.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
    if (k.length >= 3) set.add(k)
  }
  return set
}

export function looksOrphan(dirName: string, known: Set<string>, publishers: Set<string>): boolean {
  const k = dirName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  if (k.length < 3) return false
  if (known.has(k)) return false
  for (const n of known) if (n.includes(k) || k.includes(n)) return false
  for (const p of publishers) if (p.includes(k) || k.includes(p)) return false
  return true
}

export { normKey }
