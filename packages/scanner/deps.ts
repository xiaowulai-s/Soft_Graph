/**
 * 依赖解析模块 DependencyResolver
 * 对应技术设计方案 5.2（八类依赖证据）与 7.1（依赖归属置信度打分）
 *
 * 核心思想：不依赖单一证据下结论，把多源证据加权融合成置信度。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  DependencyEdge,
  DependencyType,
  EvidenceCode,
  FileNode,
  PeArch,
  SoftwareItem
} from '../shared/types'
import { EVIDENCE_WEIGHT } from '../shared/types'
import { classifyKind, extName, isSharedRuntime, normKey, normPath, baseName, isSubPath, clamp } from '../shared/util'
import { parsePe, type PeResult } from './pe'
import {
  buildPathDirs,
  loadKnownDlls,
  resolveDll,
  resolveSxsAssembly,
  type ResolveContext,
  type ResolvedDll
} from './dllresolve'

export function fileId(fullPath: string): string {
  return 'f_' + createHash('sha1').update(normKey(fullPath)).digest('hex').slice(0, 16)
}

// ───────────────── 证据累积 ─────────────────

interface EvidenceBag {
  path: string
  /** 逻辑名（缺失依赖时只有名字没有路径） */
  name: string
  evidence: Set<EvidenceCode>
  types: Set<DependencyType>
  missing: boolean
  /** API Set 虚拟 DLL：不计入缺失，也不渲染为独立节点 */
  virtual: boolean
  requestedAs?: string
}

class EvidenceCollector {
  private map = new Map<string, EvidenceBag>()

  add(
    key: string,
    name: string,
    evidence: EvidenceCode,
    type: DependencyType,
    opts: { missing?: boolean; virtual?: boolean; requestedAs?: string } = {}
  ): void {
    const k = key.toLowerCase()
    let bag = this.map.get(k)
    if (!bag) {
      bag = {
        path: key,
        name,
        evidence: new Set(),
        types: new Set(),
        missing: opts.missing ?? false,
        virtual: opts.virtual ?? false,
        requestedAs: opts.requestedAs
      }
      this.map.set(k, bag)
    }
    bag.evidence.add(evidence)
    bag.types.add(type)
    // 只要有一条证据解析到真实路径，就不再算缺失
    if (!opts.missing) bag.missing = false
    if (opts.requestedAs && !bag.requestedAs) bag.requestedAs = opts.requestedAs
  }

  values(): EvidenceBag[] {
    return [...this.map.values()]
  }
}

// ───────────────── 置信度打分（7.1） ─────────────────

/**
 * refCount 基线：数据库中的真实引用计数需要多次扫描才积累出来，
 * 冷启动时若一律按 1 计算，kernel32.dll 会被判为某软件的专属依赖（设计意图明确反对）。
 * 因此对系统目录与共享运行库给出保守基线，使共享惩罚立即生效。
 */
export function baselineRefCount(fullPath: string, name: string): number {
  const p = normKey(fullPath)
  const sysRoot = normKey(process.env.SystemRoot || 'C:\\Windows')
  if (p.startsWith(sysRoot + '\\system32') || p.startsWith(sysRoot + '\\syswow64')) return 120
  if (p.startsWith(sysRoot + '\\winsxs')) return 60
  if (isSharedRuntime(name)) return 40
  if (p.startsWith(sysRoot)) return 25
  return 1
}

/**
 * confidence = clamp(
 *   max(E_weight)                 // 取命中的最强证据权重
 *   + 0.05 * (hitCount - 1)       // 多证据互相印证加成
 *   - 0.15 * sharedPenalty        // 被大量软件共享则降低专属度
 * )
 * sharedPenalty = min(1, log10(refCount) / 2)
 */
export function scoreConfidence(evidence: EvidenceCode[], refCount: number): number {
  if (evidence.length === 0) return 0
  const maxW = Math.max(...evidence.map((e) => EVIDENCE_WEIGHT[e]))
  const hitBonus = 0.05 * (evidence.length - 1)
  const sharedPenalty = Math.min(1, Math.log10(Math.max(refCount, 1)) / 2)
  return clamp(maxW + hitBonus - 0.15 * sharedPenalty, 0, 1)
}

/** 证据集合 → 主关系类型（用于边的渲染与文案） */
function pickType(types: Set<DependencyType>, evidence: Set<EvidenceCode>): DependencyType {
  const order: DependencyType[] = [
    'imports',
    'dotnet_ref',
    'sxs',
    'delay_loads',
    'com',
    'service',
    'shortcut',
    'data',
    'binds'
  ]
  for (const t of order) if (types.has(t)) return t
  return evidence.has('E1') ? 'binds' : 'data'
}

// ───────────────── COM / 服务反查索引（证据 E6） ─────────────────

let comIndex: Map<string, string[]> | null = null

/**
 * 建立 InprocServer32 → CLSID 反查索引。
 * 注册表 CLSID 子键数量常在万级，一次性读取约 2~5s，因此全局只做一次并缓存。
 */
export async function loadComIndex(): Promise<Map<string, string[]>> {
  if (comIndex) return comIndex
  const idx = new Map<string, string[]>()
  try {
    const { psJson, asArray } = await import('./psbridge')
    const rows = asArray(
      await psJson<{ clsid: string; dll: string }[]>(
        String.raw`
$out = New-Object System.Collections.ArrayList
foreach ($rootPath in @('SOFTWARE\Classes\CLSID','SOFTWARE\WOW6432Node\Classes\CLSID')) {
  try {
    $root = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($rootPath)
    if ($null -eq $root) { continue }
    foreach ($clsid in $root.GetSubKeyNames()) {
      try {
        $k = $root.OpenSubKey($clsid + '\InprocServer32')
        if ($null -eq $k) { $k = $root.OpenSubKey($clsid + '\LocalServer32') }
        if ($null -eq $k) { continue }
        $v = [string]$k.GetValue('')
        if ([string]::IsNullOrWhiteSpace($v)) { continue }
        [void]$out.Add([pscustomobject]@{ clsid = $clsid; dll = $v })
        $k.Close()
      } catch { }
    }
    $root.Close()
  } catch { }
}
Write-SgJson @($out)
`,
        { timeoutMs: 120_000 }
      )
    )
    for (const r of rows) {
      if (!r?.dll) continue
      let p = r.dll.trim().replace(/^"+|"+$/g, '')
      const m = p.match(/^(.*?\.(?:dll|exe|ocx))\b/i)
      if (m) p = m[1]
      p = normPath(expandEnv(p))
      if (!/^[a-z]:\\/i.test(p)) continue
      const k = normKey(p)
      const arr = idx.get(k) || []
      if (arr.length < 8) arr.push(r.clsid)
      idx.set(k, arr)
    }
  } catch {
    /* 读不到就跳过 E6，不影响其他证据 */
  }
  comIndex = idx
  return idx
}

function expandEnv(s: string): string {
  return s.replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`)
}

// ───────────────── 快捷方式索引（证据 E7） ─────────────────

let lnkIndex: Map<string, string[]> | null = null

/** 扫描开始菜单与桌面的 .lnk，建立「目标 exe → 快捷方式路径」索引 */
export async function loadLnkIndex(): Promise<Map<string, string[]>> {
  if (lnkIndex) return lnkIndex
  const idx = new Map<string, string[]>()
  try {
    const { psJson, asArray } = await import('./psbridge')
    const rows = asArray(
      await psJson<{ lnk: string; target: string; args: string }[]>(
        String.raw`
$roots = @(
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$sh = New-Object -ComObject WScript.Shell
$out = New-Object System.Collections.ArrayList
foreach ($r in $roots) {
  try {
    $lnks = Get-ChildItem -LiteralPath $r -Filter *.lnk -Recurse -ErrorAction SilentlyContinue
    foreach ($l in $lnks) {
      try {
        $s = $sh.CreateShortcut($l.FullName)
        if ([string]::IsNullOrWhiteSpace($s.TargetPath)) { continue }
        [void]$out.Add([pscustomobject]@{ lnk = $l.FullName; target = $s.TargetPath; args = [string]$s.Arguments })
      } catch { }
    }
  } catch { }
}
Write-SgJson @($out)
`,
        { timeoutMs: 90_000 }
      )
    )
    for (const r of rows) {
      if (!r?.target) continue
      const k = normKey(r.target)
      const arr = idx.get(k) || []
      if (arr.length < 6) arr.push(r.lnk)
      idx.set(k, arr)
    }
  } catch {
    /* 忽略 */
  }
  lnkIndex = idx
  return idx
}

export function resetIndexes(): void {
  comIndex = null
  lnkIndex = null
}

// ───────────────── 安装目录文件枚举（证据 E1） ─────────────────

const DATA_EXT_INTEREST = new Set([
  'exe', 'dll', 'ocx', 'ax', 'cpl', 'sys', 'drv', 'node', 'pyd', 'so',
  'ini', 'cfg', 'conf', 'json', 'xml', 'yml', 'yaml', 'toml', 'db', 'sqlite',
  'dat', 'bin', 'pak', 'asar', 'jar', 'lib', 'so', 'nls', 'mui'
])

export interface DirScanResult {
  files: { path: string; size: number; mtime: number }[]
  truncated: boolean
  totalBytes: number
}

/** 安装目录递归枚举（对应扫描流水线阶段二：目录快照） */
export async function snapshotInstallDir(
  root: string,
  opts: { maxDepth?: number; maxFiles?: number; onlyInteresting?: boolean } = {}
): Promise<DirScanResult> {
  const { maxDepth = 6, maxFiles = 6000, onlyInteresting = true } = opts
  const files: DirScanResult['files'] = []
  let truncated = false
  let totalBytes = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const full = join(dir, e.name)
      if (e.isSymbolicLink()) continue // 防链接逃逸（9.1）
      if (e.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      const ext = extName(e.name)
      let st: import('node:fs').Stats
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      totalBytes += st.size
      if (onlyInteresting && !DATA_EXT_INTEREST.has(ext) && st.size < 512 * 1024) continue
      files.push({ path: normPath(full), size: st.size, mtime: st.mtimeMs })
    }
  }
  await walk(root, 0)
  return { files, truncated, totalBytes }
}

// ───────────────── 主流程 ─────────────────

export interface ResolveResult {
  files: Map<string, FileNode>
  edges: DependencyEdge[]
  peResults: PeResult[]
  stats: {
    parsedOk: number
    parseFailed: number
    missing: number
    truncated: boolean
    totalBytes: number
  }
}

export interface ResolveOptions {
  /** 依赖递归深度：1 = 仅主程序直接依赖，2 = 再解析一层（T3） */
  maxDepth?: number
  /** 已知的全局引用计数（来自数据库） */
  refCounts?: Map<string, number>
  onProgress?: (phase: string, percent: number, current: string) => void
  signal?: { cancelled: boolean }
  /** 是否启用 E6 / E7（需要额外注册表与 lnk 扫描，首次较慢） */
  enableComEvidence?: boolean
  enableShortcutEvidence?: boolean
}

export async function resolveDependencies(sw: SoftwareItem, opts: ResolveOptions = {}): Promise<ResolveResult> {
  const {
    maxDepth = 2,
    refCounts = new Map(),
    onProgress,
    signal,
    enableComEvidence = true,
    enableShortcutEvidence = true
  } = opts

  const collector = new EvidenceCollector()
  const peResults: PeResult[] = []
  let parsedOk = 0
  let parseFailed = 0

  onProgress?.('解析主程序', 5, sw.mainExe)

  // ── 阶段一：主程序 PE 解析 ──
  const known = await loadKnownDlls()
  const pathDirs = buildPathDirs()
  let mainPe: PeResult | null = null
  if (sw.mainExe) {
    mainPe = await parsePe(sw.mainExe)
    peResults.push(mainPe)
    if (mainPe.parseStatus === 'ok') parsedOk++
    else parseFailed++
  }
  const arch: PeArch = mainPe?.arch && mainPe.arch !== 'unknown' ? mainPe.arch : sw.arch || 'x64'

  // ── 阶段二：目录快照（证据 E1） ──
  onProgress?.('枚举安装目录', 18, sw.installPath)
  const snap = sw.installPath ? await snapshotInstallDir(sw.installPath) : { files: [], truncated: false, totalBytes: 0 }
  const dirFileByName = new Map<string, string>()
  for (const f of snap.files) {
    const bn = baseName(f.path).toLowerCase()
    if (!dirFileByName.has(bn)) dirFileByName.set(bn, f.path)
    // 目录归属：安装目录内的每个关注文件都建立 E1 证据
    collector.add(f.path, baseName(f.path), 'E1', 'binds')
  }

  const extraDirs = [
    ...new Set(
      snap.files
        .map((f) => f.path.slice(0, f.path.lastIndexOf('\\')))
        .filter((d) => d && d !== sw.installPath)
        .slice(0, 60)
    )
  ]

  const ctx: ResolveContext = {
    appDir: sw.mainExe ? sw.mainExe.slice(0, sw.mainExe.lastIndexOf('\\')) : sw.installPath,
    arch,
    pathDirs,
    known,
    extraDirs
  }

  // ── 阶段三：静态解析（E2 / E3 / E4 / E5） ──
  const queue: { pe: PeResult; depth: number }[] = mainPe ? [{ pe: mainPe, depth: 1 }] : []
  const parsedPaths = new Set<string>(mainPe ? [normKey(mainPe.path)] : [])
  let processed = 0

  while (queue.length) {
    if (signal?.cancelled) break
    const { pe, depth } = queue.shift()!
    processed++
    onProgress?.('解析依赖', 20 + Math.min(processed, 60), baseName(pe.path))

    const nextLevel: string[] = []

    const handle = (dll: string, evidence: EvidenceCode, type: DependencyType): void => {
      const r: ResolvedDll = resolveDll(dll, ctx)
      if (r.kind === 'apiset') {
        // API Set 未映射成功：标记为虚拟，不产生噪声节点
        collector.add('apiset:' + r.requested.toLowerCase(), r.requested, evidence, type, {
          virtual: true,
          missing: false,
          requestedAs: dll
        })
        return
      }
      if (r.kind === 'missing') {
        collector.add('missing:' + r.resolvedName.toLowerCase(), r.resolvedName, evidence, type, {
          missing: true,
          requestedAs: dll
        })
        return
      }
      collector.add(r.fullPath, baseName(r.fullPath), evidence, type, {
        virtual: r.virtual,
        requestedAs: dll
      })
      if (depth < maxDepth) nextLevel.push(r.fullPath)
    }

    for (const d of pe.imports) handle(d, 'E2', 'imports')
    for (const d of pe.delayImports) handle(d, 'E3', 'delay_loads')

    // E4：.NET 程序集引用 —— 候选字符串按「磁盘上是否存在同名程序集」过滤
    if (pe.isDotNet && pe.assemblyRefs.length) {
      const runtimeDirs = dotnetRuntimeDirs()
      let hits = 0
      for (const nm of pe.assemblyRefs) {
        if (hits > 120) break
        const dllName = nm.endsWith('.dll') ? nm : nm + '.dll'
        const local = dirFileByName.get(dllName.toLowerCase())
        if (local) {
          collector.add(local, baseName(local), 'E4', 'dotnet_ref', { requestedAs: nm })
          hits++
          if (depth < maxDepth) nextLevel.push(local)
          continue
        }
        let found = ''
        for (const rd of runtimeDirs) {
          const p = join(rd, dllName)
          try {
            await fs.access(p)
            found = p
            break
          } catch {
            /* 继续 */
          }
        }
        if (found) {
          collector.add(found, baseName(found), 'E4', 'dotnet_ref', { requestedAs: nm })
          hits++
        }
      }
    }

    // E5：SxS 并行程序集清单 → WinSxS 重定向
    for (const asmName of pe.sxsDependencies) {
      const hit = await resolveSxsAssembly(asmName, arch)
      if (hit) {
        for (const f of hit.files.slice(0, 20)) {
          collector.add(f, baseName(f), 'E5', 'sxs', { requestedAs: asmName })
        }
      } else {
        collector.add('missing:sxs:' + asmName.toLowerCase(), asmName, 'E5', 'sxs', {
          missing: true,
          requestedAs: asmName
        })
      }
    }

    // 递归解析下一层（限量，避免图谱爆炸）
    if (depth < maxDepth) {
      let added = 0
      for (const p of nextLevel) {
        if (added >= 40) break
        const k = normKey(p)
        if (parsedPaths.has(k)) continue
        // 只递归软件自身目录内的模块；系统 DLL 的依赖归入系统聚合组，不再展开
        if (sw.installPath && !isSubPath(p, sw.installPath)) continue
        parsedPaths.add(k)
        const sub = await parsePe(p, { resources: false, dotnet: true })
        peResults.push(sub)
        if (sub.parseStatus === 'ok') parsedOk++
        else parseFailed++
        queue.push({ pe: sub, depth: depth + 1 })
        added++
      }
    }
  }

  // ── E6：COM 与服务注册反查 ──
  if (enableComEvidence && !signal?.cancelled) {
    onProgress?.('COM 注册反查', 84, '')
    try {
      const idx = await loadComIndex()
      for (const f of snap.files) {
        const ext = extName(f.path)
        if (ext !== 'dll' && ext !== 'ocx' && ext !== 'exe') continue
        if (idx.has(normKey(f.path))) collector.add(f.path, baseName(f.path), 'E6', 'com')
      }
    } catch {
      /* 忽略 */
    }
  }

  // ── E7：快捷方式关联 ──
  if (enableShortcutEvidence && !signal?.cancelled) {
    onProgress?.('快捷方式关联', 90, '')
    try {
      const idx = await loadLnkIndex()
      for (const [target, lnks] of idx) {
        if (!sw.installPath || !isSubPath(target, sw.installPath)) continue
        for (const l of lnks.slice(0, 3)) collector.add(l, baseName(l), 'E7', 'shortcut')
      }
    } catch {
      /* 忽略 */
    }
  }

  // ── 阶段四：证据融合 → 置信度打分 ──
  onProgress?.('证据融合与打分', 94, '')
  const files = new Map<string, FileNode>()
  const edges: DependencyEdge[] = []
  let missingCount = 0

  const snapMeta = new Map(snap.files.map((f) => [normKey(f.path), f]))
  const peByPath = new Map(peResults.map((p) => [normKey(p.path), p]))

  for (const bag of collector.values()) {
    // API Set 虚拟节点不进图谱（设计意图：避免数十个无法定位的噪声节点）
    if (bag.virtual && bag.path.startsWith('apiset:')) continue

    const isMissing = bag.missing
    const fullPath = isMissing ? '' : bag.path
    const nodeKey = isMissing ? bag.path : fullPath
    const id = fileId(nodeKey)

    const evidence = [...bag.evidence]
    const meta = fullPath ? snapMeta.get(normKey(fullPath)) : undefined
    let size = meta?.size ?? 0
    let mtime = meta?.mtime ?? 0
    if (fullPath && !meta) {
      try {
        const st = await fs.stat(fullPath)
        size = st.size
        mtime = st.mtimeMs
      } catch {
        /* 已在别处判定存在，取不到属性不致命 */
      }
    }

    const name = bag.name
    const dbRef = refCounts.get(normKey(nodeKey)) ?? 0
    const refCount = Math.max(dbRef, baselineRefCount(fullPath || name, name))
    const confidence = isMissing ? 0.99 : scoreConfidence(evidence, refCount)
    const pe = fullPath ? peByPath.get(normKey(fullPath)) : undefined

    if (isMissing) missingCount++

    files.set(id, {
      id,
      fullPath: fullPath || `（未找到）${name}`,
      name,
      sizeBytes: size,
      mtime,
      kind: isMissing ? 'dll' : classifyKind(fullPath || name),
      ext: extName(fullPath || name),
      arch: pe?.arch,
      version: pe?.fileVersion,
      missing: isMissing,
      refCount,
      parseStatus: pe?.parseStatus
    })

    edges.push({
      sourceId: sw.id,
      targetId: id,
      type: pickType(bag.types, bag.evidence),
      confidence,
      evidence
    })
  }

  return {
    files,
    edges,
    peResults,
    stats: {
      parsedOk,
      parseFailed,
      missing: missingCount,
      truncated: snap.truncated,
      totalBytes: snap.totalBytes || sw.sizeBytes
    }
  }
}

/** .NET 运行时目录（用于 E4 程序集定位） */
let dotnetDirsCache: string[] | null = null

function dotnetRuntimeDirs(): string[] {
  if (dotnetDirsCache) return dotnetDirsCache
  const out: string[] = []
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const fx = join(sysRoot, 'Microsoft.NET', 'Framework64')
  const fx86 = join(sysRoot, 'Microsoft.NET', 'Framework')
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const coreRoot = join(pf, 'dotnet', 'shared', 'Microsoft.NETCore.App')
  const wpfRoot = join(pf, 'dotnet', 'shared', 'Microsoft.WindowsDesktop.App')
  const { readdirSync, existsSync } = require('node:fs') as typeof import('node:fs')

  for (const base of [fx, fx86]) {
    try {
      if (!existsSync(base)) continue
      const vers = readdirSync(base).filter((v) => /^v\d/.test(v)).sort().reverse()
      for (const v of vers.slice(0, 3)) out.push(join(base, v))
    } catch {
      /* ignore */
    }
  }
  for (const base of [coreRoot, wpfRoot]) {
    try {
      if (!existsSync(base)) continue
      const vers = readdirSync(base).sort().reverse()
      for (const v of vers.slice(0, 2)) out.push(join(base, v))
    } catch {
      /* ignore */
    }
  }
  const gac = join(sysRoot, 'assembly', 'GAC_MSIL')
  if (existsSync(gac)) out.push(gac)
  dotnetDirsCache = out
  return out
}
