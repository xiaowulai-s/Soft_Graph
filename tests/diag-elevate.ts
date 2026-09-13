/**
 * E3 提权通道真机验证
 *
 * 验证策略（本环境无法自动点 UAC，因此分两层）：
 *   ① helper 脚本语法：用 PowerShell 的 AST 解析器 ParseFile 静态校验（不执行）
 *   ② helper 行为：以**当前权限**直接运行 helper，验证移动 / 拒绝 / manifest 三条逻辑。
 *      提权只改变权限，不改变脚本逻辑 —— 因此这一层能真实覆盖 helper 的正确性。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildElevatedTask, validateElevatedTask } from '@junk/elevated'
import { ensureHelper } from '../apps/desktop/src/main/services/elevate'
import type { JunkItem } from '@shared/types'

const PS = 'powershell.exe'

function runPs(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
      (e, stdout, stderr) => {
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(stdout ?? ''), err: String(stderr ?? '') })
      }
    )
  })
}

async function main(): Promise<void> {
  const local = process.env.LOCALAPPDATA || ''
  const temp = process.env.TEMP || ''
  const root = join(local, 'SoftGraph')
  const sandbox = join(temp, 'sg-elev-test-' + randomBytes(3).toString('hex'))
  const work = join(sandbox, 'SoftGraph', 'Quarantine')
  await fs.mkdir(sandbox, { recursive: true })

  console.log('═══ ① helper 脚本语法解析 ═══')
  const helper = await ensureHelper(root)
  console.log('helper 路径:', helper)
  const st = await fs.stat(helper)
  console.log(`落盘大小: ${st.size} B`)
  const parse = await runPs([
    '-Command',
    `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${helper.replace(/'/g, "''")}',[ref]$t,[ref]$e)|Out-Null; if($e -and $e.Count -gt 0){ $e | ForEach-Object { 'ERR: ' + $_.Message } } else { 'AST_OK' }`
  ])
  const astOk = /AST_OK/.test(parse.out)
  console.log('语法解析:', astOk ? '✅ 通过（0 语法错误）' : `❌ ${parse.out || parse.err}`)

  console.log('\n═══ ② helper 行为（当前权限直接运行）═══')
  // 合法项（落在提权可清理区且真实存在）
  const good: string[] = []
  for (const n of ['a.tmp', 'b.log']) {
    const p = join(sandbox, n)
    await fs.writeFile(p, 'x'.repeat(2048), 'utf8')
    good.push(p)
  }
  const ps1 = join(sandbox, 'evil.ps1')
  await fs.writeFile(ps1, 'Write-Host pwned', 'utf8')
  const ghost = join(sandbox, 'ghost.tmp')

  const items: JunkItem[] = [...good, ps1, ghost].map((p, i) => ({
    id: 'j' + i,
    categoryId: 'GC-01',
    fullPath: p,
    name: p.split('\\').pop()!,
    sizeBytes: i < 2 ? 2048 : 16,
    mtime: Date.now(),
    risk: 'low' as const,
    keep: false
  }))

  const batchId = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 8)
    .replace(/^(\d{4})(\d{2})(\d{2})$/, '$1$2$3') + '-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '')

  const { task, accepted, rejected } = buildElevatedTask(items, {
    taskId: 'task_diag0001',
    quarantineRoot: work,
    batchId,
    keepDaysLow: 7,
    keepDaysHigh: 14
  })
  console.log(`清单生成：接受 ${accepted.length} / 拒绝 ${rejected.length}`)
  for (const r of rejected) console.log(`  ✗ ${r.path.split('\\').pop()} → ${r.reason}`)
  if (!task) throw new Error('未生成任务')

  console.log('执行侧整任务校验:', validateElevatedTask(task).ok ? '✅ 通过' : '❌ 失败')

  const taskFile = join(sandbox, 'task.json')
  await fs.writeFile(taskFile, JSON.stringify(task), 'utf8')
  const r = await runPs(['-File', helper, '-TaskFile', taskFile])
  console.log('helper 退出码:', r.code, r.err.trim() ? `stderr=${r.err.trim().slice(0, 200)}` : '')

  const result = JSON.parse(await fs.readFile(taskFile + '.result.json', 'utf8')) as {
    ok: boolean
    succeeded: number
    freedBytes: number
    failed: { path: string; reason: string }[]
  }
  console.log(`结果：ok=${result.ok} 成功 ${result.succeeded} 释放 ${result.freedBytes}B 失败 ${result.failed.length}`)
  for (const f of result.failed) console.log(`  ✗ ${f.path.split('\\').pop()} → ${f.reason}`)

  console.log('\n文件系统核对：')
  for (const p of good) console.log(`  原位置已消失: ${p.split('\\').pop()} = ${!(await fs.stat(p).catch(() => null))}`)
  const moved = await fs.readdir(join(work, batchId)).catch(() => [] as string[])
  console.log('隔离区内容:', moved.join(', ') || '(空)')
  const manifest = JSON.parse(
    await fs.readFile(join(work, batchId, 'manifest.json'), 'utf8').catch(() => '{}')
  ) as { quarantineId?: string; elevated?: boolean; records?: unknown[] }
  console.log(`manifest: batch=${manifest.quarantineId} elevated=${manifest.elevated} records=${manifest.records?.length}`)

  console.log('\n═══ ③ 篡改任务后执行侧必须拒绝 ═══')
  const tampered = JSON.parse(JSON.stringify(task))
  tampered.items[0].path = 'C:\\Windows\\System32\\kernel32.dll'
  console.log('篡改为 System32 路径:', validateElevatedTask(tampered).ok ? '❌ 竟然通过' : `✅ 已拒绝（${validateElevatedTask(tampered).reason}）`)
  const tampered2 = JSON.parse(JSON.stringify(task))
  tampered2.items[0].path = sandbox + '\\*.tmp'
  console.log('篡改为通配符:', validateElevatedTask(tampered2).ok ? '❌ 竟然通过' : '✅ 已拒绝')

  await fs.rm(sandbox, { recursive: true, force: true })
  console.log('\n清理完成。')
  process.exit(0)
}

void main()
