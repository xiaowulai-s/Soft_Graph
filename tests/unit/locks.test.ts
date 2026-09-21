/**
 * 占用检测与重启后删除（v2.0.0 M2 / B2+B3）单元测试
 *
 * 重点验证「任何情况下都不抛异常、失败有明确原因」——
 * 这两项能力依赖 PowerShell P/Invoke，在受限环境（无 PS / 非 Windows /
 * 权限策略拦截）必须优雅降级，绝不能影响清理主流程。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { platform } from 'node:os'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { findLockingProcesses, findLockingProcessesDetailed, scheduleDeleteOnReboot, isElevated } from '@junk/locks'

const ON_WIN = platform() === 'win32'

describe('占用检测与重启后删除（M2/B2+B3）', () => {
  it('不存在的路径：返回空占用者，不抛异常', async () => {
    if (!ON_WIN) return
    const ghost = join(tmpdir(), 'sg-lock-ghost-' + randomBytes(4).toString('hex') + '.bin')
    const r = await findLockingProcesses(ghost)
    assert.ok(Array.isArray(r), '应返回数组')
    assert.equal(r.length, 0)
  })

  it('未被占用的文件：无占用者，detailed 不产生致命错误', async () => {
    if (!ON_WIN) return
    const dir = join(tmpdir(), 'sg-lock-t-' + randomBytes(4).toString('hex'))
    await fs.mkdir(dir, { recursive: true })
    const f = join(dir, 'free.bin')
    await fs.writeFile(f, 'a'.repeat(512))
    try {
      const d = await findLockingProcessesDetailed(f)
      assert.equal(d.lockers.length, 0, '未占用的文件不应有占用者')
      // 环境缺少 PS 时允许有 error，但 lockers 必须仍是数组
      assert.ok(Array.isArray(d.lockers))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('查自身可执行文件：必须看到本进程（RM_PROCESS_INFO 布局哨兵）', async () => {
    if (!ON_WIN) return
    // 本进程的 exe 必然处于「已被加载」状态，所以它一定在占用清单里。
    // 这条断言钉的是托管结构体与原生逐字节对齐：v3.0.0 兼容探测发现旧声明
    // 用 C# long 表达 FILETIME（多出 4 字节对齐填充）+ AppName 用了 256 而非 255，
    // 于是第 2 条记录起 PID 全是垃圾值，且 Get-Process 的**终止性**参数绑定错误
    // 会中断整个循环 —— 单占用者用例永远测不到（BUG-35）。
    const d = await findLockingProcessesDetailed(process.execPath)
    assert.ok(!d.error, `RM 通道不应报错：${d.error ?? ''}`)
    const pids = d.lockers.map((l) => l.pid)
    assert.ok(pids.includes(process.pid), `应包含本进程 pid=${process.pid}，实得 ${JSON.stringify(pids)}`)
    assert.ok(
      pids.every((p) => Number.isInteger(p) && p > 0 && p <= 0x7fffffff),
      `所有 pid 必须是合法值：${JSON.stringify(pids)}`
    )
  })

  it('重启后删除：非提权环境下明确返回 needsElevation，不抛异常', async () => {
    if (!ON_WIN) return
    const dir = join(tmpdir(), 'sg-lock-t2-' + randomBytes(4).toString('hex'))
    await fs.mkdir(dir, { recursive: true })
    const f = join(dir, 'pending.bin')
    await fs.writeFile(f, 'b'.repeat(512))
    try {
      const elevated = await isElevated()
      const r = await scheduleDeleteOnReboot(f)
      assert.equal(typeof r.ok, 'boolean')
      assert.ok(['native', 'ps', 'none'].includes(r.source))
      if (!elevated) {
        // 未提权：要么失败并标记 needsElevation，要么返回明确原因
        if (!r.ok) assert.equal(r.needsElevation, true, '未提权失败时应标记 needsElevation')
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('不存在的文件登记重启删除：返回失败且有原因', async () => {
    if (!ON_WIN) return
    const ghost = join(tmpdir(), 'sg-lock-ghost2-' + randomBytes(4).toString('hex') + '.bin')
    const r = await scheduleDeleteOnReboot(ghost)
    assert.equal(r.ok, false)
    assert.ok(r.reason || r.win32Error !== undefined, '失败时应给出原因或 Win32 错误码')
  })

  it('isElevated 返回布尔值且不抛异常', async () => {
    if (!ON_WIN) return
    const e = await isElevated()
    assert.equal(typeof e, 'boolean')
  })
})
