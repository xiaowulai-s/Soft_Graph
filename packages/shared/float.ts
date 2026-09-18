/**
 * 浮窗多实例 · 设置规范化（v3.0.0 · F4）
 *
 * 为什么放在 shared 而不是主进程：
 *   这套逻辑有两类调用方 ——
 *     1) 主进程创建窗口前必须先规范化（保证坏数据不影响窗口创建）；
 *     2) 渲染层设置页要展示 / 编辑实例列表，需要「老配置折叠成单实例」的同一口径。
 *   两边各写一份必然会漂移（一边改了兜底规则另一边没改），因此提取为纯函数模块。
 *   本文件不依赖 electron，主进程的 float/window.ts 重新导出，保持原有导入路径可用。
 *
 * 向后兼容是硬要求：v2.0.0 及以前没有 instances 字段，必须折叠成一个默认实例，
 * 且逐字段与原地行为等价（由 tests/unit/float-instances.test.ts 钉死）。
 */

import type { FloatInstanceSettings, FloatSettings } from './types'

/** 主实例 id：老配置（没有 instances 字段）被折叠成这一个实例 */
export const DEFAULT_INSTANCE_ID = 'default'

/** 把顶层字段折叠成一个实例设置 —— 老配置（v2.0.0 及以前）的兼容路径 */
export function instanceFromLegacy(s: FloatSettings, id = DEFAULT_INSTANCE_ID): FloatInstanceSettings {
  return {
    id,
    plugins: [...(s.plugins ?? [])],
    x: s.x,
    y: s.y,
    width: s.width,
    opacity: s.opacity,
    theme: s.theme,
    clickThrough: s.clickThrough,
    compact: s.compact,
    lockPosition: s.lockPosition,
    autoHide: s.autoHide
  }
}

/**
 * 规范化实例列表：
 *   - 未配置 instances → 由顶层字段合成一个默认实例（单实例行为完全不变）
 *   - 配置了但为空数组 → 同上（用户删光了实例，当作回到单实例，而不是「一个都不显示」）
 *   - 过滤掉 id 缺失/重复的项，并补齐缺失字段（用默认实例的值兜底）
 *
 * 后两条是防呆：instances 是从磁盘读进来的用户数据，可能被手工编辑坏，
 * 规范化必须发生在它影响窗口创建之前。
 */
export function normalizeInstances(s: FloatSettings): FloatInstanceSettings[] {
  const list = Array.isArray(s.instances) ? s.instances : []
  const base = instanceFromLegacy(s)
  if (list.length === 0) return [base]

  const seen = new Set<string>()
  const out: FloatInstanceSettings[] = []
  for (const raw of list) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      plugins: Array.isArray(raw.plugins) ? [...raw.plugins] : [...base.plugins],
      x: Number.isFinite(raw.x) ? raw.x : base.x,
      y: Number.isFinite(raw.y) ? raw.y : base.y,
      width: Number.isFinite(raw.width) ? raw.width : base.width,
      opacity: Number.isFinite(raw.opacity) ? raw.opacity : base.opacity,
      theme: raw.theme === 'dark' || raw.theme === 'light' || raw.theme === 'glass' ? raw.theme : base.theme,
      clickThrough: typeof raw.clickThrough === 'boolean' ? raw.clickThrough : base.clickThrough,
      compact: typeof raw.compact === 'boolean' ? raw.compact : base.compact,
      lockPosition: typeof raw.lockPosition === 'boolean' ? raw.lockPosition : base.lockPosition,
      autoHide: typeof raw.autoHide === 'boolean' ? raw.autoHide : base.autoHide
    })
  }
  return out.length > 0 ? out : [base]
}

/** 多实例下窗口需要区分「自己是谁」，用 URL query 传递比 IPC 握手更简单可靠 */
export function floatInstanceTarget(base: string, instanceId: string): string {
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}instance=${encodeURIComponent(instanceId)}`
}

/**
 * 生成一个不与现有实例冲突的新实例 id（F4-UI 新增实例用）。
 * 纯函数：把「ID 生成」从组件里拿出来，便于测试唯一性与可预期性。
 */
export function nextInstanceId(existing: { id: string }[]): string {
  const used = new Set(existing.map((i) => i.id))
  let n = existing.length + 1
  let id = `inst-${n}`
  while (used.has(id)) id = `inst-${++n}`
  return id
}
