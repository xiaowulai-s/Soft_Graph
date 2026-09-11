/**
 * PowerShell 桥（替代设计文档中 Rust 层的 WinRT / Shell API 调用）
 *
 * 为什么不用 reg.exe：
 *   reg.exe 以控制台代码页输出（中文系统为 GBK/936），Node 侧按 UTF-8 解码会产生乱码，
 *   导致中文软件名不可用。此处统一改为 PowerShell 用 .NET Registry API 读取，
 *   结果以 UTF-8 无 BOM 写入临时 JSON 文件后再由 Node 读取，彻底绕开控制台编码问题。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export interface PsOptions {
  timeoutMs?: number
  /** 传给脚本的额外环境变量 */
  env?: Record<string, string>
}

/**
 * 执行 PowerShell 脚本并读取其写入 $env:SG_OUT 的 JSON 结果。
 * 脚本内部约定：把结果对象通过 Write-SgJson 输出。
 */
export async function psJson<T>(script: string, opts: PsOptions = {}): Promise<T> {
  const tag = randomBytes(6).toString('hex')
  const scriptPath = join(tmpdir(), `sg-${tag}.ps1`)
  const outPath = join(tmpdir(), `sg-${tag}.json`)

  const prelude = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function Write-SgJson($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  if ($null -eq $json) { $json = 'null' }
  [System.IO.File]::WriteAllText($env:SG_OUT, $json, (New-Object System.Text.UTF8Encoding($false)))
}
`
  await fs.writeFile(scriptPath, '\ufeff' + prelude + script, 'utf8')

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        PS,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        {
          timeout: opts.timeoutMs ?? 120_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, SG_OUT: outPath, ...(opts.env || {}) }
        },
        (err) => {
          // 即便退出码非 0，只要产出了 JSON 就认为可用（局部权限失败很常见）
          if (err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') return reject(new Error('PowerShell 执行超时'))
          resolve()
        }
      )
    })
    const raw = await fs.readFile(outPath, 'utf8')
    return JSON.parse(raw.replace(/^\ufeff/, '')) as T
  } finally {
    fs.unlink(scriptPath).catch(() => {})
    fs.unlink(outPath).catch(() => {})
  }
}

/** PowerShell 的 ConvertTo-Json 对单元素数组会退化为对象，统一成数组 */
export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}
