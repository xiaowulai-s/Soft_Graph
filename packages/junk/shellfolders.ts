/**
 * 用户库目录（Shell Folders）解析
 * ============================================================
 * 为什么需要它：
 *   垃圾规则里若把用户库目录写成 `%USERPROFILE%\Documents`，在很多机器上会全部落空：
 *     · 中文 Windows 上真实目录是 `文档` / `图片` / `桌面`
 *     · 用户手动把库目录重定向到了其它盘（实测某机全部指向 D:\文档、D:\图片…）
 *     · OneDrive 接管了「文档/桌面/图片」
 *   一旦落空，GC-11（重复文件）与 GC-12（超大文件）会静默失效 —— 用户以为扫过了，
 *   其实一个真实数据目录都没进。因此这里从注册表读取权威路径。
 *
 * 数据源：HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders
 *   该表只存「原始值」并可能含 %USERPROFILE% 之类的环境变量，因此需要展开。
 *
 * 失败时返回 null，由调用方回退到基于同义名的猜测（见 engine.ts 的 resolveShellFolder）。
 */

import { existsSync } from 'node:fs'

export type ShellFolderKey =
  | 'documents'
  | 'pictures'
  | 'desktop'
  | 'downloads'
  | 'videos'
  | 'music'
  | 'favorites'

export type ShellFolderMap = Partial<Record<ShellFolderKey, string>>

/** 注册表 Windows 已知文件夹 GUID（Downloads 没有英文名，只有 GUID） */
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}'

const SCRIPT = String.raw`
$keys = @{
  documents = @('Personal')
  pictures  = @('My Pictures')
  desktop   = @('Desktop')
  videos    = @('My Video')
  music     = @('My Music')
  favorites = @('Favorites')
  downloads = @('${DOWNLOADS_GUID}')
}
$out = @{}
$root = $null
try {
  $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders')
} catch { }
if ($null -ne $root) {
  foreach ($k in $keys.Keys) {
    foreach ($name in $keys[$k]) {
      $v = [string]$root.GetValue($name)
      if (-not [string]::IsNullOrWhiteSpace($v)) {
        $out[$k] = [Environment]::ExpandEnvironmentVariables($v)
        break
      }
    }
  }
  $root.Close()
}
# 注册表缺失时退化为 Shell API（体积更小但同样权威）
foreach ($pair in @(@('documents','MyDocuments'), @('pictures','MyPictures'), @('desktop','Desktop'), @('videos','MyVideos'), @('music','MyMusic'), @('favorites','Favorites'))) {
  if (-not $out.ContainsKey($pair[0])) {
    $p = [Environment]::GetFolderPath($pair[1])
    if (-not [string]::IsNullOrWhiteSpace($p)) { $out[$pair[0]] = $p }
  }
}
Write-SgJson $out
`

/**
 * 解析用户库目录的真实路径。
 * @returns 解析成功的映射；完全失败时返回 null
 */
export async function resolveUserShellFolders(timeoutMs = 15_000): Promise<ShellFolderMap | null> {
  try {
    const { psJson } = await import('../scanner/psbridge')
    const raw = await psJson<Record<string, string>>(SCRIPT, { timeoutMs })
    if (!raw || typeof raw !== 'object') return null

    const map: ShellFolderMap = {}
    for (const key of ['documents', 'pictures', 'desktop', 'downloads', 'videos', 'music', 'favorites'] as ShellFolderKey[]) {
      const v = raw[key]
      if (typeof v === 'string' && /^[A-Za-z]:\\/.test(v)) map[key] = v
    }
    return Object.keys(map).length > 0 ? map : null
  } catch {
    return null
  }
}

/** 过滤掉在磁盘上不存在的条目（避免把无效路径注入规则） */
export function pruneMissing(map: ShellFolderMap): ShellFolderMap {
  const out: ShellFolderMap = {}
  for (const [k, v] of Object.entries(map) as [ShellFolderKey, string][]) {
    if (v && existsSync(v)) out[k] = v
  }
  return out
}
