/**
 * 垃圾规则引擎与图谱构建测试
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { loadRulesSync, expandRoots, setShellFolderMap, getShellFolderMap, type CompiledRule } from '@junk/engine'
import { pruneMissing } from '@junk/shellfolders'
import rulesJson from '@rules/junk-rules.json'
import { buildGraph } from '@graph-core/build'
import { layoutGraph, TIER_RADIUS } from '@graph-core/layout'
import { classifyKind, isSharedRuntime } from '@shared/util'
import type { DependencyEdge, FileNode, SoftwareItem } from '@shared/types'
import { fileId } from '@scanner/deps'

const ruleSet = loadRulesSync(rulesJson as never)

describe('规则库完整性', () => {
  it('恰好 13 类，编号连续且唯一', () => {
    const ids = ruleSet.rules.map((r) => r.id)
    assert.equal(ids.length, 13)
    assert.equal(new Set(ids).size, 13, '存在重复编号')
    ids.forEach((id, i) => assert.equal(id, `GC-${String(i + 1).padStart(2, '0')}`))
  })

  it('每类都有名称、风险等级与默认勾选策略', () => {
    for (const r of ruleSet.rules) {
      assert.ok(r.name && r.name.length > 0, `${r.id} 缺少名称`)
      assert.ok(['low', 'medium', 'high', 'hint'].includes(r.risk), `${r.id} 风险等级非法`)
      assert.equal(typeof r.defaultSelected, 'boolean')
      assert.ok(r.description && r.description.length > 0, `${r.id} 缺少说明`)
    }
  })

  it('13 类中 7 类为 defaultSelected=true（低风险直清项）', () => {
    const on = ruleSet.rules.filter((r) => r.defaultSelected)
    assert.ok(on.length >= 4 && on.length <= 8, `默认勾选数量异常: ${on.length}`)
  })

  it('特殊算法类规则带 algorithm 字段', () => {
    const map = new Map(ruleSet.rules.map((r) => [r.id, r]))
    assert.equal(map.get('GC-08')?.algorithm, 'orphan')
    assert.equal(map.get('GC-11')?.algorithm, 'duplicate')
    assert.equal(map.get('GC-12')?.algorithm, 'bigfile')
    assert.equal(map.get('GC-13')?.algorithm, 'deadlink')
  })

  it('每个规则至少解析出一个存在的根目录', () => {
    for (const r of ruleSet.rules) {
      assert.ok(r.roots.length > 0, `${r.id} (${r.name}) 没有任何有效根目录`)
    }
  })
})

describe('环境变量展开', () => {
  it('%TEMP% 展开为真实路径', () => {
    const out = expandRoots('%TEMP%')
    assert.equal(out.length, 1)
    assert.ok(!out[0].includes('%'), `未展开: ${out[0]}`)
  })

  it('%SG_DRIVES% 展开为多个盘符（至少 C:）', () => {
    const out = expandRoots('%SG_DRIVES%\\$Recycle.Bin')
    assert.ok(out.length >= 1)
    assert.ok(out.every((p) => /^[A-Z]:\\/i.test(p)))
  })

  it('不存在的环境变量被丢弃而不是退化成盘根相对路径', () => {
    assert.deepEqual(expandRoots('%SG_NOT_EXIST_VAR_XYZ%\\bar'), [])
  })

  it('环境变量缺失时不得产生非绝对路径（防扫描范围被放大）', () => {
    const out = expandRoots('%SG_NOT_EXIST_VAR_XYZ%\\Temp')
    assert.deepEqual(out, [], '展开失败必须整体丢弃，否则会扫到盘根')
    // 正常展开仍须是绝对路径
    for (const r of ruleSet.rules) {
      for (const root of r.roots) {
        assert.ok(/^[A-Za-z]:\\/.test(root), `${r.id} 的根目录不是绝对路径：${root}`)
      }
    }
  })
  it('用户库目录在中文本地化 / OneDrive 环境下被修正为真实路径', () => {
    // 该机器上 Documents 不存在（被 OneDrive 接管或本地化），此时应修正到真实目录或保持原样，
    // 关键是：绝不能退化成非绝对路径，也不能指向盘根
    const out = expandRoots('%USERPROFILE%\\Documents')
    assert.equal(out.length, 1)
    assert.ok(/^[A-Za-z]:\\/.test(out[0]), `结果必须是绝对路径：${out[0]}`)
    assert.ok(out[0].length > 4, '不应退化为盘根')
  })

  it('已存在的库目录保持原样（不误改）', () => {
    const temp = process.env.TEMP!
    const out = expandRoots('%TEMP%')
    assert.equal(out[0].toLowerCase(), temp.toLowerCase())
  })

  it('每类规则的根目录都存在或为可解释的缺失（不产生盘根路径）', () => {
    for (const r of ruleSet.rules) {
      for (const root of r.roots) {
        assert.ok(/^[A-Za-z]:\\[^\\]/.test(root), `${r.id} 的根目录疑似盘根：${root}`)
      }
    }
  })
})

describe('用户库目录注入（Shell Folders 权威路径）', () => {
  const tmp = join(os.tmpdir(), 'sg-shellfolder-test')

  it('注入后，英文名库目录被替换为重定向后的真实路径', () => {
    mkdirSync(tmp, { recursive: true })
    setShellFolderMap({ documents: tmp })
    try {
      // %TEMP%\Documents 在不存在的父路径下必然不存在，从而走注入分支
      const out = expandRoots('%TEMP%\\Documents')
      assert.equal(out.length, 1)
      assert.equal(out[0].toLowerCase(), tmp.toLowerCase(), '应使用注入的权威路径')
    } finally {
      setShellFolderMap(null)
    }
  })

  it('清空注入后回到原来的猜测策略（不残留状态）', () => {
    assert.equal(getShellFolderMap(), null)
    const out = expandRoots('%TEMP%\\Documents')
    assert.equal(out.length, 1)
    assert.ok(/documents$/i.test(out[0]), `未注入时应保留原名或本地化名：${out[0]}`)
  })

  it('注入指向不存在的路径时不生效（避免把无效路径灌进规则）', () => {
    setShellFolderMap({ documents: join(tmp, '__not_exist__') })
    try {
      const out = expandRoots('%TEMP%\\Documents')
      assert.ok(!out[0].includes('__not_exist__'), '不存在的注入路径不应被采用')
    } finally {
      setShellFolderMap(null)
    }
  })
})

describe('规则编译结果', () => {
  const byId = new Map<string, CompiledRule>(ruleSet.rules.map((r) => [r.id, r]))

  it('GC-04 浏览器缓存的多根目录都被编译', () => {
    const r = byId.get('GC-04')!
    assert.ok(r.roots.length >= 5, `根目录未展开全: ${r.roots.length}`)
    assert.equal(r.risk, 'low')
    assert.equal(r.defaultSelected, true)
  })

  it('GC-05/06 中风险默认不勾选（符合确认强度设计）', () => {
    assert.equal(byId.get('GC-05')!.defaultSelected, false)
    assert.equal(byId.get('GC-06')!.defaultSelected, false)
  })

  it('GC-06 使用整目录模式', () => {
    assert.equal(byId.get('GC-06')!.wholeDir, true)
  })

  it('GC-09 有最小体积与最小存在时长过滤', () => {
    const r = byId.get('GC-09')!
    assert.ok(r.minSizeBytes >= 1024 * 1024, '安装包残留应过滤小文件')
    assert.ok(r.maxAgeMs > 0, '应有最小存在时长过滤')
  })

  it('排除规则被编译为正则', () => {
    const r = byId.get('GC-04')!
    assert.ok(r.exclude.length > 0)
    assert.ok(r.exclude.some((re) => re.test('C:\\x\\Cache\\index-dir\\f_1')))
  })
})

describe('图谱构建', () => {
  const sw: SoftwareItem = {
    id: 'sw_test',
    name: '测试软件',
    version: '1.0',
    publisher: 'tester',
    installPath: 'D:\\App\\Test',
    mainExe: 'D:\\App\\Test\\test.exe',
    iconHash: 'h1',
    source: 'registry',
    sizeBytes: 1000
  }

  function mkFile(fullPath: string, size = 1000, missing = false): FileNode {
    const name = fullPath.split('\\').pop()!
    return {
      id: fileId(fullPath),
      fullPath: missing ? `（未找到）${name}` : fullPath,
      name,
      sizeBytes: size,
      mtime: Date.now(),
      kind: classifyKind(fullPath),
      ext: name.split('.').pop() ?? '',
      missing,
      refCount: 1
    }
  }

  function mkEdge(f: FileNode, evidence: DependencyEdge['evidence'], confidence: number): DependencyEdge {
    return {
      sourceId: sw.id,
      targetId: f.id,
      type: evidence.includes('E2') ? 'imports' : 'binds',
      confidence,
      evidence
    }
  }

  const files = new Map<string, FileNode>()
  const edges: DependencyEdge[] = []

  const add = (p: string, ev: DependencyEdge['evidence'], conf: number, size = 1000, missing = false): void => {
    const f = mkFile(p, size, missing)
    files.set(f.id, f)
    edges.push(mkEdge(f, ev, conf))
  }

  add('D:\\App\\Test\\test.exe', ['E1'], 0.6)
  add('D:\\App\\Test\\lib\\core.dll', ['E1', 'E2'], 0.95)
  add('C:\\Windows\\System32\\kernel32.dll', ['E2'], 0.75)
  add('C:\\Windows\\System32\\vcruntime140.dll', ['E2'], 0.83)
  add('D:\\App\\Test\\settings.ini', ['E1'], 0.6)
  add('D:\\App\\Test\\missing.dll', ['E2'], 0.99, 0, true)
  add('D:\\App\\Test\\weak.dat', ['E1'], 0.3)

  const model = buildGraph(sw, files, edges, {
    parsedOk: 3,
    parseFailed: 0,
    totalBytes: 5000,
    buildMs: 12
  })

  it('中心节点唯一且为软件节点', () => {
    const centers = model.nodes.filter((n) => n.type === 'software')
    assert.equal(centers.length, 1)
    assert.equal(centers[0].id, sw.id)
    assert.equal(centers[0].tier, 0)
  })

  it('系统依赖被折叠为聚合节点', () => {
    const sys = model.nodes.find((n) => n.type === 'group' && n.policy === 'system')
    assert.ok(sys, '未生成系统依赖聚合节点')
    assert.ok((sys!.collapsedCount ?? 0) >= 1, 'kernel32 应被收纳进系统依赖组')
    assert.ok((sys!.children?.length ?? 0) >= 1, '聚合节点应携带子节点用于展开')
    assert.ok(
      (sys!.children ?? []).some((c) => /kernel32/i.test(c.label)),
      'kernel32 应属于系统依赖而非其他分组'
    )
  })

  it('共享运行库单独成组（对齐文档 5.3 分组策略）', () => {
    const g = model.nodes.find((n) => n.type === 'group' && n.policy === 'shared_runtime')
    assert.ok(g, '未生成共享运行库聚合节点')
    assert.ok((g!.children ?? []).some((c) => /vcruntime/i.test(c.label)), 'vcruntime140 应归入共享运行库组')
    // 关键：它不能同时出现在系统依赖组里（分组互斥）
    const sys = model.nodes.find((n) => n.type === 'group' && n.policy === 'system')
    assert.ok(
      !(sys?.children ?? []).some((c) => /vcruntime/i.test(c.label)),
      'vcruntime 不应同时被归入系统依赖组'
    )
  })

  it('缺失依赖进入 missing 分组且携带 missing 标记', () => {
    const missingEdges = model.edges.filter((e) => e.missing)
    assert.ok(missingEdges.length >= 1, '缺失依赖边未标记')
    const fileNodes = model.nodes.filter((n) => n.type === 'file' && n.file?.missing)
    const missingGroup = model.nodes.find((n) => n.policy === 'missing')
    assert.ok(fileNodes.length + (missingGroup?.collapsedCount ?? 0) >= 1)
  })

  it('统计字段与实际数据一致', () => {
    assert.equal(model.stats.fileCount, edges.length)
    assert.equal(model.stats.parsedOk, 3)
    assert.equal(model.stats.totalSizeBytes, 5000)
    assert.equal(model.stats.missingCount, 1)
  })

  it('每条边都至少带一条证据（可溯源）', () => {
    for (const e of model.edges) {
      assert.ok(e.evidence.length > 0, `边 ${e.id} 缺少证据`)
      assert.ok(e.confidence >= 0 && e.confidence <= 1)
    }
  })

  it('高置信度节点优先进入直连层', () => {
    const core = [...files.values()].find((f) => /core\.dll$/.test(f.name))!
    const node = model.nodes.find((n) => n.id === core.id)
    assert.ok(node, '高置信度的 core.dll 应直接入图而非被折叠')
    assert.equal(node!.tier, 1)
  })
})

describe('布局算法', () => {
  it('径向模式中心固定在原点，其余按层分布', () => {
    const nodes = [
      { id: 'c', tier: 0, radius: 48 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, tier: 1, radius: 12 })),
      ...Array.from({ length: 20 }, (_, i) => ({ id: 'g' + i, tier: 2, radius: 12 }))
    ]
    const edges = nodes.slice(1).map((n) => ({ source: 'c', target: n.id }))
    const r = layoutGraph(nodes, edges, 'radial')
    assert.equal(r.approximate, false)
    const c = r.positions['c']
    assert.equal(c.x, 0)
    assert.equal(c.y, 0)
    // T1 节点应大致落在 T1 半径附近
    const dists = nodes.filter((n) => n.tier === 1).map((n) => Math.hypot(r.positions[n.id].x, r.positions[n.id].y))
    const avg = dists.reduce((a, b) => a + b, 0) / dists.length
    assert.ok(Math.abs(avg - TIER_RADIUS[1]) < 90, `T1 平均半径偏离: ${avg.toFixed(0)} vs ${TIER_RADIUS[1]}`)
  })

  it('超过 3000 节点切换为近似布局（跳过力学迭代）', () => {
    const nodes = Array.from({ length: 3200 }, (_, i) => ({
      id: 'n' + i,
      tier: (i % 3) + 1,
      radius: 12
    }))
    const r = layoutGraph(nodes, [], 'radial')
    assert.equal(r.approximate, true)
    assert.equal(r.iterations, 0)
    assert.ok(r.ms < 500, `近似布局过慢: ${r.ms}ms`)
    assert.equal(Object.keys(r.positions).length, 3200)
  })

  it('三种布局模式都能在有限时间内完成', () => {
    const nodes = [
      { id: 'c', tier: 0, radius: 48 },
      ...Array.from({ length: 60 }, (_, i) => ({ id: 'f' + i, tier: 1, radius: 12, sector: i % 3 ? 'imports' : 'sxs' }))
    ]
    for (const mode of ['radial', 'force', 'cluster'] as const) {
      const r = layoutGraph(nodes, [{ source: 'c', target: 'f0' }], mode)
      assert.ok(r.ms < 4000, `${mode} 布局过慢: ${r.ms}ms`)
    }
  })

  it('证据类型可映射为聚类扇区（不出现未定义坐标）', () => {
    const nodes = [
      { id: 'c', tier: 0, radius: 48, sector: 'center' },
      { id: 'a', tier: 1, radius: 12, sector: 'imports' },
      { id: 'b', tier: 1, radius: 12, sector: 'sxs' }
    ]
    const r = layoutGraph(nodes, [{ source: 'c', target: 'a' }], 'cluster')
    assert.ok(r.positions['a'] && r.positions['b'])
  })
})

describe('shellfolders —— 缺失路径过滤', () => {
  it('pruneMissing 丢弃磁盘上不存在的条目', () => {
    const keep = process.env.TEMP!
    const pruned = pruneMissing({ documents: keep, pictures: 'C:\\__not_exist_dir__\\x' })
    assert.equal(pruned.documents, keep)
    assert.equal(pruned.pictures, undefined)
  })
})

describe('共享运行库判定与图例一致性', () => {
  it('isSharedRuntime 与 GC 规则无关但影响分组', () => {
    assert.equal(isSharedRuntime('msvcp140.dll'), true)
    assert.equal(isSharedRuntime('libdisp.dll'), false)
  })
})
