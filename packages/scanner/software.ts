/**
 * 软件发现模块 SoftwareScanner
 * 对应技术设计方案 5.1（已安装软件来源 / 便携软件识别 / 图标提取）
 */

import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { SoftwareItem, SoftwareSource } from '../shared/types'
import { normPath, normKey, isSubPath, extName, baseName, dirName } from '../shared/util'
import { enumerateWindows, type EnumResult, type RawUninstall } from './winenum'
import { readPeMeta } from './pe'

// ───────────────── ID / 哈希 ─────────────────

export function softwareId(installPath: string, name: string): string {
  return 'sw_' + createHash('sha1').update(`${normKey(installPath)}|${name.toLowerCase()}`).digest('hex').slice(0, 16)
}

export function iconHashOf(sources: string[]): string {
  return createHash('sha256').update(sources.map(normKey).join('|')).digest('hex').slice(0, 16)
}

// ───────────────── 过滤规则 ─────────────────

/** 驱动包 / 更新补丁 / 系统组件 —— 这些不是「用户视角的软件」，纳入会淹没清单 */
const NOISE_NAME_RE = [
  /^windows\s*(driver\s*package|驱动程序包)/i,
  /^(security\s+)?update\s+for\s+/i,
  /^(hotfix|kb\d{6,})/i,
  /^用于\s.*的\s*(gdr|安全更新|更新)/i,
  /^microsoft\s+visual\s+c\+\+\s+\d{4}.*(additional|minimum)\s+runtime/i,
  /\s\(KB\d{6,}\)\s*$/i,
  /^crystal\s+reports\s+basic/i
]

function isNoise(u: RawUninstall): boolean {
  const n = (u.DisplayName || '').trim()
  if (!n) return true
  if (u.SystemComponent === 1) return true
  if (u.ReleaseType && /update|hotfix|securityupdate/i.test(u.ReleaseType)) return true
  // ParentKeyName 存在说明这是某个产品的补丁子项
  if (u.ParentKeyName) return true
  if (NOISE_NAME_RE.some((r) => r.test(n))) return true
  return false
}

// ───────────────── 主可执行文件定位 ─────────────────

const EXE_SKIP_RE =
  /^(unins|uninstall|setup|install|update|upgrade|repair|crashpad|crashreport|vcredist|dxsetup|helper|service|daemon|notify|report|elevate|launcher_helper)/i

/** 名称相似度：用于在安装目录里挑出「最像主程序」的 exe */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  const y = b.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.8
  // 公共前缀长度占比
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i / Math.max(x.length, y.length)
}

interface ExeCandidate {
  path: string
  size: number
  score: number
}

async function findMainExe(installPath: string, displayName: string, hintExe?: string): Promise<string> {
  if (hintExe && extName(hintExe) === 'exe') {
    try {
      const st = await fs.stat(hintExe)
      if (st.isFile()) return normPath(hintExe)
    } catch {
      /* 继续搜索 */
    }
  }
  if (!installPath) return ''
  const cands: ExeCandidate[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 2 || cands.length > 400) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (/^(locales?|resources?|lib|logs?|temp|cache|data|plugins?|node_modules|\.git)$/i.test(e.name)) continue
        subdirs.push(join(dir, e.name))
        continue
      }
      if (!e.isFile() || extName(e.name) !== 'exe') continue
      const full = join(dir, e.name)
      let size = 0
      try {
        size = (await fs.stat(full)).size
      } catch {
        continue
      }
      const stem = e.name.replace(/\.exe$/i, '')
      let score = similarity(stem, displayName) * 100
      if (EXE_SKIP_RE.test(stem)) score -= 70
      // 越靠外层越可能是主程序
      score += (2 - depth) * 8
      // 体积越大越可能是主程序（弱信号）
      score += Math.min(Math.log10(Math.max(size, 1)) * 2, 14)
      if (/^bin$/i.test(basename(dir))) score += 5
      cands.push({ path: normPath(full), size, score })
    }
    for (const sd of subdirs) await walk(sd, depth + 1)
  }

  await walk(installPath, 0)
  if (cands.length === 0) return ''
  cands.sort((a, b) => b.score - a.score)
  return cands[0].path
}

/** 从 UninstallString / DisplayIcon 反推安装目录 */
function inferInstallPath(u: RawUninstall): string {
  const cands: string[] = []
  if (u.InstallLocation) cands.push(normPath(u.InstallLocation))
  if (u.DisplayIcon) {
    const p = normPath(u.DisplayIcon.split(',')[0])
    if (extName(p) === 'exe' || extName(p) === 'ico') cands.push(dirName(p))
  }
  if (u.UninstallString) {
    const m = u.UninstallString.match(/^"?([a-zA-Z]:\\[^"]+?\.exe)"?/)
    if (m) {
      const d = dirName(m[1])
      // MsiExec.exe 之类不能作为安装目录
      if (!/\\(system32|syswow64)$/i.test(d)) cands.push(d)
    }
  }
  for (const c of cands) {
    if (!c) continue
    if (/^[a-z]:\\?$/i.test(c)) continue
    if (/\\(windows|system32|syswow64)$/i.test(c)) continue
    return c
  }
  return ''
}

function parseInstallDate(s?: string): number | undefined {
  if (!s) return undefined
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

// ───────────────── 便携软件识别（5.1.2） ─────────────────

export interface PortableFeature {
  key: string
  label: string
  weight: number
}

/** 七类特征与权重，完全对齐设计文档表格 */
export const PORTABLE_FEATURES: Record<string, PortableFeature> = {
  selfContained: { key: 'selfContained', label: '目录自包含', weight: 30 },
  noUninstall: { key: 'noUninstall', label: '无卸载项', weight: 20 },
  localConfig: { key: 'localConfig', label: '存在本地配置', weight: 15 },
  writable: { key: 'writable', label: '目录可写', weight: 10 },
  noInstaller: { key: 'noInstaller', label: '无安装器痕迹', weight: 10 },
  versionRes: { key: 'versionRes', label: '版本资源完整', weight: 10 },
  manual: { key: 'manual', label: '用户手动标记', weight: 100 }
}

const CONFIG_RE = /\.(ini|cfg|conf|json|xml|yaml|yml|toml|db|sqlite)$/i
const INSTALLER_RE = /^(setup|install|installer|uninstall|unins\d*|uninst)/i

export interface PortableCandidate {
  dir: string
  mainExe: string
  score: number
  evidence: string[]
  name: string
  version?: string
  publisher?: string
  sizeBytes: number
}

/**
 * 对单个目录做便携软件评分。
 * @param installedPaths 已安装软件目录集合（用于「无卸载项」特征判定）
 */
async function scorePortableDir(
  dir: string,
  installedPaths: Set<string>,
  manual: boolean
): Promise<PortableCandidate | null> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  const exes: string[] = []
  const files: string[] = []
  const dirs: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name)
    else if (e.isFile()) {
      files.push(e.name)
      if (extName(e.name) === 'exe') exes.push(e.name)
    }
  }
  if (exes.length === 0) return null

  const evidence: string[] = []
  let score = 0

  // 特征 1：目录自包含（同时存在 exe 与配置/数据子目录）
  const hasDataDir = dirs.some((d) => /^(data|config|conf|settings|profile|user|plugins?|lib|bin|resources?)$/i.test(d))
  const hasConfigFile = files.some((f) => CONFIG_RE.test(f))
  if (hasDataDir || hasConfigFile) {
    score += PORTABLE_FEATURES.selfContained.weight
    evidence.push(PORTABLE_FEATURES.selfContained.label)
  }

  // 特征 2：无卸载项（注册表与 MSI 中查无此程序）
  const insideInstalled = [...installedPaths].some((p) => p && isSubPath(dir, p))
  if (!insideInstalled) {
    score += PORTABLE_FEATURES.noUninstall.weight
    evidence.push(PORTABLE_FEATURES.noUninstall.label)
  }

  // 特征 3：存在本地配置（配置随程序走）
  if (hasConfigFile || dirs.some((d) => /^(data|profile|settings)$/i.test(d))) {
    score += PORTABLE_FEATURES.localConfig.weight
    evidence.push(PORTABLE_FEATURES.localConfig.label)
  }

  // 特征 4：目录可写且位于非 Program Files 区域
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(
    Boolean
  ) as string[]
  const inProgramFiles = pf.some((p) => isSubPath(dir, p))
  if (!inProgramFiles) {
    let writable = false
    try {
      await fs.access(dir, (await import('node:fs')).constants.W_OK)
      writable = true
    } catch {
      writable = false
    }
    if (writable) {
      score += PORTABLE_FEATURES.writable.weight
      evidence.push(PORTABLE_FEATURES.writable.label)
    }
  }

  // 特征 5：无安装器痕迹
  if (!files.some((f) => extName(f) === 'exe' && INSTALLER_RE.test(f.replace(/\.exe$/i, '')))) {
    score += PORTABLE_FEATURES.noInstaller.weight
    evidence.push(PORTABLE_FEATURES.noInstaller.label)
  }

  // 挑主 exe：优先与目录同名
  const dirStem = baseName(dir)
  exes.sort((a, b) => {
    const sa = similarity(a.replace(/\.exe$/i, ''), dirStem)
    const sb = similarity(b.replace(/\.exe$/i, ''), dirStem)
    if (sa !== sb) return sb - sa
    const pa = INSTALLER_RE.test(a) ? 1 : 0
    const pb = INSTALLER_RE.test(b) ? 1 : 0
    return pa - pb
  })
  const mainExe = join(dir, exes[0])

  // 特征 6：版本资源完整
  const meta = await readPeMeta(mainExe)
  if (meta.fileDescription || meta.productName) {
    score += PORTABLE_FEATURES.versionRes.weight
    evidence.push(PORTABLE_FEATURES.versionRes.label)
  }

  // 特征 7：用户手动标记（优先级最高）
  if (manual) {
    score += PORTABLE_FEATURES.manual.weight
    evidence.push(PORTABLE_FEATURES.manual.label)
  }

  // 体积不在此处计算：dirSize 要递归 stat 最多 3000 个文件，是评分阶段最贵的
  // IO 操作，而阈值判定根本用不到它 —— 由调用方对「命中项」并行补算（v2.0.0 M1）
  return {
    dir: normPath(dir),
    mainExe: normPath(mainExe),
    score,
    evidence,
    name: meta.productName || meta.fileDescription || dirStem,
    version: meta.fileVersion,
    publisher: meta.companyName,
    sizeBytes: 0
  }
}

/** 浅层目录体积统计（限深度与文件数，避免拖慢扫描）；文件 stat 分块并行 */
export async function dirSize(dir: string, maxDepth = 3, maxFiles = 20000): Promise<number> {
  let total = 0
  let count = 0
  // 单目录内 stat 分块并行：便携目录动辄上千文件，串行 stat 是主要等待
  const STAT_CHUNK = 16
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > maxDepth || count > maxFiles) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    const files: import('node:fs').Dirent[] = []
    for (const e of entries) {
      if (count > maxFiles) return
      if (e.isDirectory()) subdirs.push(e.name)
      else if (e.isFile()) files.push(e)
    }
    for (let i = 0; i < files.length && count <= maxFiles; i += STAT_CHUNK) {
      const chunk = files.slice(i, i + STAT_CHUNK)
      const sizes = await Promise.all(
        chunk.map(async (e) => {
          count++
          try {
            return (await fs.stat(join(d, e.name))).size
          } catch {
            return 0
          }
        })
      )
      for (const s of sizes) total += s
    }
    for (const name of subdirs) {
      if (count > maxFiles) return
      await walk(join(d, name), depth + 1)
    }
  }
  await walk(dir, 0)
  return total
}

/** 便携软件扫描入口（支持用户指定目录 + 盘符常见目录名）
 *
 * v2.0.0 M1：目录处理并发化（worker 池拉取共享 BFS 队列）。
 * 串行版每个候选要串行跑 readPeMeta + dirSize（递归 stat 最多 3000 文件），
 * 两个根目录 68 个候选全串联 —— 实测 6.5s；并发后主要等待重叠。
 */
export async function scanPortable(
  roots: string[],
  installedPaths: Set<string>,
  threshold: number,
  manualMarks: Map<string, boolean>,
  onProgress?: (cur: string, found: number) => void
): Promise<SoftwareItem[]> {
  const found: SoftwareItem[] = []
  const pendingSize: { dir: string; mainExe: string }[] = []
  const visited = new Set<string>()
  const rawConc = Number(process.env.SG_PORTABLE_CONCURRENCY ?? 8)
  const CONCURRENCY = Number.isFinite(rawConc) && rawConc >= 1 ? Math.floor(rawConc) : 8

  let active = 0 // 正在处理目录的 worker 数（决定「队列空但还有人会往里加」）
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

  async function processOne(dir: string, depth: number): Promise<void> {
    const key = normKey(dir)
    if (visited.has(key)) return
    visited.add(key)
    onProgress?.(dir, found.length)

    const manual = manualMarks.get(key) === true
    if (manualMarks.get(key) === false) return // 用户显式纠正为「非便携」

    const cand = await scorePortableDir(dir, installedPaths, manual)
    if (cand && cand.score >= threshold) {
      pendingSize.push(cand)
      found.push({
        id: softwareId(cand.dir, cand.name),
        name: cand.name,
        version: cand.version || '',
        publisher: cand.publisher || '',
        installPath: cand.dir,
        mainExe: cand.mainExe,
        iconHash: iconHashOf([cand.mainExe]),
        source: 'portable',
        sizeBytes: 0, // 命中后统一并行补算
        portableScore: cand.score,
        portableEvidence: cand.evidence
      })
      return // 命中即不再深入其子目录
    }
    if (depth < 2) {
      try {
        const subs = await fs.readdir(dir, { withFileTypes: true })
        for (const s of subs) if (s.isDirectory()) queue.push({ dir: join(dir, s.name), depth: depth + 1 })
      } catch {
        /* ignore */
      }
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const task = queue.shift()
      if (!task) {
        // 队列空：若还有 worker 在处理（可能继续产生子目录任务），让步等待
        if (active === 0) return
        await new Promise<void>((r) => setImmediate(r))
        continue
      }
      await acquire()
      try {
        if (visited.has(normKey(task.dir))) continue
        await processOne(task.dir, task.depth)
      } finally {
        release()
      }
    }
  }

  // 根目录层先串行读一层（数量少），随后多 worker 并发处理
  for (const root of roots) {
    let level1: import('node:fs').Dirent[]
    try {
      level1 = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of level1) if (e.isDirectory()) queue.push({ dir: join(root, e.name), depth: 1 })
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, () => worker()))

  // 命中项体积并行补算（延迟到选择之后，非命中目录零开销）
  if (pendingSize.length) {
    const byExe = new Map(found.map((f) => [normKey(f.mainExe), f]))
    await mapPool(pendingSize, 8, async (p) => {
      const size = await dirSize(p.dir, 2, 3000)
      const item = byExe.get(normKey(p.mainExe))
      if (item) item.sizeBytes = size
      return size
    })
  }
  return found
}

/** 默认便携软件扫描根目录（盘符根下常见目录名） */
export async function defaultPortableRoots(): Promise<string[]> {
  const names = ['Tools', 'Portable', 'Green', 'Software', 'Soft', 'Apps', 'PortableApps', '绿色软件', '便携软件']
  const out: string[] = []
  const drives: string[] = []
  for (const c of 'CDEFGH') {
    const d = `${c}:\\`
    try {
      await fs.access(d)
      drives.push(d)
    } catch {
      /* 盘符不存在 */
    }
  }
  for (const d of drives) {
    for (const n of names) {
      const p = join(d, n)
      try {
        const st = await fs.stat(p)
        if (st.isDirectory()) out.push(normPath(p))
      } catch {
        /* ignore */
      }
    }
  }
  const up = process.env.USERPROFILE
  if (up) {
    for (const n of ['Tools', 'Apps', 'Portable']) {
      const p = join(up, n)
      try {
        if ((await fs.stat(p)).isDirectory()) out.push(normPath(p))
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

// ───────────────── 已安装软件构建 ─────────────────

export interface ScanSoftwareOptions {
  portableRoots?: string[]
  portableThreshold?: number
  manualMarks?: Map<string, boolean>
  onProgress?: (phase: string, percent: number, current: string, found: number) => void
  onBatch?: (items: SoftwareItem[]) => void
  signal?: { cancelled: boolean }
}

export async function scanInstalled(raw: EnumResult, opts: ScanSoftwareOptions = {}): Promise<SoftwareItem[]> {
  const { onProgress, onBatch, signal } = opts
  const items: SoftwareItem[] = []
  const appPathByExe = new Map<string, string>()
  for (const a of raw.appPaths) appPathByExe.set(a.exeName.toLowerCase(), normPath(a.path))

  // MSI 产品名 → 便于优先级取值（MSI > 卸载项 > App Paths）
  const msiNames = new Set(raw.msi.map((m) => (m.name || '').toLowerCase()).filter(Boolean))

  const cleaned = raw.uninstall.filter((u) => !isNoise(u))
  const total = cleaned.length || 1
  let done = 0

  // v2.0.0 M1：findMainExe（目录深度 2 遍历 + 逐 exe stat）是纯 IO 等待，
  // 串行 280 项约 1.5s；并发后主要等待互相重叠。进度计数按完成数推进。
  const mainExeList = await mapPool(cleaned, 8, async (u) => {
    if (signal?.cancelled) return ''
    const name = (u.DisplayName || '').trim()
    const installPath = inferInstallPath(u)
    const hint = u.DisplayIcon ? normPath(u.DisplayIcon.split(',')[0]) : appPathByExe.get(name.toLowerCase() + '.exe')
    const mainExe = await findMainExe(installPath, name, hint && extName(hint) === 'exe' ? hint : undefined)
    done++
    if (done % 10 === 0) onProgress?.('解析已安装软件', (done / total) * 60, name, done)
    return mainExe
  })
  if (signal?.cancelled) return dedupe(items)

  const batch: SoftwareItem[] = []
  for (let i = 0; i < cleaned.length; i++) {
    const u = cleaned[i]
    const mainExe = mainExeList[i]
    const name = (u.DisplayName || '').trim()
    const installPath = inferInstallPath(u)
    // 既无安装目录又无主程序 → 无法参与依赖图谱，跳过
    if (!installPath && !mainExe) continue

    const source: SoftwareSource = msiNames.has(name.toLowerCase()) || u.WindowsInstaller === 1 ? 'msi' : 'registry'
    const iconSources = [u.DisplayIcon || '', mainExe, installPath ? join(installPath, baseName(installPath) + '.ico') : '']
      .filter(Boolean)

    const item: SoftwareItem = {
      id: softwareId(installPath || mainExe, name),
      name,
      version: (u.DisplayVersion || '').trim(),
      publisher: (u.Publisher || '').trim(),
      installPath: installPath || dirName(mainExe),
      mainExe,
      iconHash: iconHashOf(iconSources),
      source,
      sizeBytes: (u.EstimatedSize || 0) * 1024,
      installDate: parseInstallDate(u.InstallDate),
      uninstallString: u.UninstallString
    }
    items.push(item)
    batch.push(item)
    if (batch.length >= 25) {
      onBatch?.(batch)
      batch.length = 0
    }
  }
  if (batch.length) onBatch?.(batch)

  // Microsoft Store 应用（同样并发化 findMainExe）
  onProgress?.('解析 Store 应用', 70, '', items.length)
  const storeTargets = raw.store.filter((s) => normPath(s.InstallLocation))
  const storeExes = await mapPool(storeTargets, 8, async (s) => {
    if (signal?.cancelled) return ''
    return findMainExe(normPath(s.InstallLocation), s.Name)
  })
  const storeItems: SoftwareItem[] = []
  for (let i = 0; i < storeTargets.length; i++) {
    const s = storeTargets[i]
    const mainExe = storeExes[i]
    const loc = normPath(s.InstallLocation)
    const displayName = s.Name.replace(/^[^.]*\./, '') || s.Name
    storeItems.push({
      id: softwareId(loc, s.PackageFullName),
      name: displayName,
      version: s.Version,
      publisher: (s.Publisher || '').replace(/^CN=/, '').split(',')[0],
      installPath: loc,
      mainExe,
      iconHash: iconHashOf([mainExe || loc]),
      source: 'store',
      sizeBytes: 0
    })
  }
  if (storeItems.length) onBatch?.(storeItems)
  items.push(...storeItems)

  // 服务与驱动（仅保留非 svchost 的独立宿主，且不在已收录目录内）
  onProgress?.('解析服务宿主', 80, '', items.length)
  const knownDirs = new Set(items.map((i) => normKey(i.installPath)).filter(Boolean))
  const serviceItems: SoftwareItem[] = []
  const seenSvcExe = new Set<string>()
  for (const s of raw.services) {
    if (signal?.cancelled) break
    const m = s.imagePath.match(/([a-zA-Z]:\\[^"]*?\.exe)/)
    if (!m) continue
    const exe = normPath(m[1])
    const low = normKey(exe)
    if (seenSvcExe.has(low)) continue
    if (/\\(svchost|dllhost|rundll32|msiexec|taskhostw|conhost|wininit|services|lsass)\.exe$/i.test(low)) continue
    if (/^c:\\windows\\/i.test(low)) continue
    const dir = dirName(exe)
    if ([...knownDirs].some((k) => k && isSubPath(dir, k))) continue
    seenSvcExe.add(low)
    serviceItems.push({
      id: softwareId(dir, s.displayName || s.name),
      name: s.displayName || s.name,
      version: '',
      publisher: '',
      installPath: dir,
      mainExe: exe,
      iconHash: iconHashOf([exe]),
      source: 'service',
      sizeBytes: 0
    })
  }
  if (serviceItems.length) onBatch?.(serviceItems)
  items.push(...serviceItems)

  return items
}

/**
 * 去重策略（5.1.1）：
 *   以「规范化后的主可执行文件路径」为主键，辅以「发布者 + 产品名」模糊匹配；
 *   冲突时按 MSI > 卸载项 > App Paths > Store > 服务 的优先级取值。
 */
const SOURCE_PRIORITY: Record<SoftwareSource, number> = {
  msi: 5,
  registry: 4,
  portable: 3,
  store: 2,
  service: 1
}

export function dedupe(items: SoftwareItem[]): SoftwareItem[] {
  const byExe = new Map<string, SoftwareItem>()
  const noExe: SoftwareItem[] = []

  for (const it of items) {
    const key = normKey(it.mainExe)
    if (!key) {
      noExe.push(it)
      continue
    }
    const prev = byExe.get(key)
    if (!prev) {
      byExe.set(key, it)
      continue
    }
    byExe.set(key, mergePick(prev, it))
  }

  // 发布者 + 产品名模糊合并
  const result = [...byExe.values(), ...noExe]
  const byNamePub = new Map<string, SoftwareItem>()
  const out: SoftwareItem[] = []
  for (const it of result) {
    const pub = (it.publisher || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
    const nm = it.name.toLowerCase().replace(/\s*\d[\d.]*\s*$/, '').replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
    const k = pub && nm ? `${pub}|${nm}` : ''
    if (!k) {
      out.push(it)
      continue
    }
    const prev = byNamePub.get(k)
    if (!prev) {
      byNamePub.set(k, it)
      out.push(it)
      continue
    }
    // 同名同发布者：保留优先级更高者，合并到已入列的那条
    const winner = mergePick(prev, it)
    const idx = out.indexOf(prev)
    if (idx >= 0) out[idx] = winner
    byNamePub.set(k, winner)
  }
  return out
}

function mergePick(a: SoftwareItem, b: SoftwareItem): SoftwareItem {
  const pa = SOURCE_PRIORITY[a.source]
  const pb = SOURCE_PRIORITY[b.source]
  const win = pa >= pb ? a : b
  const lose = pa >= pb ? b : a
  return {
    ...win,
    version: win.version || lose.version,
    publisher: win.publisher || lose.publisher,
    installPath: win.installPath || lose.installPath,
    mainExe: win.mainExe || lose.mainExe,
    sizeBytes: Math.max(win.sizeBytes, lose.sizeBytes),
    installDate: win.installDate ?? lose.installDate,
    uninstallString: win.uninstallString || lose.uninstallString,
    portableScore: win.portableScore ?? lose.portableScore,
    portableEvidence: win.portableEvidence ?? lose.portableEvidence
  }
}

/**
 * 定并发映射池（v2.0.0 M1）：文件系统调用是 IO 等待，串行逐项 await 会把
 * 延迟完全串联（280 项 findMainExe 串行 1.45s）。结果按输入顺序返回。
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const raw = Number(concurrency)
  const conc = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 8
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/** 完整软件发现流程 */export async function discoverSoftware(opts: ScanSoftwareOptions = {}): Promise<SoftwareItem[]> {
  const { onProgress, onBatch, signal } = opts
  onProgress?.('枚举注册表与系统来源', 4, '正在读取注册表卸载项…', 0)
  const raw = await enumerateWindows()
  if (signal?.cancelled) return []

  const installed = await scanInstalled(raw, opts)
  if (signal?.cancelled) return dedupe(installed)

  const installedPaths = new Set(installed.map((i) => normKey(i.installPath)).filter(Boolean))
  const roots = opts.portableRoots?.length ? opts.portableRoots : await defaultPortableRoots()
  onProgress?.('扫描便携软件', 85, roots.join('、') || '未配置目录', installed.length)

  const portable = roots.length
    ? await scanPortable(
        roots,
        installedPaths,
        opts.portableThreshold ?? 55,
        opts.manualMarks ?? new Map(),
        (cur, found) => onProgress?.('扫描便携软件', 85 + Math.min(found, 10), cur, installed.length + found)
      )
    : []
  if (portable.length) onBatch?.(portable)

  onProgress?.('去重与合并', 98, '', installed.length + portable.length)
  return dedupe([...installed, ...portable])
}
