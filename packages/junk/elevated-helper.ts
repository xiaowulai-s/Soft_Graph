/**
 * 提权清理 helper（PowerShell）
 *
 * 由主进程在首次使用时写入 %LOCALAPPDATA%\SoftGraph\helpers\elevated-clean.ps1，
 * 再通过 `Start-Process -Verb RunAs` 以管理员身份运行。
 *
 * 为什么把脚本内容内嵌成常量而不是打包成资源文件：
 *   1. 内容完全由程序代码决定，用户与非管理员进程无法篡改（写入前比对 hash）
 *   2. 免去 electron-builder extraResources 配置，任何打包方式都不会漏
 *
 * 脚本的输入只有一个：任务 JSON 文件路径（--TaskFile）。
 * 除该路径外不接受任何参数，且**不执行清单中的任何内容**，只做文件移动。
 *
 * ⚠️ 本字符串内**不得出现反引号**（PowerShell 的转义/续行符），
 *    否则会与 TS 模板字符串冲突。多行语句一律用括号分组换行。
 */
export const ELEVATED_HELPER_VERSION = 1

export const ELEVATED_HELPER_PS1 = String.raw`
# SoftGraph 提权清理 helper（自动生成，请勿手工修改）
# 版本: 1
param(
  [Parameter(Mandatory=$true)][string]$TaskFile
)

$ErrorActionPreference = 'Stop'
$resultFile = $TaskFile + '.result.json'

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  if ($null -eq $json) { $json = 'null' }
  [System.IO.File]::WriteAllText($resultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Fail($code, $detail) {
  Write-Result @{ ok = $false; error = $code; detail = [string]$detail }
  exit 2
}

# ── 1. 读取任务 ──
if (-not (Test-Path -LiteralPath $TaskFile -PathType Leaf)) { Fail 'TASK_MISSING' '' }
try {
  $raw = [System.IO.File]::ReadAllText($TaskFile, [System.Text.Encoding]::UTF8)
  $task = $raw | ConvertFrom-Json
} catch {
  Fail 'TASK_UNREADABLE' $_.Exception.Message
}

# ── 2. 任务级校验（与生成侧同一套规则，这里是纵深防御的第二道） ──
if ($task.version -ne 1) { Fail 'BAD_VERSION' $task.version }
if ($task.action -ne 'quarantine') { Fail 'BAD_ACTION' $task.action }
if ($task.taskId -notmatch '^[a-z0-9_-]{6,64}$') { Fail 'BAD_TASK_ID' $task.taskId }
if ($task.quarantineRoot -notmatch '^[A-Za-z]:\\') { Fail 'BAD_QUARANTINE' $task.quarantineRoot }
if ($task.quarantineRoot -notmatch '\\SoftGraph\\') { Fail 'QUARANTINE_OUTSIDE_APP' $task.quarantineRoot }
if ($task.batchId -notmatch '^\d{8}-\d{6}$') { Fail 'BAD_BATCH_ID' $task.batchId }
$itemCount = @($task.items).Count
if ($itemCount -eq 0) { Fail 'EMPTY_ITEMS' '' }
if ($itemCount -gt 20000) { Fail 'TOO_MANY_ITEMS' $itemCount }

$denyExt = @(
  '.ps1','.psm1','.bat','.cmd','.vbs','.vbe','.wsf','.wsh','.hta','.js','.jse',
  '.reg','.msi','.msp','.scr','.com','.sys','.exe','.dll'
)

# ── 3. 执行（唯一的动作：移动到隔离区） ──
$batchDir = Join-Path $task.quarantineRoot $task.batchId
if (-not (Test-Path -LiteralPath $batchDir)) {
  New-Item -ItemType Directory -Force -Path $batchDir | Out-Null
}

$records = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList
$okCount = 0
$freedBytes = [int64]0
$index = 0

foreach ($it in @($task.items)) {
  $p = [string]$it.path
  $reason = $null

  if ([string]::IsNullOrWhiteSpace($p)) { $reason = 'EMPTY_PATH' }
  elseif ($p -match '[*?\[\]]') { $reason = 'WILDCARD' }
  elseif ($p -notmatch '^[A-Za-z]:\\') { $reason = 'NOT_ABSOLUTE' }
  elseif ($p -match '\\\.\.\\') { $reason = 'RELATIVE_SEGMENT' }
  else {
    $ext = ''
    try { $ext = [System.IO.Path]::GetExtension($p).ToLowerInvariant() } catch { $ext = '' }
    if ($denyExt -contains $ext) { $reason = 'DENY_EXT:' + $ext }
  }
  if (-not $reason) {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $reason = 'MISSING' }
  }
  if ($reason) {
    [void]$failed.Add([pscustomobject]@{ path = $p; reason = $reason })
    continue
  }

  # 二次状态复核：大小一致才动（防清单生成后文件被替换）
  try {
    $st = Get-Item -LiteralPath $p -Force
    $expectSize = [int64]$it.sizeBytes
    if ($st.Length -ne $expectSize -and $expectSize -gt 0) {
      [void]$failed.Add([pscustomobject]@{ path = $p; reason = 'SIZE_CHANGED' })
      continue
    }
  } catch {
    [void]$failed.Add([pscustomobject]@{ path = $p; reason = 'STAT_FAILED' })
    continue
  }

  $index = $index + 1
  $leaf = [System.IO.Path]::GetFileName($p)
  $destName = ('{0:d5}_{1}' -f $index, $leaf)
  $dest = Join-Path $batchDir $destName

  try {
    Move-Item -LiteralPath $p -Destination $dest -Force
    $okCount = $okCount + 1
    $freedBytes = $freedBytes + [int64]$it.sizeBytes
    [void]$records.Add([pscustomobject]@{
      id            = 'q_' + $task.batchId + '_' + $index
      originalPath  = $p
      quarantinedPath = $dest
      sizeBytes     = [int64]$it.sizeBytes
      deletedAt     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      keepUntil     = [int64]$it.keepUntil
      categoryId    = [string]$it.categoryId
      risk          = [string]$it.risk
      isDir         = $false
    })
  } catch {
    [void]$failed.Add([pscustomobject]@{ path = $p; reason = 'MOVE_FAILED: ' + $_.Exception.Message })
  }
}

# ── 4. 写 manifest（与普通删除同一格式，保证还原能力一致） ──
$manifestPath = Join-Path $batchDir 'manifest.json'
$existing = $null
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $existing = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch { $existing = $null }
}
if ($existing -and @($existing.records).Count -gt 0) {
  $merged = @($existing.records) + @($records)
} else {
  $merged = @($records)
}
if ($records.Count -gt 0) {
  $manifest = [pscustomobject]@{
    quarantineId = $task.batchId
    createdAt    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    elevated     = $true
    records      = $merged
  }
  [System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 8),
    (New-Object System.Text.UTF8Encoding($false))
  )
}

Write-Result @{
  ok         = $true
  batchId    = $task.batchId
  succeeded  = $okCount
  freedBytes = $freedBytes
  failed     = @($failed)
}
exit 0
`
