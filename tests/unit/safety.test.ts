/**
 * 安全白名单测试（9.1 最高优先级规则）
 * 这是整个产品信任的地基，因此既测正常路径，也做 fuzz 保证不崩溃、不误放行。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { guardPath, isScannable, isOneClickEligible } from '@shared/safety'
import { isSubPath, normPath, normKey } from '@shared/util'

const SYS = process.env.SystemRoot || 'C:\\Windows'
const LOCAL = process.env.LOCALAPPDATA || 'C:\\Users\\x\\AppData\\Local'
const PROFILE = process.env.USERPROFILE || 'C:\\Users\\x'
const PF = process.env.ProgramFiles || 'C:\\Program Files'

describe('guardPath —— 整树禁删', () => {
  const blocked = [
    `${SYS}\\System32\\kernel32.dll`,
    `${SYS}\\SysWOW64\\user32.dll`,
    `${SYS}\\WinSxS\\amd64_x\\x.dll`,
    `${PF}\\SomeApp\\a.dll`,
    `${SYS}\\Fonts\\arial.ttf`
  ]
  for (const p of blocked) {
    it(`拦截 ${p}`, () => {
      const v = guardPath(p)
      assert.equal(v.allowed, false)
      assert.ok(v.reason && v.reason.length > 0, '必须给出拦截原因')
    })
  }
})

describe('guardPath —— 关键目录本身禁删', () => {
  const blocked = [SYS, `${SYS}\\Temp`, LOCAL, PROFILE, `${PROFILE}\\Desktop`, `${PROFILE}\\Documents`, PF]
  for (const p of blocked) {
    it(`拦截目录本身 ${p}`, () => assert.equal(guardPath(p).allowed, false))
  }
})

describe('guardPath —— 卷根与非法输入', () => {
  it('拦截卷根', () => {
    assert.equal(guardPath('C:\\').allowed, false)
    assert.equal(guardPath('D:').allowed, false)
  })
  it('拦截 UNC 路径', () => {
    assert.equal(guardPath('\\\\server\\share\\a.txt').allowed, false)
  })
  it('拦截相对路径', () => {
    assert.equal(guardPath('foo\\bar.txt').allowed, false)
    assert.equal(guardPath('').allowed, false)
  })
  it('拦截含相对跳转的路径', () => {
    assert.equal(guardPath('C:\\temp\\..\\..\\Windows\\System32\\x.dll').allowed, false)
  })
})

describe('guardPath —— 关键文件名禁删', () => {
  const names = ['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'bootmgr', 'ntuser.dat']
  for (const n of names) {
    it(`拦截关键文件名 ${n}`, () => {
      assert.equal(guardPath(`C:\\${n}`).allowed, false)
    })
  }
})

describe('guardPath —— 允许清理的路径', () => {
  const allowed = [
    `${LOCAL}\\Temp\\a.tmp`,
    `${SYS}\\Temp\\b.tmp`,
    `${LOCAL}\\Google\\Chrome\\User Data\\Default\\Cache\\data_1`,
    `${PROFILE}\\Desktop\\old.log`,
    `${PROFILE}\\Downloads\\setup.exe`,
    'C:\\Windows.old\\Users\\x\\a.txt'
  ]
  for (const p of allowed) {
    it(`允许 ${p}`, () => assert.equal(guardPath(p).allowed, true, `被误拦：${guardPath(p).reason}`))
  }
})

describe('guardPath —— 大小写与斜杠归一', () => {
  it('大小写不同也应拦截', () => {
    assert.equal(guardPath(`${SYS.toUpperCase()}\\SYSTEM32\\KERNEL32.DLL`).allowed, false)
  })
  it('正斜杠路径也应识别', () => {
    const p = `${SYS}\\System32\\x.dll`.replace(/\\/g, '/')
    assert.equal(guardPath(p).allowed, false)
  })
  it('尾部反斜杠不影响判定', () => {
    assert.equal(guardPath(`${SYS}\\System32\\`).allowed, false)
  })
})

describe('guardPath —— fuzz：任何输入都不应抛异常', () => {
  it('随机字符串与畸形路径', () => {
    const seeds = [
      '', ' ', '\\', '/', ':', '::', 'C', 'C:', 'C:\\\\', '\\\\?\\C:\\Windows',
      '\u0000', '中文路径\\测试.dll', 'a'.repeat(1000), 'C:\\' + 'a\\'.repeat(400),
      'CON', 'NUL', 'C:\\con\\x', '../', '....//....//Windows/System32'
    ]
    for (const s of seeds) {
      const v = guardPath(s)
      assert.equal(typeof v.allowed, 'boolean', `输入 ${JSON.stringify(s.slice(0, 20))} 未返回布尔值`)
    }
  })
})

describe('isSubPath 边界', () => {
  it('同路径视为子路径', () => assert.equal(isSubPath('C:\\a', 'C:\\a'), true))
  it('前缀相同但不是子目录', () => {
    assert.equal(isSubPath('C:\\abc\\x', 'C:\\ab'), false, 'C:\\abc 不应被当作 C:\\ab 的子路径')
  })
  it('大小写不敏感', () => assert.equal(isSubPath('c:\\A\\b.txt', 'C:\\a'), true))
  it('空值返回 false', () => {
    assert.equal(isSubPath('', 'C:\\a'), false)
    assert.equal(isSubPath('C:\\a', ''), false)
  })
})

describe('normPath / normKey', () => {
  it('统一斜杠并去尾斜杠', () => {
    assert.equal(normPath('C:/a/b/'), 'C:\\a\\b')
    assert.equal(normPath('C:\\a\\\\b'), 'C:\\a\\b')
  })
  it('去掉包裹的引号', () => assert.equal(normPath('"C:\\a\\b.exe"'), 'C:\\a\\b.exe'))
  it('normKey 小写', () => assert.equal(normKey('C:\\A\\B'), 'c:\\a\\b'))
})

describe('isScannable —— 允许清理的例外目录', () => {
  it('Windows\\Temp 可扫描', () => assert.equal(isScannable(`${SYS}\\Temp\\x.tmp`), true))
  it('SoftwareDistribution\\Download 可扫描', () => {
    assert.equal(isScannable(`${SYS}\\SoftwareDistribution\\Download\\a.cab`), true)
  })
  it('Windows.old 可扫描', () => assert.equal(isScannable('C:\\Windows.old\\Users\\x\\a.txt'), true))
  it('System32 内部仍不可扫描', () => assert.equal(isScannable(`${SYS}\\System32\\x.dll`), false))
})

describe('一键删除安全边界（不可通过设置关闭）', () => {
  it('仅低风险 + 默认勾选 才eligible', () => {
    assert.equal(isOneClickEligible('low', true), true)
  })
  it('中风险即使默认勾选也排除', () => assert.equal(isOneClickEligible('medium', true), false))
  it('高风险即使默认勾选也排除', () => assert.equal(isOneClickEligible('high', true), false))
  it('低风险但未默认勾选也排除', () => assert.equal(isOneClickEligible('low', false), false))
  it('提示级不参与', () => assert.equal(isOneClickEligible('hint', true), false))
})
