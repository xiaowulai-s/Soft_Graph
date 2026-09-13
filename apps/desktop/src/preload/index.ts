/**
 * Preload 桥接层（L4）
 * 对应技术设计方案 4.1 L4 桥接层 与 9.4 应用自身安全
 *
 * 安全约束：
 *   以 contextBridge 暴露白名单方法，渲染层拿不到 ipcRenderer 本体，
 *   也就无法调用未列出的频道或任意 Node API。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '@shared/ipc'
import type { SoftGraphApi } from '@shared/ipc'

/** 订阅事件频道，返回取消订阅函数（渲染层组件卸载时必须调用，避免监听器泄漏） */
function sub(channel: string, cb: (payload: never) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(args[0] as never)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SoftGraphApi = {
  // 软件扫描
  scanSoftware: (opts) => ipcRenderer.invoke(CH.SCAN_SOFTWARE_START, opts),
  cancelSoftwareScan: () => ipcRenderer.invoke(CH.SCAN_SOFTWARE_CANCEL),
  listSoftware: () => ipcRenderer.invoke(CH.SOFTWARE_LIST),
  getIcon: (iconHash) => ipcRenderer.invoke(CH.SOFTWARE_ICON, iconHash),
  markPortable: (payload) => ipcRenderer.invoke(CH.SOFTWARE_MARK_PORTABLE, payload),

  // 图谱
  buildGraph: (payload) => ipcRenderer.invoke(CH.GRAPH_BUILD, payload),
  expandGroup: (payload) => ipcRenderer.invoke(CH.GRAPH_EXPAND, payload),
  graphDrilldown: (fileId) => ipcRenderer.invoke(CH.GRAPH_DRILLDOWN, { fileId }),
  graphDiff: (softwareId) => ipcRenderer.invoke(CH.GRAPH_DIFF, { softwareId }),
  fileDetail: (payload) => ipcRenderer.invoke(CH.FILE_DETAIL, payload),

  // 垃圾
  scanJunk: (payload) => ipcRenderer.invoke(CH.JUNK_SCAN, payload),
  cancelJunkScan: () => ipcRenderer.invoke(CH.JUNK_CANCEL),
  junkSummary: () => ipcRenderer.invoke(CH.JUNK_SUMMARY),
  junkItems: (payload) => ipcRenderer.invoke(CH.JUNK_ITEMS, payload),
  junkRules: () => ipcRenderer.invoke(CH.JUNK_RULES),
  rulesUpdate: () => ipcRenderer.invoke(CH.RULES_UPDATE),

  // 清理
  cleanPlan: (payload) => ipcRenderer.invoke(CH.CLEAN_PLAN, payload),
  cleanExecute: (payload) => ipcRenderer.invoke(CH.CLEAN_EXECUTE, payload),
  cleanLockers: (path) => ipcRenderer.invoke(CH.CLEAN_LOCKERS, { path }),
  cleanRebootDelete: (paths) => ipcRenderer.invoke(CH.CLEAN_REBOOT_DELETE, { paths }),
  cleanElevate: (itemIds) => ipcRenderer.invoke(CH.CLEAN_ELEVATE, { itemIds }),
  quarantineList: () => ipcRenderer.invoke(CH.QUARANTINE_LIST),
  quarantineRestore: (payload) => ipcRenderer.invoke(CH.QUARANTINE_RESTORE, payload),
  quarantinePurge: (payload) => ipcRenderer.invoke(CH.QUARANTINE_PURGE, payload),

  // 系统
  reveal: (payload) => ipcRenderer.invoke(CH.FS_REVEAL, payload),
  pickDir: () => ipcRenderer.invoke(CH.FS_PICK_DIR),
  copy: (text) => ipcRenderer.invoke(CH.CLIPBOARD_WRITE, text),
  getSettings: () => ipcRenderer.invoke(CH.SETTINGS_GET),
  setSettings: (patch) => ipcRenderer.invoke(CH.SETTINGS_SET, patch),
  appInfo: () => ipcRenderer.invoke(CH.APP_INFO),
  exportReport: (payload) => ipcRenderer.invoke(CH.EXPORT_REPORT, payload),
  diagExport: () => ipcRenderer.invoke(CH.DIAG_EXPORT),

  // 浮窗
  floatGetSettings: () => ipcRenderer.invoke(CH.FLOAT_GET_SETTINGS),
  floatSetSettings: (patch) => ipcRenderer.invoke(CH.FLOAT_SET_SETTINGS, patch),
  floatToggle: (on) => ipcRenderer.invoke(CH.FLOAT_TOGGLE, on),
  floatPlugins: () => ipcRenderer.invoke(CH.FLOAT_PLUGINS),
  floatRequestTick: () => ipcRenderer.invoke(CH.FLOAT_REQUEST_TICK),
  floatReloadPlugins: () => ipcRenderer.invoke(CH.FLOAT_RELOAD_PLUGINS),
  floatOpenPluginDir: () => ipcRenderer.invoke(CH.FLOAT_PLUGIN_DIR),
  floatDrag: (payload) => ipcRenderer.invoke(CH.FLOAT_DRAG, payload),
  floatDragEnd: () => ipcRenderer.invoke(CH.FLOAT_DRAG_END),
  floatPeek: (entered) => ipcRenderer.invoke(entered ? CH.FLOAT_PEEK_ENTER : CH.FLOAT_PEEK_LEAVE),
  floatOpenMain: () => ipcRenderer.invoke(CH.FLOAT_OPEN_MAIN),
  floatResize: (payload) => ipcRenderer.invoke(CH.FLOAT_RESIZE, payload),

  // 事件订阅
  onScanProgress: (cb) => sub(CH.SCAN_SOFTWARE_PROGRESS, cb as never),
  onSoftwareBatch: (cb) => sub(CH.SCAN_SOFTWARE_BATCH, cb as never),
  onScanDone: (cb) => sub(CH.SCAN_SOFTWARE_DONE, cb as never),
  onJunkProgress: (cb) => sub(CH.JUNK_PROGRESS, cb as never),
  onCleanProgress: (cb) => sub(CH.CLEAN_PROGRESS, cb as never),
  onGraphProgress: (cb) => sub(CH.GRAPH_PROGRESS, cb as never),
  onFloatTick: (cb) => sub(CH.FLOAT_TICK, cb as never),
  onFloatSettingsChanged: (cb) => sub(CH.FLOAT_SETTINGS_CHANGED, cb as never),
  onFloatState: (cb) => sub(CH.FLOAT_STATE, cb as never)
}

// 垃圾统计变更事件（清理后刷新侧边栏）
const extra = {
  onJunkSummaryChanged: (cb: (s: unknown) => void) => sub('junk:summary:changed', cb as never)
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('apiExtra', extra)
