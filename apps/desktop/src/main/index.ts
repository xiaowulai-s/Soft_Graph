/**
 * SoftGraph 主进程入口
 * 对应技术设计方案 4.1 分层架构（L3 服务层 + L4 桥接层的主进程侧）
 */

import { app, BrowserWindow, dialog, ipcMain, clipboard, shell, screen } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { CH, type AppInfo } from '@shared/ipc'
import type { AppSettings, FloatSettings } from '@shared/types'
import { formatBytes } from '@shared/util'
import { openDb } from './db/driver'
import { Store } from './db/store'
import { ScanService } from './services/scan'
import { ensurePaths, ensureRules, isElevated, resolvePaths, SettingsStore, type AppPaths } from './services/env'
import { FloatWindowManager, floatRendererTarget } from './float/window'
import { PluginRegistry } from './float/registry'
import builtinRules from '@rules/junk-rules.json'

// 关于 10.2 的 UV_THREADPOOL_SIZE=16：libuv 在进程初始化时读取该环境变量，
// 主进程代码内设置为时已晚，故此处置放在启动脚本（package.json scripts）中通过 NODE_OPTIONS 注入；
// 默认线程池(4)在本应用的扫描负载下同样可用，只是 IO 并发略低。

let mainWindow: BrowserWindow | null = null
let store: Store
let scan: ScanService
let settings: SettingsStore
let paths: AppPaths
let float: FloatWindowManager
let registry: PluginRegistry
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

function emitToAll(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// ───────────────── 浮窗调度 ─────────────────

function restartFloatTimer(): void {
  if (floatTimer) clearInterval(floatTimer)
  floatTimer = null
  const s = settings.get().float
  if (!float.isOpen || s.plugins.length === 0) return
  const interval = registry.minInterval(s.plugins)
  floatTimer = setInterval(() => void pushFloatTick(false), interval)
  void pushFloatTick(true)
}

async function pushFloatTick(force: boolean): Promise<void> {
  if (!float.isOpen) return
  try {
    const s = settings.get().float
    const payloads = await registry.tick(s.plugins, force)
    float.pushTick(payloads)
  } catch {
    /* 单轮采集失败不影响后续 */
  }
}

// ───────────────── IPC 注册（白名单，见 9.4） ─────────────────

function registerIpc(): void {
  const h = <T extends unknown[], R>(ch: string, fn: (...args: T) => R | Promise<R>): void => {
    ipcMain.handle(ch, async (_e, ...args) => fn(...(args as T)))
  }

  // ── 软件扫描 ──
  h(CH.SCAN_SOFTWARE_START, (opts?: { roots?: string[] }) => scan.scanSoftware(opts?.roots))
  h(CH.SCAN_SOFTWARE_CANCEL, () => scan.cancelSoftwareScan())
  h(CH.SOFTWARE_LIST, () => store.listSoftware())

  h(CH.SOFTWARE_ICON, async (iconHash: string) => {
    if (!iconHash) return null
    const p = join(paths.iconDir, `${iconHash}.png`)
    try {
      const buf = await fs.readFile(p)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
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

  h(CH.FILE_DETAIL, async (payload: { path: string }) => {
    const p = payload.path
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
  h(CH.JUNK_SCAN, (payload?: { categoryIds?: string[]; force?: boolean }) =>
    scan.scanJunkNow(payload?.categoryIds, payload?.force ?? false)
  )
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
      return scan.clean(ids, payload.useQuarantine)
    })()
  )
  h(CH.QUARANTINE_LIST, () => scan.quarantineList())

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
    for (const p of payload.paths ?? []) {
      const r = await scheduleDeleteOnReboot(p)
      if (r.ok) ok++
      else {
        if (r.needsElevation) needsElevation = true
        errors.push(`${p}：${r.reason ?? '未知原因'}`)
      }
    }
    return { ok, needsElevation, errors: errors.slice(0, 10) }
  })
  h(CH.QUARANTINE_RESTORE, (payload: { ids: string[] }) => scan.quarantineRestore(payload.ids))
  h(CH.QUARANTINE_PURGE, (payload: { ids?: string[]; expiredOnly?: boolean }) => scan.quarantinePurge(payload))

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

  // ── 浮窗（模块二） ──
  h(CH.FLOAT_GET_SETTINGS, () => settings.get().float)
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
  h(CH.FLOAT_PLUGIN_DIR, async () => {
    await fs.mkdir(registry.externalDir, { recursive: true }).catch(() => {})
    void shell.openPath(registry.externalDir)
    return null
  })
  h(CH.FLOAT_REQUEST_TICK, async () => registry.tick(settings.get().float.plugins, true))
  h(CH.FLOAT_DRAG, (payload: { dx: number; dy: number }) => {
    float.dragBy(payload.dx, payload.dy)
    return null
  })
  h(CH.FLOAT_DRAG_END, () => {
    float.endDrag()
    return null
  })
  h(CH.FLOAT_PEEK_ENTER, () => {
    float.setHovering(true)
    return null
  })
  h(CH.FLOAT_PEEK_LEAVE, () => {
    float.setHovering(false)
    return null
  })
  h(CH.FLOAT_RESIZE, (payload: { height: number }) => {
    float.setContentHeight(payload.height)
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
  float.applySettings(s)
  float.pushSettings(s)
  restartFloatTimer()
}

// ───────────────── 启动 ─────────────────

async function bootstrap(): Promise<void> {
  paths = resolvePaths()
  await ensurePaths(paths)
  await ensureRules(paths, builtinRules)

  settings = await SettingsStore.load(paths.settingsFile)

  const db = await openDb({
    file: paths.dbFile,
    wasmDir: join(process.resourcesPath || '', 'sqljs')
  })
  store = new Store(db)
  store.init()

  scan = new ScanService(store, paths, settings, emitToAll)
  void scan.purgeExpired()
  // 后台预热 COM 反查索引（M2/B4），让用户点开图谱时 E6 证据已就绪
  void scan.warmupComIndex()

  // 浮窗与插件
  const target = floatRendererTarget(DEV_URL, RENDERER_OUT)
  float = new FloatWindowManager(
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
  })
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
    if (floatTimer) clearInterval(floatTimer)
    registry?.dispose()
    await settings?.flush()
    await store?.close()
    // 结束常驻 PowerShell 会话池（A1：避免遗留 powershell.exe 子进程）
    const { shutdownPsPool } = await import('@scanner/psbridge')
    shutdownPsPool()
  })

  app.on('activate', () => createMainWindow())
}

export { formatBytes }
