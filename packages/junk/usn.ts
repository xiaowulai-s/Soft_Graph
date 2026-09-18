/**
 * USN Journal 访问（v2.0.0 M2 / B1）
 *
 * 本机实测的能力边界（重要）：
 *   fsutil usn queryjournal C:   ✅ 无需管理员，返回 Journal ID / nextUsn 等
 *   fsutil usn readjournal  C:   ❌ 错误 5 拒绝访问 —— 读变更记录必须提权
 *
 * 因此本模块提供两级能力：
 *
 *   级别 1（已验证、默认启用）：**卷级变更哨兵**
 *     nextUsn 是该卷的全局写入计数。若两次扫描之间 nextUsn 完全相同，
 *     则该卷上没有任何文件被创建/删除/修改 —— 连目录签名遍历都可以整体跳过。
 *
 *   级别 2（未验证、需提权、默认关闭）：**变更记录读取**
 *     readJournal 解析 fsutil 输出得到变更路径，可精确到「哪些目录变了」。
 *     由于本机无管理员权限无法真机验证，且其输出随系统语言本地化，
 *     解析器按中英文双套关键字做尽力解析，并强制由 settings.enableUsn 显式开启。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
// 必须用绝对路径：调用方的 PATH 可能是非 Windows 风格（CI / MSYS / 精简环境），
// 仅写 'fsutil.exe' 会 ENOENT 且被 catch 吞掉，表现为「USN 不可用」的静默降级。
const FSUTIL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'fsutil.exe')

export interface UsnJournalInfo {
  volume: string
  /** 日志 ID（十六进制字符串） */
  journalId: string
  /** 下一个 USN：卷级写入计数，哨兵判定依据 */
  nextUsn: string
  firstUsn: string
  lowestValidUsn: string
  maxUsn: string
}

export interface UsnChangeRecord {
  /** 变更文件路径（fsutil 输出的是文件名 + 父目录引用号，需上层映射） */
  name: string
  usn?: string
  /** 变更原因（尽力解析，中英文均可能出现） */
  reasons: string[]
  /** 原因标志位（fsutil 在原因前带的 0x... 前缀，如 0x80000002） */
  reasonFlags?: string
  /** 文件 ID（MFT 引用号，需反查才能得路径） */
  fileId?: string
  /** 父目录的文件 ID —— 理论上可反查目录路径，但需额外系统调用 */
  parentFileId?: string
  /** 变更时间戳（fsutil 本地化字符串，如 2026/9/18 0:05:41） */
  timestamp?: string
}

export interface ReadJournalResult {
  records: UsnChangeRecord[]
  nextUsn?: string
  /** 需要管理员权限（错误 5） */
  needsElevation: boolean
  error?: string
}

/** 十六进制字段值（0x... 或纯十六进制）提取 */
function hexValue(line: string): string {
  const m = line.match(/(0x[0-9a-fA-F]+|\b[0-9a-fA-F]{8,}\b)/)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 解码控制台输出。
 *
 * 关键坑：fsutil 走控制台代码页输出，中文系统为 **GBK(936)** —— 直接按 utf8 解码
 * 得到乱码（实测「下一个 Usn」变成 `��һ�� Usn`），关键字匹配必然失败，
 * 表现为「USN 能力静默不可用」。因此这里先试 utf8，出现替换字符则按 GBK 重解码
 * （Node 22 官方构建含完整 ICU，TextDecoder 支持 gbk）。
 */
export function decodeConsole(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

/**
 * 查询卷的 USN 日志状态。无需管理员权限。
 * 输出随系统语言本地化（实测中文环境为「下一个 Usn」），按中英文双套关键字匹配。
 */
export async function queryJournal(volume: string): Promise<UsnJournalInfo | null> {
  const vol = volume.replace(/\\+$/, '').slice(0, 2).toUpperCase()
  try {
    const { stdout } = await execFileAsync(FSUTIL, ['usn', 'queryjournal', vol], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024
    })
    const text = decodeConsole(stdout as unknown as Buffer)
    const lines = text.split(/\r?\n/)
    const pick = (re: RegExp): string => {
      for (const l of lines) if (re.test(l)) return hexValue(l)
      return ''
    }
    let nextUsn = pick(/下一个\s*Usn|Next\s+Usn/i)
    if (!nextUsn) {
      // 关键字仍未命中（未知语言环境）：按行位置兜底 —— fsutil 的输出顺序固定为
      // Journal ID / 第一个 Usn / 下一个 Usn / 最低有效 Usn / 最大 Usn
      const usnLines = lines.filter((l) => /Usn/i.test(l) && hexValue(l))
      if (usnLines.length >= 3) nextUsn = hexValue(usnLines[2])
    }
    if (!nextUsn) return null
    return {
      volume: vol,
      journalId: pick(/日志\s*ID|Journal\s+ID/i) || hexValue(lines[0] ?? ''),
      nextUsn,
      firstUsn: pick(/第一个\s*Usn|First\s+Usn/i),
      lowestValidUsn: pick(/最低的有效\s*Usn|Lowest\s+Valid\s+Usn/i),
      maxUsn: pick(/最大\s*Usn|Max\s+Usn/i)
    }
  } catch {
    return null
  }
}

/** 该卷是否支持 USN 查询（queryjournal 可用即可） */
export async function isUsnAvailable(volume: string): Promise<boolean> {
  return (await queryJournal(volume)) !== null
}

/**
 * 读取自 startUsn 之后的变更记录。
 * **需要管理员权限**；非提权时返回 needsElevation，调用方必须优雅降级。
 *
 * 验证状态（v3.0.0 · 2026-09-17）：在未提权的普通用户环境下实测，
 * `fsutil usn readjournal` 稳定返回错误（needsElevation=true），与 v2.0.0 记录一致。
 * 因此**默认关闭**，增量继续走「卷哨兵（queryJournal，无需提权）+ 目录签名」降级方案。
 * 解析器本身已由 `tests/unit/usn-parse.test.ts` 用中英文双套输出覆盖（17 个用例），
 * 拿到管理员权限后可直接跑 `node scripts/run-ts.mjs tests/diag-usn-elevated.ts` 复测。
 */
export async function readJournal(volume: string, startUsn?: string): Promise<ReadJournalResult> {
  const vol = volume.replace(/\\+$/, '').slice(0, 2).toUpperCase()
  const args = startUsn ? ['usn', 'readjournal', vol, 'startusn=' + startUsn] : ['usn', 'readjournal', vol]
  try {
    const { stdout } = await execFileAsync(FSUTIL, args, {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024
    })
    return parseReadJournal(decodeConsole(stdout as unknown as Buffer))
  } catch (e) {
    // 注意：fsutil 的错误信息走控制台代码页（中文系统为 GBK），且位于 stderr ——
    // 不能依赖「错误 5 / 拒绝访问」这类文案判定。改用具语言无关性且确定的依据：
    // readJournal 本身需要管理员权限，未提权即判定 needsElevation。
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const text = [
      err.stdout ? decodeConsole(err.stdout) : '',
      err.stderr ? decodeConsole(err.stderr) : '',
      err.message ?? ''
    ].join(' ')
    const denied = /Access is denied|错误 5|拒绝访问/i.test(text)
    let needsElevation = denied
    if (!needsElevation) {
      try {
        const { isElevated } = await import('./locks')
        needsElevation = !(await isElevated())
      } catch {
        needsElevation = true
      }
    }
    return {
      records: [],
      needsElevation,
      error: String(err.message ?? 'readJournal 失败').slice(0, 200)
    }
  }
}

/**
 * 尽力解析 fsutil readjournal 输出。
 *
 * 真实输出（2026-09-18 提权实测）的单条记录形态 —— **USN 在文件名之前**：
 *
 * ```
 * Usn               : 22712337088
 * 文件名            : LeAppOM.txt.logdat
 * 文件名长度        : 36
 * 原因              : 0x00000002: 数据扩展
 * 时间戳            : 2026/9/18 0:05:41
 * 文件属性          : 0x00002020: 存档 | 没有内容已编入索引
 * 文件 ID           : 0000000000000000002e0000000006d6
 * 父文件 ID         : 00000000000000000005000000009160
 * 源信息            : 0x00000000: *无*
 * ```
 *
 * 修正前的实现假设「文件名行开启一条新记录」，于是 Usn 行会被赋给**上一条**
 * 已入账的记录 —— USN 整体错位一格。现在改为 **Usn 行开启新记录**，
 * 同时兼容「文件名在前」的老格式（遇到第二个文件名行也会开新记录）。
 *
 * 注意：输出只有文件名 + 文件 ID / 父文件 ID，**没有路径**。
 *
 * 关于 ID 反查（v3.0.0 实测定稿）：`fsutil file queryFileNameById <卷> <fileid>`
 * 无需提权即可用（3/3 命中、返回完整路径），但**单次 158ms 且无批量入口**，
 * 按每轮 200 条变更外推 31.6s，是签名遍历基线（约 10s）的 3 倍以上。
 * 因此上层**不做 ID 反查**，第 2 级只用 `reuse-all`（0 条记录 ⇒ 缓存完全有效），
 * 详见 incremental.ts 的 planUsnInvalidation 注释与 tests/diag-usn-idlookup.ts。
 */
export function parseReadJournal(stdout: string): ReadJournalResult {
  const records: UsnChangeRecord[] = []
  let cur: UsnChangeRecord | null = null
  const flush = (): void => {
    if (cur && cur.name) records.push(cur)
    cur = null
  }
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const usnM = line.match(/^(?:Usn|USN)\s*[:：]\s*(.+)$/i)
    const nameM = line.match(/^(?:文件名|File\s*Name)\s*[:：]\s*(.+)$/i)
    const reasonM = line.match(/^(?:原因|Reason)\s*[:：]\s*(.+)$/i)
    const fileIdM = line.match(/^(?:文件\s*ID|File\s*ID)\s*[:：]\s*(.+)$/i)
    const parentM = line.match(/^(?:父文件\s*ID|Parent\s*File\s*ID)\s*[:：]\s*(.+)$/i)
    const timeM = line.match(/^(?:时间戳|Time\s*Stamp)\s*[:：]\s*(.+)$/i)

    if (usnM) {
      // 真实格式（实测）：Usn 是记录第一行 → 它开启新记录。
      // 但若当前记录已经有 name，说明遇到的是「文件名在前」的老格式，
      // 此时 USN 应归属当前记录，不能另起一条（否则 USN 会整体错位一格）。
      // 判定依据不能只看「有没有 name」—— 真实格式里第二条记录的 Usn 出现时，
      // 上一条也已经有 name 了。真正的区别是：**老格式的 USN 紧跟文件名行，
      // 此时还没解析到原因**；而真实格式下再遇到 Usn 时上一条的原因早已填好。
      if (cur && cur.name && cur.reasons.length === 0) {
        cur.usn = usnM[1].trim()
      } else {
        flush()
        cur = { name: '', usn: usnM[1].trim(), reasons: [] }
      }
    } else if (nameM) {
      // 已有 name 说明这是下一条记录（兼容「文件名在前」的输出形态）
      if (cur && cur.name) flush()
      if (!cur) cur = { name: nameM[1].trim(), reasons: [] }
      else cur.name = nameM[1].trim()
    } else if (reasonM && cur) {
      // 真实输出形如「原因 : 0x80000002: 数据扩展 | 关闭」（英文为 Reason : 0x...: Data Extend | Close）
      // —— 原因文本前面带一个十六进制标志位，直接切分会把 "0x80000002:" 混进原因列表里。
      // 这里先把标志位剥离出来单独存，剩下的再按 | 、 , 、 ; 切分。
      const raw = reasonM[1].trim()
      const flagM = raw.match(/^(0x[0-9a-fA-F]+)\s*[:：]?\s*(.*)$/)
      const rest = flagM ? flagM[2] : raw
      if (flagM) cur.reasonFlags = flagM[1].toLowerCase()
      cur.reasons = rest
        .split(/[|、，,;；\s]+/)
        .map((s) => s.trim())
        .filter((s) => s && s !== '|')
    } else if (fileIdM && cur) {
      cur.fileId = fileIdM[1].trim().toLowerCase()
    } else if (parentM && cur) {
      cur.parentFileId = parentM[1].trim().toLowerCase()
    } else if (timeM && cur) {
      cur.timestamp = timeM[1].trim()
    }
  }
  flush()
  return { records, needsElevation: false }
}

/** 卷号（C: / D:）提取，用于把规则根目录映射到卷 */
export function volumeOf(path: string): string {
  const m = path.match(/^([A-Za-z]):/)
  return m ? m[1].toUpperCase() + ':' : ''
}
