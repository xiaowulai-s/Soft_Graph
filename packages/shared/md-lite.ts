/**
 * v3.9 E4：极简 Markdown → 安全 HTML（无依赖，先转义再解析受支持语法）。
 * 支持：# 标题、- 列表、**加粗**、`代码`、链接文本化。其余原样保留。
 */
export function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function mdLite(src: string): string {
  const lines = escapeHtml(src).split(/\r?\n/)
  const out: string[] = []
  let inList = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    const list = /^[-*]\s+(.*)$/.exec(line)
    if (list) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(list[1])}</li>`)
      continue
    }
    if (inList) {
      out.push('</ul>')
      inList = false
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`)
      continue
    }
    if (line.trim() === '') {
      out.push('<div style="height:4px"></div>')
      continue
    }
    out.push(`<div>${inline(line)}</div>`)
  }
  if (inList) out.push('</ul>')
  return out.join('')
}

function inline(t: string): string {
  return t
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code style="font-family:var(--mono)">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）') // 链接文本化（防外跳）
}
