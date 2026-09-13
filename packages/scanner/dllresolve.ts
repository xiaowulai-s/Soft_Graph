/**
 * DLL 搜索路径解析 + Windows 三大特殊机制处理
 * 对应技术设计方案 5.2.3 / 5.2.4
 *
 * API Set（v2.0.0 M2/B5 更新）：
 *   原实现为「静态前缀映射表」（纯 Node 无法访问 PEB ApiSetMap）。
 *   现改为**动态解析**：apiset.ts 用 Windows 加载器
 *   （LoadLibraryW + GetModuleFileNameW）探测每个 API set 的真实宿主，
 *   结果缓存 30 天。实测动态表与静态表有 30 条冲突（静态表会猜错宿主），
 *   因此动态映射优先，静态表仅作未加载时的兜底。
 */

import { existsSync } from 'node:fs'
import { apiSetMapSync } from './apiset'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { normKey, normPath, baseName } from '../shared/util'
import type { PeArch } from '../shared/types'

const env = (k: string): string => process.env[k] || ''

const SYSROOT = env('SystemRoot') || 'C:\\Windows'
const SYSTEM32 = join(SYSROOT, 'System32')
const SYSWOW64 = join(SYSROOT, 'SysWOW64')
const SYSTEM16 = join(SYSROOT, 'System')
const WINSXS = join(SYSROOT, 'WinSxS')

// ───────────────── API Set 静态映射（5.2.3） ─────────────────

/**
 * api-ms-win-<族>-<组件>-l<x>-<y>-<z>.dll → 真实宿主 DLL
 * 按族群前缀匹配，长前缀优先。
 */
const API_SET_PREFIX_MAP: [string, string][] = [
  ['api-ms-win-crt-', 'ucrtbase.dll'],
  ['api-ms-win-core-winrt', 'combase.dll'],
  ['api-ms-win-core-com', 'combase.dll'],
  ['api-ms-win-core-synch', 'kernelbase.dll'],
  ['api-ms-win-core-fibers', 'kernelbase.dll'],
  ['api-ms-win-core-localization', 'kernelbase.dll'],
  ['api-ms-win-core-path', 'kernelbase.dll'],
  ['api-ms-win-core-file', 'kernelbase.dll'],
  ['api-ms-win-core-processthreads', 'kernelbase.dll'],
  ['api-ms-win-core-heap', 'kernelbase.dll'],
  ['api-ms-win-core-memory', 'kernelbase.dll'],
  ['api-ms-win-core-registry', 'kernelbase.dll'],
  ['api-ms-win-core-string', 'kernelbase.dll'],
  ['api-ms-win-core-sysinfo', 'kernelbase.dll'],
  ['api-ms-win-core-libraryloader', 'kernelbase.dll'],
  ['api-ms-win-core-errorhandling', 'kernelbase.dll'],
  ['api-ms-win-core-handle', 'kernelbase.dll'],
  ['api-ms-win-core-console', 'kernelbase.dll'],
  ['api-ms-win-core-datetime', 'kernelbase.dll'],
  ['api-ms-win-core-debug', 'kernelbase.dll'],
  ['api-ms-win-core-interlocked', 'kernelbase.dll'],
  ['api-ms-win-core-namedpipe', 'kernelbase.dll'],
  ['api-ms-win-core-profile', 'kernelbase.dll'],
  ['api-ms-win-core-rtlsupport', 'ntdll.dll'],
  ['api-ms-win-core-util', 'kernelbase.dll'],
  ['api-ms-win-core-', 'kernelbase.dll'],
  ['api-ms-win-security-cryptoapi', 'cryptsp.dll'],
  ['api-ms-win-security-', 'sechost.dll'],
  ['api-ms-win-service-', 'sechost.dll'],
  ['api-ms-win-eventing-', 'sechost.dll'],
  ['api-ms-win-downlevel-kernel32', 'kernelbase.dll'],
  ['api-ms-win-downlevel-advapi32', 'sechost.dll'],
  ['api-ms-win-downlevel-ole32', 'combase.dll'],
  ['api-ms-win-downlevel-shlwapi', 'shlwapi.dll'],
  ['api-ms-win-downlevel-user32', 'user32.dll'],
  ['api-ms-win-downlevel-', 'kernelbase.dll'],
  ['api-ms-win-appmodel-', 'kernel.appcore.dll'],
  ['api-ms-win-shcore-', 'shcore.dll'],
  ['api-ms-win-gdi-', 'gdi32full.dll'],
  ['api-ms-win-ntuser-', 'win32u.dll'],
  ['api-ms-win-dx-', 'd3d11.dll'],
  ['api-ms-win-', 'kernelbase.dll'],
  ['ext-ms-win-', 'kernelbase.dll']
]

export function isApiSetName(dll: string): boolean {
  const n = dll.toLowerCase()
  return n.startsWith('api-ms-win-') || n.startsWith('ext-ms-win-')
}

/**
 * API Set 解析（v2.0.0 M2/B5）。
 *
 * 优先级：
 *   1. **动态映射**（apiset.ts 用加载器探测出的权威结果）—— 覆盖系统实际存在的
 *      全部 API set，且不会像静态前缀表那样猜错宿主（实测两者有 30 条冲突）
 *   2. 静态前缀表兜底 —— 动态映射尚未加载时使用（例如 CLU 工具链、单测）
 */
export function mapApiSet(dll: string): string | null {
  const n = dll.toLowerCase()
  if (!isApiSetName(n)) return null
  const dyn = apiSetMapSync()
  if (dyn) {
    const hit = dyn.get(n)
    if (hit) return hit
  }
  let best: string | null = null
  let bestLen = -1
  for (const [prefix, host] of API_SET_PREFIX_MAP) {
    if (n.startsWith(prefix) && prefix.length > bestLen) {
      best = host
      bestLen = prefix.length
    }
  }
  return best
}

// ───────────────── KnownDLLs（5.2.3） ─────────────────

let knownDlls: Set<string> | null = null

/**
 * 读取 HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs
 * 登记项直接解析到 System32，不参与常规搜索顺序。
 */
export async function loadKnownDlls(): Promise<Set<string>> {
  if (knownDlls) return knownDlls
  const set = new Set<string>()
  try {
    // 用 PowerShell 读取注册表（与软件枚举同一通道），不依赖被安全策略拦截的 reg.exe
    const { psJson, asArray } = await import('./psbridge')
    const rows = asArray(
      await psJson<{ name: string; value: string }[]>(
        String.raw`
$out = New-Object System.Collections.ArrayList
$k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs')
if ($null -ne $k) {
  foreach ($n in $k.GetValueNames()) {
    $v = [string]$k.GetValue($n)
    [void]$out.Add([pscustomobject]@{ name = $n; value = $v })
  }
  $k.Close()
}
Write-SgJson @($out)
`,
        { timeoutMs: 30_000 }
      )
    )
    for (const r of rows) {
      // 注册表值名通常是文件名（ntdll），值可能是路径；优先取值命中 .dll 的那一个
      const cand = r?.value && /\.dll$/i.test(r.value) ? r.value : r?.name
      if (cand && /\.dll$/i.test(cand)) set.add(cand.toLowerCase())
    }
  } catch {
    /* 读不到就走常规搜索顺序，不影响正确性 */
  }
  // 兜底：这些在所有 Windows 版本上都是 KnownDLL
  for (const d of [
    'kernel32.dll',
    'kernelbase.dll',
    'user32.dll',
    'gdi32.dll',
    'advapi32.dll',
    'ole32.dll',
    'oleaut32.dll',
    'shell32.dll',
    'shlwapi.dll',
    'ws2_32.dll',
    'rpcrt4.dll',
    'sechost.dll',
    'combase.dll',
    'msvcrt.dll',
    'imagehlp.dll',
    'psapi.dll',
    'setupapi.dll',
    'difxapi.dll',
    'comdlg32.dll',
    'clbcatq.dll',
    'coml2.dll',
    'normaliz.dll',
    'nsi.dll',
    'wldp.dll'
  ])
    set.add(d)
  knownDlls = set
  return set
}

// ───────────────── WinSxS 索引（5.2.3） ─────────────────

let sxsIndex: Map<string, string[]> | null = null

/**
 * 建立 WinSxS 目录索引：assemblyName（小写去版本）→ 该目录下的文件列表。
 * VC++ 运行库等通过清单声明依赖，实际文件位于 WinSxS\<版本哈希> 目录。
 */
export async function loadSxsIndex(): Promise<Map<string, string[]>> {
  if (sxsIndex) return sxsIndex
  const idx = new Map<string, string[]>()
  try {
    const dirs = await fs.readdir(WINSXS, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      // 形如 amd64_microsoft.vc90.crt_1fc8b3b9a1e18e3b_9.0.30729.9635_none_08e61857a83bc251
      const parts = d.name.split('_')
      if (parts.length < 3) continue
      const name = parts[1]
      if (!name) continue
      const key = name.toLowerCase()
      const arr = idx.get(key) || []
      arr.push(join(WINSXS, d.name))
      idx.set(key, arr)
    }
  } catch {
    /* WinSxS 不可读（权限）→ SxS 依赖会标记为缺失并提示，符合设计 */
  }
  sxsIndex = idx
  return idx
}

/** 在 WinSxS 中定位 SxS 清单声明的程序集，返回其内部文件的绝对路径 */
export async function resolveSxsAssembly(
  assemblyName: string,
  arch: PeArch
): Promise<{ dir: string; files: string[] } | null> {
  const idx = await loadSxsIndex()
  const cands = idx.get(assemblyName.toLowerCase())
  if (!cands || cands.length === 0) return null
  const archTag = arch === 'x86' ? 'x86_' : arch === 'arm64' ? 'arm64_' : 'amd64_'
  const sorted = [...cands].sort((a, b) => {
    const an = baseName(a).toLowerCase()
    const bn = baseName(b).toLowerCase()
    const aHit = an.startsWith(archTag) ? 0 : 1
    const bHit = bn.startsWith(archTag) ? 0 : 1
    if (aHit !== bHit) return aHit - bHit
    return bn.localeCompare(an) // 版本号大的在前
  })
  for (const dir of sorted) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const files = entries.filter((e) => e.isFile()).map((e) => join(dir, e.name))
      if (files.length) return { dir, files }
    } catch {
      continue
    }
  }
  return null
}

// ───────────────── DLL 搜索路径解析（5.2.4） ─────────────────

export interface ResolveContext {
  /** EXE 所在目录 */
  appDir: string
  /** 目标程序位数：决定 System32 / SysWOW64 的选择（WOW64 重定向） */
  arch: PeArch
  /** PATH 环境变量拆分后的目录列表 */
  pathDirs: string[]
  known: Set<string>
  /** 额外搜索目录（如软件安装根目录下的子目录） */
  extraDirs?: string[]
}

const existsCache = new Map<string, boolean>()

function fileExists(p: string): boolean {
  const k = normKey(p)
  const hit = existsCache.get(k)
  if (hit !== undefined) return hit
  let ok = false
  try {
    ok = existsSync(p)
  } catch {
    ok = false
  }
  if (existsCache.size < 200_000) existsCache.set(k, ok)
  return ok
}

export function buildPathDirs(): string[] {
  return env('PATH')
    .split(';')
    .map((s) => normPath(s))
    .filter((s) => s.length > 2)
}

export type ResolveKind = 'known' | 'app' | 'system' | 'system16' | 'windows' | 'path' | 'extra' | 'apiset' | 'missing'

export interface ResolvedDll {
  /** 导入表里出现的原始名字 */
  requested: string
  /** 映射后的实际 DLL 名（API Set 还原后） */
  resolvedName: string
  /** 绝对路径；missing 时为空串 */
  fullPath: string
  kind: ResolveKind
  /** 是否为 API Set 虚拟 DLL */
  virtual: boolean
}

/**
 * 按 Windows 真实搜索顺序还原绝对路径（见 5.2.4）：
 *   KnownDLLs 登记项 → System32
 *   → 应用程序所在目录
 *   → System32（64 位程序）/ SysWOW64（32 位程序）
 *   → 16 位系统目录 System
 *   → Windows 目录
 *   → 当前工作目录（此处等同 appDir，跳过）
 *   → PATH 环境变量中的各目录
 */
export function resolveDll(requested: string, ctx: ResolveContext): ResolvedDll {
  const raw = requested.trim()
  let name = raw
  let virtual = false

  if (isApiSetName(raw)) {
    const host = mapApiSet(raw)
    virtual = true
    if (host) name = host
    else
      return { requested: raw, resolvedName: raw, fullPath: '', kind: 'apiset', virtual: true }
  }

  const lower = name.toLowerCase()
  // 系统目录按目标程序位数选择（WOW64 重定向，见 5.2.2 位数处理）
  const sysDir = ctx.arch === 'x86' ? SYSWOW64 : SYSTEM32

  // 1. KnownDLLs → 直接 System32（32 位程序取 SysWOW64 中的对应副本）
  if (ctx.known.has(lower)) {
    const p = join(sysDir, name)
    if (fileExists(p)) return { requested: raw, resolvedName: name, fullPath: p, kind: 'known', virtual }
    const p2 = join(SYSTEM32, name)
    if (fileExists(p2)) return { requested: raw, resolvedName: name, fullPath: p2, kind: 'known', virtual }
  }

  // 2. 应用程序所在目录
  const inApp = join(ctx.appDir, name)
  if (fileExists(inApp)) return { requested: raw, resolvedName: name, fullPath: inApp, kind: 'app', virtual }

  // 2.5 额外目录（软件自带的 bin/lib/plugins 等）
  for (const d of ctx.extraDirs || []) {
    const p = join(d, name)
    if (fileExists(p)) return { requested: raw, resolvedName: name, fullPath: p, kind: 'extra', virtual }
  }

  // 3. System32 / SysWOW64
  const inSys = join(sysDir, name)
  if (fileExists(inSys)) return { requested: raw, resolvedName: name, fullPath: inSys, kind: 'system', virtual }
  // 反向兜底：64 位程序也可能引用只存在于 SysWOW64 的组件
  const inSysAlt = join(ctx.arch === 'x86' ? SYSTEM32 : SYSWOW64, name)
  if (fileExists(inSysAlt))
    return { requested: raw, resolvedName: name, fullPath: inSysAlt, kind: 'system', virtual }

  // 4. 16 位系统目录
  const in16 = join(SYSTEM16, name)
  if (fileExists(in16)) return { requested: raw, resolvedName: name, fullPath: in16, kind: 'system16', virtual }

  // 5. Windows 目录
  const inWin = join(SYSROOT, name)
  if (fileExists(inWin)) return { requested: raw, resolvedName: name, fullPath: inWin, kind: 'windows', virtual }

  // 6. PATH
  for (const d of ctx.pathDirs) {
    const p = join(d, name)
    if (fileExists(p)) return { requested: raw, resolvedName: name, fullPath: p, kind: 'path', virtual }
  }

  // 全部命中失败 → 缺失依赖（FR-16：红色虚线 + 修复建议）
  return { requested: raw, resolvedName: name, fullPath: '', kind: 'missing', virtual }
}

/** 缺失依赖的修复建议（FR-16） */
export function repairHint(dllName: string): string {
  const n = dllName.toLowerCase()
  if (/^(msvcp|msvcr|vcruntime|concrt)\d*/.test(n) || n.startsWith('ucrtbase'))
    return '缺少 Microsoft Visual C++ 运行库，建议安装对应版本的 VC++ Redistributable'
  if (/^(mscoree|clr|coreclr|hostfxr|hostpolicy)/.test(n))
    return '缺少 .NET 运行时，建议安装对应版本的 .NET Runtime / Framework'
  if (n.startsWith('qt')) return '缺少 Qt 运行库，通常需与软件同目录分发，建议重新安装该软件'
  if (n.startsWith('python')) return '缺少 Python 运行库，建议安装对应版本的 Python 或修复该软件'
  if (/^d3d|^xinput|^openal|^x3daudio/.test(n)) return '缺少 DirectX / 音频运行库，建议安装 DirectX Runtime'
  if (n.startsWith('api-ms-win-')) return 'API Set 虚拟 DLL，由系统在加载时重定向，通常无需处理'
  return '该文件未在标准搜索路径中找到，可能导致软件无法启动；建议重新安装该软件'
}

export function resetResolveCache(): void {
  existsCache.clear()
  knownDlls = null
  sxsIndex = null
}
