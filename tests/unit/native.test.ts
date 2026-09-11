/**
 * 原生能力探针测试（v2.0.0 双轨决策的守护测试）
 *
 * 双轨方案能成立的前提是两件事，本文件把它们固化成测试：
 *   1. 原生模块缺失时，探针必须返回「降级」而不是抛异常（否则整个应用起不来）；
 *   2. 代码里**不得**静态 import 原生模块（否则打包/安装阶段就会硬失败），
 *      只能运行时 require + try/catch。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import {
  loadNativeCapabilities,
  describeCapabilities,
  resetCapabilityCache,
  getNativeModule,
  NATIVE_PACKAGE_NAME,
  FALLBACK_STRATEGY
} from '@native/capabilities'

// 测试由 scripts/run-tests.mjs 以项目根目录为 cwd 启动，
// 且打包为 CJS（import.meta 不可用），因此直接用 cwd 定位仓库根
const ROOT = process.cwd()

describe('探针在无原生模块时安全降级', () => {
  it('返回 fallback 而非抛异常', () => {
    resetCapabilityCache()
    const caps = loadNativeCapabilities()
    assert.ok(['native', 'fallback'].includes(caps.source))
    assert.equal(typeof caps.usn, 'boolean')
    assert.equal(typeof caps.restartManager, 'boolean')
    assert.equal(typeof caps.apiSet, 'boolean')
    assert.ok(caps.probeMs >= 0)
  })

  it('本仓库未安装可选原生模块时，三项能力均为 false 且有加载说明', () => {
    resetCapabilityCache()
    const caps = loadNativeCapabilities()
    // 仓库不含 softgraph-native（它是可选的），因此这里应走降级分支
    if (caps.source === 'fallback') {
      assert.equal(caps.usn, false)
      assert.equal(caps.restartManager, false)
      assert.equal(caps.apiSet, false)
      assert.ok((caps.loadError ?? '').length > 0, '降级时应给出可排查的原因说明')
    }
  })

  it('未降级时 getNativeModule 返回 null 而不是抛错', () => {
    resetCapabilityCache()
    const caps = loadNativeCapabilities()
    if (caps.source === 'fallback') assert.equal(getNativeModule(), null)
  })

  it('结果被缓存：重复调用只探针一次', () => {
    resetCapabilityCache()
    const a = loadNativeCapabilities()
    const b = loadNativeCapabilities()
    assert.equal(a, b, '应返回同一对象（缓存生效）')
    const c = loadNativeCapabilities(true)
    assert.notEqual(a, c, 'force=true 时应重新探测')
  })
})

describe('降级策略说明完整', () => {
  it('三项能力都有对应的降级说明', () => {
    for (const k of ['usn', 'restartManager', 'apiSet'] as const) {
      assert.ok(FALLBACK_STRATEGY[k] && FALLBACK_STRATEGY[k].length > 10, `${k} 缺少降级说明`)
    }
  })

  it('describeCapabilities 输出三行且每行都有结论', () => {
    resetCapabilityCache()
    const rep = describeCapabilities()
    assert.equal(rep.rows.length, 3)
    assert.ok(rep.summary.length > 0)
    for (const r of rep.rows) {
      assert.ok(r.capability.length > 0)
      assert.equal(typeof r.enabled, 'boolean')
      if (!r.enabled) assert.ok(r.fallback && r.fallback.length > 0, `${r.capability} 未启用却无降级说明`)
    }
  })
})

describe('架构守护：不得静态 import 原生模块', () => {
  const SCAN_DIRS = ['packages', 'apps', 'scripts']

  function walk(dir: string, out: string[] = []): string[] {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) return out
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'out' || e.name === 'dist') continue
      const p = join(abs, e.name)
      if (e.isDirectory()) walk(join(dir, e.name), out)
      else if (['.ts', '.vue', '.mjs', '.js'].includes(extname(e.name))) out.push(p)
    }
    return out
  }

  it(`没有任何文件静态 import "${NATIVE_PACKAGE_NAME}"`, () => {
    const files = SCAN_DIRS.flatMap((d) => walk(d))
    assert.ok(files.length > 30, `扫描到的文件过少（${files.length}），路径可能不对`)

    const offenders: string[] = []
    for (const f of files) {
      let src: string
      try {
        src = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      // 静态导入的几种写法
      const patterns = [
        new RegExp(`import\\s+[^;]*from\\s+['"]${NATIVE_PACKAGE_NAME}['"]`),
        new RegExp(`import\\s+['"]${NATIVE_PACKAGE_NAME}['"]`),
        new RegExp(`export\\s+[^;]*from\\s+['"]${NATIVE_PACKAGE_NAME}['"]`)
      ]
      if (patterns.some((re) => re.test(src))) offenders.push(f.replace(ROOT, '.'))
    }

    assert.deepEqual(offenders, [], `以下文件静态导入了可选原生模块，会导致无模块环境打包失败：\n${offenders.join('\n')}`)
  })

  it('能力探针自身使用运行时 require（保证可 try/catch 降级）', () => {
    const src = readFileSync(join(ROOT, 'packages', 'native', 'capabilities.ts'), 'utf8')
    assert.ok(/require\(resolved\)/.test(src) || /require\(NATIVE_PACKAGE_NAME\)/.test(src), '应通过运行时 require 加载')
    assert.ok(!/^\s*import .*softgraph-native/m.test(src), '不得静态 import')
  })
})

describe('仓库完整性', () => {
  it('模块文件存在且导出了约定的公开接口', () => {
    const p = join(ROOT, 'packages', 'native', 'capabilities.ts')
    assert.equal(existsSync(p), true)
    assert.ok(statSync(p).size > 1000)
    const src = readFileSync(p, 'utf8')
    for (const name of [
      'loadNativeCapabilities',
      'getNativeModule',
      'describeCapabilities',
      'resetCapabilityCache',
      'NATIVE_PACKAGE_NAME',
      'FALLBACK_STRATEGY'
    ]) {
      assert.ok(src.includes(`export`) && src.includes(name), `缺少导出：${name}`)
    }
  })

  it('CI 工作流存在且包含关键步骤', () => {
    const ci = join(ROOT, '.github', 'workflows', 'ci.yml')
    assert.equal(existsSync(ci), true)
    const src = readFileSync(ci, 'utf8')
    for (const step of ['typecheck', 'npm test', 'npm run build']) {
      assert.ok(src.includes(step), `CI 缺少步骤：${step}`)
    }
  })
})
