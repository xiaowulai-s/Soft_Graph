/**
 * 验证 B3：Restart Manager 能否在**真实占用期间**查出占用进程。
 * 做法：由独立 PowerShell 进程以 FileShare.None 持有文件句柄 → Node 侧查询 → 释放后再次查询。
 */
import { spawn, execSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { findLockingProcessesDetailed } from '@junk/locks'

const HOLD = String.raw`
$s = [System.IO.File]::Open($env:SG_TARGET, 'Open', 'Read', 'None')
Write-Output "HELD $PID"
Start-Sleep -Seconds 40
$s.Close(); $s.Dispose()
`

async function main(): Promise<void> {
  const dir = join(tmpdir(), 'sg-lock2-' + randomBytes(4).toString('hex'))
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, 'occupied.bin')
  await fs.writeFile(file, 'z'.repeat(4096))

  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { env: { ...process.env, SG_TARGET: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let holderPid = 0
  ps.stdout.setEncoding('utf8')
  const ready = new Promise<void>((resolve) => {
    ps.stdout.on('data', (c: string) => {
      const m = c.match(/HELD (\d+)/)
      if (m) {
        holderPid = Number(m[1])
        resolve()
      }
    })
  })
  ps.stdin.write(HOLD + '\n')
  await Promise.race([ready, new Promise((r) => setTimeout(r, 10000))])
  console.log('持句柄进程 pid =', holderPid)

  if (!holderPid) {
    console.error('未能启动持句柄进程')
    process.exit(1)
  }

  // 真实占用期间查询
  const during = await findLockingProcessesDetailed(file)
  console.log('【占用期间】占用者:', during.lockers, '· error:', during.error ?? '(无)')
  const hit = during.lockers.some((l) => l.pid === holderPid)
  console.log(hit ? '✅ 正确识别到持有句柄的进程' : '❌ 未识别到持有句柄的进程')

  // 删除应失败（share None）
  let delErr = ''
  try {
    await fs.unlink(file)
    delErr = '(竟然删除成功)'
  } catch (e) {
    delErr = (e as NodeJS.ErrnoException).code ?? (e as Error).message
  }
  console.log('占用期间删除结果:', delErr)

  // 释放后查询
  try {
    execSync(`taskkill /PID ${holderPid} /F`, { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 1500))
  const after = await findLockingProcessesDetailed(file)
  console.log('【释放后】占用者:', after.lockers.length, '条 · error:', after.error ?? '(无)')
  console.log(after.lockers.length === 0 ? '✅ 释放后无残留误报' : '⚠️ 释放后仍有占用者')

  try {
    ps.kill()
  } catch {
    /* ignore */
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  console.log('\n验证结束')
  process.exit(hit ? 0 : 1)
}
void main()
