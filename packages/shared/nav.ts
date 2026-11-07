/**
 * 导航模块注册表 v5.0：活动栏五区由本表驱动 —— 新功能追加条目即可入导航。
 * 仪表盘（默认首页）/ 软件图谱 / 清理 / 工具箱 / 设置。
 */
export interface NavModule {
  id: string
  title: string
  icon: string
  desc: string
  /** 二级导航（可选，v5 未启用，保留扩容机制） */
  children?: NavModule[]
}

export const NAV_MODULES: NavModule[] = [
  { id: 'dashboard', title: '仪表盘', icon: 'home', desc: '系统概览 · 快捷动作 · 最近动态' },
  { id: 'graph', title: '软件图谱', icon: 'graph', desc: '认知：装了什么 · 文件属于谁 · 依赖关系' },
  { id: 'junk', title: '清理', icon: 'funnel', desc: '行动：扫描发现文件 → 勾选 → 隔离清理' },
  { id: 'toolbox', title: '工具箱', icon: 'case', desc: '自启动 · 升级 · 注册表 · 相似图片 · 插件市场 · 规则' },
  { id: 'settings', title: '设置', icon: 'gear', desc: '主题 · 浮窗 · 备份 · 规则源 · 关于' }
]

/** 校验 mainView 合法性（防注册表遗漏导致白屏） */
export function isNavId(id: string): boolean {
  return NAV_MODULES.some((m) => m.id === id)
}

/**
 * 活动栏 SVG 线性图标（v5.0 重设计）：统一 24 viewBox / 1.7px 圆头描边 / currentColor。
 * 与 nav.module.icon 的 id 对应；由 ActivityBar 以 v-html 内联渲染。
 */
export const NAV_ICONS: Record<string, string> = {
  home: '<path d="M3.8 10.6 12 4l8.2 6.6"/><path d="M6.1 9.4V19.4h11.8V9.4"/><path d="M10 19.4v-5h4v5"/>',
  graph: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="8.6" r="2.6"/><circle cx="10" cy="18" r="2.6"/><path d="M8.5 6.9l7 .8M7.1 8.3l2 7.3M16.8 10.7l-5.4 5.3"/>',
  funnel: '<path d="M4 5h16l-6.2 7.1v6.3l-3.6-2.3v-4z" stroke-linejoin="round"/>',
  case: '<rect x="4" y="8.2" width="16" height="11" rx="2.2"/><path d="M9.2 8V6.3a1.3 1.3 0 0 1 1.3-1.3h3a1.3 1.3 0 0 1 1.3 1.3V8M4 13.2h16"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
}

/** 生成内联 SVG（ActivityBar 用）；统一描边规格，颜色随 currentColor */
export function navIconSvg(id: string, size = 18): string {
  const body = NAV_ICONS[id] ?? ''
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}
