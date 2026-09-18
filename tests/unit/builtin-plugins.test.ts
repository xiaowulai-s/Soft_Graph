/**
 * 浮窗内置插件单元测试（v3.0.0 · G2 覆盖率补测）
 *
 * builtin.ts 是全部内置插件的集合体，此前**零覆盖** ——
 * 它只在 Electron 主进程里被 registry 驱动，测试链路从来没碰过。
 * 这里用最小 PluginContext 直接驱动每个插件的 collect，验证：
 *   1. 每个插件都能产出符合契约的数据（label 非空、ratio 在 0~100）
 *   2. 跨轮次状态（CPU 差分、网络速率差分、专注计时）在首轮/次轮行为正确
 *   3. 采集源不可用时的降级文案不会出现 undefined / NaN
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import { BUILTIN_PLUGINS, DEFAULT_ENABLED } from '../../apps/desktop/src/main/float/builtin'
import type { PluginContext } from '../../apps/desktop/src/main/float/plugin-api'

function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

interface CtxOpts {
  state?: Map<string, unknown>
  psJson?: PluginContext['psJson']
  app?: Partial<PluginContext['app']>
}

function makeCtx(opts: CtxOpts = {}): PluginContext {
  return {
    formatBytes,
    app: {
      junkTotalBytes: () => 0,
      junkOneClickBytes: () => 0,
      quarantineCount: () => 0,
      softwareCount: () => 0,
      lastJunkScanAt: () => null,
      ...(opts.app || {})
    },
    state: opts.state ?? new Map<string, unknown>(),
    log: () => {},
    psJson: opts.psJson ?? (async () => ({}) as never)
  }
}

const byId = (id: string) => {
  const p = BUILTIN_PLUGINS.find((x) => x.manifest.id === id)
  assert.ok(p, `应存在内置插件 ${id}`)
  return p!
}

describe('浮窗内置插件 · 清单完整性', () => {
  it('全部插件都具备合法清单', () => {
    assert.equal(BUILTIN_PLUGINS.length, 12)
    const ids = new Set<string>()
    for (const p of BUILTIN_PLUGINS) {
      const m = p.manifest
      assert.ok(/^[a-z0-9]+\.[a-z0-9-]+$/.test(m.id), `id 形如 vendor.name：${m.id}`)
      assert.ok(!ids.has(m.id), `id 不重复：${m.id}`)
      ids.add(m.id)
      assert.ok(m.name.length > 0)
      assert.ok(m.interval > 0 && m.interval <= 3_600_000)
      assert.ok(['metric', 'gauge', 'bars', 'list', 'text'].includes(m.view))
      assert.equal(m.builtin, true)
    }
  })

  it('默认启用集合里的 id 都真实存在', () => {
    const ids = new Set(BUILTIN_PLUGINS.map((p) => p.manifest.id))
    for (const id of DEFAULT_ENABLED) assert.ok(ids.has(id), `默认启用的 ${id} 应存在`)
  })
})

describe('浮窗内置插件 · collect 契约', () => {
  it('每个插件都能产出非空数据且字段合法', async () => {
    for (const p of BUILTIN_PLUGINS) {
      const ctx = makeCtx({ psJson: async () => ({ rx: 1000, tx: 500 }) as never })
      const data = await p.collect(ctx)
      assert.ok(Array.isArray(data), `${p.manifest.id} 应返回数组`)
      assert.ok(data.length > 0, `${p.manifest.id} 不应返回空数组`)
      for (const d of data) {
        assert.ok(typeof d.label === 'string' && d.label.length > 0, `${p.manifest.id} label 非空`)
        assert.ok(typeof d.value === 'string' && d.value.length > 0, `${p.manifest.id} value 非空`)
        // 任何降级文案都不能带 undefined / NaN —— 那是直接暴露给用户的
        assert.ok(!/undefined|NaN/.test(d.value), `${p.manifest.id} value 不应含 undefined/NaN：${d.value}`)
        if (d.ratio !== undefined) {
          assert.ok(Number.isFinite(d.ratio), `${p.manifest.id} ratio 应为有限数`)
          assert.ok(d.ratio >= 0 && d.ratio <= 100, `${p.manifest.id} ratio 应在 0~100：${d.ratio}`)
        }
      }
    }
  })

  it('CPU 插件：首轮无基线时给出 0%，次轮有差分', async () => {
    const p = byId('sys.cpumem')
    const state = new Map<string, unknown>()
    const first = await p.collect(makeCtx({ state }))
    const cpu1 = first.find((d) => d.label === 'CPU')
    assert.ok(cpu1)
    // 首轮没有上一帧快照，无法算差分 —— 必须是 0% 而不是 NaN
    assert.equal(cpu1!.ratio, 0)
    const second = await p.collect(makeCtx({ state }))
    const cpu2 = second.find((d) => d.label === 'CPU')
    assert.ok(Number.isFinite(cpu2!.ratio))
  })

  it('网络插件：首轮采样中，次轮出速率；PowerShell 不可用时降级', async () => {
    const p = byId('sys.network')
    const state = new Map<string, unknown>()
    const okPs = async () => ({ rx: 2_000_000, tx: 1_000_000 }) as never

    const first = await p.collect(makeCtx({ state, psJson: okPs }))
    assert.ok(first.some((d) => d.value.includes('采样中')), '首轮应提示采样中')

    // 次轮：计数器增长 1MB / 0.5MB，时间差被钳到最小 0.5s
    const second = await p.collect(makeCtx({ state, psJson: async () => ({ rx: 3_000_000, tx: 1_500_000 }) as never }))
    assert.ok(second.some((d) => d.label.includes('下载')))
    for (const d of second) assert.ok(!/NaN|undefined/.test(d.value))

    // 采集源不可用：必须有降级文案且 tone 为 warn
    const down = await p.collect(makeCtx({ state: new Map(), psJson: async () => { throw new Error('PS 不可用') } }))
    assert.ok(down.length > 0)
    assert.equal(down[0].tone, 'warn')
  })

  it('磁盘插件：无可用盘符时给出兜底文案', async () => {
    const p = byId('sys.disk')
    const data = await p.collect(makeCtx())
    assert.ok(data.length > 0)
    for (const d of data) assert.ok(!/NaN|undefined/.test(d.value))
  })

  it('时钟插件：输出包含星期与合法时间', async () => {
    const p = byId('sys.clock')
    const data = await p.collect(makeCtx())
    const text = data.map((d) => d.value).join(' ')
    assert.ok(/周[一二三四五六日]/.test(text), `应含星期：${text}`)
    assert.ok(!/NaN|undefined/.test(text))
  })

  it('垃圾与概览插件：读取 app 数据并正确格式化', async () => {
    const app = {
      junkTotalBytes: () => 3_221_225_472,
      junkOneClickBytes: () => 1_073_741_824,
      quarantineCount: () => 12,
      softwareCount: () => 318,
      lastJunkScanAt: () => Date.now()
    }
    for (const id of ['sg.junk', 'sg.overview']) {
      const data = await byId(id).collect(makeCtx({ app }))
      assert.ok(data.length > 0)
      for (const d of data) assert.ok(!/NaN|undefined/.test(d.value))
    }
  })

  it('进程 TOP 插件：PowerShell 返回异常时仍给出可用输出', async () => {
    const p = byId('sys.topproc')
    const bad = await p.collect(makeCtx({ psJson: async () => { throw new Error('PS 失败') } }))
    assert.ok(Array.isArray(bad))
    for (const d of bad) assert.ok(!/NaN|undefined/.test(d.value))
  })

  it('CPU 占用 TOP：按核数归一化，且非有限值不冒 NaN', async () => {
    const p = byId('sys.topcpu')
    const cores = Math.max(1, os.cpus().length)

    // 计数器以「单核 = 100%」计量：给满核数倍应显示 100%
    const full = await p.collect(
      makeCtx({ psJson: async () => [{ name: 'busy', cpu: cores * 100 }] as never })
    )
    assert.equal(full[0].value, '100.0%')
    assert.equal(full[0].ratio, 100)

    // 取到一半核数 → 占整机 50%
    const half = await p.collect(makeCtx({ psJson: async () => [{ name: 'half', cpu: cores * 50 }] as never }))
    assert.equal(half[0].value, '50.0%')

    // 脏数据（NaN / 缺字段）必须归 0，不能把 NaN 直接印到浮窗上
    const dirty = await p.collect(
      makeCtx({ psJson: async () => [{ name: 'weird', cpu: null }, { name: '', cpu: 5 }] as never })
    )
    assert.equal(dirty.length, 1, 'name 为空的条目应被过滤')
    assert.equal(dirty[0].value, '0.0%')
    for (const d of dirty) assert.ok(!/NaN|undefined/.test(d.value))

    // 采集源不可用 → 降级文案
    const bad = await p.collect(makeCtx({ psJson: async () => { throw new Error('PS 失败') } }))
    assert.equal(bad[0].value, '不可用')
    assert.equal(bad[0].tone, 'warn')
  })
})

describe('浮窗内置插件 · F3 新增项', () => {
  it('温度插件：传感器不可用时明说「未暴露」，绝不显示 0°C', async () => {
    const p = byId('sys.temp')
    const none = await p.collect(makeCtx({ psJson: async () => ({ temp: null, fan: null }) as never }))
    assert.equal(none[0].label, '温度')
    assert.equal(none[0].value, '本机未暴露')
    assert.equal(none[0].tone, 'warn')

    // 取到读数时按温度分级
    const hot = await p.collect(makeCtx({ psJson: async () => ({ temp: 92, fan: 2400 }) as never }))
    assert.equal(hot[0].value, '92°C')
    assert.equal(hot[0].tone, 'danger')
    assert.ok(hot.some((d) => d.label === '风扇' && d.value.includes('RPM')))

    // 采集抛异常也要有降级文案
    const err = await p.collect(makeCtx({ psJson: async () => { throw new Error('PS 失败') } }))
    assert.equal(err[0].value, '本机未暴露')
  })

  it('电池插件：无电池 / 低电量 / 充电中三态', async () => {
    const p = byId('sys.battery')
    const none = await p.collect(makeCtx({ psJson: async () => ({ percent: null, status: null }) as never }))
    assert.equal(none[0].value, '无电池')

    const low = await p.collect(makeCtx({ psJson: async () => ({ percent: 8, status: 1 }) as never }))
    assert.equal(low[0].value, '8%')
    assert.equal(low[0].tone, 'danger')
    assert.equal(low[0].hint, '放电中')

    const charging = await p.collect(makeCtx({ psJson: async () => ({ percent: 55, status: 6 }) as never }))
    assert.equal(charging[0].hint, '充电中')
    assert.equal(charging[0].tone, 'normal')
  })

  it('网络连接插件：总数与 TOP 进程，不可用时降级', async () => {
    const p = byId('sys.netconn')
    const ok = await p.collect(
      makeCtx({
        psJson: async () =>
          ({ total: 42, tops: [{ name: 'chrome', count: 20 }, { name: 'node', count: 5 }] }) as never
      })
    )
    assert.equal(ok[0].value, '42')
    assert.ok(ok.some((d) => d.label === 'chrome' && d.value === '20 条'))

    const bad = await p.collect(makeCtx({ psJson: async () => { throw new Error('PS 失败') } }))
    assert.equal(bad[0].tone, 'warn')
  })

  it('专注计时：首轮立起点，之后按间隔累加', async () => {
    const p = byId('sg.focus')
    const state = new Map<string, unknown>()

    const first = await p.collect(makeCtx({ state }))
    assert.equal(first[0].value, '0 分钟')

    // 模拟两次间隔 1 分钟的采集
    const rec = state.get('focus') as { ms: number; last: number }
    state.set('focus', { ms: rec.ms, last: rec.last - 60_000 })
    const second = await p.collect(makeCtx({ state }))
    assert.equal(second[0].value, '1 分钟')

    // 跨小时显示
    state.set('focus', { ms: 0, last: Date.now() - 95 * 60_000 })
    const long = await p.collect(makeCtx({ state }))
    assert.equal(long[0].value, '1 小时 35 分钟')
  })
})
