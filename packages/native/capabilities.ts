/**
 * 原生能力探针与降级骨架
 * ============================================================
 * v2.0.0 关键决策：**双轨方案**
 *
 *   默认路径（无原生模块）—— 保持 v1.0.0 的分发优势：npm install 免编译、
 *   任何机器可构建、单 exe 分发。
 *   增强路径（原生模块存在）—— 若可选依赖 softgraph-native 加载成功，
 *   自动启用 USN 增量、Restart Manager 占用检测、API Set 动态映射。
 *
 * 设计约束：
 *   1. 本文件**不得**静态 import 任何原生模块，否则打包/安装时会硬失败；
 *      必须用运行时 require + try/catch，缺失即降级。
 *   2. 任何调用方都不得假设能力存在，必须读 capabilities 后再决定走哪条实现路径。
 *   3. 探针结果缓存，并在诊断包中输出，便于排查「为什么没启用增强能力」。
 */

/** 可选原生模块的包名（写入 optionalDependencies） */
export const NATIVE_PACKAGE_NAME = 'softgraph-native'

/** 原生模块需要导出的能力签名（缺失任一即整体降级，避免半可用状态） */
export interface NativeModuleShape {
  /** USN Journal：读取卷的变更记录 */
  usnReadJournal?: (volume: string, cursor: string | null, limit?: number) => Promise<UsnRecord[]>
  /** USN Journal：读取当前游标 */
  usnGetCursor?: (volume: string) => Promise<string | null>
  /** Restart Manager：查询占用某文件的进程 */
  rmFindLockers?: (filePath: string) => Promise<{ pid: number; name: string }[]>
  /** 登记重启后删除（MOVEFILE_DELAY_UNTIL_REBOOT） */
  rmDeleteOnReboot?: (filePath: string) => Promise<boolean>
  /** API Set：从 PEB/.apiset 节读取映射表 */
  apiSetResolve?: (dllName: string) => string | null
}

export interface UsnRecord {
  /** 0=新增 1=删除 2=重命名 3=写入 */
  reason: number
  path: string
  size: number
  mtime: number
}

export type CapabilitySource = 'native' | 'fallback'

export interface NativeCapabilities {
  source: CapabilitySource
  /** USN Journal 增量扫描可用 */
  usn: boolean
  /** Restart Manager 占用检测与延迟删除可用 */
  restartManager: boolean
  /**
   * Restart Manager 是否可由 PowerShell P/Invoke 提供（默认路径）
   * v2.0.0 M2：即便没有原生模块，也能通过 Add-Type P/Invoke 拿到真实能力，
   * 因此 UI 不应简单显示「不可用」，而要区分原生 / P/Invoke / 完全不可用。
   */
  restartManagerPs: boolean
  /** API Set 动态映射可用 */
  apiSet: boolean
  /** 原生模块版本（若加载成功） */
  version?: string
  /** 加载失败原因（用于诊断，不影响运行） */
  loadError?: string
  /** 探针耗时 */
  probeMs: number
}

let cached: NativeCapabilities | null = null

/**
 * 探测原生能力。失败绝不抛异常 —— 缺失原生模块是**预期内**的正常情况。
 */
export function loadNativeCapabilities(force = false): NativeCapabilities {
  if (cached && !force) return cached
  const t0 = Date.now()

  const fallback = (loadError?: string, version?: string): NativeCapabilities => ({
    source: 'fallback',
    usn: false,
    restartManager: false,
    // Windows 上默认走 PowerShell P/Invoke：Rstrtmgr.dll 与 kernel32 均为系统自带
    restartManagerPs: process.platform === 'win32',
    apiSet: false,
    version,
    loadError,
    probeMs: Date.now() - t0
  })

  let mod: NativeModuleShape | null = null
  let version: string | undefined
  try {
    // 关键：运行时 require，绝不在文件顶部静态 import
    const resolved = require.resolve(NATIVE_PACKAGE_NAME)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(resolved) as NativeModuleShape
    try {
      version = (require(`${NATIVE_PACKAGE_NAME}/package.json`) as { version?: string }).version
    } catch {
      version = undefined
    }
  } catch (e) {
    cached = fallback(`未安装可选原生模块（${(e as Error).message.slice(0, 120)}）`)
    return cached
  }

  if (!mod) {
    cached = fallback('原生模块导出为空')
    return cached
  }

  // 逐项判定：某项缺失只降级该项，不整体失败
  const usn = typeof mod.usnReadJournal === 'function' && typeof mod.usnGetCursor === 'function'
  const restartManager = typeof mod.rmFindLockers === 'function' && typeof mod.rmDeleteOnReboot === 'function'
  const apiSet = typeof mod.apiSetResolve === 'function'

  const anyEnabled = usn || restartManager || apiSet
  cached = {
    source: anyEnabled ? 'native' : 'fallback',
    usn,
    restartManager,
    restartManagerPs: process.platform === 'win32',
    apiSet,
    version,
    loadError: anyEnabled ? undefined : '原生模块已加载但未导出任何已实现的增强能力',
    probeMs: Date.now() - t0
  }
  return cached
}

/** 取得原生模块实例（仅在需要调用时使用；未安装时返回 null） */
export function getNativeModule(): NativeModuleShape | null {
  const caps = loadNativeCapabilities()
  if (caps.source !== 'native') return null
  try {
    return require(NATIVE_PACKAGE_NAME) as NativeModuleShape
  } catch {
    return null
  }
}

/**
 * 降级策略说明表 —— 供 UI（关于页/诊断包）与日志使用。
 * 让「为什么没启用增强能力」对用户与排查者都是明确的。
 */
export const FALLBACK_STRATEGY: Record<'usn' | 'restartManager' | 'restartManagerPs' | 'apiSet', string> = {
  usn: '改用按卷 mtime 水位增量扫描（非 NTFS 卷同样适用），代价是全量首扫仍需完整遍历',
  restartManager: '未安装可选原生模块，改用 PowerShell P/Invoke 调用 Restart Manager（能力等价）',
  restartManagerPs: '非 Windows 平台不可用时，占用检测降级为「按 errno 判定 + 关闭进程后重试」提示',
  apiSet: '改用内置静态前缀映射表覆盖常见 API Set 族群，未命中者标记为虚拟而非缺失'
}

export interface CapabilityReport {
  summary: string
  rows: { capability: string; enabled: boolean; fallback?: string }[]
}

export function describeCapabilities(caps: NativeCapabilities = loadNativeCapabilities()): CapabilityReport {
  return {
    summary:
      caps.source === 'native'
        ? `已启用原生增强能力（${NATIVE_PACKAGE_NAME}@${caps.version ?? 'unknown'}）`
        : `运行在纯 JavaScript 降级模式（探针 ${caps.probeMs}ms）`,
    rows: [
      { capability: 'USN Journal 增量扫描', enabled: caps.usn, fallback: caps.usn ? undefined : FALLBACK_STRATEGY.usn },
      {
        capability: '占用检测与重启后删除（Restart Manager）',
        enabled: caps.restartManager || caps.restartManagerPs,
        fallback: caps.restartManager
          ? undefined
          : caps.restartManagerPs
            ? FALLBACK_STRATEGY.restartManager
            : FALLBACK_STRATEGY.restartManagerPs
      },
      {
        capability: 'API Set 动态映射',
        enabled: caps.apiSet,
        fallback: caps.apiSet ? undefined : FALLBACK_STRATEGY.apiSet
      }
    ]
  }
}

/** 供测试重置探针缓存 */
export function resetCapabilityCache(): void {
  cached = null
}
