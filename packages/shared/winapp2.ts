/**
 * v3.1 P1-1：Winapp2.ini 社区规则导入（借鉴 BleachBit/FluentCleaner 生态）
 *
 * Winapp2.ini 格式（每节一条规则）：
 *   [Section Name]
 *   FileKey1=%LocalAppData%\App\Cache|*.*|RECURSE
 *   FileKey2=...（路径|文件模式（; 分隔多个）[|RECURSE]）
 *   ExcludeKey1=FILE|%LocalAppData%\App\Cache\|keep.dat
 *
 * 转换策略（安全优先）：
 *   - 每节 → 一条规则，id = GC-101 起（顺延，上限 GC-999）
 *   - 全部 defaultSelected=false、risk=medium（用户逐项审阅后手动勾选）
 *   - 裸 '*' 模式改写为 '*.*'（避免过宽模式被毒丸防线拒绝，且少删无扩展名文件影响有限）
 *   - ExcludeKey FILE 类型 → rule.exclude 的 basename 正则（近似：全根生效）
 *   - RECURSE → maxDepth 6，否则 maxDepth 1
 */
export interface Winapp2Section {
  name: string
  fileKeys: { dir: string; patterns: string[]; recurse: boolean }[]
  excludes: string[]
}

export function parseWinapp2(text: string): Winapp2Section[] {
  const sections: Winapp2Section[] = []
  let cur: Winapp2Section | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      cur = { name: sec[1].trim(), fileKeys: [], excludes: [] }
      sections.push(cur)
      continue
    }
    if (!cur) continue
    const kv = line.split('=', 2)
    if (kv.length !== 2) continue
    const [key, val] = [kv[0].trim(), kv[1].trim()]
    if (/^FileKey\d+$/i.test(key)) {
      const parts = val.split('|')
      if (parts.length < 2) continue
      const dir = parts[0].trim()
      const pats = parts[1].split(';').map((x) => x.trim()).filter(Boolean)
      const recurse = (parts[2] ?? '').toUpperCase().includes('RECURSE')
      if (dir && pats.length) cur.fileKeys.push({ dir, patterns: pats, recurse })
    } else if (/^ExcludeKey\d+$/i.test(key)) {
      const parts = val.split('|')
      if (parts.length >= 3 && parts[0].toUpperCase() === 'FILE') {
        cur.excludes.push(...parts.slice(2).join('|').split(';').map((x) => x.trim()).filter(Boolean))
      }
    }
  }
  return sections.filter((s) => s.fileKeys.length > 0)
}

export interface ConvertedRule {
  id: string
  name: string
  description: string
  risk: 'medium'
  defaultSelected: false
  match: { roots: string[]; patterns: string[]; exclude?: string[]; maxDepth: number }
}

/** 把解析出的节转换为我们的规则（从 startId 起，GC-101 ~ GC-999） */
export function convertSections(sections: Winapp2Section[], startId = 101, maxRules = 899): ConvertedRule[] {
  const out: ConvertedRule[] = []
  for (const sec of sections) {
    if (out.length >= maxRules) break
    const roots = [...new Set(sec.fileKeys.map((f) => f.dir))]
    const patterns = [...new Set(sec.fileKeys.flatMap((f) => f.patterns))].map((p) =>
      /^\*+$/.test(p) ? '*.*' : p
    )
    const recurse = sec.fileKeys.some((f) => f.recurse)
    const rule: ConvertedRule = {
      id: `GC-${startId + out.length}`,
      name: `[社区] ${sec.name}`,
      description: 'Winapp2 社区规则导入（默认不勾选，请逐项审阅）',
      risk: 'medium',
      defaultSelected: false,
      match: { roots, patterns, maxDepth: recurse ? 6 : 1 }
    }
    if (sec.excludes.length) {
      // 原始 glob 字符串交给引擎统一 globToRegExp 编译（与内置规则同语义）
      rule.match.exclude = [...new Set(sec.excludes)]
    }
    out.push(rule)
  }
  return out
}
