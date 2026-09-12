/**
 * 已安装软件来源枚举
 * 对应技术设计方案 5.1.1（注册表卸载项 / MSI 产品 / App Paths / Microsoft Store / 服务与驱动）
 */

import { psJson, asArray } from './psbridge'

export interface RawUninstall {
  hive: string
  key: string
  DisplayName?: string
  DisplayVersion?: string
  Publisher?: string
  InstallLocation?: string
  DisplayIcon?: string
  UninstallString?: string
  EstimatedSize?: number
  InstallDate?: string
  SystemComponent?: number
  ParentKeyName?: string
  ReleaseType?: string
  WindowsInstaller?: number
}

export interface RawAppPath {
  exeName: string
  path: string
  pathDir?: string
}

export interface RawStoreApp {
  Name: string
  PackageFullName: string
  InstallLocation: string
  Version: string
  Publisher: string
  Logo?: string
}

export interface RawService {
  name: string
  displayName?: string
  imagePath: string
}

export interface RawMsiProduct {
  productCode: string
  name?: string
  version?: string
  publisher?: string
  installLocation?: string
  localPackage?: string
}

export interface EnumResult {
  uninstall: RawUninstall[]
  appPaths: RawAppPath[]
  store: RawStoreApp[]
  services: RawService[]
  msi: RawMsiProduct[]
  errors: string[]
}

/**
 * 五来源采集拆为两个脚本并行执行（v2.0.0 M1）：
 *   CORE —— 四个纯注册表来源（快，~2s）；STORE —— Get-AppxPackage（慢，独占 ~1s+）。
 * 两者通过会话池的两个常驻会话并行跑，墙钟时间从「串行相加」变「取最大值」。
 * （历史注：v1.0.0 合并为单次调用是为省 5 倍进程冷启动；会话池消除了冷启动后，
 *  单次调用的「串行相加」反而成了瓶颈，拆分并行是更优解。）
 */
const SCRIPT = String.raw`
$errors = New-Object System.Collections.ArrayList

# ── 1. 注册表卸载项（含 WOW6432Node，HKLM + HKCU） ──
$uninstallRoots = @(
  @{ Hive = 'HKLM'; Path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' },
  @{ Hive = 'HKLM'; Path = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' },
  @{ Hive = 'HKCU'; Path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' },
  @{ Hive = 'HKCU'; Path = 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' }
)
$uninstall = New-Object System.Collections.ArrayList
foreach ($r in $uninstallRoots) {
  try {
    $base = if ($r.Hive -eq 'HKLM') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
    $root = $base.OpenSubKey($r.Path)
    if ($null -eq $root) { continue }
    foreach ($sub in $root.GetSubKeyNames()) {
      try {
        $k = $root.OpenSubKey($sub)
        if ($null -eq $k) { continue }
        $dn = $k.GetValue('DisplayName')
        if ([string]::IsNullOrWhiteSpace($dn)) { continue }
        [void]$uninstall.Add([pscustomobject]@{
          hive            = $r.Hive
          key             = $sub
          DisplayName     = [string]$dn
          DisplayVersion  = [string]$k.GetValue('DisplayVersion')
          Publisher       = [string]$k.GetValue('Publisher')
          InstallLocation = [string]$k.GetValue('InstallLocation')
          DisplayIcon     = [string]$k.GetValue('DisplayIcon')
          UninstallString = [string]$k.GetValue('UninstallString')
          EstimatedSize   = [int]($k.GetValue('EstimatedSize', 0))
          InstallDate     = [string]$k.GetValue('InstallDate')
          SystemComponent = [int]($k.GetValue('SystemComponent', 0))
          ParentKeyName   = [string]$k.GetValue('ParentKeyName')
          ReleaseType     = [string]$k.GetValue('ReleaseType')
          WindowsInstaller= [int]($k.GetValue('WindowsInstaller', 0))
        })
        $k.Close()
      } catch { }
    }
    $root.Close()
  } catch { [void]$errors.Add("uninstall:$($r.Hive)\$($r.Path): $($_.Exception.Message)") }
}

# ── 2. App Paths（可获取未登记卸载项的程序） ──
$appPaths = New-Object System.Collections.ArrayList
foreach ($p in @('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths','SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
  try {
    $root = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($p)
    if ($null -eq $root) { continue }
    foreach ($sub in $root.GetSubKeyNames()) {
      try {
        $k = $root.OpenSubKey($sub)
        $v = $k.GetValue('')
        if ([string]::IsNullOrWhiteSpace($v)) { continue }
        [void]$appPaths.Add([pscustomobject]@{
          exeName = $sub
          path    = ([string]$v).Trim('"')
          pathDir = [string]$k.GetValue('Path')
        })
        $k.Close()
      } catch { }
    }
    $root.Close()
  } catch { [void]$errors.Add("appPaths:$p") }
}

# ── 3. MSI 产品（降级：读 Installer\Products 注册表，不依赖 MsiEnumProducts P/Invoke） ──
$msi = New-Object System.Collections.ArrayList
try {
  $root = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Classes\Installer\Products')
  if ($null -ne $root) {
    foreach ($sub in $root.GetSubKeyNames()) {
      try {
        $k = $root.OpenSubKey($sub)
        $n = $k.GetValue('ProductName')
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        [void]$msi.Add([pscustomobject]@{
          productCode  = $sub
          name         = [string]$n
          version      = [string]$k.GetValue('Version')
          publisher    = ''
          localPackage = [string]$k.GetValue('PackageName')
        })
        $k.Close()
      } catch { }
    }
    $root.Close()
  }
} catch { [void]$errors.Add('msi') }

# ── 4. 服务与驱动 ImagePath ──
$services = New-Object System.Collections.ArrayList
try {
  $root = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services')
  if ($null -ne $root) {
    foreach ($sub in $root.GetSubKeyNames()) {
      try {
        $k = $root.OpenSubKey($sub)
        $ip = [string]$k.GetValue('ImagePath')
        if ([string]::IsNullOrWhiteSpace($ip)) { continue }
        if ($ip -notmatch '\.exe') { continue }
        [void]$services.Add([pscustomobject]@{
          name        = $sub
          displayName = [string]$k.GetValue('DisplayName')
          imagePath   = $ip
        })
        $k.Close()
      } catch { }
    }
    $root.Close()
  }
} catch { [void]$errors.Add('services') }

Write-SgJson ([pscustomobject]@{
  uninstall = @($uninstall)
  appPaths  = @($appPaths)
  services  = @($services)
  msi       = @($msi)
  errors    = @($errors)
})
`

const STORE_SCRIPT = String.raw`
$errors = New-Object System.Collections.ArrayList
$store = New-Object System.Collections.ArrayList
try {
  $pkgs = Get-AppxPackage -ErrorAction SilentlyContinue
  foreach ($p in $pkgs) {
    if ($p.IsFramework) { continue }
    if ([string]::IsNullOrWhiteSpace($p.InstallLocation)) { continue }
    [void]$store.Add([pscustomobject]@{
      Name            = [string]$p.Name
      PackageFullName = [string]$p.PackageFullName
      InstallLocation = [string]$p.InstallLocation
      Version         = [string]$p.Version
      Publisher       = [string]$p.Publisher
    })
  }
} catch { [void]$errors.Add('store') }

Write-SgJson ([pscustomobject]@{ store = @($store); errors = @($errors) })
`

export async function enumerateWindows(): Promise<EnumResult> {
  const [core, store] = await Promise.all([
    psJson<Partial<EnumResult>>(SCRIPT, { timeoutMs: 180_000 }),
    psJson<{ store?: RawStoreApp[]; errors?: string[] }>(STORE_SCRIPT, { timeoutMs: 120_000 })
  ])
  return {
    uninstall: asArray(core?.uninstall),
    appPaths: asArray(core?.appPaths),
    store: asArray(store?.store),
    services: asArray(core?.services),
    msi: asArray(core?.msi),
    errors: [...asArray(core?.errors), ...asArray(store?.errors)]
  }
}

/**
 * 批量图标提取（对应 5.1.3）
 * 优先级：DisplayIcon 指定资源 → 主 exe 内嵌图标 → 目录内同名 .ico → Shell 默认图标
 * 由 PowerShell + System.Drawing 完成，取 32/48/256 三档中可得的最大尺寸并落盘 PNG。
 */
export interface IconRequest {
  hash: string
  /** 候选来源，按优先级尝试 */
  sources: string[]
}

const ICON_SCRIPT = String.raw`
Add-Type -AssemblyName System.Drawing | Out-Null
$reqs = Get-Content -LiteralPath $env:SG_IN -Raw -Encoding UTF8 | ConvertFrom-Json
$outDir = $env:SG_ICON_DIR
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
$done = New-Object System.Collections.ArrayList

foreach ($r in $reqs) {
  $target = Join-Path $outDir ($r.hash + '.png')
  if (Test-Path -LiteralPath $target) { [void]$done.Add($r.hash); continue }
  $saved = $false
  foreach ($src in $r.sources) {
    if ([string]::IsNullOrWhiteSpace($src)) { continue }
    $path = $src; $index = 0
    # DisplayIcon 形如 "C:\a\b.exe,0"
    if ($src -match '^(.*?),\s*(-?\d+)\s*$') { $path = $Matches[1]; $index = [int]$Matches[2] }
    $path = $path.Trim('"')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    try {
      $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
      if ($ext -eq '.ico') {
        $ico = New-Object System.Drawing.Icon($path, 256, 256)
        $bmp = $ico.ToBitmap()
      } else {
        $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
        if ($null -eq $ico) { continue }
        $bmp = $ico.ToBitmap()
      }
      if ($null -eq $bmp) { continue }
      $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose(); $ico.Dispose()
      $saved = $true
      break
    } catch { }
  }
  if ($saved) { [void]$done.Add($r.hash) }
}
Write-SgJson @($done)
`

export async function extractIcons(reqs: IconRequest[], iconDir: string): Promise<string[]> {
  if (reqs.length === 0) return []
  const { promises: fsp } = await import('node:fs')
  const { join: pjoin } = await import('node:path')
  const { tmpdir: td } = await import('node:os')
  const { randomBytes: rb } = await import('node:crypto')
  const inPath = pjoin(td(), `sg-icons-${rb(5).toString('hex')}.json`)
  await fsp.writeFile(inPath, JSON.stringify(reqs), 'utf8')
  try {
    const done = await psJson<string[]>(ICON_SCRIPT, {
      timeoutMs: 300_000,
      env: { SG_IN: inPath, SG_ICON_DIR: iconDir }
    })
    return asArray(done)
  } finally {
    fsp.unlink(inPath).catch(() => {})
  }
}

/** 数字签名状态查询（批量） */
const SIGN_SCRIPT = String.raw`
$paths = Get-Content -LiteralPath $env:SG_IN -Raw -Encoding UTF8 | ConvertFrom-Json
$out = New-Object System.Collections.ArrayList
foreach ($p in $paths) {
  try {
    $s = Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop
    $subject = ''
    if ($s.SignerCertificate) {
      $subject = $s.SignerCertificate.Subject
      if ($subject -match 'CN=([^,]+)') { $subject = $Matches[1].Trim('"') }
    }
    [void]$out.Add([pscustomobject]@{ path = $p; status = [string]$s.Status; signer = $subject })
  } catch {
    [void]$out.Add([pscustomobject]@{ path = $p; status = 'Unknown'; signer = '' })
  }
}
Write-SgJson @($out)
`

export async function querySignatures(
  paths: string[]
): Promise<{ path: string; status: string; signer: string }[]> {
  if (paths.length === 0) return []
  const { promises: fsp } = await import('node:fs')
  const { join: pjoin } = await import('node:path')
  const { tmpdir: td } = await import('node:os')
  const { randomBytes: rb } = await import('node:crypto')
  const inPath = pjoin(td(), `sg-sign-${rb(5).toString('hex')}.json`)
  await fsp.writeFile(inPath, JSON.stringify(paths), 'utf8')
  try {
    return asArray(
      await psJson<{ path: string; status: string; signer: string }[]>(SIGN_SCRIPT, {
        timeoutMs: 120_000,
        env: { SG_IN: inPath }
      })
    )
  } finally {
    fsp.unlink(inPath).catch(() => {})
  }
}
