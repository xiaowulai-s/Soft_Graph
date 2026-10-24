/**
 * v4.0 S1 自启动管理服务：枚举 + 可逆启停。
 *
 * 范围（v1，对齐 fancyStart）：
 *   - 注册表 Run / RunOnce（HKCU / HKLM 各一，含 AutorunsDisabled 子键的可逆禁用）
 *   - 启动文件夹（当前用户 / 所有用户，含 AutorunsDisabled 子目录的可逆禁用）
 *
 * 签名状态复用 winenum.querySignatures（批量 Authenticode 查询）。
 * HKLM 项的启停需要管理员权限 —— 走 Start-Process -Verb RunAs（UAC）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { psJson } from '@scanner/psbridge'
import { querySignatures } from '@scanner/winenum'
import {
  extractExeFromCommand,
  isHklm,
  startupId,
  startupFolderName,
  type StartupEntry,
  type StartupSource
} from '@shared/startup'

const DISABLED_SUBKEY = 'AutorunsDisabled'
const DISABLED_PREFIX = '[Disabled] '

interface RawRow {
  source: StartupSource
  name: string
  command: string
  disabled: boolean
}

/** 枚举脚本：Run/RunOnce 四键 + 启动文件夹（lnk 目标解析）→ JSON 行 */
const ENUM_SCRIPT = String.raw`
$out = New-Object System.Collections.ArrayList
function Add-Entry($source, $name, $command, $disabled) {
  if (-not $name) { return }
  [void]$out.Add([pscustomobject]@{ source = $source; name = [string]$name; command = [string]$command; disabled = [bool]$disabled })
}
$runPaths = @(
  @{ s = 'HKCU:Run'; p = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' },
  @{ s = 'HKCU:RunOnce'; p = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' },
  @{ s = 'HKLM:Run'; p = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' },
  @{ s = 'HKLM:RunOnce'; p = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce' }
)
foreach ($r in $runPaths) {
  foreach ($keyBase in @($r.p, "$($r.p)\AutorunsDisabled")) {
    $isDis = $keyBase -like '*AutorunsDisabled'
    if (-not (Test-Path $keyBase)) { continue }
    $k = Get-Item -LiteralPath $keyBase -ErrorAction SilentlyContinue
    if (-not $k) { continue }
    foreach ($vn in $k.GetValueNames()) {
      if (-not $vn) { continue }
      $val = $k.GetValue($vn)
      if (-not $val) { continue }
      Add-Entry $r.s $vn $val $isDis
    }
  }
}
$folders = @(
  @{ s = 'StartupFolder:User'; p = [Environment]::GetFolderPath('Startup') },
  @{ s = 'StartupFolder:AllUsers'; p = [Environment]::GetFolderPath('CommonStartup') }
)
$sh = New-Object -ComObject WScript.Shell
foreach ($f in $folders) {
  if (-not (Test-Path $f.p)) { continue }
  foreach ($sub in @($f.p, "$($f.p)\AutorunsDisabled")) {
    $isDis = $sub -like '*AutorunsDisabled'
    if (-not (Test-Path $sub)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $sub -File -ErrorAction SilentlyContinue) {
      $cmd = $file.FullName
      if ($file.Extension -ieq '.lnk') {
        try { $t = $sh.CreateShortcut($file.FullName); if ($t.TargetPath) { $cmd = $t.TargetPath + ' ' + $t.Arguments } } catch {}
      }
      $nm = $file.Name -replace '\.(lnk|url|bat|cmd|exe)$', ''
      Add-Entry $f.s $nm $cmd $isDis
    }
  }
}
Write-SgJson $out
`

/** 启停脚本：参数由 SG_OP JSON 传入 */
const TOGGLE_SCRIPT = String.raw`
$op = Get-Content -LiteralPath $env:SG_IN -Raw -Encoding UTF8 | ConvertFrom-Json
$out = New-Object System.Collections.ArrayList
function Report($ok, $msg) { [void]$out.Add([pscustomobject]@{ ok = [bool]$ok; error = [string]$msg }) }
try {
  if ($op.kind -eq 'registry') {
    $base = $op.baseKey
    $dis = "$base\AutorunsDisabled"
    if ($op.enable) {
      if (Test-Path $dis) {
        $k = Get-Item -LiteralPath $dis
        if ($k.GetValueNames() -contains $op.name) {
          $v = $k.GetValue($op.name)
          if (-not (Test-Path $base)) { New-Item -Path $base -Force | Out-Null }
          New-ItemProperty -LiteralPath $base -Name $op.name -Value $v -PropertyType String -Force | Out-Null
          Remove-ItemProperty -LiteralPath $dis -Name $op.name
        }
      }
      Report $true ''
    } else {
      $k = Get-Item -LiteralPath $base -ErrorAction Stop
      if ($k.GetValueNames() -contains $op.name) {
        if (-not (Test-Path $dis)) { New-Item -Path $dis -Force | Out-Null }
        $v = $k.GetValue($op.name)
        New-ItemProperty -LiteralPath $dis -Name $op.name -Value $v -PropertyType String -Force | Out-Null
        Remove-ItemProperty -LiteralPath $base -Name $op.name
      }
      Report $true ''
    }
  } elseif ($op.kind -eq 'folder') {
    if ($op.enable) {
      $dis = Join-Path $op.dir 'AutorunsDisabled'
      $src = Join-Path $dis ($op.prefix + $op.file)
      if (Test-Path $src) { Move-Item -LiteralPath $src -Destination (Join-Path $op.dir $op.file) -Force }
    } else {
      $dis = Join-Path $op.dir 'AutorunsDisabled'
      if (-not (Test-Path $dis)) { New-Item -ItemType Directory -Path $dis | Out-Null }
      $src = Join-Path $op.dir $op.file
      if (Test-Path $src) { Move-Item -LiteralPath $src -Destination (Join-Path $dis ($op.prefix + $op.file)) -Force }
    }
    Report $true ''
  } else {
    Report $false '未知操作类型'
  }
} catch {
  Report $false $_.Exception.Message
}
Write-SgJson $out
`

function spawnElevatedPs(script: string, json: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const inFile = join(tmpdir(), `sg-startup-${Date.now()}.json`)
    const outFile = `${inFile}.out`
    try {
      writeFileSync(inFile, json, 'utf8')
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message })
      return
    }
    const ps = script
      .replace('Write-SgJson $out', `Set-Content -LiteralPath '${outFile.replace(/'/g, "''")}' -Value 'done'`)
      .replace(/\$env:SG_IN/g, `'${inFile.replace(/'/g, "''")}'`)
    // 提权执行（HKLM 写入需要管理员）
    const child = spawn(
      'powershell',
      [
        '-NoProfile', '-Command',
        `Start-Process powershell -ArgumentList '-NoProfile','-Command',@'\n${ps}\n'@ -Verb RunAs -Wait; exit 0`
      ],
      { windowsHide: true }
    )
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => {
      let ok = code === 0
      try {
        ok = require('node:fs').existsSync(outFile)
      } catch {
        /* ignore */
      }
      resolve({ ok, error: ok ? undefined : 'UAC 被取消或执行失败' })
    })
  })
}

export class StartupService {
  /** 枚举全部自启动项（含签名状态与文件存在性） */
  async list(): Promise<StartupEntry[]> {
    const rows = await psJson<RawRow[]>(ENUM_SCRIPT, { timeoutMs: 60_000 })
    const entries: StartupEntry[] = []
    const exeSet = new Set<string>()
    const pending: StartupEntry[] = []
    for (const r of rows ?? []) {
      const source = r.source as StartupSource
      const exePath = extractExeFromCommand(r.command)
      const entry: StartupEntry = {
        id: startupId(source, r.name),
        source,
        name: r.name,
        command: r.command,
        exePath,
        enabled: !r.disabled,
        signStatus: 'unknown',
        signer: '',
        fileExists: true,
        needsElevation: isHklm(source)
      }
      if (exePath && /\.exe$/i.test(exePath)) exeSet.add(exePath)
      pending.push(entry)
    }
    // 批量签名查询
    try {
      const sigs = await querySignatures([...exeSet])
      const map = new Map(sigs.map((x) => [x.path.toLowerCase(), x]))
      const { existsSync } = await import('node:fs')
      for (const e of pending) {
        const sig = e.exePath ? map.get(e.exePath.toLowerCase()) : undefined
        if (sig) {
          const st = (sig.status || 'Unknown').toLowerCase()
          e.signStatus = st === 'valid' ? 'signed' : st === 'unsigned' ? 'unsigned' : 'unknown'
          e.signer = sig.signer
        }
        if (e.exePath) e.fileExists = existsSync(e.exePath)
      }
    } catch {
      /* 签名查询失败不影响列表 */
    }
    entries.push(...pending)
    return entries
  }

  /** 启用/禁用（可逆；HKLM 自动弹 UAC） */
  async toggle(source: StartupSource, name: string, enable: boolean): Promise<{ ok: boolean; error?: string }> {
    if (source.startsWith('HKCU:')) {
      const base = source.replace('HKCU:', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\')
      const r = await psJson<{ ok: boolean; error?: string }[]>(TOGGLE_SCRIPT, {
        timeoutMs: 30_000,
        env: { SG_IN: JSON.stringify({ kind: 'registry', baseKey: base, name, enable }) }
      })
      const first = r?.[0]
      return first ? { ok: first.ok, error: first.error } : { ok: false, error: '无返回' }
    }
    if (source === 'StartupFolder:User' || source === 'StartupFolder:AllUsers') {
      const dir = source === 'StartupFolder:User'
        ? join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        : join(process.env.PROGRAMDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      // 文件名 = 注册的名字（可能带扩展名）—— 扫描时实际文件名需要尝试常见扩展
      const { existsSync } = await import('node:fs')
      let file = name
      if (!existsSync(join(dir, file))) {
        for (const ext of ['.lnk', '.url', '.bat', '.cmd', '.exe']) {
          if (existsSync(join(dir, file + ext))) {
            file = file + ext
            break
          }
        }
      }
      const r = await psJson<{ ok: boolean; error?: string }[]>(TOGGLE_SCRIPT, {
        timeoutMs: 30_000,
        env: { SG_IN: JSON.stringify({ kind: 'folder', dir, file, prefix: DISABLED_PREFIX, enable }) }
      })
      const first = r?.[0]
      return first ? { ok: first.ok, error: first.error } : { ok: false, error: '无返回' }
    }
    // HKLM：提权
    const base = source.replace('HKLM:', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\')
    return spawnElevatedPs(TOGGLE_SCRIPT, JSON.stringify({ kind: 'registry', baseKey: base, name, enable }))
  }
}
