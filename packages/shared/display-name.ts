/**
 * v3.9.1 显示名清洗：卸载表 DisplayName 常有脏数据（GUID、纯版本号、
 * 环境变量路径、被拼接的 "ProductVersion" 字样）——统一清洗出可读名。
 */
export function prettyDisplayName(raw: string, fallback?: string): string {
  let t = (raw ?? '').trim()
  if (!t) return fallbackName(fallback)

  // 剥离被拼接进来的 "ProductVersion" 字段名字样（如 "409ProductVersion 4.0.0.1..."）
  t = t.replace(/[\s._-]*productversion[\s._-]*/i, ' ').trim()
  // 剥离开头残留的数字版本段（如 "409 4.0.0.1..." → "409" 也是版本残留）
  t = t.replace(/^\d+(?:[.\-]\d+)*\s+/, '').trim()

  if (!t) return fallbackName(fallback)

  // GUID 全串 → 不可读
  if (/^[0-9a-f]{6,12}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4,12}-[0-9a-f]{8,16}$/i.test(t)) {
    return fallbackName(fallback)
  }
  // 纯版本号（≥2 段数字）→ 不可读
  if (/^\d+(\.\d+){2,}$/.test(t)) {
    return fallbackName(fallback)
  }
  // 环境变量路径开头（%ProgramFiles%\...）→ 不可读
  if (/^%[^%]+%/.test(t)) {
    return fallbackName(fallback)
  }
  // 含路径分隔符 → 取尾段
  if (/[\\/]/.test(t)) {
    const tail = t.split(/[\\/]/).filter(Boolean).pop() ?? ''
    if (tail) return cleanTail(tail)
    return fallbackName(fallback)
  }
  return t
}

function cleanTail(tail: string): string {
  // 尾段若仍是 GUID/版本号 → 兜底
  if (/^[0-9a-f]{6,12}-[0-9a-f]{4}/i.test(tail) || /^\d+(\.\d+){2,}$/.test(tail)) {
    return fallbackName(undefined)
  }
  return tail.replace(/\.(exe|dll|lnk|url)$/i, '').trim() || '未命名软件'
}

function fallbackName(fallback?: string): string {
  const f = (fallback ?? '').trim()
  if (!f) return '未命名软件'
  // fallback 本身可能是路径 → 尾段去扩展名
  const tail = f.split(/[\\/]/).filter(Boolean).pop() ?? f
  return tail.replace(/\.(exe|dll)$/i, '').trim() || '未命名软件'
}
