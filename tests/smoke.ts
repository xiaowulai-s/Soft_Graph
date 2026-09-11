/**
 * 冒烟验证：不启动 Electron，直接跑扫描内核，验证真机产出。
 * 覆盖：软件发现 → PE 依赖解析 → 置信度打分 → 图谱构建 → 垃圾规则扫描 → 安全白名单。
 */

import { discoverSoftware } from '../packages/scanner/software'
import { resolveDependencies } from '../packages/scanner/deps'
import { parsePe } from '../packages/scanner/pe'
import { mapApiSet, loadKnownDlls, resolveDll, buildPathDirs } from '../packages/scanner/dllresolve'
import { buildGraph } from '../packages/graph-core/build'
import { layoutGraph } from '../packages/graph-core/layout'
import { loadRulesSync } from '../packages/junk/engine'
import { scanJunk } from '../packages/junk/scanner'
import { guardPath } from '../packages/shared/safety'
import { formatBytes } from '../packages/shared/util'
import rulesJson from '../packages/rules/junk-rules.json'
import { join } from 'node:path'

const line = (s = ''): void => console.log(s)
const hr = (t: string): void => line(`\n${'='.repeat(8)} ${t} ${'='.repeat(8)}`)

async function main(): Promise<void> {
  // ── 1. PE 解析（拿系统 DLL 与 explorer.exe 做基准） ──
  hr('1. PE 解析器')
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  for (const p of [join(sysRoot, 'explorer.exe'), join(sysRoot, 'System32', 'kernel32.dll'), join(sysRoot, 'System32', 'notepad.exe')]) {
    const r = await parsePe(p)
    line(
      `  ${p.split('\\').pop()!.padEnd(16)} status=${r.parseStatus.padEnd(7)} arch=${String(r.arch).padEnd(5)} ` +
        `imports=${String(r.imports.length).padEnd(4)} delay=${String(r.delayImports.length).padEnd(3)} ` +
        `sxs=${r.sxsDependencies.length} dotnet=${r.isDotNet} ver=${r.fileVersion ?? '-'}`
    )
    if (r.imports.length) line(`      前 6 个导入：${r.imports.slice(0, 6).join(', ')}`)
    if (r.fileDescription) line(`      描述：${r.fileDescription}`)
  }

  // ── 2. API Set 映射与 DLL 搜索路径 ──
  hr('2. API Set 映射 / DLL 搜索路径')
  for (const n of [
    'api-ms-win-crt-runtime-l1-1-0.dll',
    'api-ms-win-core-file-l1-2-0.dll',
    'api-ms-win-security-base-l1-1-0.dll',
    'api-ms-win-eventing-provider-l1-1-0.dll'
  ]) {
    line(`  ${n.padEnd(44)} → ${mapApiSet(n)}`)
  }
  const known = await loadKnownDlls()
  const pathDirs = buildPathDirs()
  line(`  KnownDLLs 条目数：${known.size}`)
  for (const d of ['kernel32.dll', 'vcruntime140.dll', 'msvcp140.dll', 'definitely-not-real-xyz.dll']) {
    const r = resolveDll(d, { appDir: join(sysRoot, 'System32'), arch: 'x64', pathDirs, known })
    line(`  ${d.padEnd(30)} → kind=${r.kind.padEnd(8)} ${r.fullPath || '(未找到 → 缺失依赖节点)'}`)
  }

  // ── 3. 安全白名单 ──
  hr('3. 删除安全白名单（9.1）')
  const cases = [
    'C:\\Windows\\System32\\kernel32.dll',
    'C:\\Windows\\WinSxS\\anything\\x.dll',
    'C:\\Program Files\\App\\a.dll',
    'C:\\Windows',
    'C:\\',
    process.env.TEMP + '\\some-temp-file.tmp',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\User Data\\Default\\Cache\\data_1',
    process.env.USERPROFILE + '\\Desktop',
    process.env.USERPROFILE + '\\Desktop\\junk.log',
    '\\\\server\\share\\x',
    'C:\\Windows.old\\Users\\x'
  ]
  for (const c of cases) {
    const v = guardPath(c)
    line(`  ${v.allowed ? '✔ 允许' : '✘ 拦截'}  ${c}${v.allowed ? '' : `   ← ${v.reason}`}`)
  }

  // ── 4. 软件发现 ──
  hr('4. 软件发现')
  const t0 = Date.now()
  const items = await discoverSoftware({
    portableThreshold: 55,
    onProgress: (phase, pct, cur) => {
      if (Math.round(pct) % 25 === 0) process.stdout.write(`\r  ${phase} ${Math.round(pct)}% ${cur.slice(0, 50)}          `)
    }
  })
  line(`\r  完成：${items.length} 个软件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s                              `)
  const bySource: Record<string, number> = {}
  for (const i of items) bySource[i.source] = (bySource[i.source] ?? 0) + 1
  line(`  来源分布：${JSON.stringify(bySource)}`)
  line('  体积 TOP 5：')
  for (const i of [...items].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 5)) {
    line(`    ${formatBytes(i.sizeBytes).padStart(10)}  ${i.name}  [${i.source}]`)
  }
  const portables = items.filter((i) => i.source === 'portable')
  if (portables.length) {
    line(`  便携软件（${portables.length}）：`)
    for (const p of portables.slice(0, 5)) line(`    ${p.name} (${p.portableScore} 分: ${p.portableEvidence?.join('、')})  ${p.installPath}`)
  } else {
    line('  便携软件：未发现（未配置扫描目录或不存在常见绿色软件目录）')
  }

    // 体积最大的 3 个已安装软件：顺带压测超大 PE 与复杂依赖图谱
    for (const t of [...items]
      .filter((i) => i.mainExe && i.source !== 'service' && i.source !== 'store')
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, 3)) {
      line(`\n  --- ${t.name} (${formatBytes(t.sizeBytes)}) ---`)
      const r = await parsePe(t.mainExe)
      line(
        `    PE: status=${r.parseStatus} arch=${r.arch} imports=${r.imports.length} delay=${r.delayImports.length} ` +
          `sxs=${r.sxsDependencies.length} dotnet=${r.isDotNet}${r.error ? '  err=' + r.error : ''}`
      )
      if (r.imports.length) line(`    导入前 8：${r.imports.slice(0, 8).join(', ')}`)
    }
    line('')
  // 取体积最大的已安装软件：既是真实场景，也顺带压测超大 PE 的解析路径
  const target =
    [...items]
      .filter((i) => i.mainExe && i.source !== 'service' && i.source !== 'store')
      .sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ??
    items.find((i) => i.mainExe)
  if (!target) {
    line('  未找到可解析的软件，跳过')
  } else {
    line(`  目标：${target.name}`)
    line(`  主程序：${target.mainExe}`)
    const t1 = Date.now()
    const res = await resolveDependencies(target, {
      maxDepth: 2,
      enableComEvidence: false, // 冒烟测试跳过重量级注册表遍历
      enableShortcutEvidence: false,
      onProgress: (phase, pct, cur) => process.stdout.write(`\r  ${phase} ${Math.round(pct)}% ${cur.slice(0, 44)}            `)
    })
    const ms = Date.now() - t1
    line(`\r  依赖解析完成：${res.files.size} 文件 / ${res.edges.length} 边，用时 ${(ms / 1000).toFixed(1)}s          `)
    line(`  解析成功 ${res.stats.parsedOk} · 失败 ${res.stats.parseFailed} · 缺失 ${res.stats.missing} · 目录体积 ${formatBytes(res.stats.totalBytes)}`)

    const sorted = [...res.edges].sort((a, b) => b.confidence - a.confidence)
    line('  置信度最高 6 条：')
    for (const e of sorted.slice(0, 6)) {
      const f = res.files.get(e.targetId)!
      line(`    ${e.confidence.toFixed(2)}  [${e.evidence.join('+')}] ${e.type.padEnd(11)} ${f.name}  ←  ${f.fullPath}`)
    }
    const shared = sorted.filter((e) => (res.files.get(e.targetId)?.refCount ?? 0) > 20).slice(0, 4)
    if (shared.length) {
      line('  共享惩罚生效示例（refCount 高 → 置信度被压低）：')
      for (const e of shared) {
        const f = res.files.get(e.targetId)!
        line(`    ${e.confidence.toFixed(2)}  refCount=${f.refCount}  ${f.name}`)
      }
    }
    const missing = [...res.files.values()].filter((f) => f.missing)
    line(`  缺失依赖：${missing.length ? missing.slice(0, 5).map((m) => m.name).join(', ') : '无'}`)

    const model = buildGraph(target, res.files, res.edges, {
      parsedOk: res.stats.parsedOk,
      parseFailed: res.stats.parseFailed,
      totalBytes: res.stats.totalBytes,
      buildMs: ms
    })
    line(`  图谱：${model.nodes.length} 节点 / ${model.edges.length} 边`)
    const tiers: Record<number, number> = {}
    for (const n of model.nodes) tiers[n.tier] = (tiers[n.tier] ?? 0) + 1
    line(`  分层分布 T0/T1/T2/T3：${JSON.stringify(tiers)}`)
    line(`  聚合分组：${JSON.stringify(model.stats.groups)}`)

    const lay = layoutGraph(
      model.nodes.map((n) => ({ id: n.id, tier: n.tier, radius: n.radius })),
      model.edges.map((e) => ({ source: e.source, target: e.target })),
      'radial'
    )
    line(`  布局：${lay.approximate ? '近似' : `力学收敛 ${lay.iterations} 次`}，${lay.ms}ms，产出 ${Object.keys(lay.positions).length} 个坐标`)
    const c = lay.positions[model.nodes[0].id]
    line(`  中心节点坐标：(${c.x}, ${c.y})  ← 应为 (0, 0)`)
  }

  // ── 6. 垃圾扫描（挑轻量规则，避免全盘耗时） ──
  hr('6. 垃圾规则扫描')
  const ruleSet = loadRulesSync(rulesJson as never)
  line(`  规则库：${ruleSet.rules.length} 类（schema v${ruleSet.schemaVersion}）`)
  for (const r of ruleSet.rules) {
    line(`    ${r.id}  ${r.name.padEnd(14)} risk=${r.risk.padEnd(6)} default=${r.defaultSelected ? 'Y' : 'N'} roots=${r.roots.length}`)
  }

  const t2 = Date.now()
  const junk = await scanJunk(
    ruleSet,
    {
      knownNames: new Set(items.map((i) => i.name.toLowerCase().replace(/[^a-z0-9]/g, ''))),
      knownPublishers: new Set(items.map((i) => (i.publisher || '').toLowerCase().replace(/[^a-z0-9]/g, ''))),
      knownDirs: new Set(items.map((i) => i.installPath.toLowerCase())),
      excludes: []
    },
    {
      categoryIds: ['GC-01', 'GC-03', 'GC-04', 'GC-07', 'GC-13'],
      onProgress: (phase, pct, cur, found) =>
        process.stdout.write(`\r  ${phase} ${Math.round(pct)}% found=${found} ${cur.slice(0, 34)}              `)
    }
  )
  line(`\r  扫描完成，用时 ${((Date.now() - t2) / 1000).toFixed(1)}s                                        `)
  line(`  可释放合计：${formatBytes(junk.summary.totalBytes)} · ${junk.summary.totalCount} 项 · 遍历 ${junk.summary.scannedFiles} 文件`)
  line(`  一键可清（仅低风险默认勾选）：${formatBytes(junk.summary.oneClickBytes)}`)
  for (const c of junk.summary.categories) {
    line(`    ${c.id}  ${c.name.padEnd(14)} ${formatBytes(c.sizeBytes).padStart(10)}  ${String(c.count).padStart(6)} 项  risk=${c.risk}`)
  }
  line('  样例条目（前 5）：')
  for (const it of junk.items.slice(0, 5)) {
    line(`    ${formatBytes(it.sizeBytes).padStart(9)}  ${it.fullPath}`)
  }

  // 验证扫描结果中不含受保护路径
  const violations = junk.items.filter((i) => !guardPath(i.fullPath).allowed)
  line(`\n  安全校验：扫描结果中受保护路径条目数 = ${violations.length}（应为 0）`)
  if (violations.length) for (const v of violations.slice(0, 5)) line(`    ⚠ ${v.fullPath}`)

  hr('冒烟验证结束')
}

main().catch((e) => {
  console.error('冒烟测试失败：', e)
  process.exit(1)
})
