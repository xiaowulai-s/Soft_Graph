/**
 * 应用自更新（v3.0.3，electron-updater 路线）
 *
 * 策略（对齐主流 Electron 应用）：
 *  - 启动后延迟 30s 静默检查 + 每 24h 一次；设置页可手动检查
 *  - 发现新版本**不自动下载**（尊重用户流量），UI 通知后由用户点击下载
 *  - 下载完成 → 用户点「重启安装」（autoInstallOnAppQuit 兜底：退出时自动装）
 *  - 下载走 electron net（系统代理生效）；GitHub 限流用公仓库匿名额度
 *  - dev 环境不启用（app.isPackaged 守卫）
 */
import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'

export type AppUpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'not-available'; version: string }
  | { phase: 'available'; version: string; releaseNotes?: string }
  | { phase: 'downloading'; percent: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string }

type StateSink = (s: AppUpdateState) => void
let sink: StateSink | null = null
let timer: ReturnType<typeof setInterval> | null = null
let lastError = ''
const skipVersion = new Set<string>()

function emit(s: AppUpdateState): void {
  sink?.(s)
}

export function initAppUpdater(onState: StateSink): void {
  if (!app.isPackaged) return // dev 下 electron-updater 无法工作
  sink = onState

  // electron-updater 默认用 electron net（系统代理生效）；补上 UA 便于排障
  autoUpdater.logger = null
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.requestHeaders = { 'User-Agent': 'SoftGraph-AppUpdater' }
  // electron-updater 6.x 内部已用 electron net/session —— 系统代理自动生效

  autoUpdater.on('checking-for-update', () => emit({ phase: 'checking' }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    lastError = ''
    emit({ phase: 'available', version: info.version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined })
    // v3.3.1：主动系统通知 —— 用户不必打开设置才发现有新版本
    void import('electron').then(({ Notification }) => {
      if (Notification.isSupported() && !skipVersion.has(info.version)) {
        const n = new Notification({
          title: `SoftGraph ${info.version} 可更新`,
          body: '点击此处打开更新中心'
        })
        n.on('click', () => {
          const { BrowserWindow } = require('electron') as typeof import('electron')
          const w = BrowserWindow.getAllWindows()[0]
          if (w) {
            if (w.isMinimized()) w.restore()
            w.focus()
            w.webContents.send('app:updateCenterOpen')
          }
        })
        n.show()
      }
    })
  })
  autoUpdater.on('update-not-available', (info: UpdateInfo) => emit({ phase: 'not-available', version: info.version }))
  autoUpdater.on('download-progress', (p) => {
    emit({ phase: 'downloading', percent: Math.round(p.percent * 10) / 10, bytesPerSecond: p.bytesPerSecond })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => emit({ phase: 'downloaded', version: info.version }))
  autoUpdater.on('error', (e) => {
    lastError = e.message
    emit({ phase: 'error', message: e.message })
    void import('./services/logger').then((m) => {
      m.logger().warn('app-update', '检查/下载失败', { error: e.message.slice(0, 200), fallback: usedFallback })
      void m.logger().flushNow()
    })
  })

  // 启动延迟 30s 检查一次；此后每 24h
  setTimeout(() => void checkForAppUpdate().catch(() => {}), 30_000)
  timer = setInterval(() => void checkForAppUpdate().catch(() => {}), 24 * 3600 * 1000)
  app.on('will-quit', () => {
    if (timer) clearInterval(timer)
  })
}

export function lastAppUpdateError(): string {
  return lastError
}

export function addSkipVersion(v: string): void {
  skipVersion.add(v)
}

/** D1：备用更新源（Gitee 镜像，tag 固定为 stable；需维护者同步 latest.yml+安装包，缺失时自动回退官方源） */
const FALLBACK_FEED = 'https://gitee.com/ABCHikS/softgraph-mirror/releases/download/stable'

let usedFallback = false

export async function checkForAppUpdate(): Promise<{ available: boolean; version?: string }> {
  try {
    return await checkOnce()
  } catch (e) {
    if (usedFallback) throw e
    // 主源（GitHub）失败 → 切 Gitee 镜像重试一次
    usedFallback = true
    autoUpdater.setFeedURL({ provider: 'generic', url: FALLBACK_FEED })
    try {
      return await checkOnce()
    } catch (e2) {
      // 镜像也失败 → 还原官方源，下次检查重新走主源
      usedFallback = false
      autoUpdater.setFeedURL({ provider: 'github', owner: 'xiaowulai-s', repo: 'Soft_Graph' })
      // 镜像未同步（404）属于配置缺失而非真故障：对外只报主源的网络错误，避免误导
      const msg2 = (e2 as Error).message ?? ''
      if (/404/.test(msg2)) throw e
      throw e2
    }
  }
}

async function checkOnce(): Promise<{ available: boolean; version?: string }> {
  const r = await autoUpdater.checkForUpdates()
  const v = r?.updateInfo?.version
  return { available: v ? v !== app.getVersion() : false, version: v }
}

export async function downloadAppUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate()
}

export function quitAndInstallAppUpdate(): void {
  // 兜底：先销毁所有窗口（含桌面浮窗），防止任何窗口阻塞退出流程导致安装器不启动
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.destroy()
    } catch {
      /* ignore */
    }
  }
  // setImmediate：让 IPC 应答先完成，再退出进入安装
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}
