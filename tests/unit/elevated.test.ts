/**
 * 提权通道安全边界测试（E3，文档 5.6.3）
 *
 * 这是本项目的**安全关键路径**：提权进程拥有管理员权限，
 * 必须证明「清单之外的东西一概进不去、清单里的东西只被移动不被执行」。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateElevatedItem,
  validateElevatedTask,
  buildElevationCommand,
  buildElevatedTask,
  ELEVATED_TASK_VERSION,
  ELEVATED_DENY_EXT,
  type ElevatedItem,
  type ElevatedTask
} from '@junk/elevated'
import type { JunkItem } from '@shared/types'

// 用「确定落在提权可清理区」的路径构造合法条目：
// 不依赖 %TEMP%（CI runner 上可能是 D:\a\_temp 之类，不在白名单内）
const WIN = process.env.SystemRoot || 'C:\\Windows'
const tempDir = `${WIN}\\Temp\\sg-elev-check`

function item(overrides: Partial<ElevatedItem> = {}): ElevatedItem {
  return {
    path: `${tempDir}\\a.tmp`,
    sizeBytes: 1024,
    mtimeMs: Date.now(),
    categoryId: 'GC-01',
    risk: 'low',
    keepUntil: Date.now() + 7 * 24 * 3600 * 1000,
    ...overrides
  }
}

function junk(overrides: Partial<JunkItem> = {}): JunkItem {
  return {
    id: 'j1',
    categoryId: 'GC-01',
    fullPath: `${tempDir}\\a.tmp`,
    name: 'a.tmp',
    sizeBytes: 1024,
    mtime: Date.now(),
    risk: 'low',
    keep: false,
    ...overrides
  }
}

describe('E3 提权条目校验：拒绝一切「非明确文件」的输入', () => {
  it('正常临时文件通过', () => {
    assert.equal(validateElevatedItem(item()), null)
  })

  it('通配符一律拒绝（不接受 * ? [ ]）', () => {
    for (const p of [
      `${tempDir}\\*.tmp`,
      `${tempDir}\\a?.tmp`,
      `${tempDir}\\[ab].tmp`,
      `${tempDir}\\a]b.tmp`
    ]) {
      const r = validateElevatedItem(item({ path: p }))
      assert.ok(r && /通配符/.test(r), `应拒绝 ${p}，实际：${r}`)
    }
  })

  it('拒绝 UNC / 网络路径', () => {
    const r = validateElevatedItem(item({ path: '\\\\server\\share\\a.tmp' }))
    assert.ok(r && /UNC/.test(r), `实际：${r}`)
  })

  it('拒绝相对路径', () => {
    assert.ok(validateElevatedItem(item({ path: 'a.tmp' })))
    assert.ok(validateElevatedItem(item({ path: '.\\a.tmp' })))
    assert.ok(validateElevatedItem(item({ path: 'C:a.tmp' })))
  })

  it('拒绝含相对段的路径（. / ..）', () => {
    const r = validateElevatedItem(item({ path: `${tempDir}\\..\\a.tmp` }))
    assert.ok(r && /相对段/.test(r), `实际：${r}`)
  })

  it('拒绝脚本与可执行类型（提权通道的能力边界）', () => {
    for (const ext of ['.ps1', '.bat', '.cmd', '.vbs', '.js', '.reg', '.msi', '.exe', '.dll']) {
      assert.ok(ELEVATED_DENY_EXT.has(ext), `${ext} 应在拒绝名单内`)
      const r = validateElevatedItem(item({ path: `${tempDir}\\x${ext}` }))
      assert.ok(r && r.includes(ext), `应拒绝 ${ext}，实际：${r}`)
    }
  })

  it('拒绝受保护路径（System32 / Program Files / 卷根）', () => {
    const sys = process.env.SystemRoot || 'C:\\Windows'
    for (const p of [
      `${sys}\\System32\\kernel32.dll.bak`,
      `${sys}\\notepad.exe.bak`,
      'C:\\Program Files\\someapp\\cache.tmp',
      'C:\\'
    ]) {
      const r = validateElevatedItem(item({ path: p }))
      assert.ok(r, `应拒绝受保护路径 ${p}`)
    }
  })

  it('提权通道比普通通道更严：拒绝 Windows 根目录下的文件', () => {
    // 普通删除允许清理 C://Windows 的子目录（Temp/Logs/...），因此 guardPath 不能整棵禁删；
    // 提权通道用「可清理区白名单」把边界收回，以下路径必须被拒。
    for (const p of [`${WIN}\\notepad.exe.bak`, `${WIN}\\some.log`, `${WIN}\\System32\\x.tmp`]) {
      const r = validateElevatedItem(item({ path: p }))
      assert.ok(r, `应拒绝 ${p}`)
    }
  })

  it('多用户场景：其他用户的 Temp 允许（这是提权的真实用武之地）', () => {
    assert.equal(
      validateElevatedItem(item({ path: 'C:\\Users\\OtherUser\\AppData\\Local\\Temp\\a.tmp' })),
      null
    )
  })

  it('拒绝空路径与超长路径', () => {
    assert.ok(validateElevatedItem(item({ path: '' })))
    assert.ok(validateElevatedItem(item({ path: 'C:\\' + 'a'.repeat(33000) })))
  })

  it('拒绝非法 size / mtime / keepUntil', () => {
    assert.ok(validateElevatedItem(item({ sizeBytes: -1 })))
    assert.ok(validateElevatedItem(item({ sizeBytes: Number.NaN })))
    assert.ok(validateElevatedItem(item({ mtimeMs: 0 })))
    assert.ok(validateElevatedItem(item({ keepUntil: Date.now() - 1000 })))
  })
})

describe('E3 提权任务级校验（执行侧纵深防御）', () => {
  const good: ElevatedTask = {
    version: ELEVATED_TASK_VERSION,
    taskId: 'task_abc123',
    createdAt: Date.now(),
    action: 'quarantine',
    quarantineRoot: 'C:\\Users\\x\\AppData\\Local\\SoftGraph\\Quarantine',
    batchId: '20260913-180501',
    items: [item()]
  }

  it('合法任务通过', () => {
    assert.equal(validateElevatedTask(good).ok, true)
  })

  it('版本不符 / 动作被改 / taskId 非法 → 拒绝', () => {
    assert.equal(validateElevatedTask({ ...good, version: 99 }).ok, false)
    assert.equal(validateElevatedTask({ ...good, action: 'runScript' }).ok, false)
    assert.equal(validateElevatedTask({ ...good, taskId: 'a' }).ok, false)
    assert.equal(validateElevatedTask({ ...good, taskId: 'task id 带空格' }).ok, false)
  })

  it('隔离区必须在应用数据目录内（防被引导到任意位置）', () => {
    const v = validateElevatedTask({ ...good, quarantineRoot: 'C:\\Windows\\Temp' })
    assert.equal(v.ok, false)
    assert.ok(/应用数据目录/.test(v.reason ?? ''))
  })

  it('批目录名必须符合 YYYYMMDD-HHMMSS', () => {
    assert.equal(validateElevatedTask({ ...good, batchId: 'evil' }).ok, false)
    assert.equal(validateElevatedTask({ ...good, batchId: '2026-09-13' }).ok, false)
  })

  it('空清单 / 超量清单 → 拒绝', () => {
    assert.equal(validateElevatedTask({ ...good, items: [] }).ok, false)
    const many = Array.from({ length: 20001 }, () => item())
    assert.equal(validateElevatedTask({ ...good, items: many }).ok, false)
  })

  it('任一条目非法 → 整任务拒绝（不做部分执行）', () => {
    const v = validateElevatedTask({
      ...good,
      items: [item(), item({ path: `${tempDir}\\sg-elev-check\\*.tmp` })]
    })
    assert.equal(v.ok, false)
    assert.ok(/通配符/.test(v.reason ?? ''))
  })

  it('非对象输入不抛异常', () => {
    for (const v of [null, undefined, 42, 'x', []]) {
      assert.equal(validateElevatedTask(v).ok, false)
    }
  })
})

describe('E3 提权启动命令构造', () => {
  it('只包含固定参数与两个常量路径，无用户可控拼接', () => {
    const args = buildElevationCommand('C:\\app\\helpers\\h.ps1', 'C:\\app\\tmp\\t.json')
    assert.deepEqual(args, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\app\\helpers\\h.ps1',
      '-TaskFile',
      'C:\\app\\tmp\\t.json'
    ])
  })

  it('相对路径 / 通配符 → 直接抛错（构造阶段即失败）', () => {
    assert.throws(() => buildElevationCommand('h.ps1', 'C:\\t.json'))
    assert.throws(() => buildElevationCommand('C:\\h.ps1', 't.json'))
    assert.throws(() => buildElevationCommand('C:\\h*.ps1', 'C:\\t.json'))
    assert.throws(() => buildElevationCommand('C:\\h.ps1', 'C:\\t?.json'))
  })
})

describe('E3 清单生成：被拒条目必须留痕', () => {
  it('混合清单按规则分流，拒绝原因落到 rejected', () => {
    const { task, accepted, rejected } = buildElevatedTask(
      [
        junk(),
        junk({ id: 'j2', fullPath: `${tempDir}\\b.log`, name: 'b.log' }),
        junk({ id: 'j3', fullPath: `${tempDir}\\sg-elev-check\\*.tmp`, name: '*.tmp' }),
        junk({ id: 'j4', fullPath: `${tempDir}\\evil.ps1`, name: 'evil.ps1' }),
        junk({ id: 'j5', fullPath: 'C:\\Windows\\System32\\x.tmp', name: 'x.tmp' }),
        junk({ id: 'j6', keep: true })
      ],
      {
        taskId: 'task_mix001',
        quarantineRoot: 'C:\\Users\\x\\AppData\\Local\\SoftGraph\\Quarantine',
        batchId: '20260913-180501',
        keepDaysLow: 7,
        keepDaysHigh: 14,
        verifyOnDisk: false
      }
    )

    assert.ok(task, '应生成任务')
    assert.equal(accepted.length, 2, '只有 2 条合法项')
    assert.equal(rejected.length, 4, '4 条应被拒绝且留痕')
    assert.ok(rejected.some((r) => /通配符/.test(r.reason)))
    assert.ok(rejected.some((r) => /\.ps1/.test(r.reason)))
    assert.ok(rejected.some((r) => /白名单|保护/.test(r.reason)))
    assert.ok(rejected.some((r) => /保留项/.test(r.reason)))
    // 生成了任务就必须能通过执行侧校验
    assert.equal(validateElevatedTask(task).ok, true)
  })

  it('全部被拒时不产出任务（避免空提权调用）', () => {
    const { task, rejected } = buildElevatedTask([junk({ fullPath: 'C:\\Windows\\x.tmp' })], {
      taskId: 'task_none01',
      quarantineRoot: 'C:\\Users\\x\\AppData\\Local\\SoftGraph\\Quarantine',
      batchId: '20260913-180501',
      keepDaysLow: 7,
      keepDaysHigh: 14,
      verifyOnDisk: false
    })
    assert.equal(task, null)
    assert.equal(rejected.length, 1)
  })

  it('保留期按风险分级（高 14 天 / 低 7 天）', () => {
    const lowAt = Date.now()
    const r = buildElevatedTask([junk({ risk: 'low' }), junk({ id: 'h', risk: 'high', fullPath: `${tempDir}\\c.log` })], {
      taskId: 'task_keep01',
      quarantineRoot: 'C:\\Users\\x\\AppData\\Local\\SoftGraph\\Quarantine',
      batchId: '20260913-180501',
      keepDaysLow: 7,
      keepDaysHigh: 14,
      verifyOnDisk: false
    })
    const low = r.task!.items.find((i) => i.risk === 'low')!
    const high = r.task!.items.find((i) => i.risk === 'high')!
    const day = 24 * 3600 * 1000
    assert.ok(Math.abs(low.keepUntil - lowAt - 7 * day) < 5000)
    assert.ok(Math.abs(high.keepUntil - lowAt - 14 * day) < 5000)
  })
})
