/**
 * 提权清理调度（技术设计方案 5.6.3）
 *
 * 流程：
 *   主进程构建 ElevatedTask（packages/junk/elevated.ts，含清单校验）
 *   → 写入 %LOCALAPPDATA%\SoftGraph\tmp\elevated-<taskId>.json
 *   → 非提权 powershell 启动 launcher（路径经环境变量传递，无字符串拼接）
 *   → launcher 用 Start-Process -Verb RunAs 拉起 helper（UAC）
 *   → helper 二次校验后移动到隔离区并写 manifest
 *   → 主进程读 helper 的 .result.json 汇总
 *
 * 安全要点：
 *   - helper 脚本内容内嵌在代码里，落盘前比对 hash，被篡改会自动重写
 *   - launcher 的命令行里**没有**任何来自清单的内容，只有两个常量路径（经环境变量）
 *   - 用户取消 UAC → 明确返回 denied，不静默失败
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ElevatedTask } from '@junk/elevated'
import { ELEVATED_HELPER_PS1 } from '@junk/elevated-helper'

export interface ElevateResult {
  ok: boolean
  /** 用户在 UAC 处取消 */
  denied?: boolean
  /** 环境不支持提权（非 Windows / 找不到 powershell） */
  unsupported?: boolean
  batchId?: string
  succeeded?: number
  freedBytes?: number
  failed: { path: string; reason: string }[]
  error?: string
}

const PS = 'powershell.exe'

/**
 * launcher 脚本（常量）。
 *
 * 只有两件事：读环境变量拿两个路径 → Start-Process -Verb RunAs -Wait。
 * 把路径放在环境变量里而不是拼进命令行，是为了杜绝任何形式的参数注入。
 */
const LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
try {
  # -ArgumentList 数组不会自动为含空格路径加引号，这里显式包一层
  $h = '"' + $env:SG_HELPER + '"'
  $t = '"' + $env:SG_TASK + '"'
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $h, '-TaskFile', $t
  ) -Verb RunAs -Wait -PassThru
  [pscustomobject]@{ ok = $true; exitCode = $proc.ExitCode } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = 'ELEVATION_DENIED'; detail = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 3
}
`

/** helper 脚本落盘（内容变化时重写），返回其绝对路径 */
export async function ensureHelper(root: string): Promise<string> {
  const dir = join(root, 'helpers')
  const file = join(dir, 'elevated-clean.ps1')
  const want = createHash('sha256').update(ELEVATED_HELPER_PS1).digest('hex')
  const stamp = join(dir, 'elevated-clean.sha256')

  let current = ''
  try {
    current = (await fs.readFile(stamp, 'utf8')).trim()
  } catch {
    /* 首次运行 */
  }
  if (current === want && existsSync(file)) return file

  await fs.mkdir(dir, { recursive: true })
  // 带 BOM 写出：Windows PowerShell 5.1 对无 BOM 的 UTF-8 脚本会按 ANSI 解读
  await fs.writeFile(file, '\ufeff' + ELEVATED_HELPER_PS1, 'utf8')
  await fs.writeFile(stamp, want, 'utf8')
  return file
}

/** 提权 helper 是否已就绪（供 UI 判断是否展示「以管理员身份删除」入口） */
export function isElevationSupported(): boolean {
  return process.platform === 'win32'
}

export interface RunElevateOptions {
  root: string
  tmpDir: string
  /** 等待 UAC 与执行的超时（默认 10 分钟；用户可能正在考虑点不点 UAC） */
  timeoutMs?: number
}

/**
 * 执行提权清理。
 * 调用方需保证 task 已经过 buildElevatedTask() 的校验。
 */
export async function runElevated(
  task: ElevatedTask,
  opts: RunElevateOptions
): Promise<ElevateResult> {
  if (!isElevationSupported()) {
    return { ok: false, unsupported: true, failed: [], error: '当前平台不支持提权清理' }
  }

  let helper: string
  try {
    helper = await ensureHelper(opts.root)
  } catch (e) {
    return { ok: false, failed: [], error: `helper 落盘失败：${(e as Error).message}` }
  }

  const taskFile = join(opts.tmpDir, `elevated-${task.taskId}.json`)
  const resultFile = taskFile + '.result.json'
  await fs.mkdir(opts.tmpDir, { recursive: true })
  await fs.writeFile(taskFile, JSON.stringify(task), 'utf8')
  await fs.rm(resultFile, { force: true })

  const launcherOut = await runLauncher(taskFile, helper, opts.timeoutMs ?? 600_000)

  // launcher 失败：UAC 被拒 / 进程异常
  if (!launcherOut.ok) {
    await cleanup(taskFile, resultFile)
    return {
      ok: false,
      denied: launcherOut.error === 'ELEVATION_DENIED',
      failed: [],
      error: launcherOut.error === 'ELEVATION_DENIED' ? '用户取消了管理员授权' : launcherOut.detail
    }
  }

  // helper 结果
  let raw: {
    ok?: boolean
    error?: string
    detail?: string
    batchId?: string
    succeeded?: number
    freedBytes?: number
    failed?: { path: string; reason: string }[]
  } | null = null
  try {
    raw = JSON.parse(await fs.readFile(resultFile, 'utf8'))
  } catch {
    raw = null
  }
  await cleanup(taskFile, resultFile)

  if (!raw) {
    return { ok: false, failed: [], error: '提权进程未产出结果（可能被安全软件拦截）' }
  }
  if (!raw.ok) {
    return {
      ok: false,
      failed: [],
      error: `提权校验未通过：${raw.error ?? '未知'}${raw.detail ? `（${raw.detail}）` : ''}`
    }
  }
  return {
    ok: true,
    batchId: raw.batchId,
    succeeded: raw.succeeded ?? 0,
    freedBytes: raw.freedBytes ?? 0,
    failed: raw.failed ?? []
  }
}

interface LauncherOutcome {
  ok: boolean
  exitCode?: number
  error?: string
  detail?: string
}

function runLauncher(taskFile: string, helper: string, timeoutMs: number): Promise<LauncherOutcome> {
  return new Promise((resolve) => {
    const child = execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LAUNCHER],
      {
        env: { ...process.env, SG_TASK: taskFile, SG_HELPER: helper },
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8'
      },
      (err, stdout) => {
        const text = (stdout || '').trim()
        const lastLine = text.split(/\r?\n/).filter(Boolean).pop() ?? ''
        if (lastLine.startsWith('{')) {
          try {
            const j = JSON.parse(lastLine) as LauncherOutcome
            resolve(j)
            return
          } catch {
            /* 落到下面的兜底 */
          }
        }
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean }
          resolve({
            ok: false,
            error: e.killed ? 'ELEVATION_TIMEOUT' : 'LAUNCHER_FAILED',
            detail: e.message
          })
          return
        }
        resolve({ ok: false, error: 'LAUNCHER_NO_OUTPUT' })
      }
    )
    child.on('error', (e) =>
      resolve({ ok: false, error: 'LAUNCHER_FAILED', detail: (e as Error).message })
    )
  })
}

async function cleanup(...files: string[]): Promise<void> {
  for (const f of files) {
    try {
      await fs.rm(f, { force: true })
    } catch {
      /* ignore */
    }
  }
}
