/**
 * v4.0 S1 自启动管理：shared/startup 纯函数
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractExeFromCommand,
  startupFolderName,
  startupId,
  isHklm
} from '../../packages/shared/startup'

describe('v4.0 S1 自启动管理', () => {
  it('命令行 exe 解析：引号路径 + 参数', () => {
    assert.equal(
      extractExeFromCommand('"C:\\Program Files\\X\\x.exe" --flag'),
      'C:\\Program Files\\X\\x.exe'
    )
    assert.equal(extractExeFromCommand('C:\\Tools\\x.exe /quiet'), 'C:\\Tools\\x.exe')
    assert.equal(extractExeFromCommand('"C:\\a b\\y.exe"'), 'C:\\a b\\y.exe')
  })

  it('命令行 exe 解析：系统程序与空串', () => {
    assert.equal(extractExeFromCommand('rundll32.exe shell32.dll,FA'), 'rundll32.exe')
    assert.equal(extractExeFromCommand(''), '')
  })

  it('启动文件夹名与禁用前缀', () => {
    assert.deepEqual(startupFolderName('OneDrive.lnk'), { name: 'OneDrive', disabled: false })
    assert.deepEqual(startupFolderName('[Disabled] OneDrive.lnk'), { name: 'OneDrive', disabled: true })
  })

  it('id 与提权判定', () => {
    assert.equal(startupId('HKCU:Run', 'a'), 'HKCU:Run::a')
    assert.equal(isHklm('HKLM:Run'), true)
    assert.equal(isHklm('HKCU:Run'), false)
  })
})
