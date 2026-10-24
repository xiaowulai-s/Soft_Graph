/**
 * v3.8 浮窗插件市场：索引协议解析 / 版本比较 / 安装状态判定（纯函数，可单测）
 *
 * 索引格式（plugins-index.json）：
 * {
 *   "version": 1,
 *   "plugins": [{
 *     "id": "system.clock", "name": "时钟", "version": "1.0.0",
 *     "description": "...", "author": "...",
 *     "url": "https://.../plugin-system-clock.js",
 *     "permissions": []
 *   }]
 * }
 */

export interface MarketEntry {
  id: string
  name: string
  version: string
  description: string
  author: string
  url: string
  permissions: string[]
}

export interface MarketIndex {
  version: number
  plugins: MarketEntry[]
}

export type MarketStatus = 'not-installed' | 'up-to-date' | 'update-available' | 'unknown-version'

export function parseMarketIndex(text: string): { ok: boolean; index?: MarketIndex; error?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '索引不是合法 JSON' }
  }
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return { ok: false, error: '索引版本不支持' }
  if (!Array.isArray(o.plugins)) return { ok: false, error: '索引缺少 plugins 数组' }
  const plugins: MarketEntry[] = []
  for (const e of o.plugins) {
    const it = e as Record<string, unknown>
    const id = String(it.id ?? '')
    const url = String(it.url ?? '')
    if (!id || !/^https:\/\//i.test(url)) continue // 无 url 或非 https 的条目跳过
    plugins.push({
      id,
      name: String(it.name ?? id),
      version: String(it.version ?? '0.0.0'),
      description: String(it.description ?? ''),
      author: String(it.author ?? ''),
      url,
      permissions: Array.isArray(it.permissions) ? it.permissions.map(String) : []
    })
  }
  return { ok: true, index: { version: 1, plugins } }
}

/** semver 式比较（数字段逐位比；非数字段按字典序兜底） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/)
  const pb = b.split(/[.-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i])
    const nb = Number(pb[i])
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    if (pa[i] !== pb[i]) return (pa[i] ?? '') < (pb[i] ?? '') ? -1 : 1
  }
  return 0
}

export function marketStatus(
  entry: MarketEntry,
  installed: Map<string, { version?: string }>
): { status: MarketStatus; localVersion?: string } {
  const local = installed.get(entry.id)
  if (!local) return { status: 'not-installed' }
  const lv = local.version
  if (!lv) return { status: 'unknown-version', localVersion: lv }
  return compareVersions(entry.version, lv) > 0
    ? { status: 'update-available', localVersion: lv }
    : { status: 'up-to-date', localVersion: lv }
}

/** 官方索引地址（主源 Gitee 直连 + GitHub 回退；可在浮窗设置里覆盖） */
export const OFFICIAL_INDEX_URLS = [
  'https://gitee.com/ABCHikS/softgraph-mirror/releases/download/stable/plugins-index.json',
  'https://github.com/xiaowulai-s/Soft_Graph/releases/download/stable/plugins-index.json'
] as const
