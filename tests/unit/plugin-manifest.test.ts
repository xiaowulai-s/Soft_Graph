/**
 * F1+F2 插件清单校验 / 权限授权 / 一键安装 测试
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManifest, extractManifest } from '../../apps/desktop/src/main/float/plugin-manifest'
import { PluginApprovals } from '../../apps/desktop/src/main/float/approvals'
import { PluginRegistry, type RegistryHost } from '../../apps/desktop/src/main/float/registry'

function goodManifest(): Record<string, unknown> {
  return {
    id: 'vendor.tool',
    name: '测试插件',
    description: '用于测试的插件',
    interval: 3000,
    view: 'metric',
    icon: 'plugin',
    version: '1.0.0',
    author: 'tester'
  }
}

function pluginSource(manifest: Record<string, unknown>, collectBody = 'return []'): string {
  return `module.exports = { manifest: ${JSON.stringify(manifest)}, collect(ctx) { ${collectBody} } }`
}

const HOST: RegistryHost = {
  junkTotalBytes: () => 0,
  junkOneClickBytes: () => 0,
  quarantineCount: () => 0,
  softwareCount: () => 0,
  lastJunkScanAt: () => null,
  psJson: async () => [] as never
}

describe('F1 validateManifest（schema 校验）', () => {
  it('合法清单通过，无权限声明', () => {
    const r = validateManifest(goodManifest())
    assert.equal(r.ok, true)
    assert.deepEqual(r.permissions, [])
  })

  it('合法权限声明去重返回', () => {
    const r = validateManifest({ ...goodManifest(), permissions: ['fs', 'network', 'fs'] })
    assert.equal(r.ok, true)
    assert.deepEqual(r.permissions, ['fs', 'network'])
  })

  it('未知能力声明被拒绝（防拼写 / 防越权字段）', () => {
    for (const p of ['shell', 'admin', 'FS', 'process']) {
      const r = validateManifest({ ...goodManifest(), permissions: [p] })
      assert.equal(r.ok, false, `应拒绝 ${p}`)
    }
  })

  it('id 格式：必须 vendor.name 小写点分段', () => {
    for (const id of ['tool', 'Vendor.Tool', 'a.b.c.d.e', '9bad.x', 'x..y']) {
      assert.equal(validateManifest({ ...goodManifest(), id }).ok, false, `应拒绝 ${id}`)
    }
  })

  it('interval / view / version 字段约束', () => {
    assert.equal(validateManifest({ ...goodManifest(), interval: -1 }).ok, false)
    assert.equal(validateManifest({ ...goodManifest(), interval: 1.5 }).ok, false)
    assert.equal(validateManifest({ ...goodManifest(), interval: 3_600_001 }).ok, false)
    assert.equal(validateManifest({ ...goodManifest(), view: 'iframe' }).ok, false)
    assert.equal(validateManifest({ ...goodManifest(), version: '1.0' }).ok, false)
  })

  it('非对象 / 缺字段全部拒绝', () => {
    assert.equal(validateManifest(null).ok, false)
    assert.equal(validateManifest('x').ok, false)
    assert.equal(validateManifest({}).ok, false)
  })
})

describe('F1 extractManifest（vm 沙箱提取，不执行插件代码）', () => {
  it('正常提取', () => {
    const r = extractManifest(pluginSource(goodManifest()))
    assert.equal(r.ok, true)
    assert.equal((r.manifest as { id: string }).id, 'vendor.tool')
  })

  it('沙箱内没有 require/process —— 顶层摸系统的代码直接失败', () => {
    const evil = `
      const fs = require('fs')           // 应抛错：require 未定义
      module.exports = { manifest: ${JSON.stringify(goodManifest())}, collect() { return [] } }
    `
    const r = extractManifest(evil)
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /require|执行出错/)
  })

  it('顶层 process 探测也被拦截', () => {
    const evil = `const h = process.env; module.exports = { manifest: ${JSON.stringify(goodManifest())}, collect(){return[]} }`
    assert.equal(extractManifest(evil).ok, false)
  })

  it('超长源码 / 空源码拒绝', () => {
    assert.equal(extractManifest('').ok, false)
    assert.equal(extractManifest('x'.repeat(300 * 1024)).ok, false)
  })
})

describe('F1+F2 Registry 全流程（安装 → 待授权 → 授权 → 删除）', () => {
  it('无权限插件：安装即可用', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-plug-'))
    try {
      const reg = new PluginRegistry(dir, HOST, join(dir, '..', 'appr.json'))
      await reg.load()
      const r = await reg.installSource(pluginSource(goodManifest()), 'test')
      assert.equal(r.ok, true)
      const list = reg.manifests()
      const mine = list.find((p) => p.id === 'vendor.tool')
      assert.ok(mine)
      assert.deepEqual(mine.permissions, [])
      assert.deepEqual(mine.pendingPermissions, [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('带权限插件：安装后待授权、不参与调度；授权后可调度', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-plug-'))
    const apprFile = join(dir, '..', `appr-${Date.now()}.json`)
    try {
      const reg = new PluginRegistry(dir, HOST, apprFile)
      await reg.load()
      const m = { ...goodManifest(), permissions: ['fs', 'network'] }
      const r = await reg.installSource(pluginSource(m, 'return [{ label: "x", value: "1" }]'), 'test')
      assert.equal(r.ok, true)
      assert.deepEqual(r.permissions, ['fs', 'network'])

      // 待授权态：pending 非空，tick 跳过
      let mine = reg.manifests().find((p) => p.id === 'vendor.tool')
      assert.ok(mine)
      assert.deepEqual(mine.pendingPermissions, ['fs', 'network'])
      let out = await reg.tick(['vendor.tool'], true)
      assert.equal(out.length, 0, '未授权时不应采集')

      // 授权部分能力 → 仍待授权
      await reg.approvePermissions('vendor.tool', ['fs'])
      mine = reg.manifests().find((p) => p.id === 'vendor.tool')
      assert.deepEqual(mine?.pendingPermissions, ['network'])

      // 授权全部 → 可采集
      await reg.approvePermissions('vendor.tool', ['network'])
      mine = reg.manifests().find((p) => p.id === 'vendor.tool')
      assert.deepEqual(mine?.pendingPermissions, [])
      out = await reg.tick(['vendor.tool'], true)
      assert.equal(out.length, 1)
      assert.equal(out[0].data[0].label, 'x')

      // 授权已持久化：新实例读同一文件 → 无需再授权
      const reg2 = new PluginRegistry(dir, HOST, apprFile)
      await reg2.load()
      assert.deepEqual(reg2.manifests().find((p) => p.id === 'vendor.tool')?.pendingPermissions, [])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(apprFile, { force: true })
    }
  })

  it('安装校验失败不落盘；id 冲突拒绝；删除外部插件成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-plug-'))
    try {
      const reg = new PluginRegistry(dir, HOST, join(dir, '..', 'appr.json'))
      await reg.load()

      // 坏 manifest：不写入任何文件
      const bad1 = await reg.installSource(pluginSource({ ...goodManifest(), id: 'BAD ID' }))
      assert.equal(bad1.ok, false)
      // 顶层抛错：不写入
      const bad2 = await reg.installSource("require('fs'); module.exports={manifest:1}")
      assert.equal(bad2.ok, false)
      const files = await readdir(dir)
      // 目录里会有注册表写入的示例插件 example-hello.js，只统计安装产物
      assert.equal(files.filter((f) => f.endsWith('.js') && f !== 'example-hello.js').length, 0, '校验失败不应产生文件')

      // 正常安装
      const ok1 = await reg.installSource(pluginSource(goodManifest()))
      assert.equal(ok1.ok, true)

      // id 冲突
      const dup = await reg.installSource(pluginSource(goodManifest()))
      assert.equal(dup.ok, false)
      assert.match(dup.error ?? '', /已存在/)

      // installFromUrl：拒绝非 https
      const http = await reg.installFromUrl('http://example.com/x.js')
      assert.equal(http.ok, false)

      // 删除外部插件 → 文件消失、授权记录清除
      const rmR = await reg.removeExternal('vendor.tool')
      assert.equal(rmR.ok, true)
      const after = await readdir(dir)
      assert.equal(after.filter((f) => f === 'vendor.tool.js').length, 0)
      assert.ok(!reg.manifests().some((p) => p.id === 'vendor.tool'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('安装失败的插件回滚文件（collect 缺失被加载器拒绝）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-plug-'))
    try {
      const reg = new PluginRegistry(dir, HOST, join(dir, '..', 'appr.json'))
      await reg.load()
      // 有 manifest 无 collect → load 后被拒 → 应回滚
      const src = `module.exports = { manifest: ${JSON.stringify(goodManifest())} }`
      const r = await reg.installSource(src)
      assert.equal(r.ok, false)
      const files = await readdir(dir)
      assert.equal(files.filter((f) => f.includes('vendor.tool')).length, 0, '应回滚已写文件')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('Approvals 独立持久化与撤销', async () => {
    const f = join(tmpdir(), `sg-appr-${Date.now()}.json`)
    try {
      const a = new PluginApprovals(f)
      await a.load()
      assert.deepEqual(a.approvedFor('x.y'), [])
      await a.approve('x.y', ['fs'])
      assert.deepEqual(a.pendingFor('x.y', ['fs', 'network']), ['network'])

      const b = new PluginApprovals(f)
      await b.load()
      assert.deepEqual(b.approvedFor('x.y'), ['fs'])
      await b.revoke('x.y')
      assert.deepEqual(b.approvedFor('x.y'), [])

      // 授权文件内容可读（审计友好）
      const a2 = new PluginApprovals(f)
      await a2.load()
      await a2.approve('x.y', ['powershell'])
      const raw = JSON.parse(await readFile(f, 'utf8'))
      assert.ok(raw['x.y'].approvedAt > 0)
    } finally {
      await rm(f, { force: true })
    }
  })
})
