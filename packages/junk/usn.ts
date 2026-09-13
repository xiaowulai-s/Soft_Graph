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
 * 注意：输出结构随 Windows 版本与语言变化，且本机无权限真机验证，
 * 因此这里只做「能解析出多少算多少」，解析不到时返回空数组而不是报错。
 */
export function parseReadJournal(stdout: string): ReadJournalResult {
  const records: UsnChangeRecord[] = []
  let cur: UsnChangeRecord | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const nameM = line.match(/^(?:文件名|File\s*Name)\s*[:：]\s*(.+)$/i)
    const usnM = line.match(/^USN\s*[:：]\s*(.+)$/i)
    const reasonM = line.match(/^(?:原因|Reason)\s*[:：]\s*(.+)$/i)
    if (nameM) {
      if (cur) records.push(cur)
      cur = { name: nameM[1].trim(), reasons: [] }
    } else if (usnM && cur) {
      cur.usn = usnM[1].trim()
    } else if (reasonM && cur) {
      cur.reasons = reasonM[1]
        .split(/[ ,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  if (cur) records.push(cur)
  return { records, needsElevation: false }
}

/** 卷号（C: / D:）提取，用于把规则根目录映射到卷 */
export function volumeOf(path: string): string {
  const m = path.match(/^([A-Za-z]):/)
  return m ? m[1].toUpperCase() + ':' : ''
}
