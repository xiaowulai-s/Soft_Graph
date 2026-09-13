/** E4 审计日志往返验证：append → flush → recent 读回 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AuditLog } from '../packages/junk/audit'

async function main(): Promise<void> {
  const dir = join(tmpdir(), 'sg-audit-' + randomBytes(3).toString('hex'))
  const log = new AuditLog(dir)
  await log.append({
    ts: Date.now(),
    action: 'clean',
    taskId: 'task_audit01',
    batchId: '20260913-190000',
    freedBytes: 2048,
    results: [
      { path: 'C:\\Users\\x\\Temp\\a.tmp', sizeBytes: 1024, ok: true },
      { path: 'C:\\Users\\x\\Temp\\b.log', sizeBytes: 1024, ok: false, reason: '文件被占用' }
    ]
  })
  await log.append({
    ts: Date.now() + 1,
    action: 'restore',
    taskId: 'task_audit02',
    freedBytes: 0,
    results: [{ path: 'C:\\Users\\x\\Temp\\a.tmp', sizeBytes: 1024, ok: true }]
  })
  const entries = await log.recent(10)
  console.log(`读回 ${entries.length} 条（新→旧）：`)
  for (const e of entries) {
    console.log(`  ${e.action} ${e.taskId} results=${e.results.length} freed=${e.freedBytes} batch=${e.batchId ?? '-'}`)
  }
  const restore = entries.find((e) => e.action === 'restore')
  console.log(
    '往返校验:',
    entries.length === 2 && restore && restore.results[0].path.includes('a.tmp') ? '✅ 通过' : '❌ 失败'
  )
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

void main()
