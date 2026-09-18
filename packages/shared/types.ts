/**
 * SoftGraph 核心数据结构
 * 对应技术设计方案 6.1 核心数据结构 / 5.3 图谱数据模型
 */

// ───────────────────────── 软件 ─────────────────────────

export type SoftwareSource = 'registry' | 'msi' | 'store' | 'portable' | 'service'

export interface SoftwareItem {
  /** 'sw_' + sha1(installPath|name) 前 16 位 */
  id: string
  name: string
  version: string
  publisher: string
  /** 安装根目录，用于 E1 目录归属证据 */
  installPath: string
  /** 主可执行文件路径，图谱解析入口 */
  mainExe: string
  /** 图标缓存键（sha256 前 16 位） */
  iconHash: string
  source: SoftwareSource
  sizeBytes: number
  installDate?: number
  /** 仅便携软件：启发式评分 */
  portableScore?: number
  /** 便携软件评分明细，用于 UI 解释判定原因 */
  portableEvidence?: string[]
  /** 卸载命令（来自注册表 UninstallString） */
  uninstallString?: string
  arch?: PeArch
}

// ───────────────────────── 文件 ─────────────────────────

export type FileKind = 'exe' | 'dll' | 'ocx' | 'data' | 'config' | 'plugin' | 'resource'
export type SignStatus = 'signed' | 'unsigned' | 'unknown'
export type PeArch = 'x86' | 'x64' | 'arm64' | 'unknown'

export interface FileNode {
  id: string
  fullPath: string
  name: string
  sizeBytes: number
  mtime: number
  kind: FileKind
  ext: string
  version?: string
  signStatus?: SignStatus
  arch?: PeArch
  /** true = 导入表命中但磁盘上找不到（缺失依赖，FR-16） */
  missing?: boolean
  /** 引用该文件的软件数，用于共享惩罚与「被 N 个软件引用」展示 */
  refCount?: number
  /** PE 解析状态，failed 时 UI 灰显提示「未能解析」 */
  parseStatus?: 'ok' | 'failed' | 'not_pe' | 'skipped'
}

// ───────────────────────── 依赖 ─────────────────────────

export type DependencyType =
  | 'imports'
  | 'delay_loads'
  | 'dotnet_ref'
  | 'sxs'
  | 'com'
  | 'service'
  | 'shortcut'
  | 'data'
  | 'binds'

/** 八类依赖证据编号，见设计文档 5.2.1 */
export type EvidenceCode = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8'

export const EVIDENCE_WEIGHT: Record<EvidenceCode, number> = {
  E1: 0.6, // 安装目录归属
  E2: 0.9, // PE 静态导入表
  E3: 0.75, // 延迟导入表
  E4: 0.9, // .NET 程序集引用
  E5: 0.8, // SxS 并行程序集清单
  E6: 0.7, // COM 与服务注册
  E7: 0.5, // 快捷方式关联
  E8: 1.0 // 运行时映像加载（ETW，可选）
}

export const EVIDENCE_LABEL: Record<EvidenceCode, string> = {
  E1: '安装目录归属',
  E2: 'PE 静态导入表',
  E3: '延迟导入表',
  E4: '.NET 程序集引用',
  E5: 'SxS 并行程序集清单',
  E6: 'COM 与服务注册',
  E7: '快捷方式关联',
  E8: '运行时映像加载'
}

export const DEP_TYPE_LABEL: Record<DependencyType, string> = {
  imports: '静态导入',
  delay_loads: '延迟导入',
  dotnet_ref: '.NET 引用',
  sxs: 'SxS 清单',
  com: 'COM 注册',
  service: '服务宿主',
  shortcut: '快捷方式',
  data: '数据文件',
  binds: '目录归属'
}

export interface DependencyEdge {
  sourceId: string
  targetId: string
  type: DependencyType
  /** 0~1，由证据加权得出，见 7.1 */
  confidence: number
  /** ['E2','E5'] 支持溯源 */
  evidence: EvidenceCode[]
}

// ───────────────────────── 图谱 ─────────────────────────

export type GraphNodeType = 'software' | 'file' | 'group'

/** 聚合分组策略，见 5.3 分组策略 */
export type GroupPolicy = 'system' | 'shared_runtime' | 'plugin' | 'user_data' | 'missing' | 'other'

export const GROUP_LABEL: Record<GroupPolicy, string> = {
  system: '系统依赖',
  shared_runtime: '共享运行库',
  plugin: '插件与扩展',
  user_data: '用户数据',
  missing: '缺失依赖',
  other: '其他关联'
}

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  /** 径向分层：0=中心, 1=T1, 2=T2, 3=T3 */
  tier: 0 | 1 | 2 | 3
  radius: number
  /** file 节点专有 */
  file?: FileNode
  /** software 节点专有 */
  software?: SoftwareItem
  /** group 节点专有 */
  policy?: GroupPolicy
  /** 聚合节点收纳的子节点数 */
  collapsedCount?: number
  /** 聚合节点收纳的子节点（展开时使用） */
  children?: GraphNode[]
  /** 布局坐标（缓存复用） */
  x?: number
  y?: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: DependencyType
  confidence: number
  evidence: EvidenceCode[]
  /** 缺失依赖 → 红色虚线 */
  missing?: boolean
}

export interface GraphStats
{
  nodeCount: number
  edgeCount: number
  fileCount: number
  missingCount: number
  parsedOk: number
  parseFailed: number
  totalSizeBytes: number
  buildMs: number
  fromCache: boolean
  /** 各分组收纳数量 */
  groups: Record<string, number>
}

export interface GraphModel {
  softwareId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
}

// ───────────────── 依赖 Diff（v2.0.0 M4/D3）─────────────────────────

export interface GraphSnapshot {
  builtAt: number
  /** normKey(fullPath) → { name, confidence } */
  files: Record<string, { name: string; confidence: number }>
}

export interface DiffChanged {
  path: string
  name: string
  from: number
  to: number
}

export interface GraphDiff {
  added: { path: string; name: string; confidence: number }[]
  removed: { path: string; name: string; confidence: number }[]
  changed: DiffChanged[]
  fromAt: number
  toAt: number
}

// ───────────────── 审计日志（v2.0.0 M5/E4）─────────────────────────

export type AuditAction =
  | 'clean'
  | 'clean-direct'
  | 'clean-elevate'
  | 'reboot-delete'
  | 'restore'
  | 'purge'
  /** 注册表残留清理（v3.0.0 · M4） */
  | 'registry-clean'
  /** 注册表备份还原 */
  | 'registry-restore'

export interface AuditFileResult {
  path: string
  sizeBytes: number
  ok: boolean
  reason?: string
}

export interface AuditEntry {
  ts: number
  action: AuditAction
  taskId: string
  batchId?: string
  freedBytes: number
  results: AuditFileResult[]
}

// ───────────────────────── 垃圾 ─────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'hint'

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  hint: '提示'
}

export interface JunkItem {
  id: string
  categoryId: string
  fullPath: string
  name: string
  sizeBytes: number
  mtime: number
  risk: RiskLevel
  /** 重复文件分组 ID，同组保留一份 */
  groupId?: string
  /** 该项是否为分组内建议保留的一份 */
  keep?: boolean
  /** 被占用，需延迟删除 */
  locked?: boolean
  isDir?: boolean
}

/** 垃圾规则（JSON 配置驱动，见 7.4） */
export interface JunkRule {
  id: string
  name: string
  description?: string
  risk: RiskLevel
  defaultSelected: boolean
  /** 特殊算法类：重复文件 / 超大文件 / 失效快捷方式 */
  algorithm?: 'duplicate' | 'bigfile' | 'deadlink' | 'orphan'
  match?: {
    roots: string[]
    patterns?: string[]
    exclude?: string[]
    maxAgeDays?: number
    minSizeBytes?: number
    /** 目标是目录本身（如 Windows.old），整目录计入 */
    wholeDir?: boolean
    maxDepth?: number
  }
  options?: Record<string, number | string | boolean>
}

export interface JunkCategorySummary {
  id: string
  name: string
  description?: string
  risk: RiskLevel
  defaultSelected: boolean
  sizeBytes: number
  count: number
  /** 扫描是否因权限失败 */
  denied?: boolean
  /** v2.0.0 M2/A5：本次结果是否来自增量缓存（目录签名未变化） */
  cached?: boolean
}

export interface JunkSummary {
  scanId: string
  totalBytes: number
  totalCount: number
  /** 一键删除可释放（仅低风险且默认勾选） */
  oneClickBytes: number
  categories: JunkCategorySummary[]
  scanMs: number
  scannedFiles: number
}

// ───────────────────────── 清理 ─────────────────────────

export interface DeletePlan
{
  taskId: string
  items: JunkItem[]
  totalBytes: number
  useQuarantine: boolean
  riskBreakdown: Record<RiskLevel, number>
  /** 被白名单硬拦截的项 */
  blocked: { path: string; reason: string }[]
}

/** 文件占用者（v2.0.0 M2/B3 · Restart Manager） */
export interface LockerInfo {
  pid: number
  name: string
  /** Restart Manager 应用类型：0=未知 1=主窗口 2=其他窗口 3=服务 4=资源管理器 5=控制台 6=关键进程 */
  appType: number
  /** 系统是否认为该进程可安全重启 */
  restartable: boolean
}

export interface CleanResult {
  taskId: string
  ok: number
  failed: { path: string; reason: string }[]
  blocked: { path: string; reason: string }[]
  freedBytes: number
  quarantineId?: string
  pendingReboot: number
}

/**
 * 提权清理结果（v2.0.0 M3/E3）。
 * 提权通道只处理**明确的文件清单**，因此结果里没有 blocked（清单外的项在生成阶段就被拒了）。
 */
export interface ElevateOutcome {
  ok: boolean
  /** 用户在 UAC 处取消授权 */
  denied?: boolean
  /** 平台不支持（非 Windows） */
  unsupported?: boolean
  batchId?: string
  succeeded?: number
  freedBytes?: number
  failed: { path: string; reason: string }[]
  /** 生成阶段被拒绝的条目（含原因，供 UI 与审计呈现） */
  rejected?: { path: string; reason: string }[]
  error?: string
}

export interface QuarantineRecord {
  id: string
  originalPath: string
  quarantinedPath: string
  sizeBytes: number
  sha256?: string
  deletedAt: number
  keepUntil: number
  categoryId: string
  risk: RiskLevel
  isDir?: boolean
}

// ───────────────── 注册表清理（v3.0.0 · M4）─────────────────────────

/**
 * 一条「卸载残留」注册表项。
 * 只承载展示与定位所需字段 —— 删除时上层只回传 keyPath，
 * 由主进程重新枚举取回完整信息，渲染层无法伪造键内容。
 */
export interface RegistryResidueItem {
  /** PowerShell 路径，如 HKLM:\SOFTWARE\...\Uninstall\{GUID} */
  keyPath: string
  hive: 'HKLM' | 'HKCU'
  view: '64' | '32'
  displayName: string
  publisher: string
  displayVersion: string
  installLocation: string
  uninstallString: string
  /** 判定为残留的依据（逐条可读） */
  reasons: string[]
  risk: RiskLevel
  /** 安装目录仍存在时的实测体积；目录已不存在则为 0 */
  sizeBytes: number
}

export interface RegistryScanResult {
  scanMs: number
  /** 枚举到的 Uninstall 键总数（不是残留数） */
  scanned: number
  residues: RegistryResidueItem[]
  /** 含 HKLM 项且当前未提权 → 清理会失败，UI 据此提示 */
  needsElevation: boolean
}

export interface RegistryCleanOutcome {
  ok: boolean
  removed: number
  failed: number
  needsElevation: boolean
  /** 备份失败 → 已拒绝删除（内核硬约束：备份拿不到就什么都不做） */
  backupFailed?: boolean
  /** 备份快照绝对路径，供「还原」入口直接引用 */
  backupFile?: string
  /** 未通过白名单 / 未能回查到枚举结果的键 */
  rejected: string[]
  error?: string
}

export interface RegistryBackupInfo {
  file: string
  createdAt: string
  keyCount: number
}

// ───────────────── 文件检索（v3.0.0 · I-11）─────────────────────────

export interface FileSearchHit {
  id: string
  fullPath: string
  name: string
  sizeBytes: number
  ext: string
  kind: string
  /** 被多少个软件引用（结果排序依据） */
  refCount: number
  missing: boolean
}

/**
 * 实际生效的检索策略。**不是装饰字段** —— 它决定 UI 该不该提示「这次是走索引还是全表」：
 *   - `prefix-index`：范围查询命中 idx_file_path_lc / idx_file_name_lc（默认路径）
 *   - `unindexed-scan`：小写派生列迁移失败，范围比较退化为扫描
 *   - `substring-scan`：子串检索必然是全表（`%q%` 无法用 B+Tree 索引）
 *   - `fts5`：驱动支持 FTS5 时用 MATCH（**打包应用到不了这条**，见 docs/09）
 */
export type FileSearchStrategy = 'prefix-index' | 'unindexed-scan' | 'substring-scan' | 'fts5'

export interface FileSearchOptions {
  limit?: number
  /** 'prefix'（默认，走索引）| 'substring'（显式启用，代价高） */
  mode?: 'prefix' | 'substring'
}

export interface FileSearchResult {
  hits: FileSearchHit[]
  strategy: FileSearchStrategy
  /** 合并去重后的候选总数（可能大于 hits.length，因为 hits 被 limit 截断） */
  total: number
}

// ───────────────────────── 扫描进度 ─────────────────────────

export interface ScanProgress {
  scanId: string
  phase: string
  percent: number
  current: string
  found?: number
}

// ───────────────────────── 浮窗与插件（模块二） ─────────────────────────

export type FloatEdge = 'left' | 'right' | 'top' | 'none'

export interface FloatPluginManifest {
  id: string
  name: string
  description: string
  /** 采集间隔（毫秒），0 = 不自动刷新 */
  interval: number
  /** 卡片渲染模板类型 */
  view: 'metric' | 'gauge' | 'list' | 'text' | 'bars'
  icon: string
  /** 内置插件不可删除 */
  builtin: boolean
  version: string
  author?: string
  /** F1：声明的能力（fs / network / powershell）；声明后需用户授权才被调度 */
  permissions?: string[]
  /** F1：运行时由注册表填充 —— 尚未授权的能力（空 = 可用） */
  pendingPermissions?: string[]
  /** F1：插件文件名（外部插件，供删除；内置为空） */
  file?: string
}

export interface FloatPluginDatum {
  label: string
  value: string
  /** 0~100，用于 gauge / bars 视图 */
  ratio?: number
  hint?: string
  tone?: 'normal' | 'good' | 'warn' | 'danger'
}

export interface FloatPluginPayload {
  pluginId: string
  ts: number
  title: string
  view: FloatPluginManifest['view']
  icon: string
  data: FloatPluginDatum[]
  error?: string
}

/**
 * 单个浮窗实例的设置（F4）。
 *
 * 为什么把「每实例」的字段单独抽出来而不是复用一个大的 FloatSettings：
 * 多实例的本质是「同一个应用在不同位置显示不同的东西」，因此插件组合、
 * 位置、尺寸、主题、穿透这些**随实例而异**；而 enabled / peekSize /
 * alwaysOnTop 是应用级行为，多实例共享才有意义（总不能一个实例置顶另一个不置顶）。
 */
export interface FloatInstanceSettings {
  /** 稳定标识：窗口映射、IPC 归属都靠它 */
  id: string
  /** 该实例显示的插件 id，顺序即显示顺序 */
  plugins: string[]
  x: number
  y: number
  width: number
  opacity: number
  theme: FloatTheme
  clickThrough: boolean
  compact: boolean
  lockPosition: boolean
  autoHide: boolean
}

export type FloatTheme = 'dark' | 'light' | 'glass'

export interface FloatSettings {
  enabled: boolean
  /** 启用的插件 id，顺序即显示顺序（主实例；多实例见 instances） */
  plugins: string[]
  x: number
  y: number
  width: number
  opacity: number
  /** 靠边自动隐藏 */
  autoHide: boolean
  /** 隐藏后露出的触发条宽度 */
  peekSize: number
  theme: FloatTheme
  /** 鼠标穿透（点击穿到桌面） */
  clickThrough: boolean
  alwaysOnTop: boolean
  compact: boolean
  lockPosition: boolean
  /**
   * 多实例（F4）。为空 / 未设置时表示「单实例」—— 由上面的顶层字段
   * 合成一个默认实例，因此老配置无需迁移即照常工作。
   */
  instances?: FloatInstanceSettings[]
}

// ───────────────────────── 设置 ─────────────────────────

export interface AppSettings {
  portableRoots: string[]
  portableThreshold: number
  excludePaths: string[]
  quarantineKeepDaysLow: number
  quarantineKeepDaysHigh: number
  theme: 'dark' | 'light'
  maxDepth: number
  enabledJunkCategories: string[]
  /** 高级模式：允许勾选高风险项 */
  advancedMode: boolean
  /** 允许 Shift 跳过隔离区直接删除 */
  allowDirectDelete: boolean
  /** 规则库在线更新源（HTTPS，需签名匹配才生效；空 = 禁用在线更新） */
  rulesUpdateUrl: string
  float: FloatSettings
}

export interface FileDetail {
  fullPath: string
  name: string
  sizeBytes: number
  mtime: number
  ctime: number
  version?: string
  signStatus: SignStatus
  signer?: string
  arch?: PeArch
  refCount: number
  exists: boolean
  isDir: boolean
}
