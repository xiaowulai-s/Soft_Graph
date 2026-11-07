/**
 * winget 服务模块（v5.3 C2 模块化）
 *
 * 历史背景：v3.1 时 winget 调用内嵌在 scan.ts（当时 C2 评估官方
 * Microsoft.WinGet.Client PowerShell 模块成熟度不足，以「文本解析 + 回归
 * 测试锁定行为」过渡，见 docs/11 实施偏差记录）。v5.3 将这部分收敛为
 * 独立模块，**行为与过渡版逐字节一致**，后续迁官方模块时只动本文件。
 *
 * 设计要点（沿用已验证的经验，勿"优化"掉）：
 *  1. winget 是控制台程序，输出走 OEM 码页（中文系统 = GBK）——
 *     必须 buffer 接收 + TextDecoder('gbk') 解码，直接 toString('utf8')
 *     会让关键字匹配静默失效（v1.x 的教训）。
 *  2. id 参数只接受 [A-Za-z0-9.-_] 白名单（winget Id 格式子集），
 *     从源头杜绝注入 —— 提权路径的参数拼进 PowerShell 命令行。
 *  3. needsElevation 探测：需要管理员权限的包在静默模式下"失败但不明显"，
 *     靠输出关键字 + 0x8a15 退出码识别，供 UI 提供提权重试。
 */

/** winget Id 合法字符（白名单，防注入的第一道闸） */
const WINGET_ID_RE = /^[A-Za-z0-9.\-_]+$/

/** 升级结果（与 scan.ts 旧契约一致） */
export interface WingetRunResult {
  ok: boolean
  needsElevation?: boolean
  output?: string
}

/** 控制台输出解码：GBK 优先（中文系统），解码器缺失时退化 utf8 */
export function decodeConsoleOutput(raw: Buffer): string {
  try {
    // 延迟 import，保证纯 Node 测试环境无需特殊配置
    const u = require('node:util') as typeof import('node:util')
    return new u.TextDecoder('gbk').decode(raw)
  } catch {
    return raw.toString('utf8')
  }
}

/** id 白名单校验（集中一处，三处调用共用） */
export function isValidWingetId(id: string): boolean {
  return typeof id === 'string' && WINGET_ID_RE.test(id)
}

/**
 * 从退出码 + 输出判定升级结果（纯函数，回归测试锁定）。
 * 输出只保留末尾 4000 字符（winget 进度条会刷屏，有用的错误在末尾）。
 */
export function interpretUpgradeExit(code: number, output: string): WingetRunResult {
  const tail = output.slice(-4000)
  const needsElevation = code !== 0 && /(管理员|administrator|elevation|0x8a15)/i.test(tail)
  return { ok: code === 0, needsElevation, output: tail }
}

/** 组装静默升级参数（纯函数，锁定 CLI 契约） */
export function upgradeArgs(id: string): string[] {
  return [
    'upgrade',
    '--id',
    id,
    '--exact',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity'
  ]
}

/** spawn 一次 winget 并收集输出（内部通用；error 时 code = -1） */
function runWinget(args: string[], timeoutMs = 120_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let child: import('node:child_process').ChildProcess
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      child = spawn('winget', args, { windowsHide: true })
    } catch (e) {
      resolve({ code: -1, output: (e as Error).message })
      return
    }
    let raw = Buffer.alloc(0)
    let settled = false
    const done = (code: number): void => {
      if (settled) return
      settled = true
      resolve({ code, output: decodeConsoleOutput(raw) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      done(-1)
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => (raw = Buffer.concat([raw, d])))
    child.stderr?.on('data', (d: Buffer) => (raw = Buffer.concat([raw, d])))
    child.on('error', (e) => {
      raw = Buffer.concat([raw, Buffer.from(e.message)])
      done(-1) // winget 未安装或不可执行
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code ?? -1)
    })
  })
}

/** 列出可升级软件（winget 不在 PATH 时解析结果为空表，UI 呈现"暂无数据"） */
export async function listUpgrades(): Promise<import('@shared/types').WingetUpgrade[]> {
  const { output } = await runWinget(['upgrade', '--disable-interactivity'], 90_000)
  const { parseWingetUpgradeOutput } = await import('@shared/schedule')
  return parseWingetUpgradeOutput(output)
}

/** 静默升级单个软件 */
export async function upgrade(id: string): Promise<WingetRunResult> {
  if (!isValidWingetId(id)) return { ok: false, output: '非法软件 Id' }
  const { code, output } = await runWinget(upgradeArgs(id), 600_000)
  return interpretUpgradeExit(code, output)
}

/** 以管理员权限静默升级单个软件（触发 UAC，等待完成） */
export async function upgradeElevated(id: string): Promise<WingetRunResult> {
  if (!isValidWingetId(id)) return { ok: false, output: '非法软件 Id' }
  // Start-Process -Verb RunAs 触发 UAC；-Wait 等待升级完成
  const args = id.replace(/'/g, "''")
  return new Promise((resolve) => {
    let child: import('node:child_process').ChildProcess
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Start-Process winget -ArgumentList 'upgrade','--id','${args}','--exact','--silent','--accept-package-agreements','--accept-source-agreements','--disable-interactivity' -Verb RunAs -Wait; exit $LASTEXITCODE`
        ],
        { windowsHide: true }
      )
    } catch (e) {
      resolve({ ok: false, output: (e as Error).message })
      return
    }
    let raw = Buffer.alloc(0)
    child.stdout?.on('data', (d: Buffer) => (raw = Buffer.concat([raw, d])))
    child.stderr?.on('data', (d: Buffer) => (raw = Buffer.concat([raw, d])))
    child.on('error', (e) => resolve({ ok: false, output: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0, output: decodeConsoleOutput(raw).slice(-4000) }))
  })
}
