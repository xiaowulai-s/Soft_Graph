/**
 * IPC 频道定义，对应技术设计方案 6.3
 * 渲染层通过 Preload 暴露的 window.api 调用，全部为异步 Promise 接口。
 * 频道名统一命名空间，Preload 以白名单方式转发（见 9.4 应用自身安全）。
 */

import type {
  AppSettings,
  CleanResult,
  DeletePlan,
  ElevateOutcome,
  FileDetail,
  FloatPluginManifest,
  FloatPluginPayload,
  FloatSettings,
  GraphModel,
  JunkItem,
  JunkSummary,
  LockerInfo,
  QuarantineRecord,
  ScanProgress,
  SoftwareItem
} from './types'

export const CH = {
  // 软件扫描
  SCAN_SOFTWARE_START: 'scan:software:start',
  SCAN_SOFTWARE_CANCEL: 'scan:software:cancel',
  SCAN_SOFTWARE_PROGRESS: 'scan:software:progress',
  SCAN_SOFTWARE_BATCH: 'scan:software:batch',
  SCAN_SOFTWARE_DONE: 'scan:software:done',
  SOFTWARE_LIST: 'software:list',
  SOFTWARE_ICON: 'software:icon',
  SOFTWARE_MARK_PORTABLE: 'software:markPortable',

  // 图谱
  GRAPH_BUILD: 'graph:build',
  GRAPH_EXPAND: 'graph:expand',
  GRAPH_PROGRESS: 'graph:progress',
  FILE_DETAIL: 'file:detail',

  // 垃圾
  JUNK_SCAN: 'junk:scan',
  JUNK_CANCEL: 'junk:cancel',
  JUNK_PROGRESS: 'junk:progress',
  JUNK_SUMMARY: 'junk:summary',
  JUNK_ITEMS: 'junk:items',
  JUNK_RULES: 'junk:rules',

  // 清理
  CLEAN_PLAN: 'clean:plan',
  CLEAN_EXECUTE: 'clean:execute',
  CLEAN_PROGRESS: 'clean:progress',
  /** v2.0.0 M2/B3：查询占用某文件的进程（Restart Manager） */
  CLEAN_LOCKERS: 'clean:lockers',
  /** v2.0.0 M2/B2：登记重启后删除（MOVEFILE_DELAY_UNTIL_REBOOT） */
  CLEAN_REBOOT_DELETE: 'clean:rebootDelete',
  /** v2.0.0 M3/E3：提权清理——只接收明确文件清单，走独立提权进程 */
  CLEAN_ELEVATE: 'clean:elevate',
  QUARANTINE_LIST: 'quarantine:list',
  QUARANTINE_RESTORE: 'quarantine:restore',
  QUARANTINE_PURGE: 'quarantine:purge',

  // 系统
  FS_REVEAL: 'fs:reveal',
  FS_PICK_DIR: 'fs:pickDir',
  CLIPBOARD_WRITE: 'clipboard:write',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  APP_INFO: 'app:info',
  EXPORT_REPORT: 'export:report',
  /** v2.0.0 M3/C5：导出脱敏诊断包 */
  DIAG_EXPORT: 'diag:export',

  // 浮窗（模块二）
  FLOAT_GET_SETTINGS: 'float:getSettings',
  FLOAT_SET_SETTINGS: 'float:setSettings',
  FLOAT_TOGGLE: 'float:toggle',
  FLOAT_PLUGINS: 'float:plugins',
  FLOAT_TICK: 'float:tick',
  FLOAT_REQUEST_TICK: 'float:requestTick',
  FLOAT_SETTINGS_CHANGED: 'float:settingsChanged',
  FLOAT_DRAG: 'float:drag',
  FLOAT_DRAG_END: 'float:dragEnd',
  FLOAT_PEEK_ENTER: 'float:peekEnter',
  FLOAT_PEEK_LEAVE: 'float:peekLeave',
  FLOAT_OPEN_MAIN: 'float:openMain',
  FLOAT_RELOAD_PLUGINS: 'float:reloadPlugins',
  FLOAT_PLUGIN_DIR: 'float:pluginDir',
  FLOAT_RESIZE: 'float:resize',
  FLOAT_STATE: 'float:state'
} as const

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  dbDriver: string
  userData: string
  elevated: boolean
}

/** window.api 的完整类型契约 */
export interface SoftGraphApi {
  scanSoftware(opts?: { roots?: string[] }): Promise<{ scanId: string }>
  cancelSoftwareScan(): Promise<void>
  listSoftware(): Promise<SoftwareItem[]>
  getIcon(iconHash: string): Promise<string | null>
  markPortable(payload: { path: string; isPortable: boolean }): Promise<SoftwareItem | null>

  buildGraph(payload: { softwareId: string; maxDepth?: number }): Promise<GraphModel>
  expandGroup(payload: { softwareId: string; nodeId: string }): Promise<GraphModel>
  fileDetail(payload: { path: string }): Promise<FileDetail>

  scanJunk(payload?: { categoryIds?: string[]; force?: boolean }): Promise<{ scanId: string }>
  cancelJunkScan(): Promise<void>
  junkSummary(): Promise<JunkSummary | null>
  junkItems(payload: {
    categoryId: string
    offset?: number
    limit?: number
    sort?: 'size' | 'mtime' | 'path'
  }): Promise<{ items: JunkItem[]; total: number }>
  junkRules(): Promise<{ id: string; name: string; risk: string; defaultSelected: boolean; description?: string }[]>

  cleanPlan(payload: { itemIds: string[]; useQuarantine: boolean }): Promise<DeletePlan>
  cleanExecute(payload: { itemIds: string[]; useQuarantine: boolean }): Promise<CleanResult>
  /** 占用查询（Restart Manager；失败返回空数组与原因，不抛异常） */
  cleanLockers(path: string): Promise<{ lockers: LockerInfo[]; error?: string }>
  /** 重启后删除登记；需要管理员权限，未提权时返回 needsElevation */
  cleanRebootDelete(paths: string[]): Promise<{ ok: number; needsElevation: boolean; errors: string[] }>
  /**
   * 提权清理（E3）：把普通权限删不掉的文件交给独立提权进程。
   * 只接受已扫描出的条目 id —— 提权进程侧不会收到任何通配符或命令。
   */
  cleanElevate(itemIds: string[]): Promise<ElevateOutcome>
  quarantineList(): Promise<QuarantineRecord[]>
  quarantineRestore(payload: { ids: string[] }): Promise<{ ok: number; failed: string[] }>
  quarantinePurge(payload: { ids?: string[]; expiredOnly?: boolean }): Promise<{ ok: number; freed: number }>

  reveal(payload: { path: string }): Promise<void>
  pickDir(): Promise<string | null>
  copy(text: string): Promise<void>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  appInfo(): Promise<AppInfo>
  exportReport(payload: { kind: 'graph' | 'junk'; format: 'json' | 'csv' | 'html'; softwareId?: string }): Promise<string | null>
  /** 导出脱敏诊断包（C5）；返回 zip 绝对路径，失败返回 null */
  diagExport(): Promise<{ ok: boolean; file?: string; bytes?: number; error?: string }>

  // 浮窗
  floatGetSettings(): Promise<FloatSettings>
  floatSetSettings(patch: Partial<FloatSettings>): Promise<FloatSettings>
  floatToggle(on?: boolean): Promise<boolean>
  floatPlugins(): Promise<FloatPluginManifest[]>
  floatRequestTick(): Promise<FloatPluginPayload[]>
  floatReloadPlugins(): Promise<FloatPluginManifest[]>
  floatOpenPluginDir(): Promise<void>
  floatDrag(payload: { dx: number; dy: number }): Promise<void>
  floatDragEnd(): Promise<void>
  floatPeek(entered: boolean): Promise<void>
  floatOpenMain(): Promise<void>
  floatResize(payload: { height: number }): Promise<void>

  // 事件订阅
  onScanProgress(cb: (p: ScanProgress) => void): () => void
  onSoftwareBatch(cb: (items: SoftwareItem[]) => void): () => void
  onScanDone(cb: (p: { scanId: string; total: number; ms: number }) => void): () => void
  onJunkProgress(cb: (p: ScanProgress) => void): () => void
  onCleanProgress(cb: (p: { taskId: string; done: number; total: number; current: string }) => void): () => void
  onGraphProgress(cb: (p: ScanProgress) => void): () => void
  onFloatTick(cb: (payloads: FloatPluginPayload[]) => void): () => void
  onFloatSettingsChanged(cb: (s: FloatSettings) => void): () => void
  onFloatState(cb: (s: { docked: 'left' | 'right' | 'top' | 'none'; hidden: boolean }) => void): () => void
}
