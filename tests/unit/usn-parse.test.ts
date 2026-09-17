/**
 * USN 解析与控制台解码 · 分支补测（v3.0.0 · G2，同时为 B1 提权验证铺路）
 *
 * usn.ts 此前覆盖率 23.7%，缺口集中在纯函数部分：
 *   - decodeConsole：fsutil 走控制台代码页（中文系统 GBK），解码错了会「静默不可用」
 *   - parseReadJournal：readjournal 输出的中英文双套关键字解析（B1 第 2 级的核心）
 *   - volumeOf：规则根目录 → 卷号的映射
 * 这些函数在提权环境下拿到真实输出后就要直接投入使用，必须先有回归网。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeConsole, parseReadJournal, volumeOf } from '@junk/usn'

describe('decodeConsole · 控制台编码', () => {
  it('纯 ASCII 输出原样返回', () => {
    assert.equal(decodeConsole(Buffer.from('Usn Journal ID: 0x01\n', 'utf8')).trim(), 'Usn Journal ID: 0x01')
  })

  it('合法 UTF-8 多字节内容不会被误判', () => {
    const s = '下一个 Usn: 0x0000000012340000'
    assert.equal(decodeConsole(Buffer.from(s, 'utf8')), s)
  })

  it('GBK 编码的中文输出能正确还原（UTF-8 解码会出现替换字符）', () => {
    // 「下一个 Usn」的 GBK 字节；按 utf8 解码必然产生 U+FFFD
    const gbk = Buffer.from([0xcf, 0xc2, 0xd2, 0xbb, 0xb8, 0xf6, 0x20, 0x55, 0x73, 0x6e])
    const raw = gbk.toString('utf8')
    assert.ok(raw.includes('\uFFFD'), '前提：按 utf8 解码应出现替换字符')
    const out = decodeConsole(gbk)
    assert.equal(out, '下一个 Usn')
  })

  it('解码失败时回退到 utf8 结果，不抛异常', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x41])
    const out = decodeConsole(buf)
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 0)
  })
})

describe('parseReadJournal · 中英文双套输出', () => {
  it('解析中文输出：文件名 / USN / 原因', () => {
    const text = [
      '文件名       : C:\\Temp\\a.tmp',
      'USN          : 12345',
      '原因         : 关闭 数据覆盖',
      '',
      '文件名       : C:\\Temp\\b.log',
      'USN          : 12346',
      '原因         : 文件删除'
    ].join('\n')
    const r = parseReadJournal(text)
    assert.equal(r.needsElevation, false)
    assert.equal(r.records.length, 2)
    assert.equal(r.records[0].name, 'C:\\Temp\\a.tmp')
    assert.equal(r.records[0].usn, '12345')
    assert.deepEqual(r.records[0].reasons, ['关闭', '数据覆盖'])
    assert.equal(r.records[1].name, 'C:\\Temp\\b.log')
    assert.deepEqual(r.records[1].reasons, ['文件删除'])
  })

  it('解析英文输出：File Name / USN / Reason', () => {
    const text = [
      'File Name    : C:\\Temp\\a.tmp',
      'USN          : 0x0000000000003039',
      'Reason       : Close Data Overwrite',
      'File Name    : C:\\Temp\\b.log',
      'USN          : 0x000000000000303a',
      'Reason       : File Delete'
    ].join('\n')
    const r = parseReadJournal(text)
    assert.equal(r.records.length, 2)
    assert.equal(r.records[0].name, 'C:\\Temp\\a.tmp')
    assert.equal(r.records[0].usn, '0x0000000000003039')
    assert.deepEqual(r.records[0].reasons, ['Close', 'Data', 'Overwrite'])
  })

  it('全角冒号与中文顿号分隔同样识别', () => {
    const r = parseReadJournal('文件名：C:\\a.tmp\n原因：关闭、数据覆盖')
    assert.equal(r.records.length, 1)
    assert.equal(r.records[0].name, 'C:\\a.tmp')
    // 顿号是分隔符：关闭 / 数据覆盖 应拆成两条原因
    assert.deepEqual(r.records[0].reasons, ['关闭', '数据覆盖'])
  })

  it('真实输出（提权实测样本）：Usn 在文件名之前，且原因带 0x 标志位', () => {
    // 2026-09-18 管理员终端实测 fsutil usn readjournal 的完整单条记录。
    // 关键：**Usn 是第一条**，文件名在后 —— 修正前的实现按「文件名开启记录」处理，
    // 会把每条的 USN 赋给上一条记录，整体错位一格。
    const text = [
      'USN 日志 ID    : 0x01db1d5c32c0e941',
      '下一个 USN     : 22712337664',
      '',
      'Usn               : 22712337088',
      '文件名            : LeAppOM.txt.logdat',
      '文件名长度        : 36',
      '原因              : 0x00000002: 数据扩展',
      '时间戳            : 2026/9/18 0:05:41',
      '文件 ID           : 0000000000000000002e0000000006d6',
      '父文件 ID         : 00000000000000000005000000009160',
      '记录长度          : 112',
      '',
      'Usn               : 22712337184',
      '文件名            : LeAppOM.txt.logdat',
      '原因              : 0x80000002: 数据扩展 | 关闭',
      '父文件 ID         : 00000000000000000005000000009160'
    ].join('\n')

    const r = parseReadJournal(text)
    assert.equal(r.records.length, 2, '应解析出 2 条记录')

    // USN 必须与同一条记录的文件名配对，不能错位
    assert.equal(r.records[0].name, 'LeAppOM.txt.logdat')
    assert.equal(r.records[0].usn, '22712337088')
    assert.deepEqual(r.records[0].reasons, ['数据扩展'])
    assert.equal(r.records[0].reasonFlags, '0x00000002')
    assert.equal(r.records[0].fileId, '0000000000000000002e0000000006d6')
    assert.equal(r.records[0].parentFileId, '00000000000000000005000000009160')
    assert.equal(r.records[0].timestamp, '2026/9/18 0:05:41')

    assert.equal(r.records[1].usn, '22712337184')
    assert.deepEqual(r.records[1].reasons, ['数据扩展', '关闭'])
    assert.equal(r.records[1].reasonFlags, '0x80000002')
  })

  it('真实输出：没有路径字段，只有文件名 + ID（上层据此决定不做 ID 反查）', () => {
    const r = parseReadJournal('Usn : 1\n文件名 : a.tmp\n父文件 ID : 00000000000000000005000000009160')
    assert.equal(r.records.length, 1)
    // 文件名里不含任何盘符/分隔符 —— 这就是实测的形态
    assert.ok(!/[:\\]/.test(r.records[0].name.replace(/^\w:/, '')))
    assert.ok(r.records[0].parentFileId)
  })

  it('空输出 / 无记录输出返回空数组且不抛异常', () => {
    for (const t of ['', '   \n\n  ', '没有任何匹配项']) {
      const r = parseReadJournal(t)
      assert.equal(r.records.length, 0)
      assert.equal(r.needsElevation, false)
    }
  })

  it('最后一条记录（没有后续文件名行）也要入账', () => {
    const r = parseReadJournal('文件名 : C:\\x.tmp\nUSN : 1')
    assert.equal(r.records.length, 1)
    assert.equal(r.records[0].usn, '1')
  })

  it('USN / 原因行出现在文件名之前时不会凭空造记录', () => {
    const r = parseReadJournal('USN : 999\n原因 : 关闭')
    assert.equal(r.records.length, 0)
  })
})

describe('volumeOf · 卷号提取', () => {
  it('常见路径都能取到卷号', () => {
    assert.equal(volumeOf('C:\\Users\\a'), 'C:')
    assert.equal(volumeOf('d:\\temp'), 'D:')
    assert.equal(volumeOf('D:'), 'D:')
    assert.equal(volumeOf('/mnt/c'), '')
    assert.equal(volumeOf('\\\\server\\share'), '')
    assert.equal(volumeOf(''), '')
  })
})
