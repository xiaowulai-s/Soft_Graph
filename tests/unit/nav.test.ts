import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NAV_MODULES, isNavId } from '../../packages/shared/nav'

describe('v5.0 导航注册表', () => {
  it('恰好五区，顺序与 id 正确', () => {
    assert.deepEqual(
      NAV_MODULES.map((m) => m.id),
      ['dashboard', 'graph', 'junk', 'toolbox', 'settings']
    )
  })

  it('isNavId 覆盖五区并拒绝未知 id', () => {
    for (const m of NAV_MODULES) assert.ok(isNavId(m.id))
    assert.equal(isNavId('maintenance'), false, '旧维护中心 id 退役')
    assert.equal(isNavId('nope'), false)
  })

  it('每个模块都有图标与描述（活动栏 tooltip 依赖）', () => {
    for (const m of NAV_MODULES) {
      assert.ok(m.icon, `${m.id} 缺 icon`)
      assert.ok(m.desc.length >= 4, `${m.id} desc 过短`)
    }
  })
})
