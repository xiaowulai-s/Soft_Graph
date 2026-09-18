/**
 * 诊断：B1-L2「父文件 ID 反查路径」可行性评估（v3.0.0 · B2 补全动作）
 *
 * 背景（doc 08 第二点五节 B2）：
 *   第 2 级增量的 `partial` 模式已实现但**未启用** —— 因为 `fsutil usn readjournal`
 *   的真实输出只有「文件名 + 文件 ID + 父文件 ID」，**没有路径**。没有路径就无法
 *   判断一条变更是否落在规则根目录内，启用就会漏检新增垃圾。
 *
 * 因此补全动作是：评估「把 ID 反查成路径」的**可用性与单次成本**，
 *   可行 → 实现目录级定向失效；
 *   不可行 → 明确放弃，把降级方案固化下来。
 *
 * 本脚本给出可复核的数字，而不是「应该很快」这类判断。判定口径：
 *   partial 模式的收益上限是「省掉一次签名遍历」。
 *   签名遍历在 v2.0.0 实测约 10.0s（GC-12，50528 目录）。
 *   因此反查总成本必须显著低于这个量级才有意义 —— 这里用「200 条变更」作为
 *   一轮典型窗口的规模（抖动目录实测每轮变化个数量级），换算后与 10s 对比。
 *
 *   node scripts/run-ts.mjs tests/diag-usn-idlookup.ts
 *
 * 产出：`.tmp/usn-idlookup.json`（UTF-8，含每项耗时与结论）
 * 注意：全部为只读系统调用，不修改任何数据。
 */
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { decodeConsole } from '@junk/usn'
import { isElevated } from '@junk/locks'

const execFileAsync = promisify(execFile)
const FSUTIL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'fsutil.exe')

/** 一轮扫描窗口内变更记录数的估算规模（用于把单次成本换算成总成本） */
const ASSUMED_RECORDS = 200
/** 签名遍历基线（v2.0.0 实测 GC-12 约 10.0s）；反查总成本必须远低于它 */
const SIGNATURE_WALK_MS = 10_000

async function fsutil(args: string[]): Promise<{ ok: boolean; stdout: string; ms: number; error?: string }> {
  const t = Date.now()
  try {
    const { stdout } = await execFileAsync(FSUTIL, args, {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 512 * 1024
    })
    return { ok: true, stdout: decodeConsole(stdout as unknown as Buffer), ms: Date.now() - t }
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const text = [err.stdout ? decodeConsole(err.stdout) : '', err.stderr ? decodeConsole(err.stderr) : ''].join(' ')
    return { ok: false, stdout: text, ms: Date.now() - t, error: String(err.message ?? e).slice(0, 200) }
  }
}

/** 取出十六进制 ID（0x 开头，或纯 hex 长串） */
function pickId(s: string): string {
  const m = s.match(/0x[0-9a-fA-F]+/)
  if (m) return m[0].toLowerCase()
  const m2 = s.match(/\b[0-9a-fA-F]{16,}\b/)
  return m2 ? m2[0].toLowerCase() : ''
}

/** 取出路径（含盘符的最后一个匹配） */
function pickPath(s: string): string {
  const m = s.match(/[A-Za-z]:\\[^\r\n]*/)
  return m ? m[0].trim() : ''
}

/** 路径所属卷（fileid 是卷内编号，用错卷必然参数错误） */
function volumeOfPath(p: string): string {
  const m = p.match(/^([A-Za-z]):/)
  return m ? m[1].toUpperCase() + ':\\' : ''
}

/**
 * 反向查询：先试单参数形式；若报参数错误（87）且 ID 是 32 位十六进制，
 * 改试 ReFS 的「上下 64 位分开传」形式。两种都失败才算不可用。
 */
async function reverseLookup(
  volume: string,
  id: string
): Promise<{ path: string; ms: number; ok: boolean; form: string; note: string }> {
  const hexBody = id.replace(/^0x/, '')
  const attempts: { args: string[]; form: string }[] = [
    { args: ['file', 'queryFileNameById', volume, id], form: '单参数' },
    { args: ['file', 'queryFileNameById', volume, id], form: '单参数(0x)' }
  ]
  if (hexBody.length === 32) {
    attempts.push({
      args: ['file', 'queryFileNameById', volume, '0x' + hexBody.slice(0, 16), '0x' + hexBody.slice(16)],
      form: '上下64位'
    })
  }

  let lastNote = ''
  let lastMs = 0
  for (const a of attempts) {
    const r = await fsutil(a.args)
    lastMs = r.ms
    lastNote = r.stdout.trim().replace(/\s+/g, ' ').slice(0, 160)
    if (r.ok) {
      const p = pickPath(r.stdout)
      if (p) return { path: p, ms: r.ms, ok: true, form: a.form, note: lastNote }
    }
  }
  return { path: '', ms: lastMs, ok: false, form: attempts[attempts.length - 1].form, note: lastNote }
}

async function main(): Promise<void> {
  const elevated = await isElevated()
  // SystemDrive 本身已含冒号（'C:'），这里只补反斜杠
  const volume = (process.env.SystemDrive || 'C:').toUpperCase() + '\\'
  console.log(`提权状态：${elevated ? '已提权' : '未提权（普通用户）'}`)
  console.log(`系统卷：${volume}`)

  const report: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    elevated,
    systemVolume: volume,
    assumedRecordsPerWindow: ASSUMED_RECORDS,
    signatureWalkBaselineMs: SIGNATURE_WALK_MS
  }

  // ── 0. 文件系统类型（NTFS 的 ID 是 64 位，ReFS 是 128 位；反查形式随此不同）──
  console.log('\n═══ 0. 目标卷文件系统类型 ═══')
  const fsInfo: { volume: string; type: string }[] = []
  // fsinfo volumeinfo 要的是「盘符:」而不是「盘符:\」
  for (const v of ['G:', (process.env.SystemDrive || 'C:').toUpperCase()]) {
    const r = await fsutil(['fsinfo', 'volumeinfo', v])
    const m = r.stdout.match(/文件系统名\s*[:：]\s*(\S+)|File System Name\s*[:：]\s*(\S+)/i)
    const type = m ? m[1] || m[2] || '' : ''
    fsInfo.push({ volume: v, type })
    console.log(`  ${v} → ${type || r.stdout.trim().split(/\r?\n/)[0] || '未知'}`)
  }
  report.filesystems = fsInfo

  // ── 1. 正向：路径 → 文件 ID（规则根目录侧只需要几十次，成本低）──
  console.log('\n═══ 1. 正向查询 queryfileid（路径 → 文件 ID）═══')
  const samples = ['G:\\Demo\\Soft_Graph\\package.json', 'G:\\Demo\\Soft_Graph\\docs', 'G:\\Demo\\Soft_Graph']
  const forward: { path: string; volume: string; id: string; idLen: number; ms: number; ok: boolean }[] = []
  for (const p of samples) {
    const r = await fsutil(['file', 'queryfileid', p])
    const id = r.ok ? pickId(r.stdout) : ''
    forward.push({
      path: p,
      volume: volumeOfPath(p),
      id,
      idLen: id.replace(/^0x/, '').length,
      ms: r.ms,
      ok: r.ok && !!id
    })
    console.log(`  ${r.ok && id ? '✓' : '✗'} ${p} → ${id || r.stdout.trim().slice(0, 80)} · ${r.ms}ms`)
  }
  report.forward = forward

  // ── 2. 反向：文件 ID → 路径（这就是 partial 模式需要的能力）──
  console.log('\n═══ 2. 反向查询 queryFileNameById（文件 ID → 路径）═══')
  const reverse: { id: string; volume: string; path: string; ms: number; ok: boolean; form: string; note: string }[] = []
  for (const f of forward.filter((x) => x.ok)) {
    const r = await reverseLookup(f.volume, f.id)
    reverse.push({ id: f.id, volume: f.volume, ...r })
    console.log(`  ${r.ok ? '✓' : '✗'} ${f.id} → ${r.path || r.note} · ${r.ms}ms（${r.form}）`)
  }
  report.reverse = reverse

  // ── 3. 单次成本统计与线性外推 ──
  console.log('\n═══ 3. 成本统计与线性外推 ═══')
  const revMs = reverse.filter((x) => x.ok).map((x) => x.ms)
  const avgMs = revMs.length ? revMs.reduce((a, b) => a + b, 0) / revMs.length : 0
  const minMs = revMs.length ? Math.min(...revMs) : 0
  const maxMs = revMs.length ? Math.max(...revMs) : 0
  const projected = Math.round(avgMs * ASSUMED_RECORDS)
  console.log(`  单次反向查询：平均 ${avgMs.toFixed(1)}ms（min ${minMs} / max ${maxMs}，n=${revMs.length}）`)
  console.log(`  按每轮 ${ASSUMED_RECORDS} 条变更外推：${projected}ms`)
  console.log(`  签名遍历基线：${SIGNATURE_WALK_MS}ms → 占比 ${((projected / SIGNATURE_WALK_MS) * 100).toFixed(0)}%`)
  report.timing = { samples: revMs.length, avgMs, minMs, maxMs, projectedMs: projected, ratioToBaseline: projected / SIGNATURE_WALK_MS }

  // ── 4. 是否有批量通道（决定外推是否成立）──
  console.log('\n═══ 4. 批量通道探测 ═══')
  const batchHelp = await fsutil(['file', 'queryFileNameById'])
  const batchLines = batchHelp.stdout.split(/\r?\n/).filter((l) => l.trim())
  const hasBatch = batchLines.some((l) => /\{\d+\}|多个|batch|list/i.test(l))
  for (const l of batchLines.slice(0, 8)) console.log(`  ${l.trim()}`)
  console.log(`  批量入口：${hasBatch ? '疑似存在' : '无（一次只接受一个 fileid）'}`)
  report.batch = { available: hasBatch, usageLines: batchLines.slice(0, 8) }

  // ── 5. 结论 ──
  const feasible = revMs.length > 0 && projected < SIGNATURE_WALK_MS * 0.2
  const verdict = feasible ? 'feasible' : revMs.length === 0 ? 'unavailable' : 'infeasible'
  const conclusion: Record<string, string> = {
    feasible: `可行：按 ${ASSUMED_RECORDS} 条变更外推仅 ${projected}ms，低于签名遍历基线的 20%，值得实现目录级定向失效`,
    infeasible: `不可行：单次 ${avgMs.toFixed(1)}ms × ${ASSUMED_RECORDS} 条 = ${projected}ms，与签名遍历基线（${SIGNATURE_WALK_MS}ms）同量级甚至更高 —— 且无批量入口，成本随变更数线性增长。明确放弃 partial 模式，固化「卷哨兵 + reuse-all + 目录签名」降级方案`,
    unavailable: '不可用：反向查询在本机返回失败（可能需要提权或卷不支持），partial 模式无法建立在它之上'
  }
  console.log(`\n结论（${verdict}）：${conclusion[verdict]}`)
  report.verdict = verdict
  report.conclusion = conclusion[verdict]

  await fs.mkdir('.tmp', { recursive: true })
  await fs.writeFile('.tmp/usn-idlookup.json', JSON.stringify(report, null, 2), 'utf8')
  console.log('\n结论已写入 .tmp/usn-idlookup.json（UTF-8）')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
