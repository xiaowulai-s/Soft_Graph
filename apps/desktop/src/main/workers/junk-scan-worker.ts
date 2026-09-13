/**
 * 垃圾扫描 Worker（M2/C2）
 *
 * 运行在 Electron utilityProcess 中，与主进程隔离：
 *   1. 重扫描不再阻塞主进程（UI / 浮窗保持响应）
 *   2. Worker 崩溃不会带走应用；主进程可重启它并**续扫**（已完成的规则由
 *      增量缓存复用，见 packages/junk/scanner.ts 的 onRuleCache）
 *
 * 协议（主进程 ↔ 本进程）：
 *   ← { type: 'scan', payload }
 *   → { type: 'progress', phase, percent, current, found }
 *   → { type: 'rule-done', ruleId, cachePath }   // 每规则落盘，续扫依据
 *   → { type: 'done', resultPath, summary }
 *   → { type: 'error', message }
 *
 * 大数据（items 可达数万条）不出 IPC —— 由 Worker 写入结果文件，主进程读文件。
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadRulesSync, loadRules } from '@junk/engine'
import { scanJunk } from '@junk/scanner'
import { loadCache, saveCache, type CacheFile } from '@junk/incremental'
import { setShellFolderMap } from '@junk/engine'
import { resolveUserShellFolders, pruneMissing } from '@junk/shellfolders'
import type { JunkItem, JunkSummary } from '@shared/types'
import builtinRules from '@rules/junk-rules.json'

interface ScanPayload {
  scanId: string
  rulesFile: string
  cachePath: string
  resultPath: string
  categoryIds?: string[]
  force?: boolean
  knownNames: string[]
  knownPublishers: string[]
  knownDirs: string[]
  excludes: string[]
}

interface ScanDone {
  type: 'done'
  scanId: string
  resultPath: string
  cachePath: string
  summary: JunkSummary
  reusedRules: string[]
  reuseSource: Record<string, string>
}

type OutMsg =
  | { type: 'progress'; scanId: string; phase: string; percent: number; current: string; found: number }
  | { type: 'rule-done'; scanId: string; ruleId: string }
  | ScanDone
  | { type: 'error'; scanId: string; message: string }

const cancelled = { cancelled: false }
/** 缓存落盘节流（见 onRuleCache 注释） */
let lastCacheWrite = 0

function send(msg: OutMsg): void {
  // utilityProcess 中 process.parentPort 可用；直接跑 node 时退化为 stdout
  const parent = (process as unknown as { parentPort?: { postMessage: (m: unknown) => void } }).parentPort
  if (parent) parent.postMessage(msg)
  else console.log(JSON.stringify(msg))
}

async function runScan(payload: ScanPayload): Promise<void> {
  const { scanId } = payload
  try {
    // 用户库目录（GC-11/GC-12 的根目录解析依赖它）
    try {
      const map = await resolveUserShellFolders()
      setShellFolderMap(map ? pruneMissing(map) : null)
    } catch {
      /* 引擎会退回同义名猜测 */
    }

    let ruleSet
    try {
      ruleSet = await loadRules(payload.rulesFile)
    } catch {
      ruleSet = loadRulesSync(builtinRules as never)
    }

    const cache: CacheFile = await loadCache(payload.cachePath)
    await fs.mkdir(dirname(payload.resultPath), { recursive: true })
    // 自报 PID：Electron fork 出的 utility 进程命令行不一定含脚本名，
    // 外部（E2E / 诊断）要定位扫描进程时读这个文件最可靠
    await fs
      .writeFile(join(dirname(payload.resultPath), 'junk-scan-worker.pid'), String(process.pid), 'utf8')
      .catch(() => {})

    const res = await scanJunk(
      ruleSet,
      {
        knownNames: new Set(payload.knownNames),
        knownPublishers: new Set(payload.knownPublishers),
        knownDirs: new Set(payload.knownDirs),
        excludes: payload.excludes
      },
      {
        categoryIds: payload.categoryIds,
        force: payload.force,
        signal: cancelled,
        onProgress: (phase, percent, current, found) =>
          send({ type: 'progress', scanId, phase, percent, current, found }),
        // 每完成一条规则就把缓存落盘：Worker 若被杀，重启后这些规则直接复用。
        // 节流：缓存里含全部命中项（实测可达 15MB），逐规则全量写会明显拖慢扫描，
        // 因此最多每 10s 落盘一次；规则边界判定仍即时（内存中的 cache 一直是最新的）。
        onRuleCache: (c) => {
          const now = Date.now()
          if (now - lastCacheWrite < 10_000) return
          lastCacheWrite = now
          void saveCache(payload.cachePath, c)
        }
      }
    )

    await fs.writeFile(
      payload.resultPath,
      JSON.stringify({ items: res.items as JunkItem[], summary: res.summary }),
      'utf8'
    )
    await saveCache(payload.cachePath, res.cache)
    send({
      type: 'done',
      scanId,
      resultPath: payload.resultPath,
      cachePath: payload.cachePath,
      summary: res.summary,
      reusedRules: res.reusedRules,
      reuseSource: res.reuseSource
    })
  } catch (e) {
    send({ type: 'error', scanId, message: (e as Error).message })
  }
}

const parent = (process as unknown as { parentPort?: { on: (ev: string, cb: (e: { data: unknown }) => void) => void } })
  .parentPort

if (parent) {
  parent.on('message', (e) => {
    const msg = e.data as { type?: string; payload?: ScanPayload } | undefined
    if (!msg) return
    if (msg.type === 'scan' && msg.payload) void runScan(msg.payload)
    else if (msg.type === 'cancel') cancelled.cancelled = true
  })
} else {
  // 允许用 node 直接跑（调试）：把 payload 作为 argv[2] 的 JSON 文件传入
  const file = process.argv[2]
  if (file) {
    void fs.readFile(file, 'utf8').then((raw) => runScan(JSON.parse(raw) as ScanPayload))
  }
}

export {}
