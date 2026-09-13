/**
 * 结构化日志（v2.0.0 M3/C5）
 *
 * 目标：用户反馈问题时，我们能拿到「发生了什么」的完整时间线，且**不泄露隐私**。
 *
 * 三条设计约束：
 *   1. **脱敏在写入前完成** —— 日志文件落盘的那一刻就已经不含用户名/计算机名，
 *      而不是导出诊断包时才处理（否则磁盘上的原始日志本身就是隐私风险）
 *   2. **JSONL** —— 每行一条，便于追加写入与后续解析，不需要读取整个文件
 *   3. **不阻塞主流程** —— 内存队列 + 批量异步落盘；应用退出前显式 flush
 *
 * 崩溃场景：最多丢失 flushIntervalMs 窗口内的日志。为此关键节点（扫描完成、
 * 清理执行、提权任务）会调用 flushNow() 立即落盘。
 */

import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { escapeRe } from '@shared/util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  scope: string
  msg: string
  data?: unknown
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 脱敏器。
 *
 * 判断依据：用户名与计算机名会以多种形式出现在路径与文本里，
 * 因此按「盘符\Users\<名>」的模式统一替换，再叠加已知的真实路径前缀。
 */
export interface RedactorOptions {
  /** 当前用户目录（如 C:\Users\XHZJZ），会被替换为 %USERPROFILE% */
  userProfile?: string
  computerName?: string
  /** 额外需要抹掉的绝对路径（如被重定向到 D 盘的文档目录） */
  extraPaths?: string[]
}

export function makeRedactor(opts: RedactorOptions): (s: string) => string {
  const subs: [RegExp, string | ((m: string) => string)][] = []

  // 1) 任何盘符下的用户目录：C:\Users\Alice → C:\Users\%USER%
  subs.push([/([a-z]:\\users\\)[^\\/]+/gi, '$1%USER%'])
  // 同上，正斜杠形式（日志里偶尔会出现）
  subs.push([/([a-z]:\/users\/)[^\\/]+/gi, '$1%USER%'])

  // 2) 已知的用户目录（可能被重定向到其它盘，如 D:\文档）
  for (const p of [opts.userProfile, ...(opts.extraPaths ?? [])]) {
    if (!p || p.length < 4) continue
    subs.push([new RegExp(escapeRe(p), 'gi'), '%USERPROFILE%'])
  }

  // 3) 计算机名
  const cn = opts.computerName
  if (cn && cn.length >= 3) subs.push([new RegExp(escapeRe(cn), 'gi'), '%COMPUTER%'])

  // 4) 兜底：长 hex 串（疑似 token / 会话 id）
  subs.push([/\b[a-f0-9]{32,}\b/gi, (m: string) => m.slice(0, 8) + '…'])

  return (s: string): string => {
    let out = s
    for (const [re, to] of subs) out = out.replace(re, to as string)
    return out
  }
}

/** data 字段的脱敏 + 体积控制（防止把整个图谱塞进日志） */
const MAX_DATA_CHARS = 2000
const MAX_STRING_CHARS = 500

function shrink(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) + '…' : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) {
    if (depth >= 3) return `[Array(${value.length})]`
    return value.slice(0, 50).map((v) => shrink(v, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= 3) return '[Object]'
    const out: Record<string, unknown> = {}
    let n = 0
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 50) break
      out[k] = shrink(v, depth + 1)
    }
    return out
  }
  return String(value)
}

export interface LoggerOptions {
  dir: string
  /** 最低记录级别（默认 info；SG_LOG_LEVEL=debug 可打开调试） */
  level?: LogLevel
  /** 批量落盘间隔（默认 400ms） */
  flushIntervalMs?: number
  /** 保留天数（默认 7） */
  keepDays?: number
  /** 单文件上限（默认 8MB，超出后停止写入当日文件并记录一条截断标记） */
  maxFileBytes?: number
  /** 同时输出到控制台（开发期） */
  echo?: boolean
  /** 测试用：注入时钟 */
  now?: () => number
}

export class Logger {
  private dir: string
  private level: LogLevel
  private flushIntervalMs: number
  private keepDays: number
  private maxFileBytes: number
  private echo: boolean
  private now: () => number
  private queue: LogEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> | null = null
  private redact: (s: string) => string
  private currentDay = ''
  private currentBytes = 0
  private truncatedDay = ''

  constructor(opts: LoggerOptions) {
    this.dir = opts.dir
    this.level = opts.level ?? 'info'
    this.flushIntervalMs = opts.flushIntervalMs ?? 400
    this.keepDays = opts.keepDays ?? 7
    this.maxFileBytes = opts.maxFileBytes ?? 8 * 1024 * 1024
    this.echo = opts.echo ?? false
    this.now = opts.now ?? ((): number => Date.now())
    this.redact = (s: string): string => s
  }

  /** 注入脱敏规则（由主进程在拿到 shell folders 后调用） */
  setRedactor(r: (s: string) => string): void {
    this.redact = r
  }

  debug(scope: string, msg: string, data?: unknown): void {
    this.write('debug', scope, msg, data)
  }
  info(scope: string, msg: string, data?: unknown): void {
    this.write('info', scope, msg, data)
  }
  warn(scope: string, msg: string, data?: unknown): void {
    this.write('warn', scope, msg, data)
  }
  error(scope: string, msg: string, data?: unknown): void {
    this.write('error', scope, msg, data)
  }

  private write(level: LogLevel, scope: string, msg: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const entry: LogEntry = {
      ts: this.now(),
      level,
      scope,
      msg: this.redact(msg),
      ...(data === undefined ? {} : { data: this.redactValue(shrink(data)) })
    }
    this.queue.push(entry)
    if (this.echo) {
      const line = `[${level}] ${scope}: ${entry.msg}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush()
      }, this.flushIntervalMs)
      this.timer.unref?.()
    }
  }

  private redactValue(v: unknown): unknown {
    if (typeof v === 'string') return this.redact(v)
    if (Array.isArray(v)) return v.map((x) => this.redactValue(x))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = this.redactValue(val)
      }
      return out
    }
    return v
  }

  /** 立即落盘（关键节点调用） */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    // 串行化写入，避免并发 append 交错
    this.writing = (this.writing ?? Promise.resolve()).then(async () => {
      const batch = this.queue.splice(0, this.queue.length)
      if (batch.length === 0) return
      try {
        await mkdir(this.dir, { recursive: true })
        const day = dayStamp(batch[0].ts)
        const file = join(this.dir, `softgraph-${day}.jsonl`)
        if (day !== this.currentDay) {
          this.currentDay = day
          this.currentBytes = await sizeOf(file)
        }
        if (this.currentBytes >= this.maxFileBytes) {
          if (this.truncatedDay !== day) {
            this.truncatedDay = day
            await appendFile(
              file,
              JSON.stringify({
                ts: this.now(),
                level: 'warn',
                scope: 'logger',
                msg: `日志文件超过上限（${this.maxFileBytes} B），当日后续日志不再写入`
              }) + '\n',
              'utf8'
            )
          }
          return
        }
        const text = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
        await appendFile(file, text, 'utf8')
        this.currentBytes += Buffer.byteLength(text, 'utf8')
      } catch {
        // 日志失败绝不影响主流程
      }
    })
    await this.writing
  }

  /** 读取最近的日志文本（供诊断包），按时间倒序拼装到 maxBytes 为止 */
  async readRecent(maxBytes = 2 * 1024 * 1024): Promise<string> {
    await this.flushNow()
    let files: string[] = []
    try {
      files = (await readdir(this.dir)).filter((f) => /^softgraph-\d{8}\.jsonl$/.test(f)).sort()
    } catch {
      return ''
    }
    const chunks: string[] = []
    let total = 0
    for (let i = files.length - 1; i >= 0; i--) {
      const p = join(this.dir, files[i])
      try {
        const st = await stat(p)
        const take = Math.min(st.size, maxBytes - total)
        if (take <= 0) break
        const buf = await readFile(p)
        const text = buf.subarray(Math.max(0, buf.length - take)).toString('utf8')
        chunks.unshift(`### ${files[i]}\n${text}`)
        total += take
      } catch {
        /* 单个文件读失败不阻断 */
      }
    }
    return chunks.join('\n')
  }

  /** 清理超过保留期的日志文件 */
  async prune(): Promise<number> {
    const cutoff = this.now() - this.keepDays * 24 * 3600 * 1000
    let removed = 0
    try {
      for (const f of await readdir(this.dir)) {
        const m = /^softgraph-(\d{4})(\d{2})(\d{2})\.jsonl$/.exec(f)
        if (!m) continue
        const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        if (ts < cutoff) {
          await rm(join(this.dir, f), { force: true })
          removed++
        }
      }
    } catch {
      /* ignore */
    }
    return removed
  }

  /** 测试与诊断用：当前日志目录 */
  get directory(): string {
    return this.dir
  }
}

function dayStamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

/** 全局单例（未初始化时是空实现，保证任何模块都能安全调用） */
let _logger: Logger | null = null

export function initLogger(opts: LoggerOptions): Logger {
  _logger = new Logger(opts)
  return _logger
}

export function logger(): Logger {
  if (!_logger) {
    _logger = new Logger({ dir: join(process.env.TEMP || '.', 'softgraph-logs') })
  }
  return _logger
}

/** 便捷函数形式，避免调用方到处 import logger() */
export const log = {
  debug: (scope: string, msg: string, data?: unknown): void => logger().debug(scope, msg, data),
  info: (scope: string, msg: string, data?: unknown): void => logger().info(scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown): void => logger().warn(scope, msg, data),
  error: (scope: string, msg: string, data?: unknown): void => logger().error(scope, msg, data)
}
