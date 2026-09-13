/**
 * 扫描调度器
 * 对应技术设计方案 4.2 进程与线程模型 / 4.3 数据流 / 4.4 扫描流水线
 *
 * 与文档差异（需明确记录）：
 *   文档要求把扫描放进 Electron utilityProcess 子进程，实现「扫描崩溃不影响 UI」。
 *   本实现将扫描放在主进程，但保留了同等的对外契约：任务 ID、流式分批回传、
 *   可取消（CancelToken）、异常隔离（每个阶段独立 try/catch，单类失败不终止整轮）。
 *   由于 UI 运行在独立的渲染进程，主进程的 CPU 占用不会冻结界面，
 *   实际影响仅为「扫描期间 IPC 响应延迟」而非界面卡死。
 *   如需完全对齐，只需把本文件的 run* 函数搬进 utilityProcess 入口并用 postMessage 转发进度。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CleanResult,
  DeletePlan,
  FileNode,
  GraphModel,
  JunkItem,
  JunkSummary,
  ScanProgress,
  SoftwareItem
} from '@shared/types'
import { normKey, uid } from '@shared/util'
import { discoverSoftware } from '@scanner/software'
import { extractIcons, querySignatures } from '@scanner/winenum'
import { resolveDependencies } from '@scanner/deps'
import { buildGraph } from '@graph-core/build'
import { loadRules, loadRulesSync, type RuleSet } from '@junk/engine'
import { scanJunk, type JunkScanContext } from '@junk/scanner'
import type { CacheFile } from '@junk/incremental'
import { buildPlan, execute, listQuarantine, purge, restore } from '@junk/cleaner'
import type { Store } from '../db/store'
import type { AppPaths, SettingsStore } from './env'
import builtinRules from '@rules/junk-rules.json'

export interface CancelToken {
  cancelled: boolean
}

export type Emitter = (channel: string, payload: unknown) => void

export class ScanService {
  private softwareToken: CancelToken | null = null
  private junkToken: CancelToken | null = null
  private ruleSet: RuleSet | null = null
  /** 垃圾扫描增量缓存（M2/A5），懒加载自 paths.junkCacheFile */
  private junkCache: CacheFile | null = null
  private graphBuilding = new Set<string>()

  constructor(
    private store: Store,
    private paths: AppPaths,
    private settings: SettingsStore,
    private emit: Emitter
  ) {}

  // ───────────────── 规则库 ─────────────────

  async rules(): Promise<RuleSet> {
    if (this.ruleSet) return this.ruleSet
    await this.resolveShellFolders()
    try {
      this.ruleSet = await loadRules(this.paths.rulesFile)
    } catch {
      // 用户目录规则文件缺失/损坏 → 用打包内置规则兜底
      this.ruleSet = loadRulesSync(builtinRules as never)
    }
    return this.ruleSet
  }

  /**
   * 解析用户库目录（文档/图片/桌面/下载…）的真实路径并注入规则引擎。
   * 必要性：这些目录常被重定向到其它盘或被 OneDrive 接管，
   * 按英文名写死的规则会静默失效（GC-11 重复文件、GC-12 超大文件首当其冲）。
   */
  private async resolveShellFolders(): Promise<void> {
    try {
      const [{ resolveUserShellFolders, pruneMissing }, { setShellFolderMap }] = await Promise.all([
        import('@junk/shellfolders'),
        import('@junk/engine')
      ])
      const map = await resolveUserShellFolders()
      const pruned = map ? pruneMissing(map) : null
      setShellFolderMap(pruned)
      this.shellFolders = pruned
      if (pruned) {
        this.emit('app:shellFolders', pruned)
      }
    } catch {
      // 解析失败不阻断：引擎会退回「同义名猜测」策略
      this.shellFolders = null
    }
  }

  /** 最近一次解析到的用户库目录（供诊断包与设置页展示） */
  shellFolders: Partial<Record<string, string>> | null = null

  invalidateRules(): void {
    this.ruleSet = null
  }

  /**
   * 预热 COM 反查索引（证据 E6）。
   * 启动时后台跑，避免用户第一次点开图谱时才付 1.7s 的注册表遍历成本。
   */
  async warmupComIndex(): Promise<void> {
    try {
      const { setComIndexCachePath, preloadComIndex } = await import('@scanner/deps')
      setComIndexCachePath(this.paths.comIndexFile)
      await preloadComIndex()
    } catch {
      /* 预热失败不影响任何功能 */
    }
  }

  // ───────────────── 软件发现 ─────────────────

  async scanSoftware(roots?: string[]): Promise<{ scanId: string }> {
    if (this.softwareToken) this.softwareToken.cancelled = true
    const token: CancelToken = { cancelled: false }
    this.softwareToken = token
    const scanId = uid('sw_')
    const startedAt = Date.now()

    // 后台执行，立即把 scanId 返回给 UI（对应「边扫边画」的数据流）
    void (async () => {
      const collected: SoftwareItem[] = []
      try {
        const st = this.settings.get()
        const items = await discoverSoftware({
          portableRoots: roots?.length ? roots : st.portableRoots,
          portableThreshold: st.portableThreshold,
          manualMarks: this.store.portableMarks(),
          signal: token,
          onProgress: (phase, percent, current, found) => {
            const p: ScanProgress = { scanId, phase, percent: Math.min(99, Math.round(percent)), current, found }
            this.emit('scan:software:progress', p)
          },
          onBatch: (batch) => {
            collected.push(...batch)
            this.emit('scan:software:batch', batch)
          }
        })

        if (token.cancelled) {
          this.emit('scan:software:done', { scanId, total: collected.length, ms: Date.now() - startedAt, cancelled: true })
          return
        }

        this.store.replaceSoftware(items)
        // 软件清单变化会影响所有图谱的分组与置信度，缓存整体失效
        this.store.invalidateGraph()

        // 图标提取（落盘 PNG，按内容哈希命名）
        this.emit('scan:software:progress', {
          scanId,
          phase: '提取软件图标',
          percent: 99,
          current: `共 ${items.length} 个`,
          found: items.length
        } satisfies ScanProgress)

        const reqs = items
          .filter((i) => i.iconHash)
          .map((i) => ({
            hash: i.iconHash,
            sources: [i.mainExe, i.installPath ? join(i.installPath, 'app.ico') : ''].filter(Boolean)
          }))
        try {
          await extractIcons(reqs, this.paths.iconDir)
        } catch {
          /* 图标失败不影响主流程，前端有首字母色块兜底 */
        }

        await this.store.persist()
        this.store.recordScan(scanId, 'software', startedAt, Date.now(), 'ok', { total: items.length })
        this.emit('scan:software:done', { scanId, total: items.length, ms: Date.now() - startedAt })
        this.emit('scan:software:batch', items) // 最终全量，前端以此为准去重
      } catch (e) {
        this.emit('scan:software:done', {
          scanId,
          total: collected.length,
          ms: Date.now() - startedAt,
          error: (e as Error).message
        })
      } finally {
        if (this.softwareToken === token) this.softwareToken = null
      }
    })()

    return { scanId }
  }

  cancelSoftwareScan(): void {
    if (this.softwareToken) this.softwareToken.cancelled = true
  }

  // ───────────────── 图谱构建 ─────────────────

  async buildGraphFor(softwareId: string, maxDepth?: number, force = false): Promise<GraphModel> {
    const sw = this.store.getSoftware(softwareId)
    if (!sw) throw new Error('软件不存在，请先执行扫描')

    // 缓存命中（性能目标 10.1：单软件图谱构建缓存命中 ≤ 400ms）
    if (!force) {
      const cached = this.store.loadGraph(softwareId)
      if (cached) {
        const model = cached.model
        if (cached.layout) {
          for (const n of model.nodes) {
            const p = cached.layout[n.id]
            if (p) {
              n.x = p.x
              n.y = p.y
            }
          }
        }
        model.stats.fromCache = true
        return model
      }
    }

    if (this.graphBuilding.has(softwareId)) throw new Error('该软件的图谱正在构建中，请稍候')
    this.graphBuilding.add(softwareId)
    const t0 = Date.now()

    try {
      const token: CancelToken = { cancelled: false }
      const refCounts = this.store.refCounts()

      const res = await resolveDependencies(sw, {
        maxDepth: maxDepth ?? this.settings.get().maxDepth,
        refCounts,
        signal: token,
        // E6（COM 反查）v2.0.0 M2/B4 起默认开启：
        //   实测构建 1.7s（2657 DLL / 7142 CLSID），且有 7 天磁盘缓存 + 启动后台预热，
        //   会话内后续图谱零成本；v1.0.0 因误判为「分钟级」而默认关闭。
        // E7（快捷方式）成本低，同样默认开启。
        enableComEvidence: true,
        enableShortcutEvidence: true,
        onProgress: (phase, percent, current) =>
          this.emit('graph:progress', {
            scanId: softwareId,
            phase,
            percent: Math.min(99, Math.round(percent)),
            current
          } satisfies ScanProgress)
      })

      const files = [...res.files.values()]
      this.store.saveFilesAndDeps(files, res.edges)

      // 数字签名查询：只查安装目录内的可执行模块，控制成本
      void this.enrichSignatures(files)

      const model = buildGraph(sw, res.files, res.edges, {
        parsedOk: res.stats.parsedOk,
        parseFailed: res.stats.parseFailed,
        totalBytes: res.stats.totalBytes,
        buildMs: Date.now() - t0,
        fromCache: false
      })

      this.store.saveGraph(model, null)
      await this.store.persist()
      return model
    } finally {
      this.graphBuilding.delete(softwareId)
    }
  }

  /** 展开聚合节点：重建模型时把该分组标记为已展开 */
  async expandGroup(softwareId: string, nodeId: string): Promise<GraphModel> {
    const sw = this.store.getSoftware(softwareId)
    if (!sw) throw new Error('软件不存在')
    const cached = this.store.loadGraph(softwareId)
    if (!cached) return this.buildGraphFor(softwareId)

    const expandedRaw = this.store.getKv(`expanded:${softwareId}`)
    const expanded = new Set<string>(expandedRaw ? (JSON.parse(expandedRaw) as string[]) : [])
    if (expanded.has(nodeId)) expanded.delete(nodeId)
    else expanded.add(nodeId)
    this.store.setKv(`expanded:${softwareId}`, JSON.stringify([...expanded]))

    // 从数据库重放依赖，按新的展开状态重建
    const deps = this.store
      .junkByIds([]) // 占位，避免 lint 误判未使用
      .slice(0, 0)
    void deps

    const rows = this.replayDeps(softwareId)
    const model = buildGraph(sw, rows.files, rows.edges, {
      parsedOk: cached.model.stats.parsedOk,
      parseFailed: cached.model.stats.parseFailed,
      totalBytes: cached.model.stats.totalSizeBytes,
      buildMs: 0,
      fromCache: true
    }, { expanded })
    this.store.saveGraph(model, null)
    return model
  }

  /** 从数据库重建 files / edges（避免重新解析 PE） */
  private replayDeps(softwareId: string): { files: Map<string, FileNode>; edges: import('@shared/types').DependencyEdge[] } {
    const cached = this.store.loadGraph(softwareId)
    const files = new Map<string, FileNode>()
    const edges: import('@shared/types').DependencyEdge[] = []
    if (!cached) return { files, edges }

    // 图谱缓存里已含全部节点（含聚合节点的 children），从中恢复
    for (const n of cached.model.nodes) {
      if (n.type === 'file' && n.file) files.set(n.file.id, n.file)
      if (n.type === 'group' && n.children) {
        for (const c of n.children) if (c.file) files.set(c.file.id, c.file)
      }
    }
    for (const e of cached.model.edges) {
      if (e.target.startsWith('grp_')) {
        // 聚合边：展开时由 children 各自的边替代
        const grp = cached.model.nodes.find((n) => n.id === e.target)
        for (const c of grp?.children ?? []) {
          if (!c.file) continue
          edges.push({
            sourceId: cached.model.softwareId,
            targetId: c.file.id,
            type: e.type,
            confidence: e.confidence,
            evidence: e.evidence
          })
        }
        continue
      }
      edges.push({
        sourceId: e.source,
        targetId: e.target,
        type: e.type,
        confidence: e.confidence,
        evidence: e.evidence
      })
    }
    return { files, edges }
  }

  private async enrichSignatures(files: FileNode[]): Promise<void> {
    const targets = files
      .filter((f) => !f.missing && (f.kind === 'exe' || f.kind === 'dll'))
      .slice(0, 60)
      .map((f) => f.fullPath)
    if (targets.length === 0) return
    try {
      const res = await querySignatures(targets)
      const map = new Map(res.map((r) => [normKey(r.path), r]))
      const updated = files.map((f) => {
        const hit = map.get(normKey(f.fullPath))
        if (!hit) return f
        return {
          ...f,
          signStatus: hit.status === 'Valid' ? ('signed' as const) : hit.status === 'NotSigned' ? ('unsigned' as const) : ('unknown' as const)
        }
      })
      this.store.saveFilesAndDeps(updated, [])
    } catch {
      /* 签名查询失败不影响图谱 */
    }
  }

  // ───────────────── 垃圾扫描 ─────────────────

  async scanJunkNow(categoryIds?: string[], force = false): Promise<{ scanId: string }> {
    if (this.junkToken) this.junkToken.cancelled = true
    const token: CancelToken = { cancelled: false }
    this.junkToken = token
    const scanId = uid('junk_')
    const startedAt = Date.now()

    void (async () => {
      try {
        const ruleSet = await this.rules()
        const software = this.store.listSoftware()
        const ctx: JunkScanContext = {
          knownNames: new Set(
            software.map((s) => s.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')).filter((s) => s.length >= 3)
          ),
          knownPublishers: new Set(
            software
              .map((s) => (s.publisher || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''))
              .filter((s) => s.length >= 3)
          ),
          knownDirs: new Set(software.map((s) => normKey(s.installPath)).filter(Boolean)),
          excludes: this.settings.get().excludePaths
        }

        // 增量缓存（M2/A5）：首次为空缓存，扫描后回写
        if (!this.junkCache) {
          const { loadCache } = await import('@junk/incremental')
          this.junkCache = await loadCache(this.paths.junkCacheFile)
        }

        const result = await scanJunk(ruleSet, ctx, {
          categoryIds,
          signal: token,
          force,
          cache: this.junkCache,
          onProgress: (phase, percent, current, found) =>
            this.emit('junk:progress', {
              scanId,
              phase,
              percent: Math.min(99, Math.round(percent)),
              current,
              found
            } satisfies ScanProgress)
        })

        if (token.cancelled) {
          this.emit('junk:progress', {
            scanId,
            phase: '已取消',
            percent: 100,
            current: '',
            found: result.items.length
          } satisfies ScanProgress)
          return
        }

        this.store.saveJunk(result.scanId, result.items, result.summary)
        await this.store.persist()
        // 回写增量缓存（供下次扫描比对目录签名）
        this.junkCache = result.cache
        const { saveCache } = await import('@junk/incremental')
        await saveCache(this.paths.junkCacheFile, result.cache)
        if (result.reusedRules.length) {
          this.emit('junk:progress', {
            scanId,
            phase: `增量命中 ${result.reusedRules.length} 类（${result.reusedRules.join('、')}）`,
            percent: 100,
            current: '',
            found: result.items.length
          } satisfies ScanProgress)
        }
        this.store.recordScan(scanId, 'junk', startedAt, Date.now(), 'ok', {
          total: result.summary.totalBytes
        })
        this.emit('junk:progress', {
          scanId,
          phase: '扫描完成',
          percent: 100,
          current: '',
          found: result.items.length
        } satisfies ScanProgress)
        this.emit('junk:summary:changed', result.summary)
      } catch (e) {
        this.emit('junk:progress', {
          scanId,
          phase: `扫描失败：${(e as Error).message}`,
          percent: 100,
          current: '',
          found: 0
        } satisfies ScanProgress)
      } finally {
        if (this.junkToken === token) this.junkToken = null
      }
    })()

    return { scanId }
  }

  cancelJunkScan(): void {
    if (this.junkToken) this.junkToken.cancelled = true
  }

  junkSummary(): JunkSummary | null {
    return this.store.junkSummary()
  }

  // ───────────────── 清理 ─────────────────

  async plan(itemIds: string[], useQuarantine: boolean): Promise<DeletePlan> {
    const items = this.store.junkByIds(itemIds)
    return buildPlan(items, useQuarantine)
  }

  async clean(itemIds: string[], useQuarantine: boolean): Promise<CleanResult> {
    const items = this.store.junkByIds(itemIds)
    const plan = await buildPlan(items, useQuarantine)
    const st = this.settings.get()

    const result = await execute(
      plan,
      { quarantineRoot: this.paths.quarantineDir },
      {
        useQuarantine,
        keepDaysLow: st.quarantineKeepDaysLow,
        keepDaysHigh: st.quarantineKeepDaysHigh,
        onProgress: (done, total, current) =>
          this.emit('clean:progress', { taskId: plan.taskId, done, total, current })
      }
    )

    // 成功删除的项从数据库移除，并按实际释放量修正统计
    const okIds = new Set(plan.items.map((i) => i.id))
    for (const f of result.failed) {
      const hit = plan.items.find((i) => i.fullPath === f.path)
      if (hit) okIds.delete(hit.id)
    }
    this.store.removeJunk([...okIds])
    this.refreshSummaryAfterClean()
    await this.store.persist()
    return result
  }

  /** 删除后重算侧边栏统计，避免 UI 显示已删除的空间 */
  private refreshSummaryAfterClean(): void {
    const summary = this.store.junkSummary()
    if (!summary) return
    const next: JunkSummary = { ...summary, categories: [] }
    let total = 0
    let count = 0
    let oneClick = 0
    for (const c of summary.categories) {
      const { items } = this.store.junkItems(c.id, 0, 1_000_000)
      const releasable = items.filter((i) => !i.keep)
      const size = releasable.reduce((s, i) => s + i.sizeBytes, 0)
      next.categories.push({ ...c, sizeBytes: size, count: items.length })
      total += size
      count += items.length
      if (c.risk === 'low' && c.defaultSelected) oneClick += size
    }
    next.totalBytes = total
    next.totalCount = count
    next.oneClickBytes = oneClick
    this.store.setKv('junk:summary', JSON.stringify(next))
    this.emit('junk:summary:changed', next)
  }

  /** 一键删除：安全边界在 shared/safety.ts 中以纯函数固化，不可通过设置绕过 */
  async oneClickItems(): Promise<string[]> {
    const summary = this.store.junkSummary()
    if (!summary) return []
    const { isOneClickEligible } = await import('@shared/safety')
    const eligible = summary.categories.filter((c) => isOneClickEligible(c.risk, c.defaultSelected)).map((c) => c.id)
    const items = this.store.junkByCategories(eligible)
    return items.filter((i) => !i.keep).map((i) => i.id)
  }

  async quarantineList(): Promise<import('@shared/types').QuarantineRecord[]> {
    return listQuarantine(this.paths.quarantineDir)
  }

  async quarantineRestore(ids: string[]): Promise<{ ok: number; failed: string[] }> {
    const r = await restore(this.paths.quarantineDir, ids, 'rename')
    return r
  }

  async quarantinePurge(opts: { ids?: string[]; expiredOnly?: boolean }): Promise<{ ok: number; freed: number }> {
    return purge(this.paths.quarantineDir, opts)
  }

  /** 启动时清理到期隔离项（保留策略见 5.6.2） */
  async purgeExpired(): Promise<void> {
    try {
      await purge(this.paths.quarantineDir, { expiredOnly: true })
    } catch {
      /* ignore */
    }
  }

  // ───────────────── 报告导出（FR-14） ─────────────────

  async exportReport(kind: 'graph' | 'junk', format: 'json' | 'csv' | 'html', softwareId?: string): Promise<string> {
    await fs.mkdir(this.paths.reportDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(this.paths.reportDir, `softgraph-${kind}-${stamp}.${format}`)

    if (kind === 'junk') {
      const summary = this.store.junkSummary()
      if (!summary) throw new Error('尚无垃圾扫描结果，请先扫描')
      const rows: JunkItem[] = []
      for (const c of summary.categories) rows.push(...this.store.junkItems(c.id, 0, 5000).items)
      if (format === 'json') {
        await fs.writeFile(file, JSON.stringify({ summary, items: rows }, null, 2), 'utf8')
      } else if (format === 'csv') {
        const head = '分类,文件名,完整路径,大小(字节),修改时间,风险\n'
        const body = rows
          .map((r) =>
            [r.categoryId, csv(r.name), csv(r.fullPath), r.sizeBytes, new Date(r.mtime).toISOString(), r.risk].join(',')
          )
          .join('\n')
        await fs.writeFile(file, '\ufeff' + head + body, 'utf8')
      } else {
        await fs.writeFile(file, junkHtml(summary, rows), 'utf8')
      }
      return file
    }

    if (!softwareId) throw new Error('导出依赖清单需要指定软件')
    const cached = this.store.loadGraph(softwareId)
    const sw = this.store.getSoftware(softwareId)
    if (!cached || !sw) throw new Error('该软件尚无图谱数据，请先构建图谱')

    const flat: { name: string; path: string; type: string; confidence: number; evidence: string; size: number }[] = []
    const edgeByTarget = new Map(cached.model.edges.map((e) => [e.target, e]))
    const pushNode = (n: import('@shared/types').GraphNode): void => {
      if (!n.file) return
      const e = edgeByTarget.get(n.id)
      flat.push({
        name: n.file.name,
        path: n.file.fullPath,
        type: e?.type ?? 'binds',
        confidence: e?.confidence ?? 0,
        evidence: (e?.evidence ?? []).join('+'),
        size: n.file.sizeBytes
      })
    }
    for (const n of cached.model.nodes) {
      pushNode(n)
      for (const c of n.children ?? []) pushNode(c)
    }

    if (format === 'json') {
      await fs.writeFile(file, JSON.stringify({ software: sw, stats: cached.model.stats, dependencies: flat }, null, 2), 'utf8')
    } else if (format === 'csv') {
      const head = '文件名,完整路径,关系类型,置信度,证据,大小(字节)\n'
      const body = flat
        .map((r) => [csv(r.name), csv(r.path), r.type, r.confidence.toFixed(2), r.evidence, r.size].join(','))
        .join('\n')
      await fs.writeFile(file, '\ufeff' + head + body, 'utf8')
    } else {
      await fs.writeFile(file, graphHtml(sw, cached.model.stats, flat), 'utf8')
    }
    return file
  }
}

function csv(s: string): string {
  return `"${(s || '').replace(/"/g, '""')}"`
}

function esc(s: string): string {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

function junkHtml(summary: JunkSummary, rows: JunkItem[]): string {
  const fmt = (n: number): string => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB']
    let i = 0
    let v = n
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024
      i++
    }
    return `${v.toFixed(1)} ${u[i]}`
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>SoftGraph 垃圾清单</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;background:#0f1620;color:#e2e8f0;padding:24px}
h1{font-size:20px}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px}
th,td{border-bottom:1px solid #24314a;padding:6px 8px;text-align:left}th{color:#94a3b8}
.sum{background:#182230;padding:14px;border-radius:10px;margin:12px 0}
.r-low{color:#22c55e}.r-medium{color:#f59e0b}.r-high{color:#ef4444}.r-hint{color:#64748b}</style></head><body>
<h1>SoftGraph 垃圾清单</h1>
<div class="sum">可释放总计 <b>${fmt(summary.totalBytes)}</b> · 条目 ${summary.totalCount} · 一键可清 ${fmt(
    summary.oneClickBytes
  )} · 扫描耗时 ${(summary.scanMs / 1000).toFixed(1)}s</div>
<table><thead><tr><th>分类</th><th>占用</th><th>条目</th><th>风险</th></tr></thead><tbody>
${summary.categories
  .map((c) => `<tr><td>${esc(c.name)}</td><td>${fmt(c.sizeBytes)}</td><td>${c.count}</td><td class="r-${c.risk}">${c.risk}</td></tr>`)
  .join('')}
</tbody></table>
<h2 style="font-size:16px;margin-top:24px">明细（前 ${rows.length} 条）</h2>
<table><thead><tr><th>文件名</th><th>完整路径</th><th>大小</th><th>风险</th></tr></thead><tbody>
${rows
  .slice(0, 3000)
  .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.fullPath)}</td><td>${fmt(r.sizeBytes)}</td><td class="r-${r.risk}">${r.risk}</td></tr>`)
  .join('')}
</tbody></table></body></html>`
}

function graphHtml(
  sw: SoftwareItem,
  stats: GraphModel['stats'],
  rows: { name: string; path: string; type: string; confidence: number; evidence: string; size: number }[]
): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(sw.name)} 依赖清单</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;background:#0f1620;color:#e2e8f0;padding:24px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px}
th,td{border-bottom:1px solid #24314a;padding:6px 8px;text-align:left}th{color:#94a3b8}
.sum{background:#182230;padding:14px;border-radius:10px;margin:12px 0}
.hi{color:#22c55e}.mid{color:#f59e0b}.lo{color:#64748b}</style></head><body>
<h1 style="font-size:20px">${esc(sw.name)} <span style="color:#94a3b8;font-size:13px">${esc(sw.version)}</span></h1>
<div class="sum">安装目录 ${esc(sw.installPath)}<br>主程序 ${esc(sw.mainExe)}<br>
依赖 ${stats.fileCount} 项 · 缺失 ${stats.missingCount} · 解析成功 ${stats.parsedOk} · 解析失败 ${stats.parseFailed}</div>
<table><thead><tr><th>文件名</th><th>完整路径</th><th>关系</th><th>置信度</th><th>证据</th></tr></thead><tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${esc(r.name)}</td><td>${esc(r.path)}</td><td>${r.type}</td><td class="${
        r.confidence >= 0.75 ? 'hi' : r.confidence >= 0.5 ? 'mid' : 'lo'
      }">${r.confidence.toFixed(2)}</td><td>${r.evidence}</td></tr>`
  )
  .join('')}
</tbody></table></body></html>`
}
