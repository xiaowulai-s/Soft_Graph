/** v6.2.3 侧栏平铺顺序：13 项、无分组、设置最末。 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DM_FLAT_ORDER, NAV_MODULES } from '../../packages/shared/nav'

describe('DM_FLAT_ORDER', () => {
  it('13 项，仪表盘第一、设置最末', () => {
    assert.equal(DM_FLAT_ORDER.length, 13)
    assert.equal(DM_FLAT_ORDER[0], 'dm-dashboard')
    assert.equal(DM_FLAT_ORDER[DM_FLAT_ORDER.length - 1], 'dm-settings')
  })

  it('无重复入口', () => {
    assert.equal(new Set(DM_FLAT_ORDER).size, DM_FLAT_ORDER.length)
  })

  it('工具 id 均来自导航注册表，备份同步排在设置之前', () => {
    assert.ok(DM_FLAT_ORDER.indexOf('dm-groups') < DM_FLAT_ORDER.indexOf('dm-settings'))
    for (const id of DM_FLAT_ORDER.filter((x) => !x.startsWith('dm-'))) {
      assert.ok(NAV_MODULES.some((m) => m.id === id), `未知入口 ${id}`)
    }
  })

  it('按功能域排序：软件域早于空间域、空间域早于系统域', () => {
    const at = (id: string): number => DM_FLAT_ORDER.indexOf(id)
    assert.ok(at('graph') < at('treemap'))
    assert.ok(at('treemap') < at('schedule'))
    assert.ok(at('schedule') < at('dm-groups'))
  })
})
