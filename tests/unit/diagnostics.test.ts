/**
 * C5 诊断包测试：脱敏正确性 + ZIP 容器格式
 *
 * 这两点是诊断包能否安全交付的关键：
 *   - 脱敏漏一处，用户就把自己的用户名/目录结构泄露出去了
 *   - ZIP 格式错一点，用户那边根本打不开，等于没有诊断包
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createZip, crc32 } from '../../apps/desktop/src/main/services/zip'
import { makeRedactor } from '../../apps/desktop/src/main/services/logger'
import { redactText, redactDeep } from '../../apps/desktop/src/main/services/diagnostics'

// ───────────────── ZIP ─────────────────

/** 解析 zip（仅用于测试自校验；EOCD → 中央目录 → 本地头 → 数据） */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd >= 0, '应能定位 EOCD')
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  assert.equal(cdOffset + cdSize, eocd, '中央目录应紧邻 EOCD')

  const out = new Map<string, Buffer>()
  let p = cdOffset
  for (let i = 0; i < total; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '中央目录项签名')
    const method = buf.readUInt16LE(p + 10)
    assert.equal(method, 0, 'store 模式')
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, '本地头签名')
    assert.equal(buf.readUInt16LE(localOff + 6) & 0x0800, 0x0800, '应设置 UTF-8 标志位')
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const lSize = buf.readUInt32LE(localOff + 22)
    assert.equal(lSize, size, '本地头与中央目录的大小应一致')
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const data = buf.subarray(dataStart, dataStart + size)
    if (size > 0) {
      assert.equal(crc32(data), crc, `${name} 的 CRC32 应匹配`)
    }
    out.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  assert.equal(p, eocd, '中央目录应被完整消费')
  return out
}

describe('C5 ZIP 容器（零依赖 store 模式）', () => {
  it('内容可完整读回（含中文文件名与路径分隔符归一化）', () => {
    const zip = createZip([
      { name: 'README.txt', data: 'hello 诊断包' },
      { name: 'logs\\softgraph-recent.jsonl', data: '{"a":1}\n{"b":2}\n' },
      { name: 'empty.txt', data: '' }
    ])
    const files = readZip(zip)
    assert.equal(files.size, 3)
    assert.equal(files.get('README.txt')!.toString('utf8'), 'hello 诊断包')
    assert.equal(files.get('logs/softgraph-recent.jsonl')!.toString('utf8'), '{"a":1}\n{"b":2}\n')
    assert.equal(files.get('empty.txt')!.length, 0)
  })

  it('CRC32 与标准实现一致（校验向量 "123456789" = 0xCBF43926）', () => {
    assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926)
  })

  it('空包也能生成合法 zip', () => {
    const files = readZip(createZip([]))
    assert.equal(files.size, 0)
  })

  it('二进制内容不被破坏', () => {
    const bin = Buffer.from([0, 1, 2, 255, 254, 128, 0, 65])
    const files = readZip(createZip([{ name: 'b.bin', data: bin }]))
    assert.deepEqual([...files.get('b.bin')!], [...bin])
  })
})

// ───────────────── 脱敏 ─────────────────

describe('C5 脱敏：日志落盘前必须已不含个人信息', () => {
  it('任意盘符下的用户目录被替换为 %USER%', () => {
    assert.equal(
      redactText('C:\\Users\\Alice\\AppData\\Local\\Temp\\a.tmp'),
      'C:\\Users\\%USER%\\AppData\\Local\\Temp\\a.tmp'
    )
    assert.equal(redactText('d:\\users\\bob\\x'), 'd:\\users\\%USER%\\x')
    assert.equal(redactText('C:/Users/Carol/y'), 'C:/Users/%USER%/y')
  })

  it('被重定向的库目录整体替换为 %USERPROFILE%', () => {
    const out = redactText('扫描 D:\\文档\\报告.docx 与 D:\\图片\\a.png', ['D:\\文档', 'D:\\图片'])
    assert.ok(!out.includes('文档'), '不应残留重定向目录名')
    assert.equal(out, '扫描 %USERPROFILE%\\报告.docx 与 %USERPROFILE%\\a.png')
  })

  it('计算机名被替换', () => {
    const redact = makeRedactor({ computerName: 'DESKTOP-ABC123' })
    assert.equal(redact('host=DESKTOP-ABC123, user ok'), 'host=%COMPUTER%, user ok')
  })

  it('长 hex（疑似 token）被截断', () => {
    const token = 'a'.repeat(40)
    const out = redactText(`token=${token}`)
    assert.ok(!out.includes(token), '长 hex 不应原样保留')
    assert.ok(out.startsWith('token=aaaaaaaa…'))
  })

  it('redactDeep 递归处理对象与数组，不留漏网字段', () => {
    const out = redactDeep({
      path: 'C:\\Users\\Alice\\a.txt',
      nested: { list: ['D:\\文档\\x.txt', 'C:\\Users\\Bob\\y.txt'] },
      n: 42,
      b: true,
      nil: null
    }, ['D:\\文档']) as Record<string, unknown>
    assert.equal(out.path, 'C:\\Users\\%USER%\\a.txt')
    const nested = out.nested as { list: string[] }
    assert.equal(nested.list[0], '%USERPROFILE%\\x.txt')
    assert.equal(nested.list[1], 'C:\\Users\\%USER%\\y.txt')
    assert.equal(out.n, 42)
    assert.equal(out.b, true)
    assert.equal(out.nil, null)
  })

  it('替换是幂等的（二次脱敏不产生 %USER%%USER%）', () => {
    const once = redactText('C:\\Users\\Alice\\x')
    assert.equal(redactText(once), once)
  })
})
