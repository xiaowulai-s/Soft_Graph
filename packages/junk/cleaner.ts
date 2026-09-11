/**
 * 清理执行模块 Cleaner
 * 对应技术设计方案 5.6（删除执行流程 / 隔离区设计 / 权限策略）与 7.5（占用检测与安全删除）
 *
 * 删除执行流程（严格按文档顺序）：
 *   用户勾选 → 生成 DeletePlan
 *   [校验一] 路径白名单：拦截 Windows / Program Files / System32 / WinSxS 等受保护路径
 *   [校验二] 路径规范化：realpath 解析 junction 与符号链接，防逃逸
 *   [校验三] 状态复核：删除前再次 stat，比对 size + mtime，防路径复用误删
 *   → 占用检测 → 移动至隔离区 → 写入 manifest.json → 刷新统计
 *
 * 与文档的实现差异：Restart Manager(RmStartSession) 需原生调用，纯 Node 不可用。
 * 此处改为「移动失败时按 errno 判定占用 + 按需用 PowerShell 反查占用进程」，
 * 语义等价（识别占用并给出可操作提示），仅少了「主动关闭进程」这一步。
 */

import { promises as fs } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { CleanResult, DeletePlan, JunkItem, QuarantineRecord, RiskLevel } from '../shared/types'
import { baseName, normPath, normKey, uid } from '../shared/util'
import { guardPath } from '../shared/safety'

export interface CleanerPaths {
  quarantineRoot: string
}

export interface CleanOptions {
  useQuarantine: boolean
  keepDaysLow: number
  keepDaysHigh: number
  onProgress?: (done: number, total: number, current: string) => void
  signal?: { cancelled: boolean }
}

// ───────────────── 计划生成（含三重校验的前两重） ─────────────────

export async function buildPlan(items: JunkItem[], useQuarantine: boolean): Promise<DeletePlan> {
  const blocked: { path: string; reason: string }[] = []
  const accepted: JunkItem[] = []
  const riskBreakdown: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0, hint: 0 }

  for (const it of items) {
    // 重复文件分组内「建议保留的一份」永不进入删除计划
    if (it.keep) {
      blocked.push({ path: it.fullPath, reason: '重复文件分组内的保留项，已自动排除' })
      continue
    }

    // [校验二] 路径规范化：解析 junction / 符号链接后再判定，防止用链接指向受保护目录
    let real = it.fullPath
    try {
      real = normPath(await fs.realpath(it.fullPath))
    } catch {
      // 文件已不存在 → 不进计划（避免报错噪声）
      blocked.push({ path: it.fullPath, reason: '路径已不存在' })
      continue
    }

    // [校验一] 白名单硬拦截（对规范化后的真实路径判定）
    const verdict = guardPath(real)
    if (!verdict.allowed) {
      blocked.push({ path: it.fullPath, reason: verdict.reason || '受保护路径' })
      continue
    }
    // 链接逃逸检测：规范化后落到了别处
    if (normKey(real) !== normKey(it.fullPath)) {
      const v2 = guardPath(real)
      if (!v2.allowed) {
        blocked.push({ path: it.fullPath, reason: `符号链接指向受保护路径（${real}）` })
        continue
      }
    }

    accepted.push({ ...it, fullPath: real })
    riskBreakdown[it.risk]++
  }

  return {
    taskId: uid('task_'),
    items: accepted,
    totalBytes: accepted.reduce((s, i) => s + i.sizeBytes, 0),
    useQuarantine,
    riskBreakdown,
    blocked
  }
}

// ───────────────── 执行 ─────────────────

interface MoveOutcome {
  ok: boolean
  locked?: boolean
  reason?: string
}

async function ensureDir(d: string): Promise<void> {
  await fs.mkdir(d, { recursive: true })
}

/** 同卷 rename 优先，跨卷回退为流式复制 + 删除 */
async function moveFile(src: string, dest: string): Promise<MoveOutcome> {
  await ensureDir(dirname(dest))
  try {
    await fs.rename(src, dest)
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EXDEV') {
      try {
        await pipeline(createReadStream(src), createWriteStream(dest))
        await fs.unlink(src)
        return { ok: true }
      } catch (e2) {
        return { ok: false, reason: `跨卷移动失败：${(e2 as Error).message}` }
      }
    }
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
      return { ok: false, locked: true, reason: '文件被占用或权限不足' }
    }
    return { ok: false, reason: err.code || err.message }
  }
}

async function moveDir(src: string, dest: string): Promise<MoveOutcome> {
  await ensureDir(dirname(dest))
  try {
    await fs.rename(src, dest)
    return { ok: true }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EXDEV') {
      try {
        await fs.cp(src, dest, { recursive: true, force: true, errorOnExist: false })
        await fs.rm(src, { recursive: true, force: true })
        return { ok: true }
      } catch (e2) {
        return { ok: false, reason: `跨卷移动目录失败：${(e2 as Error).message}` }
      }
    }
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, locked: true, reason: '目录被占用或权限不足' }
    return { ok: false, reason: err.code || err.message }
  }
}

function keepUntilOf(risk: RiskLevel, keepDaysLow: number, keepDaysHigh: number): number {
  const days = risk === 'high' ? keepDaysHigh : keepDaysLow
  return Date.now() + days * 86_400_000
}

export async function execute(
  plan: DeletePlan,
  paths: CleanerPaths,
  opts: CleanOptions
): Promise<CleanResult> {
  const { useQuarantine, onProgress, signal } = opts
  const stamp = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const quarantineId = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
    stamp.getHours()
  )}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
  const batchDir = join(paths.quarantineRoot, quarantineId)

  const failed: { path: string; reason: string }[] = []
  const records: QuarantineRecord[] = []
  let ok = 0
  let freed = 0
  let pendingReboot = 0

  const total = plan.items.length
  let done = 0

  if (useQuarantine && total > 0) await ensureDir(batchDir)

  for (const it of plan.items) {
    if (signal?.cancelled) break
    done++
    onProgress?.(done, total, it.fullPath)

    // [校验三] 状态复核：删除前再次 stat，比对 size + mtime，防路径复用误删
    let st: import('node:fs').Stats
    try {
      st = await fs.stat(it.fullPath)
    } catch {
      failed.push({ path: it.fullPath, reason: '文件已不存在（可能已被其他程序删除）' })
      continue
    }
    const isDir = st.isDirectory()
    if (!isDir && it.sizeBytes > 0) {
      // 目录体积是估算值，只对文件做严格比对
      if (st.size !== it.sizeBytes) {
        failed.push({
          path: it.fullPath,
          reason: `状态复核失败：体积已变化（扫描时 ${it.sizeBytes} → 当前 ${st.size}），已跳过`
        })
        continue
      }
      if (it.mtime && Math.abs(st.mtimeMs - it.mtime) > 2000) {
        failed.push({ path: it.fullPath, reason: '状态复核失败：修改时间已变化，已跳过' })
        continue
      }
    }

    if (!useQuarantine) {
      // 直接删除（仍走完三重校验）
      try {
        if (isDir) await fs.rm(it.fullPath, { recursive: true, force: true })
        else await fs.unlink(it.fullPath)
        ok++
        freed += it.sizeBytes
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'EBUSY' || err.code === 'EPERM') pendingReboot++
        failed.push({ path: it.fullPath, reason: err.code === 'EBUSY' ? '文件被占用' : err.message })
      }
      continue
    }

    // 移动到隔离区：保留原始路径结构，便于还原与人工核对
    const rel = it.fullPath.replace(/^([a-zA-Z]):\\/, '$1\\')
    const dest = join(batchDir, rel)

    const outcome = isDir ? await moveDir(it.fullPath, dest) : await moveFile(it.fullPath, dest)
    if (!outcome.ok) {
      if (outcome.locked) pendingReboot++
      failed.push({ path: it.fullPath, reason: outcome.reason || '移动失败' })
      continue
    }

    ok++
    freed += it.sizeBytes
    records.push({
      id: 'q_' + createHash('sha1').update(quarantineId + '|' + normKey(it.fullPath)).digest('hex').slice(0, 16),
      originalPath: it.fullPath,
      quarantinedPath: normPath(dest),
      sizeBytes: it.sizeBytes,
      deletedAt: Date.now(),
      keepUntil: keepUntilOf(it.risk, opts.keepDaysLow, opts.keepDaysHigh),
      categoryId: it.categoryId,
      risk: it.risk,
      isDir
    })
  }

  // 写入 manifest.json（原路径 / 大小 / 时间），这是还原能力的唯一依据
  if (useQuarantine && records.length) {
    await fs.writeFile(
      join(batchDir, 'manifest.json'),
      JSON.stringify({ quarantineId, createdAt: Date.now(), records }, null, 2),
      'utf8'
    )
  }

  return {
    taskId: plan.taskId,
    ok,
    failed,
    blocked: plan.blocked,
    freedBytes: freed,
    quarantineId: records.length ? quarantineId : undefined,
    pendingReboot
  }
}

// ───────────────── 隔离区管理 ─────────────────

export async function listQuarantine(root: string): Promise<QuarantineRecord[]> {
  const out: QuarantineRecord[] = []
  let batches: import('node:fs').Dirent[]
  try {
    batches = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const b of batches) {
    if (!b.isDirectory()) continue
    try {
      const raw = await fs.readFile(join(root, b.name, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw) as { records: QuarantineRecord[] }
      for (const r of parsed.records || []) out.push(r)
    } catch {
      continue
    }
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt)
  return out
}

export async function restore(
  root: string,
  ids: string[],
  onConflict: 'skip' | 'overwrite' | 'rename' = 'rename'
): Promise<{ ok: number; failed: string[] }> {
  const all = await listQuarantine(root)
  const wanted = new Set(ids)
  const targets = all.filter((r) => wanted.has(r.id))
  let ok = 0
  const failed: string[] = []

  for (const r of targets) {
    try {
      let dest = r.originalPath
      let exists = false
      try {
        await fs.access(dest)
        exists = true
      } catch {
        exists = false
      }
      if (exists) {
        if (onConflict === 'skip') {
          failed.push(`${r.originalPath}（目标已存在，已跳过）`)
          continue
        }
        if (onConflict === 'rename') {
          const bn = baseName(dest)
          const dot = bn.lastIndexOf('.')
          const stem = dot > 0 ? bn.slice(0, dot) : bn
          const ext = dot > 0 ? bn.slice(dot) : ''
          dest = join(dirname(dest), `${stem}.restored-${Date.now().toString(36)}${ext}`)
        } else {
          await fs.rm(dest, { recursive: true, force: true })
        }
      }
      await ensureDir(dirname(dest))
      if (r.isDir) {
        const res = await moveDir(r.quarantinedPath, dest)
        if (!res.ok) throw new Error(res.reason)
      } else {
        const res = await moveFile(r.quarantinedPath, dest)
        if (!res.ok) throw new Error(res.reason)
      }
      ok++
      await removeFromManifest(root, r)
    } catch (e) {
      failed.push(`${r.originalPath}（${(e as Error).message}）`)
    }
  }
  return { ok, failed }
}

async function removeFromManifest(root: string, rec: QuarantineRecord): Promise<void> {
  // quarantinedPath = root\<batchId>\<...>
  const rel = rec.quarantinedPath.slice(root.length).replace(/^\\/, '')
  const batchId = rel.split('\\')[0]
  if (!batchId) return
  const mf = join(root, batchId, 'manifest.json')
  try {
    const parsed = JSON.parse(await fs.readFile(mf, 'utf8')) as {
      quarantineId: string
      createdAt: number
      records: QuarantineRecord[]
    }
    parsed.records = (parsed.records || []).filter((r) => r.id !== rec.id)
    if (parsed.records.length === 0) {
      await fs.rm(join(root, batchId), { recursive: true, force: true })
    } else {
      await fs.writeFile(mf, JSON.stringify(parsed, null, 2), 'utf8')
    }
  } catch {
    /* ignore */
  }
}

/** 清空隔离区：expiredOnly=true 时仅清理已到期项（保留策略见 5.6.2） */
export async function purge(
  root: string,
  opts: { ids?: string[]; expiredOnly?: boolean } = {}
): Promise<{ ok: number; freed: number }> {
  const all = await listQuarantine(root)
  const now = Date.now()
  const wanted = opts.ids ? new Set(opts.ids) : null
  const targets = all.filter((r) => {
    if (wanted) return wanted.has(r.id)
    if (opts.expiredOnly) return r.keepUntil <= now
    return true
  })

  let ok = 0
  let freed = 0
  for (const r of targets) {
    try {
      await fs.rm(r.quarantinedPath, { recursive: true, force: true })
      ok++
      freed += r.sizeBytes
      await removeFromManifest(root, r)
    } catch {
      /* ignore */
    }
  }
  // 清理空批次目录
  try {
    for (const b of await fs.readdir(root, { withFileTypes: true })) {
      if (!b.isDirectory()) continue
      const dir = join(root, b.name)
      try {
        const left = await fs.readdir(dir)
        if (left.length === 0 || (left.length === 1 && left[0] === 'manifest.json')) {
          const mf = join(dir, 'manifest.json')
          let empty = true
          try {
            const p = JSON.parse(await fs.readFile(mf, 'utf8')) as { records: QuarantineRecord[] }
            empty = (p.records || []).length === 0
          } catch {
            empty = true
          }
          if (empty) await fs.rm(dir, { recursive: true, force: true })
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return { ok, freed }
}

/** 查询占用某文件的进程（按需调用，用于失败项的可操作提示） */
export async function findLockingProcesses(path: string): Promise<{ pid: number; name: string }[]> {
  try {
    const { psJson, asArray } = await import('../scanner/psbridge')
    const rows = asArray(
      await psJson<{ pid: number; name: string }[]>(
        String.raw`
$target = $env:SG_TARGET
$out = New-Object System.Collections.ArrayList
try {
  $procs = Get-Process | Where-Object { $_.Path } 
  foreach ($p in $procs) {
    try {
      foreach ($m in $p.Modules) {
        if ($m.FileName -eq $target) { [void]$out.Add([pscustomobject]@{ pid = $p.Id; name = $p.ProcessName }); break }
      }
    } catch { }
  }
} catch { }
Write-SgJson @($out)
`,
        { timeoutMs: 30_000, env: { SG_TARGET: path } }
      )
    )
    return rows
  } catch {
    return []
  }
}
