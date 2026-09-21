/**
 * 文件占用检测与重启后删除（v2.0.0 M2 / B2+B3）
 *
 * 为什么不用原生模块：
 *   v2.0.0 决策为「双轨」—— 默认路径必须零原生依赖。Restart Manager 与
 *   MOVEFILE_DELAY_UNTIL_REBOOT 都是 Win32 API，可以由 PowerShell 的
 *   Add-Type 做 P/Invoke 调用（Add-Type 会即时编译 C#，进程内一次约 0.3~1s），
 *   从而在不引入原生模块的前提下拿到**真实的**占用检测与延迟删除能力。
 *
 * 能力来源优先级：
 *   1. 原生模块（softgraph-native.rmFindLockers / rmDeleteOnReboot，安装才启用）
 *   2. PowerShell P/Invoke（本文件，默认路径）
 *   3. 失败 → 返回空结果 / 明确的错误原因，绝不抛异常影响清理主流程
 */

import { psJson, asArray } from '../scanner/psbridge'
import { getNativeModule } from '../native/capabilities'
import type { LockerInfo } from '../shared/types'

// 兼容旧引用：占用者类型现由 shared/types 统一定义（IPC 契约）
export type { LockerInfo }

export interface RebootDeleteResult {
  ok: boolean
  /** Win32 错误码（失败时） */
  win32Error?: number
  /** 是否需要提权（错误码 5 / 权限不足） */
  needsElevation?: boolean
  /** 人可读的原因 */
  reason?: string
  /**
   * 是否真的出现在 `PendingFileRenameOperations` 里（由脚本回读注册表确认）。
   * `ok` 只代表 `MoveFileEx` 返回 TRUE —— 该 API 不校验目标存在，所以「成功」需要第二证据。
   */
  queued?: boolean
  source: 'native' | 'ps' | 'none'
}

// ───────────── Restart Manager（P/Invoke） ─────────────

const RM_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:SG_TARGET
$out = New-Object System.Collections.ArrayList
$err = ''

$src = @'
using System;
using System.Runtime.InteropServices;
// 结构体必须与原生 RM_PROCESS_INFO **逐字节**对齐，两处踩过来的坑：
//   1. FILETIME 不能用 C# 的 long 声明 —— long 的 8 字节对齐会在 dwProcessId 之后
//      插入 4 字节填充，而原生布局是紧排的。这里拆成两个 uint 表达低/高 32 位。
//   2. strAppName 是 255 个 WCHAR（不是 256）。
// 错位后 ProcessId 之外的字段全部读歪，数组第 2 条起连 ProcessId 都是垃圾值
// （实测读出 3500506783 这类不存在的 pid），Get-Process 的参数绑定错误还会
// 直接中断循环 —— 表现为「多进程占用时只报前几条」且界面上占用者 PID 是错的。
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct RM_UNIQUE_PROCESS {
  public uint dwProcessId;
  public uint ProcessStartTimeLow;
  public uint ProcessStartTimeHigh;
}
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct RM_PROCESS_INFO {
  public RM_UNIQUE_PROCESS Process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 255)] public string AppName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
  public uint ApplicationType;
  public uint AppStatus;
  public uint TSSessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
}
public class SgRm {
  [DllImport("Rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint pSessionHandle, uint dwSessionFlags, string strSessionKey);
  [DllImport("Rstrtmgr.dll")]
  public static extern int RmEndSession(uint pSessionHandle);
  [DllImport("Rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
    uint nApplications, IntPtr rgApplications, uint nServices, IntPtr rgsServiceNames);
  [DllImport("Rstrtmgr.dll")]
  public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
    [In, Out] RM_PROCESS_INFO[] rgAffectedApps, out uint lpdwRebootReasons);
}
'@

try {
  if (-not ('SgRm' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }
  $h = [uint32]0
  $r = [SgRm]::RmStartSession([ref]$h, 0, 'sg-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
  if ($r -ne 0) { throw "RmStartSession 失败，错误码 $r" }
  try {
    $files = [string[]]@($target)
    $rr = [SgRm]::RmRegisterResources($h, 1, $files, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)
    if ($rr -ne 0) { throw "RmRegisterResources 失败，错误码 $rr" }
    $needed = [uint32]0
    $n = [uint32]0
    $reasons = [uint32]0
    $g1 = [SgRm]::RmGetList($h, [ref]$needed, [ref]$n, $null, [ref]$reasons)
    # 234 = ERROR_MORE_DATA：首次调用取所需数量，再分配数组取明细
    if ($g1 -eq 234 -or ($g1 -eq 0 -and $needed -gt 0)) {
      $n = $needed
      $arr = [RM_PROCESS_INFO[]]::new([int]$n)
      $g2 = [SgRm]::RmGetList($h, [ref]$needed, [ref]$n, $arr, [ref]$reasons)
      if ($g2 -eq 0) {
        foreach ($p in $arr) {
          $procId = [int64]$p.Process.dwProcessId
          if ($procId -eq 0 -or $procId -gt [int]::MaxValue) { continue }
          $nm = [string]$p.AppName
          try {
            $proc = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
            if ($proc) { $nm = $proc.ProcessName }
          } catch {
            # 进程在其它会话或已退出：拿名字就用 RM 给的 AppName。
            # 这里必须 try —— 参数绑定失败是**终止性**错误，-ErrorAction 拦不住，
            # 一条坏数据会让整份占用清单被截断。
          }
          [void]$out.Add([pscustomobject]@{
            pid         = [int]$procId
            name        = $nm
            appType     = [int]$p.ApplicationType
            restartable = [bool]$p.Restartable
          })
        }
      } else { $err = "RmGetList 明细失败，错误码 $g2" }
    } elseif ($g1 -ne 0) { $err = "RmGetList 失败，错误码 $g1" }
  } finally {
    [void][SgRm]::RmEndSession($h)
  }
} catch {
  $err = $_.Exception.Message
}

Write-SgJson ([pscustomobject]@{ lockers = @($out); error = [string]$err })
`

interface RmResult {
  lockers?: LockerInfo[]
  error?: string
}

/** 查询占用某文件的进程（Restart Manager 优先，原生模块次之，失败返回空数组） */
export async function findLockingProcesses(path: string): Promise<LockerInfo[]> {
  const nat = getNativeModule()
  if (nat?.rmFindLockers) {
    try {
      const rows = await nat.rmFindLockers(path)
      return rows.map((r) => ({ pid: r.pid, name: r.name, appType: 0, restartable: false }))
    } catch {
      /* 原生失败 → 继续走 PS 路径 */
    }
  }
  try {
    const res = await psJson<RmResult>(RM_SCRIPT, { timeoutMs: 60_000, env: { SG_TARGET: path } })
    return asArray(res?.lockers).filter((l) => l && typeof l.pid === 'number')
  } catch {
    return []
  }
}

/** 诊断用：返回最后一次查询的原始错误（便于排查为什么查不到占用者） */
export async function findLockingProcessesDetailed(
  path: string
): Promise<{ lockers: LockerInfo[]; error?: string; source: 'native' | 'ps' }> {
  const nat = getNativeModule()
  if (nat?.rmFindLockers) {
    try {
      const rows = await nat.rmFindLockers(path)
      return {
        lockers: rows.map((r) => ({ pid: r.pid, name: r.name, appType: 0, restartable: false })),
        source: 'native'
      }
    } catch (e) {
      return { lockers: [], error: (e as Error).message, source: 'native' }
    }
  }
  try {
    const res = await psJson<RmResult>(RM_SCRIPT, { timeoutMs: 60_000, env: { SG_TARGET: path } })
    return {
      lockers: asArray(res?.lockers).filter((l) => l && typeof l.pid === 'number'),
      error: res?.error || undefined,
      source: 'ps'
    }
  } catch (e) {
    return { lockers: [], error: (e as Error).message, source: 'ps' }
  }
}

// ───────────── 重启后删除（MOVEFILE_DELAY_UNTIL_REBOOT） ─────────────

const MOVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:SG_TARGET
$ok = $false
$code = 0
$err = ''

$src = @'
using System;
using System.Runtime.InteropServices;
public class SgMove {
  // 目标路径必须为 NULL 指针（不是空字符串）才能表达「删除」，故用 IntPtr 重载
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "MoveFileExW")]
  public static extern bool MoveFileExNull(string lpExistingFileName, IntPtr lpNewFileName, uint dwFlags);
}
'@

try {
  if (-not ('SgMove' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }
  $r = [SgMove]::MoveFileExNull($target, [IntPtr]::Zero, 4) # MOVEFILE_DELAY_UNTIL_REBOOT
  if ($r) { $ok = $true } else {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $err = switch ($code) { 5 { '需要管理员权限' } 2 { '文件不存在' } default { "Win32 错误 $code" } }
  }
} catch {
  $err = $_.Exception.Message
  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

# 校验：PendingFileRenameOperations 中是否出现该路径
$queued = $false
try {
  $v = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
  if ($v -and $v.PendingFileRenameOperations) {
    $queued = @($v.PendingFileRenameOperations) -contains ('\??\' + $target)
  }
} catch { }

Write-SgJson ([pscustomobject]@{ ok = $ok; win32Error = $code; error = [string]$err; queued = $queued })
`

interface MoveResult {
  ok?: boolean
  win32Error?: number
  error?: string
  queued?: boolean
}

/**
 * 登记「重启后删除」。
 * 适用：清理时文件被占用（如正在运行的日志、被加载的 DLL）。
 * 需要管理员权限；非提权环境会返回 needsElevation 由 UI 引导。
 */
export async function scheduleDeleteOnReboot(path: string): Promise<RebootDeleteResult> {
  const nat = getNativeModule()
  if (nat?.rmDeleteOnReboot) {
    try {
      return { ok: await nat.rmDeleteOnReboot(path), source: 'native' }
    } catch (e) {
      return { ok: false, reason: (e as Error).message, source: 'native' }
    }
  }
  try {
    const r = await psJson<MoveResult>(MOVE_SCRIPT, { timeoutMs: 30_000, env: { SG_TARGET: path } })
    return {
      ok: !!r?.ok,
      win32Error: r?.win32Error || undefined,
      needsElevation: r?.win32Error === 5,
      reason: r?.error || undefined,
      queued: !!r?.queued,
      source: 'ps'
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message, source: 'none' }
  }
}

/** 是否具备提权（延迟删除需要） */
export async function isElevated(): Promise<boolean> {
  try {
    const r = await psJson<{ elevated: boolean }>(
      String.raw`
$e = $false
try {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object System.Security.Principal.WindowsPrincipal($id)
  $e = $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
Write-SgJson @{ elevated = $e }
`,
      { timeoutMs: 15_000 }
    )
    return !!r?.elevated
  } catch {
    return false
  }
}
