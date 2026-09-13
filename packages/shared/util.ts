/** 通用工具：格式化、路径规范化、glob 匹配、ID 生成 */

export function formatBytes(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const v = bytes / Math.pow(1024, i)
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 1 : digits)} ${units[i]}`
}

export function formatTime(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/** Windows 路径规范化：统一反斜杠、去尾斜杠、小写化用于比较 */
export function normPath(p: string): string {
  if (!p) return ''
  let s = p.trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\')
  s = s.replace(/\\{2,}/g, (m, off) => (off === 0 ? m : '\\'))
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1)
  return s
}

export function normKey(p: string): string {
  return normPath(p).toLowerCase()
}

export function isSubPath(child: string, parent: string): boolean {
  const c = normKey(child)
  const p = normKey(parent)
  if (!c || !p) return false
  if (c === p) return true
  return c.startsWith(p.endsWith('\\') ? p : p + '\\')
}

export function baseName(p: string): string {
  const s = normPath(p)
  const i = s.lastIndexOf('\\')
  return i < 0 ? s : s.slice(i + 1)
}

export function dirName(p: string): string {
  const s = normPath(p)
  const i = s.lastIndexOf('\\')
  return i < 0 ? s : s.slice(0, i)
}

export function extName(p: string): string {
  const b = baseName(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase()
}

/**
 * glob → RegExp。支持 ** / * / ? / {a,b}
 * 用于垃圾规则引擎的 patterns 与 exclude（见 7.4）
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\//g, '\\')
  let re = ''
  let i = 0
  while (i < g.length) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // ** 跨目录
        i += 2
        if (g[i] === '\\') i++
        re += '(?:[^\\\\]*\\\\)*'
      } else {
        re += '[^\\\\]*'
        i++
      }
    } else if (c === '?') {
      re += '[^\\\\]'
      i++
    } else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end < 0) {
        re += '\\{'
        i++
      } else {
        const parts = g.slice(i + 1, end).split(',')
        re += '(?:' + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
        i = end + 1
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp('^' + re + '$', 'i')
}

export function matchAny(name: string, patterns?: RegExp[]): boolean {
  if (!patterns || patterns.length === 0) return true
  return patterns.some((r) => r.test(name))
}

/** FNV-1a 32bit → 用于颜色哈希等轻量场景 */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 按名称生成稳定色相（图标兜底色块，见 5.1.3） */
export function nameToHsl(name: string, s = 62, l = 48): string {
  return `hsl(${hash32(name) % 360} ${s}% ${l}%)`
}

export function initialsOf(name: string): string {
  const t = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!t) return '?'
  if (/[\u4e00-\u9fa5]/.test(t[0])) return t[0]
  const words = t.split(/\s+/)
  return (words.length > 1 ? words[0][0] + words[1][0] : t.slice(0, 2)).toUpperCase()
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/** 依赖文件类型归类（决定图谱节点配色，见 8.5） */
export function classifyKind(path: string): import('./types').FileKind {
  const e = extName(path)
  if (e === 'exe' || e === 'com' || e === 'scr') return 'exe'
  if (e === 'dll' || e === 'sys' || e === 'drv') return 'dll'
  if (e === 'ocx' || e === 'ax' || e === 'cpl') return 'ocx'
  if (e === 'ini' || e === 'cfg' || e === 'conf' || e === 'json' || e === 'xml' || e === 'yml' || e === 'toml')
    return 'config'
  if (['png', 'jpg', 'jpeg', 'ico', 'svg', 'gif', 'ttf', 'otf', 'woff', 'woff2', 'wav', 'mp3'].includes(e))
    return 'resource'
  if (['plugin', 'addon', 'ext', 'vst', 'aex', 'bpl', 'node', 'pyd', 'so'].includes(e)) return 'plugin'
  return 'data'
}

/** 是否常见共享运行库（单独成组，见 5.3） */
const SHARED_RUNTIME_RE = [
  /^(msvcp|msvcr|vcruntime|concrt|mfc|atl)\d*\w*\.dll$/i,
  /^ucrtbase(d)?\.dll$/i,
  /^api-ms-win-/i,
  /^(mscoree|clr|mscorlib|coreclr|hostfxr|hostpolicy|system\.[\w.]+)\.dll$/i,
  /^qt\d?\w*\.dll$/i,
  /^(icudt|icuuc|icuin)\w*\.dll$/i,
  /^(libgcc|libstdc\+\+|libwinpthread|msys-)\w*[-.]?\w*\.dll$/i,
  /^(d3dx9|d3dcompiler|openal32|xinput\d)\w*\.dll$/i,
  /^(python\d+|node|v8|libssl|libcrypto|zlib\d?)\w*\.dll$/i
]

export function isSharedRuntime(name: string): boolean {
  return SHARED_RUNTIME_RE.some((r) => r.test(name))
}

/** 正则字面量转义：把任意字符串（路径、用户名）安全嵌入正则 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
