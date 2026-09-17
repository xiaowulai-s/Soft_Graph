/**
 * 浮窗多实例 · 设置规范化（v3.0.0 · F4）
 *
 * instances 是从磁盘读进来的用户数据，可能被手工编辑坏（缺字段、重复 id、
 * 非法主题）。规范化发生在它影响窗口创建之前，所以这个套件重点覆盖
 * 「坏数据不能让程序崩或让用户看不到浮窗」。
 *
 * 同时钉死向后兼容：v2.0.0 及以前的配置没有 instances 字段，
 * 必须被折叠成一个默认实例，行为与单实例完全一致。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeInstances,
  instanceFromLegacy,
  floatInstanceTarget,
  DEFAULT_INSTANCE_ID
} from '../../apps/desktop/src/main/float/window'
import type { FloatSettings } from '@shared/types'

function legacy(over: Partial<FloatSettings> = {}): FloatSettings {
  return {
    enabled: true,
    plugins: ['sys.cpumem', 'sys.clock'],
    x: 100,
    y: 200,
    width: 260,
    opacity: 0.96,
    autoHide: true,
    peekSize: 6,
    theme: 'dark',
    clickThrough: false,
    alwaysOnTop: true,
    compact: false,
    lockPosition: false,
    ...over
  }
}

describe('单实例兼容（老配置）', () => {
  it('instanceFromLegacy 把顶层字段折叠成一个实例', () => {
    const inst = instanceFromLegacy(legacy())
    assert.equal(inst.id, DEFAULT_INSTANCE_ID)
    assert.deepEqual(inst.plugins, ['sys.cpumem', 'sys.clock'])
    assert.equal(inst.x, 100)
    assert.equal(inst.y, 200)
    assert.equal(inst.theme, 'dark')
  })

  it('等价性：合成出的实例覆盖回全局设置后，与原设置逐字段相同', () => {
    // 这是「单实例行为不变」的数学保证 —— manager 内部用 {...global, ...instance}
    // 合成有效设置，若某个字段在折叠过程中变了，老用户的浮窗就会悄悄变形
    const g = legacy({ theme: 'glass', compact: true, lockPosition: true, clickThrough: true })
    const merged = { ...g, ...instanceFromLegacy(g) } as FloatSettings
    for (const k of [
      'plugins',
      'x',
      'y',
      'width',
      'opacity',
      'theme',
      'clickThrough',
      'compact',
      'lockPosition',
      'autoHide'
    ] as const) {
      assert.deepEqual(merged[k], g[k], `${k} 不应在折叠过程中改变`)
    }
    // 实例字段之外的全局字段也保持不变
    assert.equal(merged.enabled, g.enabled)
    assert.equal(merged.peekSize, g.peekSize)
    assert.equal(merged.alwaysOnTop, g.alwaysOnTop)
  })

  it('没有 instances 字段 → 一个默认实例', () => {
    const out = normalizeInstances(legacy())
    assert.equal(out.length, 1)
    assert.equal(out[0].id, DEFAULT_INSTANCE_ID)
  })

  it('instances 是空数组 → 仍然一个默认实例（不能变成「一个都不显示」）', () => {
    const out = normalizeInstances(legacy({ instances: [] }))
    assert.equal(out.length, 1)
    assert.equal(out[0].id, DEFAULT_INSTANCE_ID)
  })
})

describe('多实例', () => {
  it('两个合法实例被保留，插件组合各自独立', () => {
    const out = normalizeInstances(
      legacy({
        instances: [
          {
            id: 'left',
            plugins: ['sys.cpumem'],
            x: 10,
            y: 20,
            width: 200,
            opacity: 1,
            theme: 'light',
            clickThrough: false,
            compact: true,
            lockPosition: true,
            autoHide: false
          },
          {
            id: 'right',
            plugins: ['sys.network', 'sys.topproc'],
            x: 1200,
            y: 20,
            width: 300,
            opacity: 0.8,
            theme: 'glass',
            clickThrough: true,
            compact: false,
            lockPosition: false,
            autoHide: true
          }
        ]
      })
    )
    assert.equal(out.length, 2)
    assert.deepEqual(out[0].plugins, ['sys.cpumem'])
    assert.equal(out[0].theme, 'light')
    assert.equal(out[0].compact, true)
    assert.deepEqual(out[1].plugins, ['sys.network', 'sys.topproc'])
    assert.equal(out[1].clickThrough, true)
    assert.equal(out[1].x, 1200)
  })

  it('缺 id / 重复 id 的项被过滤，正常的保留', () => {
    const out = normalizeInstances(
      legacy({
        instances: [
          { id: '', plugins: [] } as never,
          { id: 'a', plugins: ['sys.clock'] } as never,
          { id: 'a', plugins: ['sys.disk'] } as never,
          { id: '  b  ', plugins: [] } as never
        ]
      })
    )
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((i) => i.id), ['a', 'b'])
    // 先出现的那条胜出，重复项被丢弃
    assert.deepEqual(out[0].plugins, ['sys.clock'])
  })

  it('条目内的缺失/非法字段用默认实例兜底，而不是留 undefined', () => {
    const out = normalizeInstances(
      legacy({
        instances: [
          {
            id: 'partial',
            plugins: 'not-an-array',
            x: Number.NaN,
            width: undefined,
            theme: 'rainbow',
            opacity: 'x'
          } as never
        ]
      })
    )
    const i = out[0]
    assert.deepEqual(i.plugins, ['sys.cpumem', 'sys.clock'], 'plugins 非法时回退到默认组合')
    assert.equal(i.x, 100)
    assert.equal(i.width, 260)
    assert.equal(i.theme, 'dark', '非法主题回退到默认')
    assert.equal(i.opacity, 0.96)
  })

  it('全部条目都非法 → 回退到默认实例（保证至少有一个浮窗）', () => {
    const out = normalizeInstances(legacy({ instances: [{ id: '' } as never] }))
    assert.equal(out.length, 1)
    assert.equal(out[0].id, DEFAULT_INSTANCE_ID)
  })
})

describe('实例 id 交给渲染层', () => {
  it('URL 与文件路径都能带上 instance 参数', () => {
    assert.equal(floatInstanceTarget('http://localhost:5173/float.html', 'left'), 'http://localhost:5173/float.html?instance=left')
    assert.equal(floatInstanceTarget('http://x/float.html?a=1', 'right'), 'http://x/float.html?a=1&instance=right')
  })

  it('id 会被转义（避免 query 注入）', () => {
    assert.ok(floatInstanceTarget('http://x/f', 'a&b=c').includes('instance=a%26b%3Dc'))
  })
})
