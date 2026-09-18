/**
 * SoftGraph 主进程入口
 * 对应技术设计方案 4.1 分层架构（L3 服务层 + L4 桥接层的主进程侧）
 */

import { app, BrowserWindow, dialog, ipcMain, clipboard, shell, screen } from 'electron'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { CH, type AppInfo } from '@shared/ipc'
import type { AppSettings, FloatSettings } from '@shared/types'
import { formatBytes } from '@shared/util'
import { openDb } from './db/driver'
import { Store } from './db/store'
import { ScanService } from './services/scan'
import { ensurePaths, ensureRules, isElevated, resolvePaths, SettingsStore, type AppPaths } from './services/env'
import { FloatWindows, floatRendererTarget, normalizeInstances, DEFAULT_INSTANCE_ID } from './float/window'
import { PluginRegistry } from './float/registry'
import { IconQueue } from './services/icon-queue'
import { extractIcons } from '@scanner/winenum'
import { initLogger, log, makeRedactor } from './services/logger'
import { describeCapabilities, loadNativeCapabilities } from '@native/capabilities'
import builtinRules from '@rules/junk-rules.json'

// 关于 10.2 的 UV_THREADPOOL_SIZE=16：libuv 在进程初始化时读取该环境变量，
// 主进程代码内设置为时已晚，故此处置放在启动脚本（package.json scripts）中通过 NODE_OPTIONS 注入；
// 默认线程池(4)在本应用的扫描负载下同样可用，只是 IO 并发略低。

let mainWindow: BrowserWindow | null = null
let store: Store
let scan: ScanService
let settings: SettingsStore
let paths: AppPaths
let float: FloatWindows
let registry: PluginRegistry
let iconQueue: IconQueue
let floatTimer: NodeJS.Timeout | null = null
let quitting = false

const DEV_URL = process.env.ELECTRON_RENDERER_URL
const RENDERER_OUT = join(__dirname, '../renderer')

// ───────────────── 窗口 ─────────────────

function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  const primary = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: Math.min(1560, Math.max(1180, primary.width - 160)),
    height: Math.min(980, Math.max(760, primary.height - 120)),
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0F1620',
    title: 'SoftGraph — 软件图谱与磁盘清理',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, // 见 9.4：开启 contextIsolation
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 禁用远程内容加载（9.4）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
  })

  mainWindow.on('close', (e) => {
    // 浮窗启用时，关主窗只是收起，浮窗继续驻留桌面
    if (!quitting && float?.isOpen) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (DEV_URL) void mainWindow.loadURL(DEV_URL)
  else void mainWindow.loadFile(join(RENDERER_OUT, 'index.html'))

  return mainWindow
}

/** 隔离区摘要（C5 诊断包用）：只统计批次/条数/体积，不含任何文件名 */
async function quarantineSummary(): Promise<{ batches: number; records: number; totalBytes: number }> {
  try {
    const list = await scan.quarantineList()
    const batches = new Set(list.map((r) => r.quarantinedPath.replace(/\\[^\\]*$/, '')))
    return {
      batches: batches.size,
      records: list.length,
      totalBytes: list.reduce((s, r) => s + r.sizeBytes, 0)
    }
  } catch {
    return { batches: 0, records: 0, totalBytes: 0 }
  }
}

function emitToAll(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// ───────────────── 图标（A2）─────────────────

/** 读已落盘的图标 PNG → dataURL；未落盘返回 null */
async function readIconData(hash: string): Promise<string | null> {
  if (!hash) return null
  try {
    const buf = await fs.readFile(join(paths.iconDir, `${hash}.png`))
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** 一批按需提取完成 → 读回 dataURL 并推给渲染层 */
async function emitIconsReady(hashes: string[]): Promise<void> {
  const icons: { hash: string; data: string }[] = []
  for (const h of hashes) {
    const data = await readIconData(h)
    if (data) icons.push({ hash: h, data })
  }
  if (icons.length > 0) emitToAll(CH.SOFTWARE_ICONS_READY, icons)
}

// ───────────────── 浮窗调度 ─────────────────

/** 所有实例启用的插件并集 —— 定时器间隔取其中最急的那个 */
function allFloatPlugins(): string[] {
  const s = settings.get().float
  return [...new Set(normalizeInstances(s).flatMap((i) => i.plugins))]
}

function restartFloatTimer(): void {
  if (floatTimer) clearInterval(floatTimer)
  floatTimer = null
  const plugins = allFloatPlugins()
  if (!float.isOpen || plugins.length === 0) return
  const interval = registry.minInterval(plugins)
  floatTimer = setInterval(() => void pushFloatTick(false), interval)
  void pushFloatTick(true)
}

async function pushFloatTick(force: boolean): Promise<void> {
  if (!float.isOpen) return
  const s = settings.get().float
  // 按实例分别采集与推送：不同实例的插件组合可以完全不同
  for (const inst of normalizeInstances(s)) {
    if (inst.plugins.length === 0) continue
    const mgr = float.managerById(inst.id)
    if (!mgr?.isOpen) continue
    try {
      const payloads = await registry.tick(inst.plugins, force)
      float.pushTick(inst.id, payloads)
    } catch {
      /* 单个实例采集失败不影响其它实例 */
    }
  }
}

// ───────────────── IPC 注册（白名单，见 9.4） ─────────────────

function registerIpc(): void {
  const h = <T extends unknown[], R>(ch: string, fn: (...args: T) => R | Promise<R>): void => {
    ipcMain.handle(ch, async (_e, ...args) => fn(...(args as T)))
  }
  // 需要知道「哪个窗口发来的」的通道用它：多实例下拖拽 / 悬停必须按来源实例分发，
  // 否则拖 A 窗口会把 B 窗口拖走
  const he = <T extends unknown[], R>(ch: string, fn: (wcId: number, ...args: T) => R | Promise<R>): void => {
    ipcMain.handle(ch, async (e, ...args) => fn(e.sender.id, ...(args as T)))
  }

  // ── 软件扫描 ──
  h(CH.SCAN_SOFTWARE_START, (opts?: { roots?: string[] }) => scan.scanSoftware(opts?.roots))
  h(CH.SCAN_SOFTWARE_CANCEL, () => scan.cancelSoftwareScan())
  h(CH.SOFTWARE_LIST, () => store.listSoftware())

  h(CH.SOFTWARE_ICON, async (iconHash: string) => {
    if (!iconHash) return null
    const data = await readIconData(iconHash)
    if (data) return data
    // 未命中磁盘缓存 → 入按需提取队列；本次先返回 null，
    // 提取完成后由 SOFTWARE_ICONS_READY 推送（前端有首字母色块兜底，不会空窗）
    iconQueue.request(iconHash)
    return null
  })

  // A2：批量取图标 —— 把「250 个软件 = 250 次串行 IPC」折成 1 次
  h(CH.SOFTWARE_ICONS, async (iconHashes: string[]) => {
    const out: Record<string, string> = {}
    const missing: string[] = []
    for (const hash of iconHashes ?? []) {
      if (!hash || out[hash]) continue
      const data = await readIconData(hash)
      if (data) out[hash] = data
      else missing.push(hash)
    }
    if (missing.length > 0) {
      const r = iconQueue.requestMany(missing)
      log.debug('icon', '图标未命中，已入队', r)
    }
    return out
  })

  h(CH.SOFTWARE_MARK_PORTABLE, async (payload: { path: string; isPortable: boolean }) => {
    store.setPortableMark(payload.path, payload.isPortable)
    await store.persist()
    return null
  })

  // ── 图谱 ──
  h(CH.GRAPH_BUILD, (payload: { softwareId: string; maxDepth?: number; force?: boolean }) =>
    scan.buildGraphFor(payload.softwareId, payload.maxDepth, payload.force)
  )
  h(CH.GRAPH_EXPAND, (payload: { softwareId: string; nodeId: string }) =>
    scan.expandGroup(payload.softwareId, payload.nodeId)
  )
  // v2.0.0 M4/D2+D4：以文件为中心的反向子图
  h(CH.GRAPH_DRILLDOWN, (payload: { fileId: string }) => scan.buildFileGraph(payload.fileId))
  // v2.0.0 M4/D3：依赖 Diff
  h(CH.GRAPH_DIFF, (payload: { softwareId: string }) => scan.graphDiff(payload.softwareId))
  // v2.0.0 M5/E4：审计日志查看
  h(CH.AUDIT_LIST, () => scan.auditRecent(50))

  // v3.0.0 I-11：全库文件检索（前缀走索引；子串仅在显式要求时启用）
  h(CH.FILE_SEARCH, (payload: { query: string; limit?: number; mode?: 'prefix' | 'substring' }) => {
    return store.searchFiles(payload?.query ?? '', { limit: payload?.limit, mode: payload?.mode })
  })

  h(CH.FILE_DETAIL, async (payload: { path: string }) => {    const p = payload.path
    try {
      const st = await fs.stat(p)
      return {
        fullPath: p,
        name: p.slice(p.lastIndexOf('\\') + 1),
        sizeBytes: st.size,
        mtime: st.mtimeMs,
        ctime: st.ctimeMs,
        signStatus: 'unknown' as const,
        refCount: store.refCountOf(p),
        exists: true,
        isDir: st.isDirectory()
      }
    } catch {
      return {
        fullPath: p,
        name: p.slice(p.lastIndexOf('\\') + 1),
        sizeBytes: 0,
        mtime: 0,
        ctime: 0,
        signStatus: 'unknown' as const,
        refCount: 0,
        exists: false,
        isDir: false
      }
    }
  })

  // ── 垃圾 ──
  h(CH.JUNK_SCAN, async (payload?: { categoryIds?: string[]; force?: boolean }) => {
    log.info('junk', '扫描开始', {
      categories: payload?.categoryIds?.length ?? 0,
      force: !!payload?.force
    })
    try {
      const r = await scan.scanJunkNow(payload?.categoryIds, payload?.force ?? false)
      log.info('junk', '扫描结束', { scanId: r.scanId })
      return r
    } catch (e) {
      log.error('junk', '扫描失败', e)
      throw e
    }
  })
  h(CH.JUNK_CANCEL, () => scan.cancelJunkScan())
  h(CH.JUNK_SUMMARY, () => scan.junkSummary())
  h(CH.JUNK_ITEMS, (payload: { categoryId: string; offset?: number; limit?: number; sort?: 'size' | 'mtime' | 'path' }) =>
    store.junkItems(payload.categoryId, payload.offset ?? 0, payload.limit ?? 200, payload.sort ?? 'size')
  )
  h(CH.JUNK_RULES, async () => {
    const rs = await scan.rules()
    return rs.rules.map((r) => ({
      id: r.id,
      name: r.name,
      risk: r.risk,
      defaultSelected: r.defaultSelected,
      description: r.description,
      roots: r.roots
    }))
  })

  // v2.0.0 M3/E2：规则库在线更新（签名 + 哈希 + 版本单调 + 结构校验）
  h(CH.RULES_UPDATE, () => scan.checkRulesUpdate())

  // ── 清理 ──
  h(CH.CLEAN_PLAN, (payload: { itemIds: string[]; useQuarantine: boolean; oneClick?: boolean }) =>
    (async () => {
      const ids = payload.oneClick ? await scan.oneClickItems() : payload.itemIds
      return scan.plan(ids, payload.useQuarantine)
    })()
  )
  h(CH.CLEAN_EXECUTE, (payload: { itemIds: string[]; useQuarantine: boolean; oneClick?: boolean }) =>
    (async () => {
      const ids = payload.oneClick ? await scan.oneClickItems() : payload.itemIds
      log.info('clean', '清理请求', {
        count: ids.length,
        quarantine: payload.useQuarantine,
        oneClick: !!payload.oneClick
      })
      const r = await scan.clean(ids, payload.useQuarantine)
      log.info('clean', '清理完成', {
        ok: r.ok,
        failed: r.failed.length,
        blocked: r.blocked.length,
        freedBytes: r.freedBytes,
        quarantineId: r.quarantineId ?? null,
        pendingReboot: r.pendingReboot
      })
      return r
    })()
  )
  h(CH.QUARANTINE_LIST, () => scan.quarantineList())

  // v2.0.0 M3/E3：提权清理（独立提权进程，只接收明确的文件清单）
  h(CH.CLEAN_ELEVATE, async (payload: { itemIds: string[] }) => {
    const ids = payload.itemIds ?? []
    log.info('elevate', '提权清理请求', { count: ids.length })
    const r = await scan.cleanElevated(ids)
    if (r.ok) {
      log.info('elevate', '提权清理完成', {
        batchId: r.batchId,
        succeeded: r.succeeded,
        freedBytes: r.freedBytes,
        failed: r.failed.length,
        rejected: r.rejected?.length ?? 0
      })
    } else {
      log.warn('elevate', '提权清理未完成', {
        denied: !!r.denied,
        unsupported: !!r.unsupported,
        rejected: r.rejected?.length ?? 0,
        error: r.error
      })
    }
    return r
  })

  // v2.0.0 M2/B3：占用查询（Restart Manager，失败不抛异常）
  h(CH.CLEAN_LOCKERS, async (payload: { path: string }) => {
    const { findLockingProcessesDetailed } = await import('@junk/locks')
    const r = await findLockingProcessesDetailed(payload.path)
    return { lockers: r.lockers, error: r.error }
  })

  // v2.0.0 M2/B2：登记重启后删除（需管理员权限；未提权时返回 needsElevation 供 UI 引导）
  h(CH.CLEAN_REBOOT_DELETE, async (payload: { paths: string[] }) => {
    const { scheduleDeleteOnReboot } = await import('@junk/locks')
    let ok = 0
    let needsElevation = false
    const errors: string[] = []
    const results: { path: string; sizeBytes: number; ok: boolean; reason?: string }[] = []
    for (const p of payload.paths ?? []) {
      const r = await scheduleDeleteOnReboot(p)
      if (r.ok) ok++
      else {
        if (r.needsElevation) needsElevation = true
        errors.push(`${p}：${r.reason ?? '未知原因'}`)
      }
      results.push({ path: p, sizeBytes: 0, ok: r.ok, reason: r.ok ? undefined : r.reason })
    }
    // 审计（M5/E4）：登记重启后删除
    await scan.appendAudit({
      ts: Date.now(),
      action: 'reboot-delete',
      taskId: 'reboot_' + Date.now(),
      freedBytes: 0,
      results
    })
    return { ok, needsElevation, errors: errors.slice(0, 10) }
  })
  h(CH.QUARANTINE_RESTORE, (payload: { ids: string[] }) => scan.quarantineRestore(payload.ids))
  h(CH.QUARANTINE_PURGE, (payload: { ids?: string[]; expiredOnly?: boolean }) => scan.quarantinePurge(payload))

  // ── 注册表残留清理（v3.0.0 · M4-UI / M4-RESTORE）──
  h(CH.REGISTRY_SCAN, async () => {
    log.info('registry', '残留扫描开始')
    const r = await scan.scanRegistry()
    log.info('registry', '残留扫描结束', {
      scanned: r.scanned,
      residues: r.residues.length,
      needsElevation: r.needsElevation,
      ms: r.scanMs
    })
    return r
  })
  h(CH.REGISTRY_CLEAN, async (payload: { keyPaths: string[] }) => {
    const keys = payload?.keyPaths ?? []
    log.info('registry', '清理请求', { count: keys.length })
    const r = await scan.cleanRegistry(keys)
    log.info('registry', '清理结果', {
      removed: r.removed,
      failed: r.failed,
      needsElevation: r.needsElevation,
      backupFailed: !!r.backupFailed,
      rejected: r.rejected.length
    })
    return r
  })
  h(CH.REGISTRY_BACKUPS, () => scan.listRegistryBackups())
  h(CH.REGISTRY_RESTORE, (payload: { file: string }) => scan.restoreRegistryBackup(payload.file))

  // ── 系统 ──
  h(CH.FS_REVEAL, async (payload: { path: string }) => {
    if (existsSync(payload.path)) shell.showItemInFolder(payload.path)
    else {
      // 文件已不存在 → 退化为打开其所在目录
      const dir = payload.path.slice(0, payload.path.lastIndexOf('\\'))
      if (existsSync(dir)) void shell.openPath(dir)
    }
    return null
  })

  h(CH.FS_PICK_DIR, async () => {
    const owner = mainWindow ?? undefined
    const r = await dialog.showOpenDialog(owner as BrowserWindow, {
      properties: ['openDirectory'],
      title: '选择要扫描便携软件的目录'
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  h(CH.CLIPBOARD_WRITE, (text: string) => {
    clipboard.writeText(text)
    return null
  })

  h(CH.SETTINGS_GET, () => settings.get())
  h(CH.SETTINGS_SET, async (patch: Partial<AppSettings>) => {
    const next = settings.patch(patch)
    if (patch.float) applyFloat(next.float)
    // 规则相关设置变化 → 规则缓存失效
    if (patch.excludePaths) scan.invalidateRules()
    return next
  })

  h(CH.APP_INFO, async (): Promise<AppInfo> => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      dbDriver: store.driverName,
      userData: paths.root,
      elevated: await isElevated()
    }
  })

  h(CH.EXPORT_REPORT, async (payload: { kind: 'graph' | 'junk'; format: 'json' | 'csv' | 'html'; softwareId?: string }) => {
    const file = await scan.exportReport(payload.kind, payload.format, payload.softwareId)
    return file
  })

  // v2.0.0 M3/C5：导出脱敏诊断包
  h(CH.DIAG_EXPORT, async () => {
    const { exportDiagnostics } = await import('./services/diagnostics')
    const r = await exportDiagnostics({
      paths,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
      settings: settings.get(),
      capabilities: describeCapabilities(await loadNativeCapabilities()),
      stats: store.dbStats(),
      quarantine: await quarantineSummary(),
      rulesSummary: await scan.rulesSummary(),
      shellFolders: scan.shellFolders ?? {},
      extraRedactions: [hostname()]
    })
    if (r.ok && r.file) shell.showItemInFolder(r.file)
    return r
  })

  // ── 浮窗（模块二） ──
  // 浮窗渲染层取设置：要带上「它自己实例」的覆盖字段（主题 / 紧凑 / 插件）
  he(CH.FLOAT_GET_SETTINGS, (wc) => {
    const s = settings.get().float
    const id = float.managerOf(wc)?.instanceId ?? DEFAULT_INSTANCE_ID
    const inst = normalizeInstances(s).find((i) => i.id === id)
    return inst ? ({ ...s, ...inst } as FloatSettings) : s
  })
  h(CH.FLOAT_SET_SETTINGS, (patch: Partial<FloatSettings>) => {
    const next = settings.patchFloat(patch)
    applyFloat(next)
    return next
  })
  h(CH.FLOAT_TOGGLE, (on?: boolean) => {
    const open = float.toggle(on)
    settings.patchFloat({ enabled: open })
    restartFloatTimer()
    return open
  })
  h(CH.FLOAT_PLUGINS, () => registry.manifests())
  h(CH.FLOAT_RELOAD_PLUGINS, async () => {
    const list = await registry.load()
    restartFloatTimer()
    return list
  })
  // v2.0.0 M5/F2：一键安装插件（https URL 或源码）
  h(CH.FLOAT_PLUGIN_INSTALL, async (payload: { url?: string; source?: string }) => {
    const r = payload.url
      ? await registry.installFromUrl(payload.url)
      : payload.source
        ? await registry.installSource(payload.source)
        : { ok: false, error: '未提供 url 或 source' }
    if (r.ok) restartFloatTimer()
    return r
  })
  // v2.0.0 M5/F1：用户授权插件能力
  h(CH.FLOAT_PLUGIN_APPROVE, async (payload: { id: string; permissions: string[] }) => {
    const list = await registry.approvePermissions(payload.id, payload.permissions ?? [])
    restartFloatTimer()
    return list
  })
  // v2.0.0 M5/F2：删除外部插件
  h(CH.FLOAT_PLUGIN_REMOVE, async (payload: { id: string }) => registry.removeExternal(payload.id))
  h(CH.FLOAT_PLUGIN_DIR, async () => {
    await fs.mkdir(registry.externalDir, { recursive: true }).catch(() => {})
    void shell.openPath(registry.externalDir)
    return null
  })
  // 请求单次刷新：按实例各自的插件组合重采一遍
  h(CH.FLOAT_REQUEST_TICK, async () => {
    await pushFloatTick(true)
    return null
  })
  // 以下五个通道必须知道来源窗口 —— 多实例下「拖哪个窗口」只有 sender 能回答
  he(CH.FLOAT_DRAG, (wc, payload: { dx: number; dy: number }) => {
    float.dragBy(wc, payload.dx, payload.dy)
    return null
  })
  he(CH.FLOAT_DRAG_END, (wc) => {
    float.endDrag(wc)
    return null
  })
  he(CH.FLOAT_PEEK_ENTER, (wc) => {
    float.setHovering(wc, true)
    return null
  })
  he(CH.FLOAT_PEEK_LEAVE, (wc) => {
    float.setHovering(wc, false)
    return null
  })
  he(CH.FLOAT_RESIZE, (wc, payload: { height: number }) => {
    float.setContentHeight(wc, payload.height)
    return null
  })
  h(CH.FLOAT_OPEN_MAIN, () => {
    createMainWindow().show()
    mainWindow?.focus()
    return null
  })
}

function applyFloat(s: FloatSettings): void {
  if (s.enabled && !float.isOpen) float.open()
  else if (!s.enabled && float.isOpen) float.close()
  // 浮窗已开启时新增实例：sync() 只创建管理器，窗口要显式打开才会出现（F4-UI）
  if (s.enabled) float.openMissing()
  float.applySettings(s)
  float.pushSettings(s)
  restartFloatTimer()
}

// ───────────────── 启动 ─────────────────

async function bootstrap(): Promise<void> {
  paths = resolvePaths()
  await ensurePaths(paths)
  await ensureRules(paths, builtinRules)

  // ── 结构化日志（M3/C5）──
  // 脱敏在**写入前**完成，因此磁盘上的日志本身就不含用户名/计算机名
  const logLevel = (process.env.SG_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info'
  const lg = initLogger({ dir: paths.logDir, level: logLevel, echo: !!DEV_URL })
  void lg.prune()
  log.info('app', '启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    dev: !!DEV_URL
  })

  settings = await SettingsStore.load(paths.settingsFile)

  const db = await openDb({
    file: paths.dbFile,
    wasmDir: join(process.resourcesPath || '', 'sqljs')
  })
  store = new Store(db)
  store.init()

  scan = new ScanService(store, paths, settings, emitToAll)

  // A2：图标按需提取队列 —— 渲染层请求未命中的图标 → 聚批（250ms）→ 一次 PowerShell
  //     → 落盘 → 读回 dataURL 推送。替代原先「扫描后无条件提取全部」的做法。
  iconQueue = new IconQueue(
    {
      resolveSources: (hash) => scan.iconSourcesOf(hash),
      extract: (reqs) => extractIcons(reqs, paths.iconDir),
      onReady: (hashes) => void emitIconsReady(hashes),
      log: (msg, meta) => log.debug('icon', msg, meta)
    },
    { debounceMs: 250 }
  )
  void scan.purgeExpired()
  // 后台预热 COM 反查索引（M2/B4），让用户点开图谱时 E6 证据已就绪
  void scan.warmupComIndex()
  // 解析用户库目录并把结果交给日志脱敏器（含被重定向到其它盘的库目录）
  void scan.ensureShellFolders().then((folders) => {
    const extra = Object.values(folders ?? {}).filter((v): v is string => !!v)
    lg.setRedactor(
      makeRedactor({
        userProfile: process.env.USERPROFILE,
        computerName: hostname(),
        extraPaths: extra
      })
    )
    log.info('app', '用户库目录已解析', { count: Object.keys(folders ?? {}).length })
  })

  // 浮窗与插件
  const target = floatRendererTarget(DEV_URL, RENDERER_OUT)
  float = new FloatWindows(
    {
      getSettings: () => settings.get().float,
      patchSettings: (patch) => settings.patchFloat(patch),
      onOpenMain: () => {
        createMainWindow().show()
        mainWindow?.focus()
      }
    },
    join(__dirname, '../preload/index.js'),
    target.url,
    target.file
  )

  registry = new PluginRegistry(paths.pluginDir, {
    junkTotalBytes: () => store.junkSummary()?.totalBytes ?? 0,
    junkOneClickBytes: () => store.junkSummary()?.oneClickBytes ?? 0,
    quarantineCount: () => Number(store.getKv('quarantine:count') ?? 0),
    softwareCount: () => store.listSoftware().length,
    lastJunkScanAt: () => {
      const s = store.lastScan('junk')
      return s?.finished_at ? Number(s.finished_at) : null
    },
    psJson: async <T,>(script: string, timeoutMs?: number) => {
      const { psJson } = await import('@scanner/psbridge')
      return psJson<T>(script, { timeoutMs: timeoutMs ?? 20_000 })
    }
 }, join(paths.root, 'plugin-approvals.json'))
  await registry.load()

  registerIpc()
  createMainWindow()

  if (settings.get().float.enabled) {
    float.open()
    restartFloatTimer()
  }

  // 隔离区条目数缓存，供浮窗插件低成本读取
  void (async () => {
    try {
      const list = await scan.quarantineList()
      store.setKv('quarantine:count', String(list.length))
    } catch {
      /* ignore */
    }
  })()
}

// 单实例：第二次启动时唤起已有窗口，避免两个实例同时扫描/删除
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    createMainWindow().show()
    mainWindow?.focus()
  })

  app.whenReady().then(async () => {
    try {
      await bootstrap()
    } catch (e) {
      dialog.showErrorBox('SoftGraph 启动失败', (e as Error).stack || (e as Error).message)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    // 浮窗在驻留时不退出应用
    if (float?.isOpen) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', async () => {
    quitting = true
    log.info('app', '退出', { uptimeMs: Math.round(process.uptime() * 1000) })
    if (floatTimer) clearInterval(floatTimer)
    iconQueue?.dispose()
    registry?.dispose()
    scan?.disposeWorker()
    await scan?.flushAudit().catch(() => {})
    await settings?.flush()
    await store?.close()
    // 结束常驻会话池（A1：避免遗留子进程）
    const { shutdownPsPool } = await import('@scanner/psbridge')
    shutdownPsPool()
    // 日志落盘（C5）：放在最后，确保前面的关闭动作都有痕迹
    const { logger } = await import('./services/logger')
    await logger().flushNow()
  })

  app.on('activate', () => createMainWindow())
}

export { formatBytes }
