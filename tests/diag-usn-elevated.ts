/**
 * 诊断：B1 USN 变更记录级增量的提权验证（v3.0.0）
 *
 * v2.0.0 留下的问题：readJournal 已实现但因 `fsutil usn readjournal` 返回错误 5
 * （需管理员）而默认关闭，解析器从未在真实输出上跑过。本脚本给出当前权限下的
 * 确定性结论，决定「启用」还是「固化降级」。
 *
 * 为什么结果要落盘：管理员终端的控制台代码页会把中文输出显示成乱码，
 * 屏幕上看不清就没法判断。因此结论写成 **UTF-8 JSON**，并抓取 fsutil 的
 * 原始输出样本 —— 解析不出记录时，没有原始样本根本无从修解析器。
 *
 *   node scripts/run-ts.mjs tests/diag-usn-elevated.ts
 *
 * 产出：
 *   .tmp/usn-elevated.json   结论（UTF-8，可安全回读）
 *   .tmp/usn-raw.txt         fsutil readjournal 原始输出前 400 行（UTF-8）
 */
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { queryJournal, readJournal, isUsnAvailable, volumeOf, decodeConsole } from '@junk/usn'
import { isElevated } from '@junk/locks'

const FSUTIL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'fsutil.exe')
const RAW_FILE = '.tmp/usn-raw.txt'
const JSON_FILE = '.tmp/usn-elevated.json'

/**
 * 抓一份 fsutil 的原始输出样本。
 *
 * 两个坑（都是踩过才改对的）：
 *   1. **必须带 startusn**：不带起点时 fsutil 会吐出整卷的全部变更记录，实测直接
 *      撑爆 128MB 的 maxBuffer —— 而 readJournal 带起点只要 26ms 就返回。
 *   2. **必须流式截断**：即便带了起点，输出量也不可控，因此用 spawn 边读边判，
 *      攒够样本就 kill，不再依赖 maxBuffer。
 * 另外解码要用 decodeConsole：fsutil 走控制台代码页（中文系统 GBK），按 utf8 解必然乱码。
 */
async function captureRaw(
  vol: string,
  startUsn?: string
): Promise<{ ok: boolean; bytes: number; lines: number; truncated: boolean; error?: string }> {
  const args = startUsn
    ? ['usn', 'readjournal', vol, 'startusn=' + startUsn]
    : ['usn', 'readjournal', vol]

  return new Promise((resolve) => {
    let settled = false
    let chunks: Buffer[] = []
    let total = 0
    let truncated = false

    const child = spawn(FSUTIL, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    const finish = (ok: boolean, error?: string): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      const buf = Buffer.concat(chunks)
      const text = decodeConsole(buf)
      const lines = text.split(/\r?\n/)
      fs.mkdir('.tmp', { recursive: true })
        .then(() => fs.writeFile(RAW_FILE, lines.slice(0, 400).join('\n'), 'utf8'))
        .catch(() => {})
        .finally(() =>
          resolve({ ok, bytes: buf.length, lines: lines.length, truncated, error })
        )
    }

    child.stdout?.on('data', (c: Buffer) => {
      chunks.push(c)
      total += c.length
      if (total > 16 * 1024 * 1024) {
        truncated = true
        finish(true)
      }
    })
    child.stderr?.resume()
    child.on('error', (e) => finish(false, String(e.message ?? e).slice(0, 300)))
    child.on('close', () => finish(true))
    setTimeout(() => {
      truncated = true
      finish(true)
    }, 120_000)
  })
}

async function main(): Promise<void> {
  const elevated = await isElevated()
  const vol = volumeOf(process.env.SystemRoot || 'C:\\Windows') || 'C:'

  console.log(`提权状态：${elevated ? '已提权' : '未提权（普通用户）'}`)
  console.log(`测试卷：${vol}`)

  const t0 = Date.now()
  const info = await queryJournal(vol)
  const queryMs = Date.now() - t0
  const available = await isUsnAvailable(vol)
  console.log(`卷哨兵 queryJournal（无需提权）：${info ? `nextUsn=${info.nextUsn}` : '不可用'} · ${queryMs}ms`)
  console.log(`isUsnAvailable：${available}`)

  const t1 = Date.now()
  // 起点取「最低有效 USN」以便真的抓到若干条记录用于核对解析器；
  // 拿不到就退回 nextUsn（此时记录为 0 条，只证明通道可用）。
  // 传空串则 readJournal 会直接拒绝 —— 它不允许无界读取整卷（会撑爆输出缓冲）。
  const start = info?.lowestValidUsn || info?.nextUsn || ''
  const r = await readJournal(vol, start)
  const readMs = Date.now() - t1
  console.log(`变更记录 readJournal（需提权）：记录 ${r.records.length} 条 · needsElevation=${r.needsElevation} · ${readMs}ms`)
  if (r.error) console.log(`  错误：${r.error}`)
  for (const rec of r.records.slice(0, 5)) {
    console.log(`    ${rec.name}  usn=${rec.usn ?? '-'}  reasons=${rec.reasons.join(',') || '-'}`)
  }

  for (const rec of r.records.slice(0, 5)) {
    if (rec.reasonFlags) console.log(`      flags=${rec.reasonFlags}`)
  }

  // 无论解析结果如何，都抓一份原始输出：解析不出记录时必须靠它定位问题
  const raw = await captureRaw(vol, info?.nextUsn)
  console.log(
    `原始输出抓取：${raw.ok ? `成功 ${raw.lines} 行 / ${raw.bytes} 字节${raw.truncated ? '（已截断）' : ''}` : `失败 ${raw.error}`}`
  )

  let verdict: 'enabled' | 'needs-elevation' | 'parser-mismatch'
  if (r.records.length > 0) verdict = 'enabled'
  else if (r.needsElevation) verdict = 'needs-elevation'
  else verdict = 'parser-mismatch'

  const conclusion: Record<string, string> = {
    enabled: '可启用第 2 级增量：readJournal 返回了可解析的变更记录',
    'needs-elevation': '需要管理员权限 —— 保持默认关闭，继续以「卷哨兵 + 目录签名」降级方案运行',
    'parser-mismatch': 'fsutil 执行成功（未报 needsElevation）但解析出 0 条 —— 输出格式与解析器不匹配，需按 .tmp/usn-raw.txt 的真实格式修正 parseReadJournal'
  }
  console.log(`\n结论（${verdict}）：${conclusion[verdict]}`)

  await fs.mkdir('.tmp', { recursive: true })
  await fs.writeFile(
    JSON_FILE,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        elevated,
        volume: vol,
        queryJournal: info ? { nextUsn: info.nextUsn, journalId: info.journalId, ms: queryMs } : null,
        isUsnAvailable: available,
        readJournal: { records: r.records.length, needsElevation: r.needsElevation, ms: readMs, error: r.error ?? null },
        sample: r.records.slice(0, 5),
        raw,
        verdict,
        conclusion: conclusion[verdict]
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`\n结论已写入 ${JSON_FILE}（UTF-8）· 原始样本 ${RAW_FILE}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
