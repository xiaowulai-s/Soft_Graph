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

/**
 * 用户库目录的同义名回退。
 * 为什么要这个：中文 Windows 上 `%USERPROFILE%\Documents` 常常并不存在 ——
 * 真实路径可能是 `%USERPROFILE%\OneDrive\文档`（OneDrive 接管）或 `桌面`/`图片` 等本地化名。
 * 若只按英文名写死，GC-11（重复文件）与 GC-12（超大文件）在中英文混合环境会静默失效。
 */
const SHELL_SYNONYMS: Record<string, string[]> = {
  documents: ['Documents', '文档', 'My Documents'],
  pictures: ['Pictures', '图片', 'My Pictures'],
  desktop: ['Desktop', '桌面'],
  downloads: ['Downloads', '下载'],
  videos: ['Videos', '视频', 'My Videos'],
  music: ['Music', '音乐', 'My Music'],
  favorites: ['Favorites', '收藏夹'],
  onedrive: ['OneDrive', 'OneDrive - Personal']
}

const ONEDRIVE_HOSTS = ['OneDrive', 'OneDrive - Personal']

/**
 * 已解析的用户库目录真实路径（由 ShellService 在启动时注入，见 shellfolders.ts）。
 * 例：{ documents: 'D:\\文档', pictures: 'D:\\图片', desktop: 'D:\\桌面' }
 */
let shellFolderMap: Partial<Record<string, string>> | null = null

export function setShellFolderMap(map: Partial<Record<string, string>> | null): void {
  shellFolderMap = map
}

export function getShellFolderMap(): Partial<Record<string, string>> | null {
  return shellFolderMap
}

/**
 * 把「按英文名拼出来的库目录」修正为真实存在的路径。
 * 优先级：
 *   1. 注入的注册表权威路径（能覆盖重定向到其它盘的情况 —— 实测有机器把文档/图片全放到 D 盘）
 *   2. 原路径下同义名（中文/英文别名）
 *   3. OneDrive 宿主目录下的同义名
 * 全部落空时返回原路径（上层遍历时自然跳过，不会报错）。
 */
function resolveShellFolder(p: string): string {
  if (existsSync(p)) return p
  const sep = p.lastIndexOf('\\')
  if (sep <= 0) return p
  const name = p.slice(sep + 1)
  const lower = name.toLowerCase()
  const parent = p.slice(0, sep)
  const syns = SHELL_SYNONYMS[lower]
  if (!syns) return p

  // 1) 注册表权威路径
  if (shellFolderMap) {
    for (const [key, real] of Object.entries(shellFolderMap)) {
      if (!real) continue
      const keySyns = SHELL_SYNONYMS[key]
      if (!keySyns) continue
      if (!keySyns.some((s) => s.toLowerCase() === lower)) continue
      if (existsSync(real)) return real
      break
    }
  }

  // 2) 同目录下的本地化名
  for (const s of syns) {
    const cand = `${parent}\\${s}`
    if (existsSync(cand)) return cand
  }

  // 3) OneDrive 下
  for (const host of ONEDRIVE_HOSTS) {
    const onedrive = `${parent}\\${host}`
    if (!existsSync(onedrive)) continue
    for (const s of syns) {
      const cand = `${onedrive}\\${s}`
      if (existsSync(cand)) return cand
    }
  }
  return p
}

/** 显式引用用户库目录的 token（始终走权威解析，不受英文名是否存在影响） */
const SHELL_TOKENS = [
  'SG_DOCUMENTS',
  'SG_PICTURES',
  'SG_DESKTOP',
  'SG_DOWNLOADS',
  'SG_VIDEOS',
  'SG_MUSIC',
  'SG_FAVORITES'
] as const

const TOKEN_KEY: Record<string, string> = {
  SG_DOCUMENTS: 'documents',
  SG_PICTURES: 'pictures',
  SG_DESKTOP: 'desktop',
  SG_DOWNLOADS: 'downloads',
  SG_VIDEOS: 'videos',
  SG_MUSIC: 'music',
  SG_FAVORITES: 'favorites'
}

/**
 * 展开库目录 token。解析不到真实路径时回退到 %USERPROFILE% 下的英文名，
 * 若该英文名也不存在则返回空数组（宁可少扫，不可扫错）。
 */
function expandShellToken(token: string): string[] {
  const key = TOKEN_KEY[token]
  if (!key) return []
  const real = shellFolderMap?.[key]
  if (real && existsSync(real)) return [normPath(real)]
  const profile = process.env.USERPROFILE
  if (!profile) return []
  for (const syn of SHELL_SYNONYMS[key] ?? []) {
    const cand = `${normPath(profile)}\\${syn}`
    if (existsSync(cand)) return [cand]
  }
  for (const host of ONEDRIVE_HOSTS) {
    for (const syn of SHELL_SYNONYMS[key] ?? []) {
      const cand = `${normPath(profile)}\\${host}\\${syn}`
      if (existsSync(cand)) return [cand]
    }
  }
  return []
}

/** 环境变量展开，额外支持 %SG_DRIVES%（所有固定盘符）与 %SG_DOCUMENTS% 等库目录 token */
export function expandRoots(root: string): string[] {
  // 库目录 token：优先权威解析
  for (const t of SHELL_TOKENS) {
    if (!root.includes(`%${t}%`)) continue
    const resolved = expandShellToken(t)
    if (resolved.length === 0) return []
    const out: string[] = []
    for (const base of resolved) {
      out.push(...expandRoots(root.replace(`%${t}%`, base)))
    }
    return [...new Set(out)]
  }

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
  let p = normPath(expanded)
  // 二次防线：展开后必须是绝对路径。
  // 若环境变量缺失导致结果退化成 "\bar"（相对盘根的路径），会被 normPath 保留下来，
  // 一旦进入规则就会被当成「盘符根目录下的 bar」从而扩大扫描范围 —— 这里硬性丢弃。
  if (!/^[A-Za-z]:\\/.test(p)) return []
  // 修正中文/OneDrive/重定向环境下的库目录
  p = resolveShellFolder(p)
  return [p]
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
  /**
   * 编译期警告：例如库目录 token 无法解析导致某条规则失去全部根目录。
   * 这类问题若静默发生，用户会以为「扫过了」，实际一个目录都没进（BUG-09 的教训），
   * 因此必须显式暴露给 UI / 诊断包。
   */
  warnings: string[]
}

function buildRuleSet(raw: { schemaVersion: number; updatedAt: string; rules: JunkRule[] }): RuleSet {
  const rules = raw.rules.map(compileRule)
  const warnings: string[] = []
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]
    const src = raw.rules[i]
    if (r.roots.length === 0) {
      warnings.push(`${r.id}（${r.name}）没有任何可用的根目录，该分类将被跳过`)
      continue
    }
    const declared = src.match?.roots ?? []
    const tokenMissing = declared.filter((d) => SHELL_TOKENS.some((t) => d.includes(`%${t}%`)))
    if (tokenMissing.length > 0) {
      const resolvedCount = r.roots.length
      if (resolvedCount < tokenMissing.length) {
        warnings.push(
          `${r.id}（${r.name}）有 ${tokenMissing.length - resolvedCount} 个用户库目录未解析成功` +
            `（可能是未调用 resolveUserShellFolders 或该目录不存在）`
        )
      }
    }
  }
  return { schemaVersion: raw.schemaVersion, updatedAt: raw.updatedAt, rules, warnings }
}

export async function loadRules(rulesPath: string): Promise<RuleSet> {
  const raw = JSON.parse(await fs.readFile(rulesPath, 'utf8')) as {
    schemaVersion: number
    updatedAt: string
    rules: JunkRule[]
  }
  return buildRuleSet(raw)
}

/** 内置规则（打包后作为兜底，防止规则文件缺失导致完全不可用） */
export function loadRulesSync(rulesJson: {
  schemaVersion: number
  updatedAt: string
  rules: JunkRule[]
}): RuleSet {
  return buildRuleSet(rulesJson)
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
