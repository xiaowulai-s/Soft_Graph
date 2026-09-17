/**
 * 删除安全白名单 · 分支补测（v3.0.0 · G2）
 *
 * safety.ts 是**唯一硬编码、不可被配置绕过**的安全边界，此前覆盖率仅 25%：
 * 已有用例集中在 fuzz 与基本路径，而真正决定「能不能删」的分支
 * （卷根 / UNC / 相对跳转 / exact 目录本身 / Windows 收紧判定 / 关键文件名）
 * 缺少逐条断言。这里按 guardPath 的判定顺序逐分支钉死行为。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { guardPath, isScannable, isOneClickEligible, SKIP_DIR_NAMES } from '@shared/safety'

const SYSROOT = process.env.SystemRoot || 'C:\\Windows'
const DRIVE = process.env.SystemDrive || 'C:'
const UP = process.env.USERPROFILE || `${DRIVE}\\Users\\tester`

describe('guardPath · 前置拦截分支', () => {
  it('空路径一律拒绝', () => {
    const v = guardPath('')
    assert.equal(v.allowed, false)
    assert.match(v.reason || '', /路径为空/)
  })

  it('非绝对路径（相对路径 / 裸文件名）一律拒绝', () => {
    for (const p of ['temp\\x.tmp', 'x.tmp', '.\\cache']) {
      const v = guardPath(p)
      assert.equal(v.allowed, false, `${p} 应被拒`)
      assert.match(v.reason || '', /绝对路径/)
    }
  })

  it('UNC / 网络路径一律拒绝', () => {
    for (const p of ['\\\\server\\share\\x.tmp', '\\\\?\\C:\\Windows\\Temp\\x.tmp']) {
      const v = guardPath(p)
      assert.equal(v.allowed, false, `${p} 应被拒`)
      assert.match(v.reason || '', /UNC/)
    }
  })

  it('卷根目录一律拒绝', () => {
    // 带尾斜杠走「卷根」分支
    for (const p of [`${DRIVE}\\`, 'd:\\']) {
      const v = guardPath(p)
      assert.equal(v.allowed, false, `${p} 应被拒`)
      assert.match(v.reason || '', /卷根/)
    }
    // 裸盘符（"C:"）没有反斜杠，先被「绝对路径格式」拦下 —— 同样拒绝，只是理由不同
    const bare = guardPath(DRIVE)
    assert.equal(bare.allowed, false)
    assert.match(bare.reason || '', /绝对路径/)
  })

  it('含相对跳转 .. 的路径一律拒绝', () => {
    const v = guardPath(`${DRIVE}\\Users\\tester\\..\\..\\Windows\\x.tmp`)
    assert.equal(v.allowed, false)
    assert.match(v.reason || '', /相对跳转/)
  })
})

describe('guardPath · 受保护树与目录本身', () => {
  it('受保护目录树内的任何文件都拒绝（System32 / WinSxS / Program Files）', () => {
    const cases = [
      `${SYSROOT}\\System32\\kernel32.dll`,
      `${SYSROOT}\\SysWOW64\\x.tmp`,
      `${SYSROOT}\\WinSxS\\amd64_x\\y.dll`,
      `${process.env.ProgramFiles || `${DRIVE}\\Program Files`}\\Some App\\uninstall.exe`
    ]
    for (const p of cases) {
      const v = guardPath(p)
      assert.equal(v.allowed, false, `${p} 应被拒`)
      assert.match(v.reason || '', /受保护目录树/)
    }
  })

  it('关键目录「本身」禁删，但内部内容交给规则判定', () => {
    // exact 命中：目录本身
    const self = guardPath(UP)
    assert.equal(self.allowed, false)
    assert.match(self.reason || '', /关键目录本身/)
    const desktop = guardPath(`${UP}\\Desktop`)
    assert.equal(desktop.allowed, false)
    assert.match(desktop.reason || '', /关键目录本身/)

    // 语义要点：exact 只挡目录本身，不挡内部文件 ——
    // 桌面上落了个 a.tmp，用户想删就该能删（风险由规则的风险分级承担）
    assert.equal(guardPath(`${UP}\\Desktop\\a.tmp`).allowed, true)
    // 但系统关键文件名仍然一票否决
    assert.equal(guardPath(`${UP}\\Desktop\\desktop.ini`).allowed, false)
  })

  it('Windows 目录下仅例外缓存目录可删（BUG-21 收紧判定）', () => {
    // 例外：明确列出的缓存目录
    for (const sub of ['Temp', 'Logs', 'Installer', 'Prefetch', 'Minidump', 'SoftwareDistribution\\Download']) {
      const p = `${SYSROOT}\\${sub}\\x.tmp`
      assert.equal(guardPath(p).allowed, true, `${p} 应放行`)
    }
    // 非例外：Windows 根下的散落文件
    for (const p of [`${SYSROOT}\\notepad.exe.bak`, `${SYSROOT}\\中 文\\x.tmp`, `${SYSROOT}\\explorer.exe`]) {
      const v = guardPath(p)
      assert.equal(v.allowed, false, `${p} 应被拒`)
      assert.match(v.reason || '', /Windows 目录下仅允许/)
    }
  })

  it('系统关键文件名即便落在可清理目录里也拒绝', () => {
    for (const name of ['pagefile.sys', 'hiberfil.sys', 'desktop.ini', 'ntuser.dat', 'bootmgr']) {
      const v = guardPath(`${DRIVE}\\Temp\\${name}`)
      assert.equal(v.allowed, false, `${name} 应被拒`)
      assert.match(v.reason || '', /系统关键文件/)
    }
  })

  it('普通垃圾路径放行', () => {
    for (const p of [`${DRIVE}\\Temp\\a.tmp`, `${UP}\\AppData\\Local\\Temp\\b.log`, `${DRIVE}\\Windows.old\\x`, `${DRIVE}\\$WINDOWS.~BT\\y`]) {
      assert.equal(guardPath(p).allowed, true, `${p} 应放行`)
    }
  })
})

describe('isScannable 与一键删除边界', () => {
  it('isScannable：例外目录为真，受保护路径为假', () => {
    assert.equal(isScannable(`${SYSROOT}\\Temp\\x.tmp`), true)
    assert.equal(isScannable(`${DRIVE}\\Temp\\x.tmp`), true)
    assert.equal(isScannable(`${SYSROOT}\\System32\\kernel32.dll`), false)
    assert.equal(isScannable(`${SYSROOT}\\notepad.exe.bak`), false)
  })

  it('isOneClickEligible：只有「低风险 + 默认勾选」可一键删', () => {
    assert.equal(isOneClickEligible('low', true), true)
    assert.equal(isOneClickEligible('low', false), false)
    assert.equal(isOneClickEligible('medium', true), false)
    assert.equal(isOneClickEligible('high', false), false)
  })

  it('SKIP_DIR_NAMES 命中大小写不敏感', () => {
    for (const n of ['winsxs', 'WinSxS', '$RECYCLE.BIN', 'System Volume Information', 'DriverStore']) {
      assert.ok(SKIP_DIR_NAMES.has(n.toLowerCase()), `${n} 应在跳过集合`)
    }
  })
})
