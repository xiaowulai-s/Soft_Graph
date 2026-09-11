/**
 * M0 性能基准（可重复执行，输出稳定数字）
 * ============================================================
 * 目的：把 v2.0.0 的性能目标（枚举 ≤6s、全量垃圾 ≤100s、增量 ≤5s）变成可反复测量的数字，
 *      避免「优化了但说不清快了多少」。
 *
 * 用法：
 *   npm run bench              完整基准（含 13 类全量垃圾扫描，约 3~5 分钟）
 *   npm run bench -- --quick   快速基准（跳过重量级垃圾规则，约 1 分钟）
 *
 * 产出：
 *   .tmp/bench/latest.json     机器可读结果
 *   docs/benchmarks/baseline-YYYY-MM-DD.md   人类可读报告
 */
import { cpus, totalmem, freemem, platform, release, arch } from 'node:os'
import { promises as fs } from 'node:fs'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { enumerateWindows } from '@scanner/winenum'
import { discoverSoftware } from '@scanner/software'
import { parsePe } from '@scanner/pe'
import { resolveDependencies, fileId } from '@scanner/deps'
import { buildGraph } from '@graph-core/build'
import { layoutGraph } from '@graph-core/layout'
import { loadRulesSync } from '@junk/engine'
import { scanJunk } from '@junk/scanner'
import { openDb } from '../apps/desktop/src/main/db/driver'
import { Store } from '../apps/desktop/src/main/db/store'
import { loadNativeCapabilities, describeCapabilities } from '../packages/native/capabilities'
import { formatBytes } from '@shared/util'
import rulesJson from '@rules/junk-rules.json'

const QUICK = process.argv.includes('--quick')
// 由 scripts/bench.mjs 以项目根目录为 cwd 启动，且打包为 CJS（import.meta 不可用）
const ROOT = process.cwd()

interface Stage {
  name: string
  ms: number
  detail: string
  extra?: Record<string, unknown>
}

const stages: Stage[] = []
const notes: string[] = []

async function time<T>(name: string, fn: () => Promise<T>, detail: (r: T) => string, extra?: (r: T) => Record<string, unknown>): Promise<T> {
  const t0 = Date.now()
  const r = await fn()
  const ms = Date.now() - t0
  stages.push({ name, ms, detail: detail(r), extra: extra ? extra(r) : undefined })
  process.stdout.write(`\r  ${name}: ${(ms / 1000).toFixed(2)}s                    \n`)
  return r
}

function heapMB(): number {
  return Math.round(process.memoryUsage().rss / 1048576)
}

async function main(): Promise<void> {
  const t_start = Date.now()
  console.log('SoftGraph M0 性能基准')
  console.log(`模式：${QUICK ? '快速（跳过重量级规则）' : '完整'}`)
  console.log(`机器：${cpus()[0]?.model ?? 'unknown'} × ${cpus().length} 核 · 内存 ${formatBytes(totalmem())}（空闲 ${formatBytes(freemem())}）`)
  console.log(`系统：${platform()} ${release()} ${arch()} · Node ${process.versions.node}\n`)

  // ── 0. 原生能力探针（双轨决策的落地检查） ──
  const caps = loadNativeCapabilities()
  const rep = describeCapabilities(caps)
  stages.push({
    name: '原生能力探针',
    ms: caps.probeMs,
    detail: rep.summary,
    extra: { usn: caps.usn, restartManager: caps.restartManager, apiSet: caps.apiSet, loadError: caps.loadError }
  })
  console.log(`  ${rep.summary}`)

  // ── 1. 注册表与五来源枚举 ──
  console.log('\n[1] 软件来源枚举')
  const raw = await time(
    '五来源枚举（注册表/MSI/Store/AppPaths/服务）',
    () => enumerateWindows(),
    (r) => `卸载项 ${r.uninstall.length} · MSI ${r.msi.length} · Store ${r.store.length} · AppPaths ${r.appPaths.length} · 服务 ${r.services.length} · 错误 ${r.errors.length}`,
    (r) => ({
      uninstall: r.uninstall.length,
      msi: r.msi.length,
      store: r.store.length,
      appPaths: r.appPaths.length,
      services: r.services.length,
      errors: r.errors.length
    })
  )

  // ── 2. 软件发现全流程（含便携目录扫描） ──
  console.log('\n[2] 软件发现全流程')
  const items = await time(
    '发现软件（含便携扫描）',
    () => discoverSoftware({ portableThreshold: 55 }),
    (r) => `共 ${r.length} 个（便携 ${r.filter((i) => i.source === 'portable').length}）`,
    (r) => {
      const by: Record<string, number> = {}
      for (const i of r) by[i.source] = (by[i.source] ?? 0) + 1
      return by
    }
  )

  // ── 3. PE 解析吞吐 ──
  console.log('\n[3] PE 解析吞吐')
  const sys32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const sampleFiles = (existsSync(sys32) ? readdirSync(sys32) : [])
    .filter((f) => /\.(dll|exe)$/i.test(f))
    .slice(0, 300)
    .map((f) => join(sys32, f))
    .filter((p) => {
      try {
        return statSync(p).size > 8 * 1024
      } catch {
        return false
      }
    })
    .slice(0, 120)

  const peRes = await time(
    `PE 解析 ${sampleFiles.length} 个系统模块`,
    async () => {
      let bytes = 0
      let ok = 0
      let totalImports = 0
      for (const p of sampleFiles) {
        const st = statSync(p)
        bytes += st.size
        const r = await parsePe(p, { resources: false })
        if (r.parseStatus === 'ok') ok++
        totalImports += r.imports.length
      }
      return { bytes, ok, totalImports, n: sampleFiles.length }
    },
    (r) => `${r.ok}/${r.n} 成功 · 平均导入 ${(r.totalImports / Math.max(r.n, 1)).toFixed(1)} 项`,
    (r) => ({ bytes: r.bytes, filesPerSec: undefined })
  )
  const peMs = stages[stages.length - 1].ms
  stages[stages.length - 1].detail += ` · ${(peRes.bytes / 1048576 / (peMs / 1000)).toFixed(1)} MB/s · ${(peRes.n / (peMs / 1000)).toFixed(0)} 文件/s`

  // ── 4. 依赖解析 + 图谱构建（选中型软件，冷启动） ──
  console.log('\n[4] 依赖解析与图谱')
  const target =
    [...items].filter((i) => i.mainExe && !['service', 'store'].includes(i.source)).sort((a, b) => b.sizeBytes - a.sizeBytes)[3] ??
    items.find((i) => i.mainExe)
  if (target) {
    console.log(`  目标：${target.name}${target.sizeBytes ? '（' + formatBytes(target.sizeBytes) + '）' : ''}`)
    const deps = await time(
      `依赖解析（maxDepth=2）`,
      () => resolveDependencies(target, { maxDepth: 2, enableComEvidence: false, enableShortcutEvidence: false }),
      (r) => `${r.files.size} 文件 / ${r.edges.length} 边 · 缺失 ${r.stats.missing} · 解析成功 ${r.stats.parsedOk}`,
      (r) => ({ files: r.files.size, edges: r.edges.length, missing: r.stats.missing })
    )
    const model = await time(
      '图谱构建',
      async () =>
        buildGraph(target, deps.files, deps.edges, {
          parsedOk: deps.stats.parsedOk,
          parseFailed: deps.stats.parseFailed,
          totalBytes: deps.stats.totalBytes,
          buildMs: 0
        }),
      (r) => `${r.nodes.length} 节点 / ${r.edges.length} 边 · 分组 ${JSON.stringify(r.stats.groups)}`,
      (r) => ({ nodes: r.nodes.length, edges: r.edges.length })
    )
    await time(
      '布局计算（径向）',
      async () =>
        layoutGraph(
          model.nodes.map((n) => ({ id: n.id, tier: n.tier, radius: n.radius })),
          model.edges.map((e) => ({ source: e.source, target: e.target })),
          'radial'
        ),
      (r) => `${r.approximate ? '近似' : `力学 ${r.iterations} 次`} · ${Object.keys(r.positions).length} 坐标`,
      (r) => ({ approximate: r.approximate, iterations: r.iterations })
    )

    // 数据库往返（图谱缓存命中路径）
    const dbFile = join(ROOT, '.tmp', 'bench', 'bench.db')
    await fs.mkdir(dirname(dbFile), { recursive: true }).catch(() => {})
    if (existsSync(dbFile)) await fs.rm(dbFile, { force: true })
    const db = await openDb({ file: dbFile })
    const store = new Store(db)
    store.init()
    store.saveSoftware(items)
    store.saveFilesAndDeps([...deps.files.values()], deps.edges)
    await time(
      '数据库写入（软件 + 依赖）',
      async () => {
        store.saveGraph(model, null)
        await store.persist()
      },
      () => `驱动 ${store.driverName}`
    )
    await time(
      '图谱缓存读取',
      async () => store.loadGraph(target.id),
      (r) => (r ? `命中 ${r.model.nodes.length} 节点` : '未命中')
    )
    await store.close()
  } else {
    notes.push('未找到可用于依赖解析的软件，图谱相关基准跳过')
  }

  console.log(`\n  当前内存：RSS ${heapMB()} MB`)

  // ── 5. 垃圾扫描（逐类计时） ──
  console.log('\n[5] 垃圾扫描（逐类）')
  // 与应用启动一致：先解析用户库目录权威路径，再编译规则。
  // 缺了这一步，%SG_DOCUMENTS% 之类的 token 会解析失败，相关分类会静默失去根目录。
  const { resolveUserShellFolders, pruneMissing } = await import('@junk/shellfolders')
  const { setShellFolderMap } = await import('@junk/engine')
  const shellMap = await resolveUserShellFolders()
  if (shellMap) {
    const pruned = pruneMissing(shellMap)
    setShellFolderMap(pruned)
    console.log(`  用户库目录已解析：${Object.entries(pruned).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  } else {
    console.log('  警告：用户库目录解析失败，库目录相关规则将退回英文名猜测')
  }
  const ruleSet = loadRulesSync(rulesJson as never)
  if (ruleSet.warnings.length) {
    for (const w of ruleSet.warnings) console.log(`  ⚠ ${w}`)
    notes.push(...ruleSet.warnings)
  }
  const HEAVY = ['GC-11', 'GC-12', 'GC-08', 'GC-06', 'GC-02']
  const activeRules = QUICK ? ruleSet.rules.filter((r) => ['GC-01', 'GC-03', 'GC-04', 'GC-07'].includes(r.id)) : ruleSet.rules
  if (QUICK) notes.push(`快速模式跳过了重量级规则：${HEAVY.join(' / ')}`)

  const ctx = {
    knownNames: new Set(items.map((i) => i.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')).filter((s) => s.length >= 3)),
    knownPublishers: new Set(items.map((i) => (i.publisher || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')).filter((s) => s.length >= 3)),
    knownDirs: new Set(items.map((i) => i.installPath.toLowerCase()).filter(Boolean)),
    excludes: []
  }

  let junkTotal = 0
  let junkCount = 0
  let scannedFiles = 0
  const perCategory: { id: string; name: string; ms: number; bytes: number; count: number }[] = []

  for (const rule of activeRules) {
    const t0 = Date.now()
    try {
      const res = await scanJunk({ schemaVersion: 1, updatedAt: '', rules: [rule] }, ctx, {})
      const ms = Date.now() - t0
      const c = res.summary.categories[0]
      perCategory.push({ id: rule.id, name: rule.name, ms, bytes: c?.sizeBytes ?? 0, count: c?.count ?? 0 })
      junkTotal += c?.sizeBytes ?? 0
      junkCount += c?.count ?? 0
      scannedFiles += res.summary.scannedFiles
      console.log(`  ${rule.id} ${rule.name.padEnd(14)} ${(ms / 1000).toFixed(2).padStart(7)}s  ${formatBytes(c?.sizeBytes ?? 0).padStart(10)}  ${String(c?.count ?? 0).padStart(6)} 项`)
    } catch (e) {
      perCategory.push({ id: rule.id, name: rule.name, ms: Date.now() - t0, bytes: 0, count: 0 })
      notes.push(`${rule.id} 扫描异常：${(e as Error).message}`)
    }
  }

  const junkMs = perCategory.reduce((s, c) => s + c.ms, 0)
  stages.push({
    name: QUICK ? '垃圾扫描（快速 4 类）' : '垃圾扫描（全部 13 类）',
    ms: junkMs,
    detail: `${formatBytes(junkTotal)} · ${junkCount} 项 · 遍历 ${scannedFiles} 文件`,
    extra: { categories: perCategory.map((c) => ({ id: c.id, ms: c.ms, bytes: c.bytes, count: c.count })) }
  })

  console.log(`\n  合计 ${(junkMs / 1000).toFixed(1)}s · 可释放 ${formatBytes(junkTotal)} · ${junkCount} 项 · 遍历 ${scannedFiles} 文件`)
  console.log(`  最终内存：RSS ${heapMB()} MB`)

  // ── 汇总 ──
  const totalMs = Date.now() - t_start
  const result = {
    kind: QUICK ? 'quick' : 'full',
    date: new Date().toISOString(),
    machine: {
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memBytes: totalmem(),
      os: `${platform()} ${release()}`,
      arch: arch(),
      node: process.versions.node
    },
    native: caps,
    totalMs,
    rssMB: heapMB(),
    softwareCount: items.length,
    junkBytes: junkTotal,
    junkCount,
    junkScannedFiles: scannedFiles,
    stages,
    notes
  }

  const outDir = join(ROOT, '.tmp', 'bench')
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(join(outDir, 'latest.json'), JSON.stringify(result, null, 2), 'utf8')

  // 生成 Markdown 报告（文件名用本地日期，避免 UTC 导致的日期偏移）
  const local = new Date()
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
  const mdDir = join(ROOT, 'docs', 'benchmarks')
  await fs.mkdir(mdDir, { recursive: true })
  const mdPath = join(mdDir, `${QUICK ? 'quick' : 'baseline'}-${today}.md`)
  const targets: [string, string][] = [
    ['软件清单枚举', '≤ 6 s'],
    ['全盘垃圾扫描', '≤ 100 s'],
    ['图谱缓存读取', '≤ 400 ms'],
    ['PE 解析吞吐', '越高越好']
  ]
  let md = `# 性能基准报告（${QUICK ? '快速' : '完整'}）\n\n`
  md += `生成时间：${new Date().toLocaleString('zh-CN')}\n\n`
  md += `## 环境\n\n| 项 | 值 |\n|---|---|\n`
  md += `| CPU | ${result.machine.cpu} × ${result.machine.cores} 核 |\n`
  md += `| 内存 | ${formatBytes(result.machine.memBytes)} |\n`
  md += `| 系统 | ${result.machine.os} ${result.machine.arch} |\n`
  md += `| Node | ${result.machine.node} |\n`
  md += `| 原生能力 | ${rep.summary} |\n\n`
  md += `## 结果\n\n| 阶段 | 耗时 | 明细 |\n|---|---|---|\n`
  for (const s of stages) md += `| ${s.name} | ${(s.ms / 1000).toFixed(2)} s | ${s.detail} |\n`
  md += `\n整体耗时 ${(totalMs / 1000).toFixed(1)} s，结束内存 RSS ${heapMB()} MB。\n\n`
  md += `## 与 v2.0.0 目标对照\n\n| 指标 | 目标 | 本次实测 | 结论 |\n|---|---|---|---|\n`
  const enumStage = stages.find((s) => s.name.includes('发现软件'))
  const junkStage = stages.find((s) => s.name.includes('垃圾扫描'))
  const cacheStage = stages.find((s) => s.name.includes('缓存读取'))
  const rows: [string, string, string][] = [
    ['软件清单枚举', '≤ 6 s', enumStage ? `${(enumStage.ms / 1000).toFixed(2)} s` : '—'],
    ['全盘垃圾扫描', '≤ 100 s', junkStage ? `${(junkStage.ms / 1000).toFixed(2)} s${QUICK ? '（快速模式，非全量）' : ''}` : '—'],
    ['图谱缓存读取', '≤ 400 ms', cacheStage ? `${cacheStage.ms} ms` : '—']
  ]
  for (const [k, target, actual] of rows) {
    const num = parseFloat(actual)
    const goal = parseFloat(target.replace(/[^\d.]/g, ''))
    const unitScale = actual.includes('ms') ? 1000 : 1
    const ok = Number.isFinite(num) ? num / unitScale <= goal : false
    md += `| ${k} | ${target} | ${actual} | ${ok ? '✅ 达标' : '⚠️ 未达标'} |\n`
  }
  md += `\n## 逐类垃圾扫描\n\n| 编号 | 分类 | 耗时 | 可释放 | 条目 |\n|---|---|---|---|---|\n`
  for (const c of perCategory) md += `| ${c.id} | ${c.name} | ${(c.ms / 1000).toFixed(2)} s | ${formatBytes(c.bytes)} | ${c.count} |\n`
  if (notes.length) md += `\n## 备注\n\n${notes.map((n) => `- ${n}`).join('\n')}\n`
  md += `\n> 重新生成：\`npm run bench\`（完整）或 \`npm run bench -- --quick\`（快速）\n`

  await fs.writeFile(mdPath, md, 'utf8')

  console.log(`\n结果已写入：`)
  console.log(`  ${join(outDir, 'latest.json')}`)
  console.log(`  ${mdPath}`)
  void fileId
}

main().catch((e) => {
  console.error('基准执行失败：', e)
  process.exit(1)
})
