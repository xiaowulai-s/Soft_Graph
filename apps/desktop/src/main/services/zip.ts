/**
 * 极简 ZIP 写入器（v2.0.0 M3/C5）
 *
 * 为什么自己写而不是引依赖：诊断包只是一堆文本文件的容器，
 * 用 store 模式（不压缩）即可，实现约 100 行；
 * 而引入 archiver / jszip 会给「零原生依赖、单 exe 分发」的原则增加体积与供应链面。
 *
 * 支持范围（够用即止）：
 *   - store 模式（method=0，无压缩）
 *   - UTF-8 文件名（通用标志位 bit 11，中文文件名可正常解开）
 *   - 文件与目录条目
 *   - 单次写入全部条目（诊断包场景不需要流式）
 * 不支持：压缩、加密、ZIP64（诊断包不会 >4GB）、分卷。
 */

export interface ZipEntry {
  /** 包内路径，用 / 分隔（ZIP 规范） */
  name: string
  data: Buffer | string
  /** 修改时间（默认当前时间） */
  mtime?: Date
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间（秒精度，最早 1980） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time: time & 0xffff, date: date & 0xffff }
}

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const crc = crc32(data)
    const { time, date } = dosDateTime(e.mtime ?? new Date())
    const isDir = e.name.endsWith('/')
    const size = isDir ? 0 : data.length

    // 本地文件头
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // method = store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(isDir ? 0 : crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    locals.push(local, nameBuf)
    if (!isDir) locals.push(data)

    // 中央目录项
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10) // method
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(isDir ? 0 : crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + (isDir ? 0 : data.length)
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // 本分卷号
  eocd.writeUInt16LE(0, 6) // 中央目录所在分卷
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd])
}
