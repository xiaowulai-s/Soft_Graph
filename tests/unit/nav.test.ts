import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NAV_MODULES, NAV_GROUPS, isNavId, navIconSvg } from '../../packages/shared/nav'

describe('v5.3 导航注册表', () => {
  it('恰好 13 个一级入口，id 唯一', () => {
    assert.equal(NAV_MODULES.length, 13)
    assert.equal(new Set(NAV_MODULES.map((m) => m.id)).size, 13)
  })

  it('13 个 id 清单固定（v5.3 新增 backup）', () => {
    assert.deepEqual(
      NAV_MODULES.map((m) => m.id),
      ['dashboard', 'graph', 'junk', 'startup', 'upgrade', 'registry', 'manifest', 'treemap', 'images', 'schedule', 'backup', 'market', 'settings']
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

  it('每个模块的图标都能渲染出非空 SVG（防注册表/图标表错位）', () => {
    for (const m of NAV_MODULES) {
      const svg = navIconSvg(m.icon)
      assert.ok(svg.includes('<svg') && svg.length > 40, `${m.id} 图标 ${m.icon} 渲染为空`)
    }
  })
})
