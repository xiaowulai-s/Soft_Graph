/**
 * v4.0 S1 自启动管理：类型与纯函数（解析命令行 exe、来源分组）
 *
 * v1 范围（对齐 fancyStart）：注册表 Run/RunOnce（HKCU/HKLM）+ 启动文件夹（用户/所有用户）。
 * 计划任务/服务等深源列入后续（BootLens 风格）。
 */

export type StartupSource = 'HKCU:Run' | 'HKCU:RunOnce' | 'HKLM:Run' | 'HKLM:RunOnce' | 'StartupFolder:User' | 'StartupFolder:AllUsers'

export interface StartupEntry {
  id: string
  source: StartupSource
  /** 显示名（Run=值名，文件夹=文件名去扩展名） */
  name: string
  /** 完整命令（Run=值数据，文件夹=lnk 目标或文件路径） */
  command: string
  /** 从命令解析出的可执行文件路径（可能为空） */
  exePath: string
  enabled: boolean
  signStatus: 'signed' | 'unsigned' | 'unknown'
  signer: string
  /** 目标可执行文件是否仍存在 */
  fileExists: boolean
  /** HKLM 等需要管理员权限才能改动的项 */
  needsElevation: boolean
}

export const STARTUP_SOURCES: readonly StartupSource[] = [
  'HKCU:Run', 'HKCU:RunOnce', 'HKLM:Run', 'HKLM:RunOnce', 'StartupFolder:User', 'StartupFolder:AllUsers'
]

export function startupId(source: StartupSource, name: string): string {
  return `${source}::${name}`
}

export function isHklm(source: StartupSource): boolean {
  return source.startsWith('HKLM:')
}

/**
 * 从启动命令解析可执行路径：
 *   "C:\Program Files\X\x.exe" --flag    → C:\Program Files\X\x.exe
 *   C:\Tools\x.exe /quiet                → C:\Tools\x.exe
 *   "C:\a b\x.exe"                       → C:\a b\x.exe
 *   rundll32.exe ...                     → 原样返回（系统程序，交由调用方处理）
 */
export function extractExeFromCommand(cmd: string): string {
  const t = (cmd ?? '').trim()
  if (!t) return ''
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1)
    return end > 1 ? t.slice(1, end) : t.slice(1)
  }
  // 裸路径：取到第一个「空格 + -」或结尾（简单启发：空格后是 - 开头的参数则截断）
  const m = /^(\S+?\.exe)(\s|$)/i.exec(t)
  if (m) return m[1]
  const firstSpace = t.indexOf(' ')
  return firstSpace > 0 ? t.slice(0, firstSpace) : t
}

/** 启动文件夹文件名 → 显示名（去扩展名、去 [Disabled] 前缀） */
export function startupFolderName(fileName: string): { name: string; disabled: boolean } {
  let f = fileName
  let disabled = false
  if (f.startsWith('[Disabled] ')) {
    disabled = true
    f = f.slice('[Disabled] '.length)
  }
  return { name: f.replace(/\.(lnk|url|bat|cmd|exe)$/i, ''), disabled }
}
