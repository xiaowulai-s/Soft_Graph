import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NAV_MODULES, NAV_GROUPS, isNavId } from '../../packages/shared/nav'

describe('v5.2 导航注册表', () => {
  it('恰好 12 个一级入口，id 唯一', () => {
    assert.equal(NAV_MODULES.length, 12)
    assert.equal(new Set(NAV_MODULES.map((m) => m.id)).size, 12)
  })

  it('12 个 id 清单固定', () => {
    assert.deepEqual(
      NAV_MODULES.map((m) => m.id),
      ['dashboard', 'graph', 'junk', 'startup', 'upgrade', 'registry', 'manifest', 'treemap', 'images', 'schedule', 'market', 'settings']
    )
  })

  it('分组覆盖全部模块且组名合法', () => {
    const keys = new Set(NAV_GROUPS.map((g) => g.key))
    for (const m of NAV_MODULES) assert.ok(keys.has(m.group), `${m.id} 分组非法`)
    assert.ok(isNavId('startup') && isNavId('market'))
    assert.equal(isNavId('toolbox'), false, '工具箱 id 退役')
  })

  it('每个模块都有图标与描述', () => {
    for (const m of NAV_MODULES) {
      assert.ok(m.icon, `${m.id} 缺 icon`)
      assert.ok(m.desc.length >= 4, `${m.id} desc 过短`)
    }
  })
})
