/**
 * PE 解析器（纯 TypeScript 实现，替代设计文档中的 Rust napi-rs 原生层）
 * 对应技术设计方案 5.2.2 PE 导入表解析要点
 *
 * 解析链路：
 *   DOS Header → e_lfanew 定位 PE 签名 → COFF Header（Machine 判 32/64 位）
 *   → Optional Header → 数据目录第 1 项（Import Table）、第 13 项（Delay Import）
 *   → 第 2 项（Resource：RT_MANIFEST 供 SxS 证据 E5、RT_VERSION 供版本资源）
 *   → 第 14 项（CLR Header：.NET 程序集引用证据 E4）
 *
 * 内存策略（重要）：
 *   采用「惰性窗口式读取」而非整文件载入。实测本机存在 146MB / 222MB 的单个可执行文件
 *   （Apipost、ZCode 等 Electron 应用），若一次性 readFile 会瞬间占用数百 MB 内存并拖慢扫描。
 *   这里按 64KB 分页按需读取并缓存窗口，解析一个 222MB 文件的常驻内存仅约 128KB。
 *
 * 异常处理：加壳或截断文件导致解析失败时不抛出，返回 parseStatus='failed'，
 * 由上层降级使用 E1 目录归属证据（见 5.2.2 异常处理 / 风险 R1）。
 */

import { open } from 'node:fs/promises'
import { promises as fs } from 'node:fs'
import type { PeArch } from '../shared/types'

// ── 数据目录索引 ──
const DIR_IMPORT = 1
const DIR_RESOURCE = 2
const DIR_DELAY_IMPORT = 13
const DIR_CLR = 14

const RT_VERSION = 16
const RT_MANIFEST = 24

const WINDOW = 64 * 1024
/** 超过此大小直接放弃解析（2GB），避免对磁盘镜像之类异常文件浪费时间 */
const MAX_PE_BYTES = 2 * 1024 * 1024 * 1024

export interface PeSection {
  name: string
  virtualAddress: number
  virtualSize: number
  rawPointer: number
  rawSize: number
}

export interface PeResult {
  path: string
  parseStatus: 'ok' | 'failed' | 'not_pe'
  arch: PeArch
  isDll: boolean
  /** 静态导入表 DLL 名（证据 E2） */
  imports: string[]
  /** 延迟导入表 DLL 名（证据 E3） */
  delayImports: string[]
  /** .NET 程序集引用候选名，不含 .dll 后缀（证据 E4，上层按磁盘存在性过滤） */
  assemblyRefs: string[]
  /** SxS 清单声明的 assemblyIdentity name（证据 E5） */
  sxsDependencies: string[]
  isDotNet: boolean
  /** 版本资源（用于便携识别与文件详情） */
  fileVersion?: string
  fileDescription?: string
  productName?: string
  companyName?: string
  /** requestedExecutionLevel，用于判断是否需要提权 */
  requestedExecutionLevel?: string
  error?: string
}

function emptyResult(path: string, status: PeResult['parseStatus'], error?: string): PeResult {
  return {
    path,
    parseStatus: status,
    arch: 'unknown',
    isDll: false,
    imports: [],
    delayImports: [],
    assemblyRefs: [],
    sxsDependencies: [],
    isDotNet: false,
    error
  }
}

/**
 * 惰性分页读取器：把文件当作可随机访问的字节序列，按需载入 64KB 窗口。
 * 使超大 PE 的解析内存占用与文件大小解耦。
 */
class PagedReader {
  private cache = new Map<number, Buffer>()
  constructor(
    private fh: Awaited<ReturnType<typeof open>>,
    private size: number
  ) {}

  private async window(idx: number): Promise<Buffer | null> {
    const hit = this.cache.get(idx)
    if (hit) return hit
    const start = idx * WINDOW
    if (start >= this.size) return null
    const len = Math.min(WINDOW, this.size - start)
    const buf = Buffer.allocUnsafe(len)
    try {
      await this.fh.read(buf, 0, len, start)
    } catch {
      return null
    }
    // 只缓存最近若干个窗口，避免长期持有
    if (this.cache.size > 8) {
      const first = this.cache.keys().next().value
      if (first !== undefined) this.cache.delete(first)
    }
    this.cache.set(idx, buf)
    return buf
  }

  /** 读取 [offset, offset+length) 区间 */
  async read(offset: number, length: number): Promise<Buffer | null> {
    if (offset < 0 || length <= 0 || offset >= this.size) return null
    const out = Buffer.allocUnsafe(Math.min(length, this.size - offset))
    let written = 0
    while (written < out.length) {
      const abs = offset + written
      const idx = Math.floor(abs / WINDOW)
      const w = await this.window(idx)
      if (!w) break
      const from = abs - idx * WINDOW
      const n = Math.min(w.length - from, out.length - written)
      if (n <= 0) break
      w.copy(out, written, from, from + n)
      written += n
    }
    return written === out.length ? out : out.subarray(0, written)
  }

  async u16(off: number): Promise<number> {
    const b = await this.read(off, 2)
    return b && b.length === 2 ? b.readUInt16LE(0) : 0
  }

  async u32(off: number): Promise<number> {
    const b = await this.read(off, 4)
    return b && b.length === 4 ? b.readUInt32LE(0) : 0
  }

  async u64(off: number): Promise<number> {
    const b = await this.read(off, 8)
    return b && b.length === 8 ? Number(b.readBigUInt64LE(0)) : 0
  }

  /** 读取以 NUL 结尾的 ASCII 字符串 */
  async cstr(off: number, max = 512): Promise<string> {
    if (off < 0) return ''
    const idx = Math.floor(off / WINDOW)
    const w = await this.window(idx)
    if (!w) return ''
    let start = off - idx * WINDOW
    let end = start
    const limit = Math.min(w.length, start + max)
    while (end < limit && w[end] !== 0) end++
    if (end < limit) return w.toString('latin1', start, end)
    // 跨窗口：退化为逐段拼接
    let s = w.toString('latin1', start, w.length)
    let abs = off + s.length
    for (let i = 0; i < 8; i++) {
      const c = await this.read(abs, 128)
      if (!c || c.length === 0) break
      const z = c.indexOf(0)
      s += z >= 0 ? c.toString('latin1', 0, z) : c.toString('latin1')
      if (z >= 0) break
      abs += c.length
    }
    return s
  }
}

/** 名称合法性：允许字母数字与常见分隔符，过滤掉解码错乱的噪声串 */
const DLL_NAME_RE = /^[A-Za-z0-9_.+\- ()]{1,120}$/

class PeImage {
  peOff = 0
  is64 = false
  imageBase = 0
  sections: PeSection[] = []
  dataDirs: { rva: number; size: number }[] = []
  machine = 0
  characteristics = 0

  constructor(private r: PagedReader) {}

  async parseHeaders(): Promise<boolean> {
    const r = this.r
    const mz = await r.u16(0)
    if (mz !== 0x5a4d) return false // 'MZ'
    this.peOff = await r.u32(0x3c)
    if (this.peOff <= 0) return false
    if ((await r.u32(this.peOff)) !== 0x00004550) return false // 'PE\0\0'

    const coff = this.peOff + 4
    this.machine = await r.u16(coff)
    const numSections = await r.u16(coff + 2)
    const sizeOfOptional = await r.u16(coff + 16)
    this.characteristics = await r.u16(coff + 18)

    const opt = coff + 20
    const magic = await r.u16(opt)
    if (magic === 0x20b) this.is64 = true
    else if (magic !== 0x10b) return false // ROM image 等非标准格式

    this.imageBase = this.is64 ? await r.u64(opt + 24) : await r.u32(opt + 28)

    const numDirsOff = opt + (this.is64 ? 108 : 92)
    const numDirs = Math.min(await r.u32(numDirsOff), 16)
    const dirOff = opt + (this.is64 ? 112 : 96)
    for (let i = 0; i < numDirs; i++) {
      const o = dirOff + i * 8
      this.dataDirs.push({ rva: await r.u32(o), size: await r.u32(o + 4) })
    }

    const secOff = opt + sizeOfOptional
    for (let i = 0; i < Math.min(numSections, 96); i++) {
      const o = secOff + i * 40
      const hdr = await r.read(o, 40)
      if (!hdr || hdr.length < 40) break
      this.sections.push({
        name: hdr.toString('latin1', 0, 8).replace(/\0+$/, ''),
        virtualSize: hdr.readUInt32LE(8),
        virtualAddress: hdr.readUInt32LE(12),
        rawSize: hdr.readUInt32LE(16),
        rawPointer: hdr.readUInt32LE(20)
      })
    }
    return this.sections.length > 0
  }

  get arch(): PeArch {
    switch (this.machine) {
      case 0x014c:
        return 'x86'
      case 0x8664:
        return 'x64'
      case 0xaa64:
        return 'arm64'
      default:
        return 'unknown'
    }
  }

  get isDll(): boolean {
    return (this.characteristics & 0x2000) !== 0
  }

  /** RVA → 文件偏移 */
  rva2off(rva: number): number {
    if (rva <= 0) return -1
    for (const s of this.sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
        const delta = rva - s.virtualAddress
        if (delta >= s.rawSize) return -1 // 落在未初始化区（.bss 等）
        return s.rawPointer + delta
      }
    }
    // 有些头部 RVA 直接等于文件偏移
    if (rva < (this.sections[0]?.rawPointer ?? 0x400)) return rva
    return -1
  }

  dir(i: number): { rva: number; size: number } | null {
    const d = this.dataDirs[i]
    return d && d.rva > 0 ? d : null
  }

  /** 数据目录第 1 项：IMAGE_IMPORT_DESCRIPTOR 链表（20 字节/项） */
  async readImports(): Promise<string[]> {
    const d = this.dir(DIR_IMPORT)
    if (!d) return []
    const off = this.rva2off(d.rva)
    if (off < 0) return []
    const out: string[] = []
    const MAX = 16384
    for (let i = 0; i < MAX; i++) {
      const rec = off + i * 20
      const oft = await this.r.u32(rec)
      const nameRva = await this.r.u32(rec + 12)
      const firstThunk = await this.r.u32(rec + 16)
      // 全零描述符 = 链表结束
      if (oft === 0 && nameRva === 0 && firstThunk === 0) break
      if (nameRva === 0) continue
      const nOff = this.rva2off(nameRva)
      if (nOff < 0) continue
      const name = await this.r.cstr(nOff)
      if (name && DLL_NAME_RE.test(name)) out.push(name)
    }
    return out
  }

  /**
   * 数据目录第 13 项：IMAGE_DELAYLOAD_DESCRIPTOR（32 字节/项）
   * 兼容旧链接器使用绝对 VA 而非 RVA 的情况（Attributes bit0 = RVA-based）
   */
  async readDelayImports(): Promise<string[]> {
    const d = this.dir(DIR_DELAY_IMPORT)
    if (!d) return []
    const off = this.rva2off(d.rva)
    if (off < 0) return []
    const out: string[] = []
    for (let i = 0; i < 4096; i++) {
      const rec = off + i * 32
      const attrs = await this.r.u32(rec)
      let nameRva = await this.r.u32(rec + 4)
      const modHandle = await this.r.u32(rec + 8)
      if (attrs === 0 && nameRva === 0 && modHandle === 0) break
      if (nameRva === 0) continue
      if ((attrs & 1) === 0 && this.imageBase && nameRva > this.imageBase) nameRva -= this.imageBase
      const nOff = this.rva2off(nameRva)
      if (nOff < 0) continue
      const name = await this.r.cstr(nOff)
      if (name && DLL_NAME_RE.test(name)) out.push(name)
    }
    return out
  }

  // ── 资源目录遍历 ──

  private async resEntries(dirOff: number): Promise<{ id: number; offset: number; isDir: boolean }[]> {
    const out: { id: number; offset: number; isDir: boolean }[] = []
    if (dirOff < 0) return out
    const named = await this.r.u16(dirOff + 12)
    const ided = await this.r.u16(dirOff + 14)
    const total = Math.min(named + ided, 4096)
    for (let i = 0; i < total; i++) {
      const e = dirOff + 16 + i * 8
      const nameField = await this.r.u32(e)
      const dataField = await this.r.u32(e + 4)
      out.push({
        id: nameField & 0x80000000 ? -1 : nameField,
        offset: dataField & 0x7fffffff,
        isDir: (dataField & 0x80000000) !== 0
      })
    }
    return out
  }

  /** 取出指定资源类型的所有数据块 */
  async readResourceBlobs(typeId: number, limit = 8): Promise<Buffer[]> {
    const d = this.dir(DIR_RESOURCE)
    if (!d) return []
    const rootOff = this.rva2off(d.rva)
    if (rootOff < 0) return []
    const blobs: Buffer[] = []

    for (const t of await this.resEntries(rootOff)) {
      if (t.id !== typeId || !t.isDir) continue
      for (const n of await this.resEntries(rootOff + t.offset)) {
        if (!n.isDir) continue
        for (const l of await this.resEntries(rootOff + n.offset)) {
          if (l.isDir) continue
          const de = rootOff + l.offset
          const dataRva = await this.r.u32(de)
          const size = await this.r.u32(de + 4)
          const dOff = this.rva2off(dataRva)
          if (dOff < 0 || size <= 0 || size > 8 * 1024 * 1024) continue
          const buf = await this.r.read(dOff, size)
          if (buf && buf.length > 0) blobs.push(buf)
          if (blobs.length >= limit) return blobs
        }
      }
    }
    return blobs
  }

  /** 数据目录第 14 项：CLR Header → 判定 .NET 并定位元数据 */
  async readClrMetadata(): Promise<{ isDotNet: boolean; strings: string[]; assemblyRefCount: number }> {
    const d = this.dir(DIR_CLR)
    if (!d) return { isDotNet: false, strings: [], assemblyRefCount: 0 }
    const cor = this.rva2off(d.rva)
    if (cor < 0) return { isDotNet: true, strings: [], assemblyRefCount: 0 }

    const mdRva = await this.r.u32(cor + 8)
    const md = this.rva2off(mdRva)
    if (md < 0) return { isDotNet: true, strings: [], assemblyRefCount: 0 }
    // 元数据根签名 'BSJB'
    if ((await this.r.u32(md)) !== 0x424a5342) return { isDotNet: true, strings: [], assemblyRefCount: 0 }

    const verLen = await this.r.u32(md + 12)
    let p = md + 16 + (((verLen + 3) >> 2) << 2)
    p += 2 // Flags
    const streamCount = await this.r.u16(p)
    p += 2

    let stringsOff = -1
    let stringsSize = 0
    let tildeOff = -1
    for (let i = 0; i < Math.min(streamCount, 16); i++) {
      const sOff = await this.r.u32(p)
      const sSize = await this.r.u32(p + 4)
      p += 8
      let name = ''
      for (let k = 0; k < 64; k++) {
        const c = await this.r.read(p, 1)
        if (!c || c.length === 0 || c[0] === 0) break
        name += String.fromCharCode(c[0])
        p++
      }
      p++ // NUL
      p = md + (((p - md + 3) >> 2) << 2) // 4 字节对齐
      if (name === '#Strings') {
        stringsOff = md + sOff
        stringsSize = sSize
      } else if (name === '#~' || name === '#-') {
        tildeOff = md + sOff
      }
    }

    // 从 #~ 头读取 AssemblyRef(0x23) 行数，用于统计与置信度参考
    let assemblyRefCount = 0
    if (tildeOff > 0) {
      const validLo = await this.r.u32(tildeOff + 8)
      const validHi = await this.r.u32(tildeOff + 12)
      let rowsPtr = tildeOff + 24
      for (let t = 0; t < 64; t++) {
        const set = t < 32 ? (validLo >>> t) & 1 : (validHi >>> (t - 32)) & 1
        if (!set) continue
        const rows = await this.r.u32(rowsPtr)
        rowsPtr += 4
        if (t === 0x23) {
          assemblyRefCount = rows
          break
        }
      }
    }

    // 从 #Strings 堆提取候选名（上层用「同目录/运行时目录是否存在同名 dll」过滤）
    const strings: string[] = []
    if (stringsOff > 0 && stringsSize > 0) {
      const end = stringsOff + Math.min(stringsSize, 512 * 1024)
      let q = stringsOff
      const seen = new Set<string>()
      while (q < end && strings.length < 4000) {
        const s = await this.r.cstr(q, 256)
        q += s.length + 1
        if (s.length < 2 || s.length > 128) continue
        if (!/^[A-Za-z][\w.\-+]*$/.test(s)) continue
        if (seen.has(s)) continue
        seen.add(s)
        strings.push(s)
      }
    }
    return { isDotNet: true, strings, assemblyRefCount }
  }
}

// ── SxS 清单解析（证据 E5） ──

function parseManifest(xml: string): { deps: string[]; execLevel?: string } {
  const deps: string[] = []
  const depBlocks = xml.match(/<dependentAssembly[\s\S]*?<\/dependentAssembly>/gi) || []
  for (const blk of depBlocks) {
    const m = blk.match(/name\s*=\s*"([^"]+)"/i)
    if (m && m[1]) deps.push(m[1])
  }
  if (deps.length === 0) {
    const alt = xml.match(/<dependency>[\s\S]*?<\/dependency>/gi) || []
    for (const blk of alt) {
      const m = blk.match(/<assemblyIdentity[^>]*name\s*=\s*"([^"]+)"/i)
      if (m && m[1]) deps.push(m[1])
    }
  }
  const lvl = xml.match(/requestedExecutionLevel[^>]*level\s*=\s*"([^"]+)"/i)
  return { deps: [...new Set(deps)], execLevel: lvl?.[1] }
}

// ── VS_VERSIONINFO 解析 ──

function parseVersionResource(blob: Buffer): {
  fileVersion?: string
  fileDescription?: string
  productName?: string
  companyName?: string
} {
  const out: ReturnType<typeof parseVersionResource> = {}
  const sig = 0xfeef04bd
  for (let i = 0; i + 52 <= blob.length; i += 4) {
    if (blob.readUInt32LE(i) === sig) {
      const msV = blob.readUInt32LE(i + 8)
      const lsV = blob.readUInt32LE(i + 12)
      out.fileVersion = `${msV >>> 16}.${msV & 0xffff}.${lsV >>> 16}.${lsV & 0xffff}`
      break
    }
  }
  const text = blob.toString('utf16le')
  const pick = (key: string): string | undefined => {
    const idx = text.indexOf(key)
    if (idx < 0) return undefined
    let p = idx + key.length
    while (p < text.length && text.charCodeAt(p) === 0) p++
    let v = ''
    while (p < text.length && text.charCodeAt(p) !== 0 && v.length < 200) {
      v += text[p]
      p++
    }
    return v.trim() || undefined
  }
  out.fileDescription = pick('FileDescription')
  out.productName = pick('ProductName')
  out.companyName = pick('CompanyName')
  return out
}

// ── 对外接口 ──

export interface ParsePeOptions {
  /** 是否解析资源（RT_MANIFEST / RT_VERSION），关闭可提速 */
  resources?: boolean
  /** 是否解析 .NET 元数据 */
  dotnet?: boolean
}

export async function parsePe(filePath: string, opts: ParsePeOptions = {}): Promise<PeResult> {
  const { resources = true, dotnet = true } = opts
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    const st = await fs.stat(filePath)
    if (!st.isFile()) return emptyResult(filePath, 'not_pe', '不是文件')
    if (st.size < 0x40) return emptyResult(filePath, 'not_pe', '文件过小')
    if (st.size > MAX_PE_BYTES) return emptyResult(filePath, 'failed', '文件超过 2GB，已跳过解析')

    fh = await open(filePath, 'r')
    const img = new PeImage(new PagedReader(fh, st.size))
    if (!(await img.parseHeaders())) return emptyResult(filePath, 'not_pe', '非 PE 文件或头部损坏')

    const res = emptyResult(filePath, 'ok')
    res.arch = img.arch
    res.isDll = img.isDll
    res.imports = await img.readImports()
    res.delayImports = await img.readDelayImports()

    if (resources) {
      const manifests = await img.readResourceBlobs(RT_MANIFEST, 2)
      for (const m of manifests) {
        const { deps, execLevel } = parseManifest(m.toString('utf8'))
        res.sxsDependencies.push(...deps)
        if (execLevel && !res.requestedExecutionLevel) res.requestedExecutionLevel = execLevel
      }
      res.sxsDependencies = [...new Set(res.sxsDependencies)]

      const vers = await img.readResourceBlobs(RT_VERSION, 1)
      if (vers.length) Object.assign(res, parseVersionResource(vers[0]))
    }

    if (dotnet && img.dir(DIR_CLR)) {
      const clr = await img.readClrMetadata()
      res.isDotNet = clr.isDotNet
      res.assemblyRefs = clr.strings
    }

    // 导入表与延迟导入表均为空、且不是 .NET → 极可能被加壳（风险 R1）
    if (res.imports.length === 0 && res.delayImports.length === 0 && !res.isDotNet) {
      res.parseStatus = 'failed'
      res.error = '导入表为空，可能已加壳或使用运行时动态加载'
    }
    return res
  } catch (e) {
    return emptyResult(filePath, 'failed', (e as Error).message)
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 仅读取版本资源与架构（用于便携软件评分，比全量解析快） */
export async function readPeMeta(
  filePath: string
): Promise<{
  arch: PeArch
  fileVersion?: string
  fileDescription?: string
  productName?: string
  companyName?: string
  ok: boolean
}> {
  const r = await parsePe(filePath, { resources: true, dotnet: false })
  return {
    arch: r.arch,
    fileVersion: r.fileVersion,
    fileDescription: r.fileDescription,
    productName: r.productName,
    companyName: r.companyName,
    ok: r.parseStatus === 'ok' || r.parseStatus === 'failed'
  }
}
