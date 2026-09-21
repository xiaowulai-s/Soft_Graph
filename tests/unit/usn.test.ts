/**
 * USN Journal（M2/B1）单元测试
 *
 * 本环境已验证的能力边界：
 *   queryjournal  ✅ 无需管理员
 *   readjournal   需管理员；未提权 → needsElevation，提权 → 真实记录
 *                 （CI 的 runner 是提权的，所以两条分支都要测到）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { platform } from 'node:os'
import { queryJournal, isUsnAvailable, readJournal, parseReadJournal, volumeOf } from '@junk/usn'
import { isElevated } from '@junk/locks'

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

  it('readJournal：不抛异常，且提权状态与结论自洽', async () => {
    if (!ON_WIN) return
    const info = await queryJournal('C:')
    assert.ok(info, '前置条件：queryJournal 应可用')
    const r = await readJournal('C:', info!.nextUsn)
    assert.ok(Array.isArray(r.records))
    const elevated = await isElevated()
    if (elevated) {
      // 提权：以 nextUsn 为起点应当读到 0 条（起点即当前末尾），且绝不该标 needsElevation。
      // 这条正是 CI 连续 8 天红灯的地方 —— 旧断言把「本机没提权」当成了契约：
      // runner 以管理员运行，不带 startusn 的整卷读取撑爆缓冲后被判「非提权失败」，
      // 于是 needsElevation=false 与断言相反。现在两个分支各自钉住真实语义。
      assert.equal(r.needsElevation, false, '提权环境不应标记 needsElevation')
      if (r.error) return // 其它失败（如卷刚被重置）已由上层按 available=false 退回签名比对
      assert.equal(r.records.length, 0, '起点取 nextUsn 时应无变更记录')
    } else {
      assert.equal(r.needsElevation, true, `未提权应标记 needsElevation：${r.error ?? ''}`)
      assert.equal(r.records.length, 0, '未提权不得给出记录（否则会被当成「无变更」而误复用缓存）')
    }
  })

  it('readJournal：缺少 startUsn 时拒绝发无界请求（不抛异常、不静默读整卷）', async () => {
    if (!ON_WIN) return
    const r = await readJournal('C:', '')
    assert.equal(r.records.length, 0)
    assert.equal(r.needsElevation, false, '这不是权限问题，不该标 needsElevation')
    assert.match(r.error ?? '', /startUsn/)
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
