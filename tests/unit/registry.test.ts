/**
 * 注册表清理内核（v3.0.0 · M4）
 *
 * 注册表没有回收站，删错没有第二次机会。因此这个套件重点不在「能不能删」，
 * 而在**那些必须被拦住的输入**：白名单之外的键、MSI 管理的项、误判为残留的正常软件。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRegistryKeyAllowed,
  exeFromUninstallString,
  judgeResidue,
  classifyResidues,
  REGISTRY_ALLOWED_PREFIXES,
  type RegistryEntry
} from '@junk/registry'

const base: RegistryEntry = {
  hive: 'HKLM',
  view: '64',
  keyPath: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{1111}',
  displayName: 'Example App',
  installLocation: 'C:\\Program Files\\Example',
  uninstallString: '"C:\\Program Files\\Example\\uninstall.exe" /S',
  publisher: 'Example Inc.',
  displayVersion: '1.0.0',
  systemComponent: ''
}

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({ ...base, ...over })

describe('注册表白名单', () => {
  it('三条 Uninstall 子树放行', () => {
    for (const pre of REGISTRY_ALLOWED_PREFIXES) {
      assert.equal(isRegistryKeyAllowed(pre + '{1111}'), true, pre)
    }
  })

  it('Uninstall 树本身不放行（否则整棵子树都能被删）', () => {
    for (const pre of REGISTRY_ALLOWED_PREFIXES) {
      assert.equal(isRegistryKeyAllowed(pre), false)
      assert.equal(isRegistryKeyAllowed(pre.slice(0, -1)), false)
    }
  })

  it('大小写不敏感', () => {
    assert.equal(isRegistryKeyAllowed('hklm:\\software\\microsoft\\windows\\currentversion\\uninstall\\{a}'), true)
  })

  it('危险位置一律拒绝（Run / Services / 整个 SOFTWARE / 盘外路径）', () => {
    const bad = [
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\\Evil',
      'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Evil',
      'HKLM:\\SOFTWARE',
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstallx\\{a}',
      'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\\Evil',
      'C:\\Windows\\System32',
      '',
      '\\\\server\\share'
    ]
    for (const b of bad) assert.equal(isRegistryKeyAllowed(b), false, `${b} 应被拒`)
  })

  it('前缀相同但属于兄弟节点不放行（Uninstallx 不是 Uninstall）', () => {
    assert.equal(isRegistryKeyAllowed('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\UninstallBackup\\{a}'), false)
  })
})

describe('卸载命令解析', () => {
  it('带引号的命令取引号内路径', () => {
    assert.equal(exeFromUninstallString('"C:\\Program Files\\A\\un.exe" /S'), 'C:\\Program Files\\A\\un.exe')
  })

  it('不带引号的命令取到 .exe 为止（空格参数不混入）', () => {
    assert.equal(exeFromUninstallString('C:\\A\\un.exe /quiet'), 'C:\\A\\un.exe')
  })

  it('MSI（裸命令名，非绝对路径）/ 空串 / 纯参数都取不到可执行路径', () => {
    // MsiExec.exe 没有盘符路径 —— 这里返回空是正确行为；
    // 判定「MSI 管理的项」由 judgeResidue 直接匹配命令串完成，不依赖本函数
    assert.equal(exeFromUninstallString('MsiExec.exe /X{1111}'), '')
    assert.equal(exeFromUninstallString(''), '')
    assert.equal(exeFromUninstallString('/S'), '')
  })
})

describe('残留判定', () => {
  const none = () => false
  const some = (list: string[]) => (p: string) => list.some((x) => x.toLowerCase() === p.toLowerCase())

  it('正常安装的软件不判定为残留', () => {
    const exists = some([base.installLocation, 'C:\\Program Files\\Example\\uninstall.exe'])
    assert.equal(judgeResidue(base, { exists }), null)
  })

  it('安装目录不存在 → 残留（medium）', () => {
    const exists = some(['C:\\Program Files\\Example\\uninstall.exe'])
    const r = judgeResidue(base, { exists })
    assert.ok(r)
    assert.equal(r!.risk, 'medium')
    assert.match(r!.reasons.join(' '), /安装目录已不存在/)
  })

  it('卸载程序不存在 → 残留', () => {
    const exists = some([base.installLocation])
    const r = judgeResidue(base, { exists })
    assert.ok(r)
    assert.match(r!.reasons.join(' '), /卸载程序已不存在/)
  })

  it('SystemComponent=1 的系统隐藏项绝对不碰（实测本机有 37 条）', () => {
    // 这些项无 DisplayName、无安装位置，早期版本会被判成「空壳残留」
    const hidden = entry({
      displayName: '',
      installLocation: '',
      uninstallString: '',
      systemComponent: '1'
    })
    assert.equal(judgeResidue(hidden, { exists: none }), null)

    // 即便是「看起来像残留」的项，只要带 SystemComponent 也一律跳过
    const hidden2 = entry({ installLocation: 'C:\\Gone', systemComponent: '1' })
    assert.equal(judgeResidue(hidden2, { exists: none }), null)
  })

  it('无 DisplayName 的键不判定（无法确认归属）', () => {
    const noName = entry({ displayName: '', installLocation: 'C:\\Gone' })
    assert.equal(judgeResidue(noName, { exists: none }), null)
  })

  it('卸载程序在 Windows 目录内 → 系统自带应用，跳过', () => {
    // mspaint / SnippingTool 的旧卸载项就长这样
    const sys = entry({
      displayName: 'Microsoft Paint',
      installLocation: '',
      uninstallString: `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\mspaint.exe`,
      publisher: ''
    })
    assert.equal(judgeResidue(sys, { exists: none }), null)
  })

  it('发布者是微软 → 跳过（系统组件一律不动）', () => {
    const ms = entry({ publisher: 'Microsoft Corporation', installLocation: 'C:\\Gone' })
    assert.equal(judgeResidue(ms, { exists: none }), null)
  })

  it('MSI 管理的项一律跳过（交给 Windows Installer，删键只会更脏）', () => {
    const msi = entry({
      uninstallString: 'MsiExec.exe /X{2222}',
      installLocation: 'C:\\Gone',
      displayName: 'MSI App'
    })
    assert.equal(judgeResidue(msi, { exists: none }), null)
  })

  it('没有安装位置也没有卸载命令、但有名字 → 不算残留', () => {
    // 部分软件只在应用商店里管，没有 InstallLocation 是正常的
    const e = entry({ installLocation: '', uninstallString: '' })
    assert.equal(judgeResidue(e, { exists: none }), null)
  })

  it('classifyResidues 只返回残留项并带上体积', () => {
    const good = entry({ keyPath: base.keyPath + '-good' })
    const bad = entry({
      keyPath: base.keyPath + '-bad',
      displayName: 'Gone App',
      installLocation: 'C:\\Gone',
      uninstallString: ''
    })
    const exists = some([base.installLocation, 'C:\\Program Files\\Example\\uninstall.exe'])
    const out = classifyResidues([good, bad], { exists, dirSize: () => 123 })
    assert.equal(out.length, 1)
    assert.equal(out[0].displayName, 'Gone App')
    assert.equal(out[0].sizeBytes, 0, '目录不存在时体积为 0')
  })
})
