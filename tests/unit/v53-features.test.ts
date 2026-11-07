/**
 * v5.3 功能特性测试：
 *   C2  winget 模块化（id 白名单 / 参数契约 / 退出码解读 / GBK 解码）
 *   N1  备份同步纯逻辑（只增不改不删决策 / 目标路径越界）
 *   A1  插件沙箱（隔离加载 / process 不可见 / 同步死循环超时 / require 白名单）
 *   S3b 插件 API v2（动作净化 / 数据项净化 / 我的应用卡）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isValidWingetId, upgradeArgs, interpretUpgradeExit, decodeConsoleOutput } from '../../apps/desktop/src/main/services/winget'
import { decideFile, resolveTargetPath } from '../../apps/desktop/src/main/services/backup'
import { loadPluginSandboxed } from '../../apps/desktop/src/main/float/plugin-sandbox'
import { sanitizeAction, sanitizeDatum } from '../../apps/desktop/src/main/float/registry'
import { BUILTIN_PLUGINS } from '../../apps/desktop/src/main/float/builtin'
import { formatBytes } from '../../packages/shared/util'
import type { PluginContext } from '../../apps/desktop/src/main/float/plugin-api'

// ───────────────── C2 winget 模块化 ─────────────────

describe('v5.3 C2 winget 模块化', () => {
  it('id 白名单：合法放行、非法拒绝', () => {
    assert.equal(isValidWingetId('Microsoft.VisualStudioCode'), true)
    assert.equal(isValidWingetId('7zip.7zip'), true)
    assert.equal(isValidWingetId('Git.Git_2.43'), true)
    assert.equal(isValidWingetId('a b'), false)
    assert.equal(isValidWingetId('x;rm'), false)
    assert.equal(isValidWingetId('..\\..\\evil'), false)
    assert.equal(isValidWingetId(''), false)
    assert.equal(isValidWingetId(undefined as unknown as string), false)
  })

  it('静默升级参数契约锁定（回归：与 v3.1 文本版逐字一致）', () => {
    assert.deepEqual(upgradeArgs('Git.Git'), [
      'upgrade',
      '--id',
      'Git.Git',
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity'
    ])
  })

  it('退出码解读：成功 / 失败+提权探测 / 输出截尾 4000', () => {
    assert.deepEqual(interpretUpgradeExit(0, ''), { ok: true, needsElevation: false, output: '' })
    const r = interpretUpgradeExit(1, '需要管理员权限才能安装')
    assert.equal(r.ok, false)
    assert.equal(r.needsElevation, true)
    const eng = interpretUpgradeExit(0x8a15 & 0xff ? 1 : 1, 'exit code: 0x8a15')
    assert.equal(eng.needsElevation, true)
    const big = interpretUpgradeExit(1, 'x'.repeat(9000))
    assert.ok(big.output!.length <= 4000)
  })

  it('GBK 控制台输出解码', () => {
    // 「软件」的 GBK 字节
    const gbk = Buffer.from([0xc8, 0xed, 0xbc, 0xfe])
    assert.equal(decodeConsoleOutput(gbk), '软件')
    assert.equal(decodeConsoleOutput(Buffer.from('hello')), 'hello')
  })
})

// ───────────────── N1 备份同步 ─────────────────

describe('v5.3 N1 备份纯逻辑', () => {
  it('decideFile：只增不改不删 —— 目标存在且不同一律 conflict，绝不覆盖', () => {
    assert.equal(decideFile(false, 100, 1e12, 0, 0), 'copy')
    assert.equal(decideFile(true, 100, 1e12, 100, 1e12), 'skip')
    assert.equal(decideFile(true, 100, 1e12, 100, 1e12 + 1000), 'skip', 'mtime 差 1s 内视为同文件')
    assert.equal(decideFile(true, 100, 1e12, 200, 1e12), 'conflict')
    assert.equal(decideFile(true, 100, 1e12, 100, 1e12 + 60_000), 'conflict')
  })

  it('resolveTargetPath：正常映射 + 越界拦截', () => {
    const r = resolveTargetPath('E:\\bk', 'dev', 'C:\\work\\app', 'C:\\work\\app\\src\\a.ts')
    assert.ok(r.ok)
    const p = r.path!.toLowerCase()
    assert.ok(p.startsWith('e:\\bk\\dev\\'), `目标应落在任务目录内：${p}`)
    assert.ok(p.endsWith('src\\a.ts'))
    // 源在源根之外 → 拒绝
    const bad = resolveTargetPath('E:\\bk', 'dev', 'C:\\work\\app', 'C:\\Windows\\system32\\evil.dll')
    assert.equal(bad.ok, false)
  })

  it('resolveTargetPath：任务名非法字符被替换（不产生子目录逃逸）', () => {
    const r = resolveTargetPath('E:\\bk', 'a/../b', 'C:\\w', 'C:\\w\\x.txt')
    assert.ok(r.ok)
    assert.ok(!r.path!.includes('..'))
  })
})

// ───────────────── A1 插件沙箱 ─────────────────

describe('v5.3 A1 插件沙箱', () => {
  const HOST: PluginContext = {
    formatBytes,
    app: {
      junkTotalBytes: () => 0,
      junkOneClickBytes: () => 0,
      quarantineCount: () => 0,
      softwareCount: () => 0,
      lastJunkScanAt: () => null,
      recentApps: () => []
    },
    state: new Map(),
    log: () => {},
    psJson: (() => Promise.resolve(null)) as PluginContext['psJson']
  }

  it('正常插件在沙箱中加载并采集（跨上下文数组可读）', async () => {
    const src = `module.exports = {
      manifest: { id: 't.ok', name: 'ok', description: 'x', interval: 1000, view: 'metric', icon: 'i', version: '1.0.0' },
      collect(ctx) {
        const n = ctx.app.softwareCount()
        return [{ label: 'a', value: String(n + 1), ratio: 50, tone: 'good' }]
      }
    }`
    const r = loadPluginSandboxed(src)
    assert.ok(r.ok && r.plugin && r.sandbox)
    const data = (await Promise.race([r.sandbox!.call('collect', HOST), new Promise<never>((_, j) => setTimeout(() => j(new Error('timeout')), 5000))])) as { label: string; value: string }[]
    assert.ok(Array.isArray(data))
    assert.equal(data[0].value, '1')
  })

  it('插件内看不到 process / Buffer / require 宿主对象', () => {
    const r = loadPluginSandboxed(`module.exports = { manifest: { id: 't.x', name: 'x', description: 'x', interval: 1000, view: 'text', icon: 'i', version: '1.0.0' } }`)
    assert.ok(r.ok && r.sandbox)
    void r
    // 顶层就访问 process 的插件 → 加载即失败（ReferenceError）
    const evil = loadPluginSandboxed('process.exit(1); module.exports = { manifest: {} }')
    assert.equal(evil.ok, false)
    assert.ok((evil.error ?? '').includes('沙箱'))
  })

  it('collect 同步死循环被沙箱超时打断（不会卡死主进程）', async () => {
    const src = `module.exports = {
      manifest: { id: 't.loop', name: 'loop', description: 'x', interval: 1000, view: 'text', icon: 'i', version: '1.0.0' },
      collect() { while (true) {} }
    }`
    const r = loadPluginSandboxed(src)
    assert.ok(r.ok && r.sandbox)
    await assert.rejects(
      () => r.sandbox!.call('collect', HOST, 800),
      /超时|timed? ?out|同步执行/i
    )
  })

  it('require 白名单：path/os/url 放行，fs 等拒绝', async () => {
    const okSrc = `const path = require('node:path'); module.exports = {
      manifest: { id: 't.p', name: 'p', description: 'x', interval: 1000, view: 'text', icon: 'i', version: '1.0.0' },
      collect() { return [{ label: 'sep', value: typeof path.join }] }
    }`
    const ok = loadPluginSandboxed(okSrc)
    assert.ok(ok.ok, ok.error)
    const badSrc = `const fs = require('node:fs'); module.exports = {
      manifest: { id: 't.f', name: 'f', description: 'x', interval: 1000, view: 'text', icon: 'i', version: '1.0.0' }
    }`
    const bad = loadPluginSandboxed(badSrc)
    assert.equal(bad.ok, false)
    assert.ok((bad.error ?? '').includes('白名单'))
  })
})

// ───────────────── S3b 插件 API v2 ─────────────────

describe('v5.3 S3b 点击动作净化', () => {
  it('sanitizeAction：kind 白名单 / url 仅 https / 超限拒绝', () => {
    assert.deepEqual(sanitizeAction({ kind: 'open-path', target: 'C:\\a\\x.exe' }), { kind: 'open-path', target: 'C:\\a\\x.exe' })
    assert.deepEqual(sanitizeAction({ kind: 'open-url', target: 'https://example.com' }), { kind: 'open-url', target: 'https://example.com' })
    assert.equal(sanitizeAction({ kind: 'open-url', target: 'http://example.com' }), undefined, '明文 http 拒绝')
    assert.equal(sanitizeAction({ kind: 'open-url', target: 'file:///C:/x' }), undefined)
    assert.equal(sanitizeAction({ kind: 'exec', target: 'anything' }), undefined)
    assert.equal(sanitizeAction({ kind: 'open-path', target: '' }), undefined)
    assert.equal(sanitizeAction({ kind: 'open-path', target: 'x'.repeat(3000) }), undefined)
    assert.equal(sanitizeAction(null), undefined)
    assert.equal(sanitizeAction('str'), undefined)
  })

  it('sanitizeDatum：只保留白名单字段，vm 产物不透传', () => {
    const d = sanitizeDatum({ label: 'l', value: 'v', ratio: 42, hint: 'h', tone: 'good', action: { kind: 'open-path', target: 'C:\\x' }, evil: 'strip-me', get hack() { return 1 } })
    assert.ok(d)
    assert.deepEqual(Object.keys(d as unknown as Record<string, unknown>).sort(), ['action', 'hint', 'label', 'ratio', 'tone', 'value'])
    assert.equal(sanitizeDatum({ label: 1, value: 'v' }), null)
    assert.equal(sanitizeDatum(null), null)
    // label/value 截断
    const long = sanitizeDatum({ label: 'x'.repeat(500), value: 'y'.repeat(500) })
    assert.equal((long as { label: string }).label.length, 120)
  })

  it('内置「我的应用」卡：数据带 open-path 动作，空数据有引导文案', () => {
    const apps = BUILTIN_PLUGINS.find((p) => p.manifest.id === 'sg.apps')
    assert.ok(apps, 'sg.apps 插件缺失')
    const ctx: PluginContext = {
      formatBytes,
      app: {
        junkTotalBytes: () => 0,
        junkOneClickBytes: () => 0,
        quarantineCount: () => 0,
        softwareCount: () => 0,
        lastJunkScanAt: () => null,
        recentApps: (n) => [{ name: 'App A', path: 'C:\\a\\a.exe' }, { name: 'App B', path: 'C:\\b\\b.exe' }].slice(0, n ?? 8)
      },
      state: new Map(),
      log: () => {},
      psJson: (() => Promise.resolve(null)) as PluginContext['psJson']
    }
    const data = apps.collect(ctx) as { label: string; action?: { kind: string; target: string } }[]
    assert.equal(data.length, 2)
    assert.equal(data[0].action?.kind, 'open-path')
    assert.equal(data[0].action?.target, 'C:\\a\\a.exe')
    // 每个动作都能过净化（保证上线数据合规）
    for (const d of data) assert.ok(sanitizeAction(d.action))
    const empty = BUILTIN_PLUGINS.find((p) => p.manifest.id === 'sg.apps')!.collect({ ...ctx, app: { ...ctx.app, recentApps: () => [] } } as PluginContext) as { value: string }[]
    assert.equal(empty.length, 1)
    assert.ok(empty[0].value.includes('暂无'))
  })

  it('默认启用列表含我的应用', () => {
    const { DEFAULT_ENABLED } = require('../../apps/desktop/src/main/float/builtin') as { DEFAULT_ENABLED: string[] }
    assert.ok(DEFAULT_ENABLED.includes('sg.apps'))
  })
})
