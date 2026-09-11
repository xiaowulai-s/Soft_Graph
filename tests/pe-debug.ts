/** 诊断：确认 ZCode.exe 导入表为空是「程序本身如此」还是「RVA→偏移映射错误」 */
import { open } from 'node:fs/promises'

const ITER = 20

async function dump(path: string): Promise<void> {
  console.log(`\n=== ${path} ===`)
  const fh = await open(path, 'r')
  const b = await fh.readFile()
  await fh.close()

  const peOff = b.readUInt32LE(0x3c)
  const coff = peOff + 4
  const machine = b.readUInt16LE(coff)
  const nsec = b.readUInt16LE(coff + 2)
  const sizeOpt = b.readUInt16LE(coff + 16)
  const opt = coff + 20
  const magic = b.readUInt16LE(opt)
  const is64 = magic === 0x20b

  console.log(`  machine=0x${machine.toString(16)} sections=${nsec} fileSize=${b.length}`)

  const secOff = opt + sizeOpt
  const secs: { name: string; va: number; vs: number; raw: number; rs: number }[] = []
  for (let i = 0; i < nsec; i++) {
    const o = secOff + i * 40
    secs.push({
      name: b.toString('latin1', o, o + 8).replace(/\0+$/, ''),
      vs: b.readUInt32LE(o + 8),
      va: b.readUInt32LE(o + 12),
      rs: b.readUInt32LE(o + 16),
      raw: b.readUInt32LE(o + 20)
    })
  }
  console.log('  节表：')
  for (const s of secs) {
    console.log(
      `    ${s.name.padEnd(10)} VA=0x${s.va.toString(16).padStart(6)} VS=0x${s.vs
        .toString(16)
        .padStart(6)} Raw=0x${s.raw.toString(16).padStart(7)} RawSize=0x${s.rs.toString(16).padStart(7)}`
    )
  }

  const dirOff = opt + (is64 ? 112 : 96)
  const impRva = b.readUInt32LE(dirOff + 1 * 8)
  const impSize = b.readUInt32LE(dirOff + 1 * 8 + 4)
  console.log(`  导入表目录 RVA=0x${impRva.toString(16)} Size=${impSize}`)

  // 手写 rva2off（与 pe.ts 同逻辑）做对照
  const rva2off = (rva: number): number => {
    for (const s of secs) {
      if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) {
        const d = rva - s.va
        if (d >= s.rs) return -1
        return s.raw + d
      }
    }
    return rva < (secs[0]?.raw ?? 0x400) ? rva : -1
  }

  const off = rva2off(impRva)
  console.log(`  rva2off(importRva) = ${off} (0x${(off < 0 ? 0 : off).toString(16)})`)
  if (off < 0) {
    console.log('  → 导入表 RVA 无法映射到文件偏移（该 PE 可能无导入表，或节表异常）')
    return
  }

  console.log('  导入描述符列表：')
  for (let i = 0; i < ITER; i++) {
    const rec = off + i * 20
    if (rec + 20 > b.length) break
    const oft = b.readUInt32LE(rec)
    const tds = b.readUInt32LE(rec + 4)
    const fwd = b.readUInt32LE(rec + 8)
    const nameRva = b.readUInt32LE(rec + 12)
    const ft = b.readUInt32LE(rec + 16)
    if (oft === 0 && nameRva === 0 && ft === 0) {
      console.log(`    [${i}] 全零描述符 → 链表结束`)
      break
    }
    let name = ''
    if (nameRva) {
      const no = rva2off(nameRva)
      if (no >= 0) {
        let e = no
        while (e < b.length && b[e] !== 0 && e - no < 256) e++
        name = b.toString('latin1', no, e)
      }
    }
    console.log(
      `    [${i}] OFT=0x${oft.toString(16)} TimeDateStamp=${tds} Fwd=${fwd} NameRVA=0x${nameRva.toString(
        16
      )} FirstThunk=0x${ft.toString(16)}  name="${name}"`
    )
  }

  // 顺带看延迟导入与资源目录
  const delayRva = b.readUInt32LE(dirOff + 13 * 8)
  const resRva = b.readUInt32LE(dirOff + 2 * 8)
  console.log(`  延迟导入 RVA=0x${delayRva.toString(16)}  资源 RVA=0x${resRva.toString(16)}`)
  // 末尾若干字节，判断文件是否完整
  console.log(`  文件尾部 16 字节: ${b.subarray(b.length - 16).toString('hex')}`)
}

const sysRoot = process.env.SystemRoot || 'C:\\Windows'
const targets = [
  'C:\\Software\\ZCode\\ZCode.exe',
  'C:\\Software\\Apipost\\Apipost.exe',
  `${sysRoot}\\explorer.exe`
]

for (const t of targets) {
  try {
    await dump(t)
  } catch (e) {
    console.log(`\n=== ${t} ===\n  读取失败：${(e as Error).message}`)
  }
}
