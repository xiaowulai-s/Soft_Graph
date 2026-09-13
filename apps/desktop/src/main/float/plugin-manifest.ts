/**
 * F1 插件清单校验与权限声明（纯函数，无 IO，可单测）
 *
 * 外部插件在主进程内执行、拥有 Node 全部能力 —— 因此 manifest 必须
 * 先过严格的 schema 校验，且**声明了敏感能力的插件必须经用户明确授权
 * 才会被调度**（见 registry 的 approval 逻辑）。
 */

/** 插件可声明的能力 */
export type PluginPermission = 'fs' | 'network' | 'powershell'

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = ['fs', 'network', 'powershell']

export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  fs: '文件系统（读写插件目录之外的文件）',
  network: '网络访问（发起 HTTP/HTTPS 请求）',
  powershell: 'PowerShell 执行（系统命令 / WMI 查询）'
}

export interface ManifestCheckResult {
  ok: boolean
  reason?: string
  /** 清单中声明的能力（校验失败时为空） */
  permissions: PluginPermission[]
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/ // vendor.name（至多 4 段）
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.-]+)?$/
const VIEWS = new Set(['metric', 'gauge', 'list', 'text', 'bars'])

/**
 * 校验插件 manifest。
 * 规则：
 *  - id：`vendor.name` 小写点分段（避免与内置 id 冲突后再发现，这里先拦格式）
 *  - interval：0 ~ 3600_000 的整数
 *  - view：五种内置模板之一
 *  - version：semver 简化版
 *  - permissions（可选）：只能是 fs / network / powershell，重复项去重后返回
 */
export function validateManifest(m: unknown): ManifestCheckResult {
  if (!m || typeof m !== 'object') return bad('manifest 缺失或不是对象')
  const r = m as Record<string, unknown>

  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return bad(`id 非法（应为 vendor.name 小写点分段）：${String(r.id)}`)
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 40) return bad('name 缺失或超长（≤40 字符）')
  if (typeof r.description !== 'string' || r.description.length > 200) return bad('description 缺失或超长（≤200 字符）')
  if (typeof r.interval !== 'number' || !Number.isInteger(r.interval) || r.interval < 0 || r.interval > 3_600_000)
    return bad('interval 必须是 0~3600000 的整数毫秒')
  if (typeof r.view !== 'string' || !VIEWS.has(r.view)) return bad(`view 非法（${[...VIEWS].join(' / ')}）：${String(r.view)}`)
  if (typeof r.icon !== 'string' || !r.icon) return bad('icon 缺失')
  if (typeof r.version !== 'string' || !VERSION_RE.test(r.version)) return bad(`version 非法（semver）：${String(r.version)}`)
  if (r.author !== undefined && (typeof r.author !== 'string' || r.author.length > 60)) return bad('author 超长（≤60 字符）')

  const permissions: PluginPermission[] = []
  if (r.permissions !== undefined) {
    if (!Array.isArray(r.permissions)) return bad('permissions 必须是数组')
    for (const p of r.permissions) {
      if (typeof p !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(p))
        return bad(`未知能力声明：${String(p)}（允许：${PLUGIN_PERMISSIONS.join(' / ')}）`)
      if (!permissions.includes(p as PluginPermission)) permissions.push(p as PluginPermission)
    }
  }
  return { ok: true, permissions }
}

/**
 * 从插件源码中**安全地**提取 manifest —— 不执行插件代码：
 * 在 node:vm 新上下文里只提供 module/exports 骨架，不给 require/process/globalThis，
 * 插件顶层代码即使写了对系统的操作也拿不到任何入口（拿不到就抛错，安装失败）。
 */
export function extractManifest(source: string): { ok: boolean; manifest?: unknown; reason?: string } {
  if (typeof source !== 'string' || source.length === 0 || source.length > 256 * 1024)
    return { ok: false, reason: '插件源码为空或超过 256KB' }
  try {
    // 延迟 require，保证本模块在渲染侧类型引用时不拖入 node:vm
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vm = require('node:vm') as typeof import('node:vm')
    const sandbox: Record<string, unknown> = { module: { exports: {} } }
    sandbox.exports = (sandbox.module as { exports: unknown }).exports
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox, { timeout: 1000 })
    const mod = sandbox.module as { exports?: { manifest?: unknown } }
    const manifest = mod.exports?.manifest
    if (!manifest) return { ok: false, reason: '插件未导出 manifest' }
    return { ok: true, manifest }
  } catch (e) {
    return { ok: false, reason: `manifest 提取失败（代码在沙箱中执行出错）：${(e as Error).message}` }
  }
}

function bad(reason: string): ManifestCheckResult {
  return { ok: false, reason, permissions: [] }
}
