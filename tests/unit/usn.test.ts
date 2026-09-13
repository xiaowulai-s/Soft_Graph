/**
 * USN Journal（M2/B1）单元测试
 *
 * 本环境已验证的能力边界：
 *   queryjournal  ✅ 无需管理员
 *   readjournal   ❌ 错误 5（需提权）→ 必须优雅降级为 needsElevation
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { platform } from 'node:os'
import { queryJournal, isUsnAvailable, readJournal, parseReadJournal, volumeOf } from '@junk/usn'

const ON_WIN = platform() === 'win32'

describe('USN Journal（M2/B1）', () => {
  it('queryJournal：无需提权即可读到 nextUsn', async () => {
    if (!ON_WIN) return
    const info = await queryJournal('C:')
    // Windows 一定带 fsutil：返回 null 说明是「静默降级」，属于缺陷而非环境限制，
    // 这里必须断言而不是 return（曾经的空断言让 PATH 解析 bug 逃过了测试）
    assert.ok(info, 'queryJournal 应返回结果（null 表示 fsutil 不可用或解析失败）')
    assert.equal(info!.volume, 'C:')
    assert.ok(
      /^0x[0-9a-f]+$|^[0-9a-f]{8,}$/.test(info!.nextUsn),
      `nextUsn 应为十六进制：${info!.nextUsn}`
    )
    assert.ok(info!.journalId.length > 0, '应能读到 Journal ID')
  })

  it('isUsnAvailable：Windows 上应为 true', async () => {
    if (!ON_WIN) return
    assert.equal(await isUsnAvailable('C:'), true)
  })

  it('readJournal：非提权环境返回 needsElevation，不抛异常', async () => {
    if (!ON_WIN) return
    const r = await readJournal('C:')
    assert.ok(Array.isArray(r.records))
    if (!r.records.length && r.error) {
      assert.equal(r.needsElevation, true, `非提权失败应标记 needsElevation：${r.error}`)
    }
  })

  it('parseReadJournal：解析中英文混合输出且不崩', () => {
    const r = parseReadJournal(
      ['文件名  : a.txt', 'USN      : 0x1234', '原因     : 关闭 数据扩展', '', 'File Name : b.txt', 'Reason    : Close File create'].join(
        '\n'
      )
    )
    assert.equal(r.records.length, 2)
    assert.equal(r.records[0].name, 'a.txt')
    assert.ok(r.records[0].reasons.length >= 1)
    assert.equal(r.records[1].name, 'b.txt')
  })

  it('parseReadJournal：无匹配内容时返回空数组', () => {
    const r = parseReadJournal('错误 5: 拒绝访问。')
    assert.equal(r.records.length, 0)
  })

  it('volumeOf：卷号提取', () => {
    assert.equal(volumeOf('C:\\Users'), 'C:')
    assert.equal(volumeOf('d:\\data'), 'D:')
    assert.equal(volumeOf('\\\\server\\share'), '')
  })
})
