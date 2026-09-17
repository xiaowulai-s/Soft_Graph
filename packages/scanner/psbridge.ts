/**
 * PowerShell 桥（替代设计文档中 Rust 层的 WinRT / Shell API 调用）
 *
 * 为什么不用 reg.exe：
 *   reg.exe 以控制台代码页输出（中文系统为 GBK/936），Node 侧按 UTF-8 解码会产生乱码，
 *   导致中文软件名不可用。此处统一改为 PowerShell 用 .NET Registry API 读取，
 *   结果以 UTF-8 无 BOM 写入临时 JSON 文件后再由 Node 读取，彻底绕开控制台编码问题。
 *
 * 性能（v2.0.0 M1 / A1）：
 *   v1.0.0 每次 psJson 都 spawn 一个 powershell.exe，冷启动 0.3~0.6s、内存 ~50MB。
 *   浮窗插件的网速 / TOP 进程每 2~3 秒调用一次，纯属浪费；软件发现的图标 / 签名
 *   批处理也要多次 spawn。现在改为【常驻会话池】：
 *     - powershell.exe 以 `-Command -` 从 stdin 逐行读取命令，进程只启动一次；
 *     - 每个请求编码为一行：环境变量赋值 + Invoke-Expression(base64 脚本) + 完成标记；
 *     - 脚本内约定不变：仍用 Write-SgJson 把 JSON 写进 $env:SG_OUT；
 *     - Node 侧按 stdout 的 SG:DONE:<id> 标记配对结果；
 *     - 会话崩溃 / 请求超时 → 杀掉会话、拒绝挂起请求，下次调用自动重启；
 *     - 池大小 2：长任务（全量枚举 180s）与短任务（浮窗轮询）互不阻塞；
 *     - 会话无法启动时（例如 PS 被安全策略拦截）自动退回一次性 execFile 路径。
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const OUT_DIR = join(tmpdir(), 'sg-ps-session')

try {
  mkdirSync(OUT_DIR, { recursive: true })
} catch {
  /* 建不出来就退一次性路径（用各自临时文件） */
}

export interface PsOptions {
  timeoutMs?: number
  /** 传给脚本的额外环境变量 */
  env?: Record<string, string>
}

/**
 * 传给 PowerShell 子进程的最小环境变量集。
 *
 * v3.0.0 修复（环境块膨胀）：Windows 创建进程时环境块上限 65535 字节，
 * 宿主进程若被注入了巨大的环境变量（实测某环境达 513KB），PowerShell 内所有
 * 需要再起子进程的操作都会失败 —— 首当其冲是 `Add-Type`（编译 C# 走 csc.exe），
 * 于是 API Set 动态映射、Restart Manager 占用检测这类 P/Invoke 能力**静默全灭**：
 * 不报错、只是结果为空，极难排查。
 *
 * 对策：只把 PowerShell 真正需要的变量传下去（顺带避免在命令行里泄漏
 * 宿主进程的敏感环境变量）。单个变量超过 32KB 一律丢弃 —— 正常环境变量
 * 不会有这么大，出现即说明是被注入的异常值。
 */
const ENV_WHITELIST = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PATH',
  'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ALLUSERSPROFILE', 'PUBLIC', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'USERNAME', 'USERDOMAIN', 'USERDNSDOMAIN', 'COMPUTERNAME', 'LOGONSERVER',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS',
  'PSModulePath', 'SESSIONNAME', 'SystemRoot'
]

const MAX_ENV_VALUE = 32 * 1024

export function minimalPsEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string> = {}
  for (const k of ENV_WHITELIST) {
    const v = process.env[k]
    if (typeof v === 'string' && v.length > 0 && v.length <= MAX_ENV_VALUE) out[k] = v
  }
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}

/** PowerShell 的 ConvertTo-Json 对单元素数组会退化为对象，统一成数组 */
export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/** 单引号字面量转义（PS 单引号串里两个单引号 = 一个字面单引号） */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`
}

/** 一次性执行（v1.0.0 行为，作为会话不可用时的兜底） */
async function psJsonOneShot<T>(script: string, opts: PsOptions = {}): Promise<T> {
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
          env: minimalPsEnv({ SG_OUT: outPath, ...(opts.env || {}) })
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

// ───────────────── 常驻会话 ─────────────────

interface PendingReq {
  resolve: (outFile: string) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** 会话级失败（区别于脚本超时：前者可降级一次性路径重跑，后者绝不能重跑） */
class PsSessionStartError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'PsSessionStartError'
  }
}

class PsSessionCrashError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'PsSessionCrashError'
  }
}

class PsTimeoutError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'PsTimeoutError'
  }
}

class PsSession {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private pending = new Map<string, PendingReq>()
  private starting = false

  /** 排队中的请求数，用于路由到最闲的会话 */
  get load(): number {
    return this.pending.size
  }

  private ensure(): void {
    if (this.proc) return
    if (this.starting) return
    this.starting = true
    try {
      const proc = spawn(
        PS,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        // 传裁剪后的最小环境：宿主环境块过大时 Add-Type 会静默失败（见 minimalPsEnv 注释）
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: minimalPsEnv() }
      )
      // 关键：空闲会话不钉住 Node 事件循环。
      // 子进程的 stdio 管道默认是 ref'd 的 —— 若不 unref，应用/基准/冒烟脚本在
      // 主流程结束后会因为「还有活的 powershell.exe 子进程」而永远不退出。
      // 请求在途时由 setRef(true) 重新钉住，保证长脚本期间进程不提前退出。
      this.setRef(false)
      proc.on('error', (e) => this.die(new PsSessionStartError(`PowerShell 会话进程异常：${e.message}`)))
      // 非主动 kill 的退出 → 会话崩溃（挂起请求降级一次性路径重跑）
      proc.on('exit', () => {
        if (this.proc) this.die(new PsSessionCrashError('PowerShell 会话意外退出'))
      })
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
      proc.stderr.resume() // 丢弃诊断输出，结果全走文件
      this.proc = proc
    } catch (e) {
      throw new PsSessionStartError(`PowerShell 会话启动失败：${(e as Error).message}`)
    } finally {
      this.starting = false
    }
  }

  /** 请求在途时钉住事件循环；空闲时解除，让进程可以自然退出 */
  private setRef(on: boolean): void {
    const p = this.proc
    if (!p) return
    // stdin/stdout/stderr 运行时是 net.Socket（带 ref/unref），类型声明为 Writable/Readable 故需断言
    type Refable = { ref?: () => void; unref?: () => void }
    const parts: Refable[] = [p, p.stdin as Refable, p.stdout as Refable, p.stderr as Refable]
    for (const x of parts) {
      if (on) x.ref?.()
      else x.unref?.()
    }
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      const m = line.match(/^SG:DONE:([0-9a-f]+)$/)
      if (!m) continue
      const req = this.pending.get(m[1])
      if (!req) continue
      this.pending.delete(m[1])
      req.resolve(line /* 占位，真正结果在 fulfill 中读文件 */)
    }
  }

  /**
   * 注意：onStdout 里拿到标记后还需要读结果文件（异步），
   * 所以这里用两段式：标记触发 → 异步读文件 → resolve/reject 真正的调用方。
   */
  private async fulfill(id: string, outFile: string): Promise<void> {
    // 由 run() 注册的 pending 已在 onStdout 删除；这里直接按 id 读取
    try {
      const raw = await fs.readFile(outFile, 'utf8')
      const value = JSON.parse(raw.replace(/^\ufeff/, ''))
      this.settle.get(id)?.(null, value)
    } catch (e) {
      this.settle.get(id)?.(new Error(`PowerShell 脚本未产出结果：${(e as Error).message}`))
    } finally {
      this.settle.delete(id)
      fs.unlink(outFile).catch(() => {})
      // 全部请求完成 → 解除事件循环钉住，让宿主进程能自然退出
      if (this.settle.size === 0) this.setRef(false)
    }
  }

  /** id → 调用方的 settle 回调（与 pending 分开，避免 onStdout 里做异步） */
  private settle = new Map<string, (err: Error | null, value?: unknown) => void>()

  async run<T>(script: string, opts: PsOptions = {}): Promise<T> {
    this.ensure()
    if (!this.proc) throw new PsSessionStartError('PowerShell 会话不可用')

    const id = randomBytes(6).toString('hex')
    const outFile = OUT_DIR ? join(OUT_DIR, `sg-${id}.json`) : join(tmpdir(), `sg-${id}.json`)
    const b64 = Buffer.from(script, 'utf8').toString('base64')

    // 单行请求：env 赋值 → SG_OUT → 脚本 → 完成标记。
    // -Command - 按行执行，因此所有内容必须在一行内（脚本本体走 base64）。
    const envSets = Object.entries(opts.env || {})
      .map(([k, v]) => `$env:${k}=${psQuote(v)}`)
      .join(';')
    const parts = [
      `$ErrorActionPreference='SilentlyContinue'`,
      `$ProgressPreference='SilentlyContinue'`,
      `function Script:Write-SgJson($obj){$json=$obj|ConvertTo-Json -Depth 8 -Compress;if($null -eq $json){$json='null'};[System.IO.File]::WriteAllText($env:SG_OUT,$json,(New-Object System.Text.UTF8Encoding($false)))}`,
      ...(envSets ? [envSets] : []),
      `$env:SG_OUT=${psQuote(outFile)}`,
      `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) 2>$null`,
      `Write-Output ('SG:DONE:${id}')`
    ]
    const line = parts.join(';') + '\n'

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 120_000
      const timer = setTimeout(() => {
        // 脚本级超时无法单独中止（会话是顺序执行的），只能重建会话；
        // 超时错误不允许触发一次性重跑（长脚本重跑会翻倍耗时）
        const msg = `PowerShell 执行超时（${Math.round(timeoutMs / 1000)}s）`
        this.kill(new PsTimeoutError(msg + '，会话已重建'))
        reject(new PsTimeoutError(msg))
      }, timeoutMs)

      this.settle.set(id, (err, value) => {
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(value as T)
      })
      this.pending.set(id, {
        resolve: () => {
          void this.fulfill(id, outFile)
        },
        reject: (e) => {
          clearTimeout(timer)
          this.settle.delete(id)
          reject(e)
        },
        timer
      })

      try {
        // 请求在途 → 重新钉住事件循环（spawn 时已 unref，防止空闲会话阻塞退出）
        this.setRef(true)
        this.proc!.stdin.write(line)
      } catch (e) {
        clearTimeout(timer)
        this.settle.delete(id)
        this.pending.delete(id)
        const err = new PsSessionCrashError(`PowerShell 会话写入失败：${(e as Error).message}`)
        this.kill(err)
        reject(err)
      }
    })
  }

  /** 杀掉会话并让所有挂起请求失败（reason 传给它们） */
  private die(reason: Error): void {
    const proc = this.proc
    this.proc = null
    if (proc) {
      try {
        proc.kill()
      } catch {
        /* 进程可能已退出 */
      }
    }
    for (const [, req] of this.pending) {
      clearTimeout(req.timer)
      req.reject(reason)
    }
    this.pending.clear()
    for (const [id, s] of this.settle) {
      s(reason)
      this.settle.delete(id)
    }
    this.buf = ''
  }

  /** 主动 kill：与 die 相同，但语义是"请求超时/外部要求重建" */
  kill(reason: Error): void {
    this.die(reason)
  }
}

const POOL_SIZE = Number(process.env.SG_PS_POOL ?? 2)
const pool: PsSession[] = []

function pickSession(): PsSession {
  if (pool.length < POOL_SIZE) {
    const s = new PsSession()
    pool.push(s)
    return s
  }
  // 路由到最闲的会话；全忙时选第一个（FIFO 排队）
  let best = pool[0]
  for (const s of pool) if (s.load < best.load) best = s
  return best
}

/** 会话启动失败 / 会话崩溃 → 可降级一次性路径重跑；超时 → 必须向上抛 */
function isDegradeable(e: unknown): boolean {
  return e instanceof Error && (e.name === 'PsSessionStartError' || e.name === 'PsSessionCrashError')
}

/**
 * 执行 PowerShell 脚本并读取其写入 $env:SG_OUT 的 JSON 结果。
 * 脚本内部约定：把结果对象通过 Write-SgJson 输出。
 *
 * 优先走常驻会话；会话无法启动或崩溃时自动降级为一次性 execFile。
 */
export async function psJson<T>(script: string, opts: PsOptions = {}): Promise<T> {
  try {
    return await pickSession().run<T>(script, opts)
  } catch (e) {
    if (isDegradeable(e)) {
      // 会话起不来（PS 被拦截 / 环境异常）→ 兜底走一次性路径，行为与 v1.0.0 一致
      return psJsonOneShot<T>(script, opts)
    }
    throw e
  }
}

/** 应用退出时调用：结束所有常驻 PowerShell 进程 */
export function shutdownPsPool(): void {
  for (const s of pool) s.kill(new Error('应用退出'))
  pool.length = 0
  if (existsSync(OUT_DIR)) {
    fs.readdir(OUT_DIR)
      .then((files) => Promise.all(files.map((f) => fs.unlink(join(OUT_DIR, f)).catch(() => {}))))
      .catch(() => {})
  }
}
