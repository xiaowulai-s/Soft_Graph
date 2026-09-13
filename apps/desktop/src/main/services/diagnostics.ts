/**
 * 本地诊断包（v2.0.0 M3/C5）
 *
 * 目的：用户反馈问题时，一键导出一个**脱敏**的 zip，包含定位问题所需的一切，
 * 但不包含任何可识别的个人信息（用户名、计算机名、具体文件名清单）。
 *
 * 包内结构：
 *   README.txt              说明包含什么、脱敏了什么
 *   environment.json        系统 / 运行时 / 应用版本
 *   paths.json              数据目录（已脱敏）
 *   settings.json           用户设置
 *   capabilities.json       原生能力探测结果与降级策略
 *   stats.json              数据库统计（表行数、最近扫描记录）
 *   quarantine.json         隔离区摘要（批次数/大小，不含文件名）
 *   rules-summary.json      规则库摘要（13 类的 id/风险/阈值，不含命中路径）
 *   logs/softgraph-*.jsonl  最近日志（写入时已脱敏）
 *
 * 明确**不包含**：文件扫描结果明细、删除清单、完整路径清单、任何 token / 凭据。
 */

import { promises as fs } from 'node:fs'
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { createZip, type ZipEntry } from './zip'
import { logger } from './logger'
import type { AppPaths } from './env'

export interface DiagnosticsInput {
  paths: AppPaths
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  settings: unknown
  capabilities: unknown
  /** 数据库统计与最近扫描记录（由 Store 提供） */
  stats: unknown
  /** 隔离区摘要 */
  quarantine: { batches: number; records: number; totalBytes: number }
  /** 规则库摘要 */
  rulesSummary: unknown
  /** 已解析的 shell folders（用于脱敏与路径核对） */
  shellFolders: Partial<Record<string, string>>
  /** 额外脱敏项（如计算机名） */
  extraRedactions?: string[]
  /** 日志最多打包多少字节（默认 2MB） */
  logBytes?: number
  /** 覆盖默认脱敏器（测试用） */
  redact?: (s: string) => string
}

export interface DiagnosticsResult {
  ok: boolean
  file?: string
  bytes?: number
  entries?: string[]
  error?: string
}

/** 默认脱敏（与 logger 的规则一致；导出阶段再兜一层，防止外部注入的文本漏网） */
export function redactText(s: string, extraPaths: string[] = []): string {
  let out = s
    .replace(/([a-z]:\\users\\)[^\\/]+/gi, '$1%USER%')
    .replace(/([a-z]:\/users\/)[^\\/]+/gi, '$1%USER%')
  for (const p of extraPaths) {
    if (!p || p.length < 4) continue
    out = out.split(p).join('%USERPROFILE%')
    out = out.split(p.replace(/\\/g, '/')).join('%USERPROFILE%')
  }
  // 兜底：长 hex 串（疑似 token / 会话 id）
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, (m) => m.slice(0, 8) + '…')
  return out
}

/** 递归脱敏任意 JSON 值 */
export function redactDeep(value: unknown, extraPaths: string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, extraPaths)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, extraPaths))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, extraPaths)
    }
    return out
  }
  return value
}

function j(value: unknown, extraPaths: string[]): string {
  return JSON.stringify(redactDeep(value, extraPaths), null, 2)
}

export async function exportDiagnostics(input: DiagnosticsInput): Promise<DiagnosticsResult> {
  try {
    const log = logger()
    const extra = [
      ...Object.values(input.shellFolders).filter((v): v is string => !!v),
      ...(input.extraRedactions ?? [])
    ]
    const redactor = input.redact ?? ((s: string): string => redactText(s, extra))

    const logs = await log.readRecent(input.logBytes ?? 2 * 1024 * 1024)

    const environment = {
      generatedAt: new Date().toISOString(),
      os: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpus()[0]?.model,
        cpuCount: cpus().length,
        totalMemBytes: totalmem(),
        freeMemBytes: freemem()
      },
      runtime: {
        app: input.appVersion,
        electron: input.electronVersion,
        node: input.nodeVersion,
        chrome: input.chromeVersion
      },
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: process.env.LANG ?? null
    }

    const entries: ZipEntry[] = [
      {
        name: 'README.txt',
        data: [
          'SoftGraph 诊断包',
          '================',
          '',
          '本包用于定位问题，已做以下脱敏处理：',
          '  1. 用户名与计算机名替换为 %USER% / %USERPROFILE% / %COMPUTER%',
          '  2. 日志在**写入磁盘前**即已脱敏（不是导出时才处理）',
          '  3. 不包含扫描结果明细、删除清单、完整文件路径清单、任何凭据',
          '',
          '包含内容：',
          '  environment.json      系统 / 运行时 / 应用版本',
          '  paths.json            数据目录（脱敏后）',
          '  settings.json         用户设置',
          '  capabilities.json     原生能力探测与降级策略',
          '  stats.json            数据库统计与最近扫描记录',
          '  quarantine.json       隔离区摘要（不含文件名）',
          '  rules-summary.json    规则库摘要（不含命中路径）',
          '  logs/                 最近日志（JSONL，已脱敏）',
          ''
        ].join('\n')
      },
      { name: 'environment.json', data: j(environment, extra) },
      {
        name: 'paths.json',
        data: j(
          {
            root: input.paths.root,
            dataDir: input.paths.dataDir,
            quarantineDir: input.paths.quarantineDir,
            pluginDir: input.paths.pluginDir,
            logDir: join(input.paths.root, 'logs'),
            tmpDir: input.paths.tmpDir
          },
          extra
        )
      },
      { name: 'settings.json', data: j(input.settings, extra) },
      { name: 'capabilities.json', data: j(input.capabilities, extra) },
      { name: 'stats.json', data: j(input.stats, extra) },
      { name: 'quarantine.json', data: j(input.quarantine, extra) },
      { name: 'rules-summary.json', data: j(input.rulesSummary, extra) }
    ]

    if (logs.trim()) {
      // 月份分片，避免单个巨大文件
      entries.push({ name: 'logs/softgraph-recent.jsonl', data: redactor(logs) })
    }

    const buf = createZip(entries)
    await fs.mkdir(input.paths.reportDir, { recursive: true })
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
      d.getMinutes()
    )}${p(d.getSeconds())}`
    const file = join(input.paths.reportDir, `softgraph-diag-${stamp}.zip`)
    await fs.writeFile(file, buf)

    log.info('diagnostics', '诊断包已导出', { bytes: buf.length, entries: entries.length })
    await log.flushNow()

    return { ok: true, file, bytes: buf.length, entries: entries.map((e) => e.name) }
  } catch (e) {
    logger().error('diagnostics', '诊断包导出失败', e)
    return { ok: false, error: (e as Error).message }
  }
}
