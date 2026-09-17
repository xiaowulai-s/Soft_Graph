/**
 * 诊断：A4 分级哈希的 A/B 实测
 *
 * 思路：v2.0.0 的链路是「三段采样 → 全文件 SHA-256」，而 v3.0.0 在中间插入扩展采样。
 * 把扩展采样段数调成 3（SG_DUP_SAMPLE_SEGMENTS=3），第三级就与第二段完全等价 ——
 * 所有候选都会通过，等价于 v2.0.0 行为。于是同一份数据跑两次即可 A/B。
 *
 * 数据集刻意模拟真实世界的「误判候选」：大量同大小、头中尾相同、但中间某段不同的
 * 文件（同版本安装包、同规格媒体文件），真重复只占少数 —— 这正是全文件哈希被浪费的地方。
 *
 *   node scripts/run-ts.mjs tests/diag-dup-tier.ts
 */
import { promises as fs } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { findDuplicates } from '@junk/scanner'
import { compileRule } from '@junk/engine'
import type { JunkRule } from '@shared/types'

const DIR = join(tmpdir(), `sg-dupbench-${randomBytes(4).toString('hex')}`)
const FILE_SIZE = 4 * 1024 * 1024
/** 误判候选组数：每组 2 个文件，仅 3MB 处不同 */
const DECOY_GROUPS = 6
/** 真重复组数：每组 2 个完全相同的文件 */
const REAL_GROUPS = 2

async function writeFile(name: string, seed: number, patch: boolean): Promise<void> {
  const fh = await open(join(DIR, name), 'w')
  // 缓冲区必须每个文件独立：并发写同一个 Buffer 会让文件内容互相污染，
  // 「真重复」的两个文件反而不再相同 —— 那样跑出来的 A/B 数字毫无意义
  const chunk = Buffer.alloc(256 * 1024)
  try {
    let state = seed
    for (let off = 0; off < FILE_SIZE; off += chunk.length) {
      const len = Math.min(chunk.length, FILE_SIZE - off)
      for (let i = 0; i < len; i += 4) {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        chunk.writeUInt32LE(state, i)
      }
      await fh.write(chunk, 0, len, off)
    }
    if (patch) await fh.write(Buffer.alloc(256 * 1024, 0x5a), 0, 256 * 1024, 3 * 1024 * 1024)
  } finally {
    await fh.close()
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true })
  console.log(`构造数据集：${(DECOY_GROUPS + REAL_GROUPS) * 2} 个 ${FILE_SIZE / 1024 / 1024}MB 文件（真重复 ${REAL_GROUPS} 组 / 误判候选 ${DECOY_GROUPS} 组）`)
  const t0 = Date.now()
  const jobs: Promise<void>[] = []
  for (let g = 0; g < DECOY_GROUPS; g++) {
    jobs.push(writeFile(`decoy_${g}_a.bin`, 1000 + g, false))
    jobs.push(writeFile(`decoy_${g}_b.bin`, 1000 + g, true))
  }
  for (let g = 0; g < REAL_GROUPS; g++) {
    jobs.push(writeFile(`real_${g}_a.bin`, 5000 + g, false))
    jobs.push(writeFile(`real_${g}_b.bin`, 5000 + g, false))
  }
  await Promise.all(jobs)
  console.log(`  落盘耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // 自检：数据真的落盘了吗？没有这一步，后面跑出什么数字都不可信
  const names = await fs.readdir(DIR)
  const first = names.length ? await fs.stat(join(DIR, names[0])) : null
  console.log(`  目录自检：${names.length} 个文件，首个 ${first ? first.size : 0} 字节`)
  if (names.length !== (DECOY_GROUPS + REAL_GROUPS) * 2 || !first || first.size !== FILE_SIZE) {
    console.error('数据集构造异常，放弃本次 A/B')
    await fs.rm(DIR, { recursive: true, force: true })
    process.exit(1)
  }

  const rule = compileRule({
    id: 'GC-11',
    name: '重复文件',
    risk: 'medium',
    defaultSelected: false,
    algorithm: 'duplicate',
    match: { roots: [DIR], patterns: ['*.bin'] }
  } as JunkRule)

  const run = async (segments: number): Promise<{ ms: number; count: number }> => {
    process.env.SG_DUP_SAMPLE_SEGMENTS = String(segments)
    const t = Date.now()
    const items = await findDuplicates(rule)
    return { ms: Date.now() - t, count: items.length }
  }

  // 两轮取第二轮的冷缓存数字？这里磁盘缓存状态不可控，两轮各跑一次取较小值
  const old1 = await run(3)
  const old2 = await run(3)
  const new1 = await run(16)
  const new2 = await run(16)

  const oldMs = Math.min(old1.ms, old2.ms)
  const newMs = Math.min(new1.ms, new2.ms)
  const gain = oldMs > 0 ? ((oldMs - newMs) / oldMs) * 100 : 0

  console.log('\n结果（每档跑 2 次取较快的一次）')
  console.log(`  v2.0.0 链路（扩展采样=3）  ${(oldMs / 1000).toFixed(2)}s  命中 ${old1.count} 项`)
  console.log(`  v3.0.0 链路（扩展采样=16） ${(newMs / 1000).toFixed(2)}s  命中 ${new1.count} 项`)
  console.log(`  变化：${gain >= 0 ? '-' : '+'}${Math.abs(gain).toFixed(0)}%`)
  console.log(`\n命中数应一致（真重复 ${REAL_GROUPS} 组 = ${REAL_GROUPS * 2} 项）：${old1.count === new1.count ? '✅ 一致' : `⚠ 不一致 ${old1.count} vs ${new1.count}`}`)

  await fs.rm(DIR, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
