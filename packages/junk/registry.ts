/**
 * 注册表清理 —— 卸载残留（v3.0.0 · M4）
 * ============================================================
 * 为什么放到审计与提权之后才做：注册表没有「回收站」，删错了没有第二次机会。
 * v2.0.0 先把 E4 审计留痕与 E3 提权规范化做扎实，M4 才具备开工条件。
 *
 * 安全约束（全部硬编码，不读配置 —— settings.json 被篡改也绕不过）：
 *   1. **白名单子树**：只允许 `...\CurrentVersion\Uninstall` 之下的键，其余一律拒绝。
 *      这一条挡掉的不只是手滑，还包括恶意规则把 `Run` / `Services` 塞进清理清单。
 *   2. **先备份后删除**：备份失败即拒绝删除（返回 backupFailed），绝不「先删再说」。
 *      备份是完整快照（含子键与值），可原样还原。
 *   3. **默认不提权**：HKLM 删除在非提权环境返回 needsElevation，
 *      由上层走提权通道；本模块不尝试自行提权。
 *   4. **不碰 MSI 管理的项**：`MsiExec.exe /X{...}` 形式的卸载项归 Windows Installer
 *      管，删键只会留下更脏的残留，直接跳过。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { psJson, asArray } from '../scanner/psbridge'
import type { RiskLevel } from '../shared/types'

// ───────────────── 白名单 ─────────────────

/** 允许清理的注册表子树（PowerShell 路径形式，大小写不敏感） */
export const REGISTRY_ALLOWED_PREFIXES = [
  'hklm:\\software\\microsoft\\windows\\currentversion\\uninstall\\',
  'hklm:\\software\\wow6432node\\microsoft\\windows\\currentversion\\uninstall\\',
  'hkcu:\\software\\microsoft\\windows\\currentversion\\uninstall\\'
]

/**
 * 键路径是否在白名单内。
 * 只做前缀比对，并且**要求前缀之后还有内容** —— 否则
 * `...\Uninstall\` 本身（整棵 Uninstall 树）也会被放行。
 */
export function isRegistryKeyAllowed(keyPath: string): boolean {
  const p = keyPath.trim().toLowerCase().replace(/\*+$/, '')
  return REGISTRY_ALLOWED_PREFIXES.some((pre) => p.startsWith(pre) && p.length > pre.length)
}

// ───────────────── 枚举 ─────────────────

export interface RegistryEntry {
  hive: 'HKLM' | 'HKCU'
  view: '64' | '32'
  /** PowerShell 路径（HKLM:\...\Uninstall\{GUID}） */
  keyPath: string
  displayName: string
  installLocation: string
  uninstallString: string
  publisher: string
  displayVersion: string
  /** SystemComponent=1 表示「Windows 用来隐藏内置组件」的项，不在「应用和功能」里显示 */
  systemComponent: string
}

interface RawEntry {
  hive?: string
  view?: string
  key?: string
  displayName?: string
  installLocation?: string
  uninstallString?: string
  publisher?: string
  displayVersion?: string
  systemComponent?: string
}

const ENUM_SCRIPT = `
$hives = @(
  @{ p = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; hive = 'HKLM'; view = '64' },
  @{ p = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; hive = 'HKLM'; view = '32' },
  @{ p = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; hive = 'HKCU'; view = '64' }
)
$out = New-Object System.Collections.ArrayList
foreach ($h in $hives) {
  if (-not (Test-Path $h.p)) { continue }
  foreach ($k in @(Get-ChildItem -LiteralPath $h.p -ErrorAction SilentlyContinue)) {
    $v = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $v) { continue }
    [void]$out.Add([pscustomobject]@{
      hive = $h.hive
      view = $h.view
      key = $h.p + '\\' + $k.PSChildName
      displayName = [string]$v.DisplayName
      installLocation = [string]$v.InstallLocation
      uninstallString = [string]$v.UninstallString
      publisher = [string]$v.Publisher
      displayVersion = [string]$v.DisplayVersion
      systemComponent = [string]$v.SystemComponent
    })
  }
}
Write-SgJson @($out)
`

export async function enumerateUninstallKeys(): Promise<RegistryEntry[]> {
  const rows = asArray(await psJson<RawEntry[]>(ENUM_SCRIPT, { timeoutMs: 120_000 }))
  const out: RegistryEntry[] = []
  for (const r of rows) {
    if (!r?.key) continue
    const hive = (r.hive || 'HKLM').toUpperCase() === 'HKCU' ? 'HKCU' : 'HKLM'
    out.push({
      hive,
      view: r.view === '32' ? '32' : '64',
      keyPath: r.key,
      displayName: (r.displayName || '').trim(),
      installLocation: (r.installLocation || '').trim(),
      uninstallString: (r.uninstallString || '').trim(),
      publisher: (r.publisher || '').trim(),
      displayVersion: (r.displayVersion || '').trim(),
      systemComponent: (r.systemComponent || '').trim()
    })
  }
  return out
}

// ───────────────── 残留判定（纯函数，便于测试）─────────────────

export interface RegistryResidue extends RegistryEntry {
  reasons: string[]
  risk: RiskLevel
  sizeBytes: number
}

/** 从 UninstallString 里取出可执行文件路径（去掉引号与参数） */
export function exeFromUninstallString(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const q = t.match(/^"([^"]+)"/)
  if (q) return q[1]
  const m = t.match(/^([A-Za-z]:\\[^\s]+\.exe)/i)
  return m ? m[1] : ''
}

export interface JudgeOptions {
  /** 路径是否存在（测试可注入） */
  exists?: (p: string) => boolean
  /** 目录体积（用于展示；取不到给 0） */
  dirSize?: (p: string) => number
}

/**
 * 判定一个 Uninstall 项是否为「卸载残留」。
 * 返回 null 表示不是残留（正常安装的软件，不动它）。
 */
export function judgeResidue(
  e: RegistryEntry,
  opts: JudgeOptions = {}
): { reasons: string[]; risk: RiskLevel } | null {
  const exists = opts.exists ?? ((p: string) => existsSync(p))

  // ── 以下四类是「绝对不能碰」的，必须排在残留判定之前 ──
  //
  // 1. SystemComponent=1：Windows 用它把内置组件从「应用和功能」里藏起来。
  //    实测本机 252 个键里有 37 个这种项（无 DisplayName、无安装位置），
  //    早期版本把它们全判成「空壳残留」—— 删掉就是在破坏系统组件注册。
  if (/^1$/.test(e.systemComponent)) return null

  // 2. MSI 管理的项交给 Windows Installer，删键只会留下更脏的残留
  if (/msiexec/i.test(e.uninstallString)) return null

  // 3. 没有 DisplayName 的键不判定：无法确认归属，误删的系统代价远大于
  //    「少清理一条无用记录」的收益
  if (!e.displayName) return null

  // 4. 卸载程序位于 Windows 目录内 / 发布者是微软：系统自带应用
  //    （mspaint、SnippingTool 的旧卸载项就属于这一类，删了会让
  //    「应用和功能」里的对应条目消失，而实际没有任何东西被清理）
  const sysRoot = (process.env.SystemRoot || `${(process.env.SystemDrive || 'C:')}\\Windows`).toLowerCase()
  const exe = exeFromUninstallString(e.uninstallString)
  if (exe && exe.toLowerCase().startsWith(sysRoot + '\\')) return null
  if (/microsoft/i.test(e.publisher)) return null

  // ── 到这里才做残留判定 ──
  const reasons: string[] = []
  const loc = e.installLocation.replace(/^"|"$/g, '')
  if (loc && !exists(loc)) reasons.push(`安装目录已不存在：${loc}`)
  if (exe && !exists(exe)) reasons.push(`卸载程序已不存在：${exe}`)

  if (reasons.length === 0) return null
  return { reasons, risk: 'medium' }
}

export function classifyResidues(entries: RegistryEntry[], opts: JudgeOptions = {}): RegistryResidue[] {
  const exists = opts.exists ?? ((p: string) => existsSync(p))
  const out: RegistryResidue[] = []
  for (const e of entries) {
    const j = judgeResidue(e, { ...opts, exists })
    if (!j) continue
    const loc = e.installLocation.replace(/^"|"$/g, '')
    // 目录都不存在就别去问体积 —— 残留项多数属于这种情况，
    // 白跑一次目录遍历是纯粹的浪费（大目录上尤其明显）
    out.push({
      ...e,
      reasons: j.reasons,
      risk: j.risk,
      sizeBytes: loc && exists(loc) && opts.dirSize ? opts.dirSize(loc) : 0
    })
  }
  return out
}

// ───────────────── 备份 ─────────────────

export interface RegistryBackup {
  createdAt: string
  /** 原始的 PowerShell 键路径 → 完整快照 */
  keys: { key: string; props: Record<string, string>; subKeys: { relative: string; props: Record<string, string> }[] }[]
}

interface RawDump {
  key?: string
  props?: Record<string, string>
  subKeys?: { relative?: string; props?: Record<string, string> }[]
}

/** 备份用的 PowerShell：把每个键的直属值与所有子键一并导出 */
function dumpScript(keys: string[]): string {
  const arr = keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(',')
  return `
$keys = @(${arr})
$out = New-Object System.Collections.ArrayList
foreach ($k in $keys) {
  if (-not (Test-Path -LiteralPath $k)) { continue }
  $item = Get-Item -LiteralPath $k
  $props = @{}
  foreach ($n in @($item.Property)) { $props[$n] = [string](Get-ItemProperty -LiteralPath $k -Name $n).$n }
  $subs = New-Object System.Collections.ArrayList
  foreach ($s in @(Get-ChildItem -LiteralPath $k -Recurse -ErrorAction SilentlyContinue)) {
    $sp = @{}
    foreach ($n in @($s.Property)) { $sp[$n] = [string](Get-ItemProperty -LiteralPath $s.PSPath -Name $n).$n }
    [void]$subs.Add([pscustomobject]@{ relative = $s.PSPath.Substring($item.PSPath.Length); props = $sp })
  }
  [void]$out.Add([pscustomobject]@{ key = $k; props = $props; subKeys = @($subs) })
}
Write-SgJson @($out)
`
}

/**
 * 备份给定键到 JSON 快照。**返回 null 表示备份失败 —— 调用方必须据此拒绝删除。**
 */
export async function backupKeys(entries: RegistryEntry[], dir: string): Promise<string | null> {
  const allowed = entries.filter((e) => isRegistryKeyAllowed(e.keyPath))
  if (allowed.length === 0) return null
  let dump: RawDump[]
  try {
    dump = asArray(await psJson<RawDump[]>(dumpScript(allowed.map((e) => e.keyPath)), { timeoutMs: 180_000 }))
  } catch {
    return null
  }
  if (dump.length === 0) return null
  const backup: RegistryBackup = {
    createdAt: new Date().toISOString(),
    keys: dump
      .filter((d) => d?.key)
      .map((d) => ({
        key: String(d.key),
        props: d.props ?? {},
        subKeys: (d.subKeys ?? []).map((s) => ({ relative: String(s.relative ?? ''), props: s.props ?? {} }))
      }))
  }
  try {
    await mkdir(dir, { recursive: true })
    const file = join(dir, `registry-${Date.now()}.json`)
    await writeFile(file, JSON.stringify(backup, null, 2), 'utf8')
    return file
  } catch {
    return null
  }
}

// ───────────────── 删除 ─────────────────

export interface RemoveOutcome {
  removed: number
  failed: number
  /** 未提权：调用方应走提权通道 */
  needsElevation: boolean
  /** 备份失败：拒绝执行删除 */
  backupFailed?: boolean
  /** 被白名单拒绝的键 */
  rejected: string[]
}

/**
 * 删除残留键。
 * 顺序固定为「先备份、再删除」—— 备份拿不到就什么都不做。
 */
export async function removeResidues(
  entries: RegistryEntry[],
  opts: { backupDir: string }
): Promise<RemoveOutcome> {
  const rejected = entries.filter((e) => !isRegistryKeyAllowed(e.keyPath)).map((e) => e.keyPath)
  const allowed = entries.filter((e) => isRegistryKeyAllowed(e.keyPath))
  if (allowed.length === 0) return { removed: 0, failed: 0, needsElevation: false, rejected }

  const backupFile = await backupKeys(allowed, opts.backupDir)
  if (!backupFile) return { removed: 0, failed: 0, needsElevation: false, backupFailed: true, rejected }

  const arr = allowed.map((e) => `'${e.keyPath.replace(/'/g, "''")}'`).join(',')
  const script = `
$keys = @(${arr})
$removed = 0
$failed = 0
foreach ($k in $keys) {
  try {
    if (-not (Test-Path -LiteralPath $k)) { $removed++; continue }
    Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $k) { $failed++ } else { $removed++ }
  } catch { $failed++ }
}
Write-SgJson ([pscustomobject]@{ removed = [double]$removed; failed = [double]$failed })
`
  try {
    const r = await psJson<{ removed: number; failed: number }>(script, { timeoutMs: 180_000 })
    return {
      removed: Number(r?.removed) || 0,
      failed: Number(r?.failed) || 0,
      needsElevation: false,
      rejected
    }
  } catch (e) {
    // 与 B2/B3 同一套语义：非提权环境明确返回 needsElevation，不伪装成失败
    const msg = String((e as Error).message ?? e)
    const denied = /Access is denied|错误 5|拒绝访问|Requested registry access is not allowed/i.test(msg)
    return { removed: 0, failed: allowed.length, needsElevation: denied, rejected }
  }
}

// ───────────────── 还原 ─────────────────

/** 从备份文件还原（键被删掉之后的反悔路径） */
export async function restoreBackup(file: string): Promise<{ restored: number; failed: number }> {
  let backup: RegistryBackup
  try {
    backup = JSON.parse(await readFile(file, 'utf8')) as RegistryBackup
  } catch {
    return { restored: 0, failed: 0 }
  }
  const keys = (backup.keys ?? []).filter((k) => isRegistryKeyAllowed(k.key))
  if (keys.length === 0) return { restored: 0, failed: 0 }

  const payload = keys.map((k) => ({
    key: k.key,
    props: Object.entries(k.props).map(([name, value]) => [name, String(value)]),
    subKeys: k.subKeys.map((s) => ({
      relative: s.relative,
      props: Object.entries(s.props).map(([name, value]) => [name, String(value)])
    }))
  }))

  const script = `
$payload = ConvertFrom-Json @'
${JSON.stringify(JSON.stringify(payload))}
'@
$data = ConvertFrom-Json $payload
$ok = 0
$bad = 0
foreach ($k in $data) {
  try {
    if (-not (Test-Path -LiteralPath $k.key)) { New-Item -Path $k.key -Force | Out-Null }
    foreach ($p in $k.props) {
      $name = [string]$p[0]; $value = [string]$p[1]
      if ([string]::IsNullOrEmpty($name)) { continue }
      New-ItemProperty -LiteralPath $k.key -Name $name -Value $value -PropertyType String -Force | Out-Null
    }
    foreach ($s in $k.subKeys) {
      $sub = $k.key + [string]$s.relative
      if (-not (Test-Path -LiteralPath $sub)) { New-Item -Path $sub -Force | Out-Null }
      foreach ($p in $s.props) {
        $name = [string]$p[0]; $value = [string]$p[1]
        if ([string]::IsNullOrEmpty($name)) { continue }
        New-ItemProperty -LiteralPath $sub -Name $name -Value $value -PropertyType String -Force | Out-Null
      }
    }
    $ok++
  } catch { $bad++ }
}
Write-SgJson ([pscustomobject]@{ restored = [double]$ok; failed = [double]$bad })
`
  try {
    const r = await psJson<{ restored: number; failed: number }>(script, { timeoutMs: 180_000 })
    return { restored: Number(r?.restored) || 0, failed: Number(r?.failed) || 0 }
  } catch {
    return { restored: 0, failed: keys.length }
  }
}
