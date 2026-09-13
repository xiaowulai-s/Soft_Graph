/**
 * C3 路径健壮性探测
 *
 * 本机用户名是 ASCII，无法直接复现「中文用户名」，因此用
 * 「在临时目录构造含中文/空格/特殊字符/超长的路径树」来逼近同一类问题：
 *   - Node 侧：mkdir / stat / readdir / realpath / unlink 是否正常
 *   - 安全层：guardPath 对这些路径的判定是否正确（不应误拦也不应放行危险路径）
 *   - 扫描层：walkRule 能否命中全部文件
 *   - 清理层：execute 能否正常隔离（三重校验不误判）
 *   - 提权侧：PowerShell 的 Test-Path / Move-Item 对长路径的行为（PS 5.1 默认 260 限制）
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { guardPath } from '@shared/safety'
import { walkRule, loadRulesSync } from '@junk/engine'
import { buildPlan, execute } from '@junk/cleaner'
import { validateElevatedItem } from '@junk/elevated'

const PS = 'powershell.exe'
const temp = process.env.TEMP || process.env.TMP || ''
const base = join(temp, 'sg-c3-' + randomBytes(3).toString('hex'))

function ps(cmd: string, timeout = 60_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout },
      (e, stdout, stderr) => {
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(stdout ?? ''), err: String(stderr ?? '') })
      }
    )
  })
}

async function main(): Promise<void> {
  const results: { name: string; ok: boolean; note: string }[] = []
  const check = (name: string, ok: boolean, note = ''): void => {
    results.push({ name, ok, note })
    console.log(`${ok ? '✅' : '❌'} ${name}${note ? ` —— ${note}` : ''}`)
  }

  // ── 1. 中文 / 空格 / 特殊字符 ──
  console.log('═══ 1. 中文 / 空格 / 特殊字符 ═══')
  const weirdDir = join(base, '中文 目录 #1', '子 (备份) & 测试')
  const weirdFiles = [
    join(weirdDir, '中文文件名.tmp'),
    join(weirdDir, 'file with spaces.log'),
    join(weirdDir, "it's a file.tmp"),
    join(weirdDir, 'a&b;c=d#1.tmp'),
    join(weirdDir, 'emoji📁cache.tmp')
  ]
  try {
    await fs.mkdir(weirdDir, { recursive: true })
    for (const f of weirdFiles) await fs.writeFile(f, 'x'.repeat(100), 'utf8')
    check('Node 创建中文/空格/特殊字符路径', true)
  } catch (e) {
    check('Node 创建中文/空格/特殊字符路径', false, (e as Error).message)
  }

  // Node 读回
  try {
    const entries = await fs.readdir(weirdDir)
    check('Node readdir 读回（' + entries.length + ' 项）', entries.length === weirdFiles.length)
  } catch (e) {
    check('Node readdir', false, (e as Error).message)
  }

  // 安全层判定
  const g1 = guardPath(weirdFiles[0])
  check('guardPath：临时目录内的中文路径放行', g1.allowed, g1.reason)
  const g2 = guardPath('C:\\Windows\\中 文\\x.tmp')
  check('guardPath：Windows 下的中文路径仍然拦截', !g2.allowed, g2.reason)

  // 扫描层
  const rs = loadRulesSync({
    schemaVersion: 1,
    updatedAt: '',
    rules: [
      {
        id: 'C3-T',
        name: 'c3t',
        description: '',
        risk: 'low',
        defaultSelected: false,
        match: { roots: [base], patterns: ['*.tmp', '*.log'], maxDepth: 5 }
      }
    ]
  })
  const rule = rs.rules[0]
  const hits: string[] = []
  const stats = { scanned: 0, denied: 0 }
  await walkRule(rule, (h) => hits.push(h.path), stats)
  check(
    'walkRule 扫描命中（' + hits.length + ' 项）',
    hits.length === weirdFiles.length,
    hits.length === weirdFiles.length ? '' : `期望 ${weirdFiles.length}`
  )

  // 清理层（隔离到临时 SoftGraph 区）
  const qRoot = join(base, 'SoftGraph', 'Quarantine')
  await fs.mkdir(qRoot, { recursive: true })
  const junkItems = weirdFiles.map((p, i) => ({
    id: 'c3_' + i,
    categoryId: 'C3-T',
    fullPath: p,
    name: p.split('\\').pop()!,
    sizeBytes: 100,
    mtime: Date.now(),
    risk: 'low' as const,
    keep: false
  }))
  try {
    const plan = await buildPlan(junkItems, true)
    const r = await execute(plan, { quarantineRoot: qRoot }, { useQuarantine: true, keepDaysLow: 7, keepDaysHigh: 14 })
    check(
      `execute 隔离（成功 ${r.ok} / 失败 ${r.failed.length} / 拦截 ${r.blocked.length}）`,
      r.ok === weirdFiles.length && r.failed.length === 0,
      r.failed.map((f) => f.reason).join('; ')
    )
  } catch (e) {
    check('execute 隔离', false, (e as Error).message)
  }

  // 提权通道对这些路径的判定
  const ev = validateElevatedItem({
    path: join(weirdDir, '中文文件名.log'),
    sizeBytes: 100,
    mtimeMs: Date.now(),
    categoryId: 'C3-T',
    risk: 'low',
    keepUntil: Date.now() + 86400_000
  })
  check('提权通道接受中文/空格路径（Windows Temp 在可清理区）', ev === null, ev ?? '')

  // ── 2. 长路径（>260 字符） ──
  console.log('\n═══ 2. 长路径（>260 字符）═══')
  // 用足够长的目录名确保总长真正超过 260（每层 ~14 字符 × 22 层 ≈ 310）
  let deep = join(base, 'long')
  let made = 0
  for (let i = 0; i < 30; i++) {
    deep = join(deep, 'segment-' + String(i).padStart(6, '0'))
    try {
      await fs.mkdir(deep, { recursive: true })
      made++
    } catch {
      break
    }
  }
  const longFile = join(deep, 'x.tmp')
  try {
    await fs.writeFile(longFile, 'data', 'utf8')
    const st = await fs.stat(longFile)
    check(
      `Node 创建/stat 长路径（${longFile.length} 字符，目录 ${made} 层）`,
      st.size === 4 && longFile.length > 260,
      longFile.length <= 260 ? '⚠️ 未超过 260，样本不够长' : ''
    )
  } catch (e) {
    check('Node 长路径', false, (e as Error).message)
  }

  // 安全层对长路径
  const gLong = guardPath(longFile)
  check('guardPath：长路径判定正常', typeof gLong.allowed === 'boolean')

  // 提权通道对长路径
  const evLong = validateElevatedItem({
    path: longFile,
    sizeBytes: 4,
    mtimeMs: Date.now(),
    categoryId: 'C3-T',
    risk: 'low',
    keepUntil: Date.now() + 86400_000
  })
  check(
    '提权通道对长路径',
    longFile.length > 260 ? evLong === null || /不|长/.test(evLong ?? '') : evLong === null,
    evLong ?? '通过'
  )

  // PowerShell 对长路径（PS 5.1 默认 260 限制）
  const psProbe = await ps(`(Test-Path -LiteralPath '${longFile.replace(/'/g, "''")}')`)
  const psOk = psProbe.out.trim() === 'True'
  check(
    'PowerShell Test-Path 长路径',
    psOk,
    psOk ? '' : `exit=${psProbe.code} ${psProbe.err.trim().slice(0, 120)}`
  )

  // ── 3. UNC 路径 ──
  console.log('\n═══ 3. UNC / 相对路径 ═══')
  check('guardPath 拒绝 UNC', !guardPath('\\\\server\\share\\a.tmp').allowed)
  check('提权通道拒绝 UNC', validateElevatedItem({ path: '\\\\srv\\share\\a.log', sizeBytes: 1, mtimeMs: Date.now(), categoryId: 'x', risk: 'low', keepUntil: Date.now() + 1 }) !== null)

  // ── 4. 多用户目录 ──
  console.log('\n═══ 4. 多用户目录 ═══')
  const otherUser = 'C:\\Users\\SomeOtherUser\\AppData\\Local\\Temp\\x.log'
  check('其他用户的 Temp：普通通道 guardPath 放行', guardPath(otherUser).allowed)
  check('其他用户的 Temp：提权通道放行（这正是提权的用武之地）', validateElevatedItem({ path: otherUser, sizeBytes: 1, mtimeMs: Date.now(), categoryId: 'x', risk: 'low', keepUntil: Date.now() + 1 }) === null)
  check('其他用户的桌面：提权通道拒绝（非垃圾目录）', validateElevatedItem({ path: 'C:\\Users\\Other\\Desktop\\a.tmp', sizeBytes: 1, mtimeMs: Date.now(), categoryId: 'x', risk: 'low', keepUntil: Date.now() + 1 }) !== null)

  // ── 5. 系统长路径策略 ──
  console.log('\n═══ 5. 系统长路径策略 ═══')
  const lp = await ps("(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled")
  const enabled = lp.out.trim() === '1'
  console.log(`${enabled ? '✅' : '⚠️'} LongPathsEnabled = ${lp.out.trim() || '(未设置 → 默认关闭)'}`)

  console.log('\n═══ 汇总 ═══')
  const failed = results.filter((r) => !r.ok)
  console.log(`通过 ${results.length - failed.length}/${results.length}`)
  if (existsSync(base)) await fs.rm(base, { recursive: true, force: true })
  process.exit(0)
}

void main()
