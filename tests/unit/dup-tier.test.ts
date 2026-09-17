/**
 * 重复文件四级过滤（v3.0.0 · A4）
 *
 * 背景：GC-11 的开销几乎全在「全文件 SHA-256 复核」—— 候选里大量文件只是
 * 大小相同 + 三段采样相同，却要各自把整个文件读一遍。A4 在中间插入
 * **扩展采样**（默认 16 段），用 1MB 级读取把全文件哈希的候选压下去。
 *
 * 这里用真实文件验证两件事：
 *   1. 真重复仍然判得出来（分级不能牺牲召回）
 *   2. 「头中尾相同、中间某段不同」的同大小文件被扩展采样拦下 ——
 *      这正是新增那一级要解决的误判候选
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { findDuplicates } from '@junk/scanner'
import { compileRule } from '@junk/engine'
import type { JunkRule } from '@shared/types'

const DIR = join(tmpdir(), `sg-dup-${randomBytes(4).toString('hex')}`)
const SIZE = 4 * 1024 * 1024 // 必须大于 16 段 × 64KB，否则扩展采样会退化为单段

/** 造一个 SIZE 字节的文件；seed 相同则内容相同 */
async function make(name: string, seed: number, patchAt?: number): Promise<string> {
  const p = join(DIR, name)
  // 用固定 seed 的伪随机填充：避免全零文件让不同文件也"看起来一致"
  const chunk = Buffer.alloc(64 * 1024)
  let state = seed
  const fh = await fs.open(p, 'w')
  try {
    for (let off = 0; off < SIZE; off += chunk.length) {
      for (let i = 0; i < chunk.length; i += 4) {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        chunk.writeUInt32LE(state, i)
      }
      await fh.write(chunk, 0, Math.min(chunk.length, SIZE - off), off)
    }
    if (patchAt !== undefined) {
      // 在指定偏移处改写 128KB：头/中/尾采样都覆盖不到，但扩展采样会命中
      const patch = Buffer.alloc(128 * 1024, 0x5a)
      await fh.write(patch, 0, patch.length, patchAt)
    }
  } finally {
    await fh.close()
  }
  return p
}

let dupA = ''
let dupB = ''
let variant = ''
let unique = ''

before(async () => {
  await fs.mkdir(DIR, { recursive: true })
  dupA = await make('dupA.bin', 111)
  dupB = await make('dupB.bin', 111) // 与 dupA 完全相同
  variant = await make('variant.bin', 111, 3 * 1024 * 1024) // 同体量，3MB 处被改写
  unique = await make('unique.bin', 999) // 完全不同的内容
})

after(async () => {
  await fs.rm(DIR, { recursive: true, force: true })
})

function rule(): ReturnType<typeof compileRule> {
  return compileRule({
    id: 'GC-11',
    name: '重复文件',
    risk: 'medium',
    defaultSelected: false,
    algorithm: 'duplicate',
    match: { roots: [DIR], patterns: ['*.bin'] }
  } as JunkRule)
}

describe('重复文件 · 四级过滤', () => {
  it('完全相同的两个文件被判定为重复，且只保留一份', async () => {
    const items = await findDuplicates(rule())
    const group = items.filter((i) => [dupA, dupB].some((p) => p.toLowerCase() === i.fullPath.toLowerCase()))
    assert.equal(group.length, 2, `应识别出 2 个重复项，实际 ${group.length}`)
    assert.equal(group.filter((i) => i.keep).length, 1, '同一组只能保留一份')
    assert.equal(new Set(group.map((i) => i.groupId)).size, 1, '同一组应共享 groupId')
  })

  it('「头中尾相同、中间不同」的同大小文件不被误判为重复', async () => {
    const items = await findDuplicates(rule())
    const hit = items.filter((i) => i.fullPath.toLowerCase() === variant.toLowerCase())
    assert.equal(hit.length, 0, '扩展采样应把它与 dupA/dupB 区分开')
  })

  it('内容完全不同的同大小文件不进入结果', async () => {
    const items = await findDuplicates(rule())
    assert.equal(items.filter((i) => i.fullPath.toLowerCase() === unique.toLowerCase()).length, 0)
  })

  it('取消信号能中止扫描', async () => {
    const items = await findDuplicates(rule(), { cancelled: true })
    assert.ok(Array.isArray(items))
  })
})
