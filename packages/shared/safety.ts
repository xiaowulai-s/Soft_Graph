/**
 * 删除安全（最高优先级）——对应技术设计方案 9.1
 *
 * 设计要点：
 *  1. 白名单规则在此模块硬编码，不从配置文件读取，因此篡改 settings.json 无法绕过；
 *  2. 拦截判定基于「规范化后的真实路径」，调用方必须先做 realpath 解析（防 junction 逃逸）；
 *  3. 拦截分两档：PROTECTED_ROOTS（整个目录树禁删）与 PROTECTED_EXACT（该目录本身禁删但内部可清）。
 */

import { isSubPath, normKey, baseName } from './util'

const env = (k: string): string => (typeof process !== 'undefined' ? process.env[k] || '' : '')

function sysDrive(): string {
  return env('SystemDrive') || 'C:'
}

/** 整棵树禁止删除的根目录 */
function protectedRoots(): string[] {
  const w = env('SystemRoot') || `${sysDrive()}\\Windows`
  return [
    w + '\\System32',
    w + '\\SysWOW64',
    w + '\\SysArm32',
    w + '\\WinSxS',
    w + '\\assembly',
    w + '\\Microsoft.NET',
    w + '\\Fonts',
    w + '\\Boot',
    w + '\\servicing',
    w + '\\security',
    w + '\\INF',
    w + '\\PolicyDefinitions',
    env('ProgramFiles') || `${sysDrive()}\\Program Files`,
    env('ProgramFiles(x86)') || `${sysDrive()}\\Program Files (x86)`,
    env('ProgramW6432') || `${sysDrive()}\\Program Files`,
    `${sysDrive()}\\ProgramData\\Microsoft\\Windows`,
    `${sysDrive()}\\Users\\Default`,
    `${sysDrive()}\\Users\\Public`,
    `${sysDrive()}\\Recovery`,
    `${sysDrive()}\\System Volume Information`,
    `${sysDrive()}\\PerfLogs`,
    `${sysDrive()}\\EFI`
  ].filter(Boolean)
}

/** 这些目录自身禁止删除（内部内容按规则可清理） */
function protectedExact(): string[] {
  const up = env('USERPROFILE') || ''
  const w = env('SystemRoot') || `${sysDrive()}\\Windows`
  const list = [
    w,
    sysDrive() + '\\',
    env('LOCALAPPDATA'),
    env('APPDATA'),
    env('TEMP'),
    env('TMP'),
    env('ProgramData'),
    `${sysDrive()}\\Users`,
    w + '\\Temp',
    w + '\\Installer',
    w + '\\SoftwareDistribution',
    w + '\\SoftwareDistribution\\Download',
    w + '\\Logs',
    w + '\\Prefetch'
  ]
  if (up) {
    list.push(
      up,
      up + '\\Desktop',
      up + '\\Documents',
      up + '\\Downloads',
      up + '\\Pictures',
      up + '\\Videos',
      up + '\\Music',
      up + '\\Favorites',
      up + '\\Links',
      up + '\\Contacts',
      up + '\\OneDrive',
      up + '\\Saved Games',
      up + '\\Searches'
    )
  }
  return list.filter(Boolean) as string[]
}

let _roots: string[] | null = null
let _exact: Set<string> | null = null

function roots(): string[] {
  if (!_roots) _roots = protectedRoots().map(normKey)
  return _roots
}
function exact(): Set<string> {
  if (!_exact) _exact = new Set(protectedExact().map(normKey))
  return _exact
}

/** 卷根：C:\ D:\ 等，任何情况下不可删除 */
const VOLUME_ROOT_RE = /^[a-z]:\\?$/i

/** 绝不可删除的文件名（即便落在可清理目录里） */
const CRITICAL_NAMES = new Set(
  [
    'ntldr',
    'bootmgr',
    'boot.ini',
    'ntdetect.com',
    'pagefile.sys',
    'swapfile.sys',
    'hiberfil.sys',
    'bcd',
    'desktop.ini',
    'ntuser.dat',
    'sam',
    'system',
    'software',
    'security',
    'default'
  ].map((s) => s.toLowerCase())
)

export interface GuardVerdict {
  allowed: boolean
  reason?: string
}

/**
 * 白名单硬拦截判定。
 * @param realPath 已经过 realpath 解析的绝对路径（调用方保证）
 */
export function guardPath(realPath: string): GuardVerdict {
  const p = normKey(realPath)

  if (!p) return { allowed: false, reason: '路径为空' }
  if (!/^[a-z]:\\/i.test(p) && !p.startsWith('\\\\'))
    return { allowed: false, reason: '非法路径格式（必须为绝对路径）' }
  if (p.startsWith('\\\\')) return { allowed: false, reason: '拒绝操作 UNC / 网络路径' }
  if (VOLUME_ROOT_RE.test(p)) return { allowed: false, reason: '卷根目录禁止删除' }
  if (p.includes('..')) return { allowed: false, reason: '路径包含相对跳转，已拦截' }

  if (exact().has(p)) return { allowed: false, reason: `系统/用户关键目录本身禁止删除：${realPath}` }

  for (const r of roots()) {
    if (isSubPath(p, r)) {
      // WinSxS / System32 等整棵树禁删
      return { allowed: false, reason: `位于受保护目录树内：${r}` }
    }
  }

  // Windows 目录的收紧判定（C3 路径健壮性 · BUG-19 的普通通道版本）：
  // GC-05 需要清理 Windows\Temp 等明确缓存目录，因此不能把整棵 C:\Windows
  // 列为受保护树 —— 但这也意味着 Windows 根目录的直接子项
  // （如 C:\Windows\notepad.exe.bak、C:\Windows\中 文\x.tmp）能滑过前面的检查。
  // 修复：Windows 子树内只允许 CLEANABLE_EXCEPTIONS 明确列出的缓存目录，
  // 其余一律拦截，防止规则污染或程序缺陷把系统文件带进删除清单。
  const windir = (env('SystemRoot') || `${sysDrive()}\\Windows`).toLowerCase().replace(/\\+$/, '')
  if (isSubPath(p, windir) && !CLEANABLE_EXCEPTIONS().some((r) => isSubPath(p, r))) {
    return { allowed: false, reason: 'Windows 目录下仅允许清理明确列出的缓存目录（Temp/Logs/Installer 等）' }
  }

  const name = baseName(p)
  if (CRITICAL_NAMES.has(name)) return { allowed: false, reason: `系统关键文件禁止删除：${name}` }

  // Windows.old / $WINDOWS.~BT 允许（GC-06），但必须是该目录本身或其子项
  return { allowed: true }
}

/**
 * 供垃圾扫描阶段使用的软判定：命中则该路径不纳入结果，避免用户看到根本删不了的项。
 * 与 guardPath 共用规则，但对 GC-05/06 这类「文档明确允许清理」的中风险目录放行。
 */
const CLEANABLE_EXCEPTIONS = (): string[] => {
  const w = env('SystemRoot') || `${sysDrive()}\\Windows`
  return [
    w + '\\Temp',
    w + '\\SoftwareDistribution\\Download',
    w + '\\Installer',
    w + '\\Logs',
    w + '\\Prefetch',
    w + '\\Minidump',
    `${sysDrive()}\\Windows.old`,
    `${sysDrive()}\\$WINDOWS.~BT`,
    `${sysDrive()}\\$WINDOWS.~WS`
  ].map(normKey)
}

let _exceptions: string[] | null = null

export function isScannable(path: string): boolean {
  const p = normKey(path)
  if (!_exceptions) _exceptions = CLEANABLE_EXCEPTIONS()
  for (const ex of _exceptions) if (isSubPath(p, ex)) return true
  return guardPath(path).allowed
}

/** 遍历时应跳过的目录名（性能 + 安全） */
export const SKIP_DIR_NAMES = new Set(
  [
    'System Volume Information',
    '$Recycle.Bin',
    'WinSxS',
    'servicing',
    'assembly',
    'DriverStore',
    'node_modules/.cache'
  ].map((s) => s.toLowerCase())
)

/**
 * 一键删除安全边界（见 8.3）：
 * 只作用于「低风险且默认勾选」的分类，中高风险即使被手动勾选也排除在外。
 * 这条规则不可通过设置关闭 —— 因此实现为纯函数，不读配置。
 */
export function isOneClickEligible(risk: string, defaultSelected: boolean): boolean {
  return risk === 'low' && defaultSelected === true
}
