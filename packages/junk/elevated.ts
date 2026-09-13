/**
 * 提权清理任务（技术设计方案 5.6.3）
 *
 * 设计约束（安全边界，任何放宽都必须经过评审）：
 *   1. 提权进程**只接收明确的文件清单**，不接受通配符、不接受脚本、不接受命令字符串
 *   2. 唯一的动作是「把清单里的文件移动到隔离区」—— 不做执行、不改注册表、不递归删除目录内容
 *   3. 清单在**生成侧**与**执行侧**各校验一次（双重校验），任一失败即整体拒绝
 *   4. 提权命令行只有两个参数：固定的 helper 脚本路径 + 任务文件路径。
 *      任务文件由主进程写入 %LOCALAPPDATA%\SoftGraph\tmp\，不含任何用户可控拼接
 *
 * 本模块是被两侧共用的**纯策略层**：不依赖 Electron，可被单测直接覆盖。
 */

import { existsSync, statSync } from 'node:fs'
import type { JunkItem, RiskLevel } from '../shared/types'
import { guardPath } from '../shared/safety'

export const ELEVATED_TASK_VERSION = 1

/** 提权任务允许的唯一动作 */
export type ElevatedAction = 'quarantine'

export interface ElevatedItem {
  path: string
  sizeBytes: number
  mtimeMs: number
  categoryId: string
  risk: RiskLevel
  /**
   * 保留截止时间（ms）。由主进程按风险分级算好后写死，
   * 提权侧不做业务判断，只按值记录 —— 两侧共用同一套保留期策略。
   */
  keepUntil: number
}

export interface ElevatedTask {
  version: number
  taskId: string
  createdAt: number
  action: ElevatedAction
  /** 隔离区根目录（提权侧据此落盘 manifest） */
  quarantineRoot: string
  /** 批目录名，形如 20260913-180501 —— 与普通删除的隔离批命名一致 */
  batchId: string
  items: ElevatedItem[]
}

export interface RejectedItem {
  path: string
  reason: string
}

export interface BuildOutcome {
  /** 可提权执行的清单（可能为空） */
  task: ElevatedTask | null
  accepted: ElevatedItem[]
  rejected: RejectedItem[]
}

/**
 * 提权任务**明确拒绝**的文件类型。
 *
 * 说明：普通清理允许删除这些类型（它们常常正是垃圾），但**不允许进入提权通道**——
 * 提权通道的能力边界越窄越安全。脚本/安装包/注册表文件一旦出现在提权清单里，
 * 说明清单来源可疑（正常垃圾规则不会产出它们），一律拒绝并留痕。
 */
export const ELEVATED_DENY_EXT = new Set([
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  '.vbs',
  '.vbe',
  '.wsf',
  '.wsh',
  '.hta',
  '.js',
  '.jse',
  '.reg',
  '.msi',
  '.msp',
  '.scr',
  '.com',
  '.sys',
  '.exe',
  '.dll'
])

/** 路径中出现的通配符（提权清单绝不接受） */
const WILDCARD_RE = /[*?[\]]/

/**
 * 提权通道的**可清理区白名单**。
 *
 * 存在的理由（E3 实测发现的缺口）：
 *   普通删除通道允许清理 `C:\Windows` 的子目录（Temp / Logs / Installer …），
 *   因此不能把整棵 `C:\Windows` 列为受保护树 —— 但这也意味着
 *   `C:\Windows\notepad.exe.bak` 这类**Windows 根目录下的文件**能通过 guardPath。
 *   对普通通道这可以接受（用户可能确实要删那里的垃圾），
 *   但提权通道拥有管理员权限，必须把能力边界收到「明确的垃圾目录」内。
 *
 * 判定规则 = 目录白名单（子树）+ 模式白名单（任意用户的 Temp / 回收站等）。
 */
const ALLOWED_SUBDIRS = (): string[] => {
  const windir = (process.env.SystemRoot || 'C:\\Windows').toLowerCase().replace(/\\+$/, '')
  const sysDrive = windir.slice(0, 2)
  const programData = (process.env.ProgramData || `${sysDrive}\\ProgramData`).toLowerCase().replace(/\\+$/, '')
  return [
    `${windir}\\temp`,
    `${windir}\\softwareDistribution\\download`.toLowerCase(),
    `${windir}\\installer`,
    `${windir}\\logs`,
    `${windir}\\prefetch`,
    `${windir}\\minidump`,
    `${windir}\\livekernelreports`,
    `${windir}\\$recycle.bin`,
    `${windir}\\sysreset`,
    `${windir}\\servicing\\lcu`,
    `${sysDrive}\\windows.old`,
    `${sysDrive}\\$windows.~bt`,
    `${sysDrive}\\$windows.~ws`,
    `${sysDrive}\\$window.~bt`,
    `${programData}\\temp`,
    `${programData}\\package cache`
  ]
}

/** 明确允许的文件（不是目录子树） */
const ALLOWED_EXACT_FILES = (): string[] => {
  const windir = (process.env.SystemRoot || 'C:\\Windows').toLowerCase().replace(/\\+$/, '')
  const sysDrive = windir.slice(0, 2)
  return [`${windir}\\memory.dmp`, `${windir}\\windowsupdate.log`, `${sysDrive}\\hiberfil.sys`.toLowerCase()]
}

/** 模式白名单：任意用户的 Temp / 回收站 / 缓存目录 */
const ALLOWED_PATTERNS: RegExp[] = [
  /^[a-z]:\\users\\[^\\]+\\appdata\\local\\temp\\/,
  /^[a-z]:\\users\\[^\\]+\\appdata\\local\\microsoft\\windows\\inetcache\\/,
  /^[a-z]:\\users\\[^\\]+\\appdata\\local\\microsoft\\windows\\explorer\\/,
  /^[a-z]:\\users\\[^\\]+\\appdata\\local\\crashdumps\\/,
  /^[a-z]:\\\$recycle\.bin\\/
]

function isSubPathOf(child: string, parent: string): boolean {
  const c = child.toLowerCase().replace(/\\+$/, '')
  const p = parent.toLowerCase().replace(/\\+$/, '')
  return c === p || c.startsWith(p + '\\')
}

/** 提权通道是否允许处理该路径（在 guardPath 之后追加的更强约束） */
export function isElevationAllowed(path: string): boolean {
  const p = path.toLowerCase().replace(/\\+$/, '')
  if (ALLOWED_PATTERNS.some((re) => re.test(p))) return true
  if (ALLOWED_EXACT_FILES().includes(p)) return true
  return ALLOWED_SUBDIRS().some((root) => isSubPathOf(p, root))
}

/**
 * 单条目校验。返回 null 表示通过，否则返回拒绝原因。
 *
 * 校验顺序按「成本低 → 成本高」排列，全部为同步判定。
 */
export function validateElevatedItem(it: ElevatedItem): string | null {
  const p = it.path

  if (typeof p !== 'string' || p.length === 0) return '路径为空'
  if (p.length > 32767) return '路径超长（>32767）'
  if (WILDCARD_RE.test(p)) return '路径包含通配符'

  // 只接受盘符绝对路径（UNC / 网络路径在提权通道一律拒绝）
  if (/^\\\\/.test(p)) return '提权通道不接受 UNC / 网络路径'
  if (!/^[A-Za-z]:\\/.test(p)) return '不是绝对路径'

  // 规范化：任何 . 与 .. 段落都视为可疑（主进程产出的清单不应含它们）
  const segs = p.split('\\')
  if (segs.some((s) => s === '.' || s === '..')) return '路径含相对段（. / ..）'

  const ext = extLower(p)
  if (ELEVATED_DENY_EXT.has(ext)) return `提权通道不接受 ${ext} 类型`

  // 白名单：必须落在安全层允许清理的范围内
  const verdict = guardPath(p)
  if (!verdict.allowed) return `不在可清理白名单（${verdict.reason}）`

  // 提权通道的更强约束：必须落在「明确的垃圾目录」内（见 isElevationAllowed）
  if (!isElevationAllowed(p)) return '不在提权可清理区（提权通道仅处理明确的垃圾目录）'

  if (!Number.isFinite(it.sizeBytes) || it.sizeBytes < 0) return 'size 非法'
  if (!Number.isFinite(it.mtimeMs) || it.mtimeMs <= 0) return 'mtime 非法'
  if (!Number.isFinite(it.keepUntil) || it.keepUntil <= Date.now()) return 'keepUntil 非法（应为未来时间戳）'
  return null
}

/**
 * 磁盘状态复核（防 TOCTOU）。
 * 提权进程在真正移动前也会再跑一次同样的检查。
 */
export function revalidateOnDisk(it: ElevatedItem): string | null {
  let st: import('node:fs').Stats
  try {
    st = statSync(it.path)
  } catch {
    return '文件已不存在'
  }
  if (st.isDirectory()) return '目标是目录（提权通道只处理文件）'
  if (st.size !== it.sizeBytes) return '大小已变化'
  // 允许 2s 的 mtime 容差（部分文件系统时间戳精度较低）
  if (Math.abs(st.mtimeMs - it.mtimeMs) > 2000) return '修改时间已变化'
  return null
}

export interface BuildTaskOptions {
  taskId: string
  quarantineRoot: string
  /** 批目录名，形如 20260913-180501 */
  batchId: string
  keepDaysLow: number
  keepDaysHigh: number
  /** 是否复核磁盘状态（默认 true；单测可关） */
  verifyOnDisk?: boolean
}

/**
 * 由垃圾条目生成提权任务。
 * 被拒绝的条目**不静默丢弃** —— 连同原因一并返回，交给审计日志与 UI 呈现。
 */
export function buildElevatedTask(items: JunkItem[], opts: BuildTaskOptions): BuildOutcome {
  const verifyOnDisk = opts.verifyOnDisk !== false
  const accepted: ElevatedItem[] = []
  const rejected: RejectedItem[] = []
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000

  for (const it of items) {
    if (it.keep) {
      rejected.push({ path: it.fullPath, reason: '重复文件的保留项' })
      continue
    }
    const keepDays = it.risk === 'high' ? opts.keepDaysHigh : opts.keepDaysLow
    const candidate: ElevatedItem = {
      path: it.fullPath,
      sizeBytes: it.sizeBytes,
      mtimeMs: it.mtime,
      categoryId: it.categoryId,
      risk: it.risk,
      keepUntil: now + Math.max(1, keepDays) * day
    }
    const bad = validateElevatedItem(candidate)
    if (bad) {
      rejected.push({ path: it.fullPath, reason: bad })
      continue
    }
    if (verifyOnDisk) {
      const diskBad = revalidateOnDisk(candidate)
      if (diskBad) {
        rejected.push({ path: it.fullPath, reason: diskBad })
        continue
      }
    }
    accepted.push(candidate)
  }

  if (accepted.length === 0) {
    return { task: null, accepted, rejected }
  }

  return {
    task: {
      version: ELEVATED_TASK_VERSION,
      taskId: opts.taskId,
      createdAt: now,
      action: 'quarantine',
      quarantineRoot: opts.quarantineRoot,
      batchId: opts.batchId,
      items: accepted
    },
    accepted,
    rejected
  }
}

/**
 * 执行侧（提权进程）的**整任务校验**。
 * 与生成侧共用同一套单条目规则，额外校验任务级字段与总量上限。
 */
export interface TaskVerdict {
  ok: boolean
  reason?: string
}

export function validateElevatedTask(
  task: unknown,
  limits: { maxItems?: number; maxTotalBytes?: number } = {}
): TaskVerdict {
  const maxItems = limits.maxItems ?? 20_000
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024 * 1024

  if (!task || typeof task !== 'object') return { ok: false, reason: '任务不是对象' }
  const t = task as Partial<ElevatedTask>

  if (t.version !== ELEVATED_TASK_VERSION) return { ok: false, reason: `版本不匹配：${String(t.version)}` }
  if (t.action !== 'quarantine') return { ok: false, reason: `动作不被允许：${String(t.action)}` }
  if (typeof t.taskId !== 'string' || !/^[a-z0-9_-]{6,64}$/i.test(t.taskId)) {
    return { ok: false, reason: 'taskId 非法' }
  }
  if (typeof t.quarantineRoot !== 'string' || !/^[A-Za-z]:\\/.test(t.quarantineRoot)) {
    return { ok: false, reason: '隔离区路径非法' }
  }
  if (typeof t.batchId !== 'string' || !/^\d{8}-\d{6}$/.test(t.batchId)) {
    return { ok: false, reason: '批目录名非法' }
  }
  // 隔离区必须位于本应用数据目录内，避免被引导到任意位置
  if (!/\\SoftGraph\\/i.test(t.quarantineRoot)) {
    return { ok: false, reason: '隔离区不在应用数据目录内' }
  }
  if (!Array.isArray(t.items) || t.items.length === 0) return { ok: false, reason: '清单为空' }
  if (t.items.length > maxItems) return { ok: false, reason: `清单超出上限（${maxItems}）` }

  let total = 0
  for (const raw of t.items) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: '条目不是对象' }
    const it = raw as ElevatedItem
    const bad = validateElevatedItem(it)
    if (bad) return { ok: false, reason: `${String(it.path).slice(0, 120)} → ${bad}` }
    total += it.sizeBytes
    if (total > maxTotalBytes) return { ok: false, reason: '总大小超出上限' }
  }
  return { ok: true }
}

/**
 * 提权启动命令构造。
 *
 * 返回值是 PowerShell 的参数数组（由主进程 spawn，不经 shell 解析）：
 * 命令行里**只有两个常量路径**，用户可控的内容全部封装在任务 JSON 文件内。
 */
export function buildElevationCommand(helperScript: string, taskFile: string): string[] {
  if (!/^[A-Za-z]:\\/.test(helperScript)) throw new Error('helper 路径必须是绝对路径')
  if (!/^[A-Za-z]:\\/.test(taskFile)) throw new Error('任务文件路径必须是绝对路径')
  if (WILDCARD_RE.test(helperScript) || WILDCARD_RE.test(taskFile)) {
    throw new Error('路径不得包含通配符')
  }
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperScript,
    '-TaskFile',
    taskFile
  ]
}

function extLower(p: string): string {
  const base = p.slice(p.lastIndexOf('\\') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export { existsSync }
