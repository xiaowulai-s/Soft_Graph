/**
 * 浮窗插件契约（模块二：插件化架构）
 *
 * 设计目标：新增一个监控项 = 新增一个插件文件，主程序零改动。
 *
 * 插件形态（外部插件为 CommonJS 模块）：
 *   module.exports = {
 *     manifest: { id, name, description, interval, view, icon, version, author },
 *     setup?: (ctx) => void | Promise<void>,      // 可选：注册长期采集器
 *     collect: (ctx) => FloatPluginDatum[] | Promise<FloatPluginDatum[]>,
 *     dispose?: () => void
 *   }
 *
 * 视图类型（view）决定渲染模板：
 *   metric — 单值/多值指标行
 *   gauge  — 环形进度（取第一项的 ratio）
 *   bars   — 多条水平进度（每项 ratio）
 *   list   — 名称 + 值列表
 *   text   — 纯文本行
 */

import type { FloatPluginDatum, FloatPluginManifest } from '@shared/types'

export interface PluginContext {
  /** 工具函数，避免插件重复实现 */
  formatBytes(bytes: number, digits?: number): string
  /** 只读的应用数据访问（垃圾统计、隔离区等） */
  app: {
    junkTotalBytes(): number
    junkOneClickBytes(): number
    quarantineCount(): number
    softwareCount(): number
    lastJunkScanAt(): number | null
  }
  /** 供插件缓存跨轮次状态（如上一次的计数器值） */
  state: Map<string, unknown>
  /** 记录日志（写入主进程控制台，便于插件调试） */
  log(...args: unknown[]): void
  /** 执行 PowerShell 并取 JSON（重量级，插件应自行控制频率） */
  psJson<T>(script: string, timeoutMs?: number): Promise<T>
}

export interface FloatPlugin {
  manifest: FloatPluginManifest
  setup?(ctx: PluginContext): void | Promise<void>
  collect(ctx: PluginContext): FloatPluginDatum[] | Promise<FloatPluginDatum[]>
  dispose?(): void
}

export function defineManifest(m: Omit<FloatPluginManifest, 'builtin'> & { builtin?: boolean }): FloatPluginManifest {
  return { builtin: false, ...m }
}
