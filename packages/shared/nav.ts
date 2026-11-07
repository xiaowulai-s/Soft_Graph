/**
 * 导航模块注册表 v5.2：侧栏 12 个一级入口（图标 + 文本），按域分组。
 * 每个功能 = 独立页面；新功能追加条目即可入导航。
 */
export interface NavModule {
  id: string
  title: string
  icon: string
  desc: string
  /** 分组 key（侧栏分组标题） */
  group: 'core' | 'software' | 'space' | 'system'
}

export const NAV_GROUPS: { key: NavModule['group']; title: string }[] = [
  { key: 'core', title: '核心' },
  { key: 'software', title: '软件管家' },
  { key: 'space', title: '空间工具' },
  { key: 'system', title: '系统' }
]

export const NAV_MODULES: NavModule[] = [
  { id: 'dashboard', title: '仪表盘', icon: 'home', desc: '系统概览 · 快捷动作', group: 'core' },
  { id: 'graph', title: '软件图谱', icon: 'graph', desc: '装了什么 · 依赖关系', group: 'core' },
  { id: 'junk', title: '垃圾清理', icon: 'funnel', desc: '19 类规则扫描审阅', group: 'core' },
  { id: 'startup', title: '自启动管理', icon: 'power', desc: 'Run / 启动文件夹 启停', group: 'software' },
  { id: 'upgrade', title: '软件升级', icon: 'up', desc: 'winget 可升级列表', group: 'software' },
  { id: 'registry', title: '注册表残留', icon: 'database', desc: '卸载表死条目清理', group: 'software' },
  { id: 'manifest', title: '装机清单', icon: 'doc', desc: '导出 CSV / winget 脚本', group: 'software' },
  { id: 'treemap', title: '空间树图', icon: 'grid', desc: '目录占用可视化', group: 'space' },
  { id: 'images', title: '相似图片', icon: 'images', desc: 'aHash 分组查重', group: 'space' },
  { id: 'schedule', title: '定时调度', icon: 'clock', desc: '静默清理计划与状态', group: 'system' },
  { id: 'backup', title: '备份同步', icon: 'backup', desc: '开发文件夹 → 移动硬盘增量备份', group: 'system' },
  { id: 'market', title: '插件市场', icon: 'store', desc: '浮窗插件安装更新', group: 'system' },
  { id: 'settings', title: '设置', icon: 'gear', desc: '主题 · 浮窗 · 备份 · 规则', group: 'system' }
]

/** 校验 mainView 合法性（防注册表遗漏导致白屏） */
export function isNavId(id: string): boolean {
  return NAV_MODULES.some((m) => m.id === id)
}

/** 活动栏 SVG 线性图标：统一 24 viewBox / 1.7px 圆头描边 / currentColor */
export const NAV_ICONS: Record<string, string> = {
  home: '<path d="M3.8 10.6 12 4l8.2 6.6"/><path d="M6.1 9.4V19.4h11.8V9.4"/><path d="M10 19.4v-5h4v5"/>',
  graph: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="8.6" r="2.6"/><circle cx="10" cy="18" r="2.6"/><path d="M8.5 6.9l7 .8M7.1 8.3l2 7.3M16.8 10.7l-5.4 5.3"/>',
  funnel: '<path d="M4 5h16l-6.2 7.1v6.3l-3.6-2.3v-4z" stroke-linejoin="round"/>',
  power: '<path d="M12 4v8"/><path d="M6.3 7.2a8 8 0 1 0 11.4 0" stroke-linecap="round"/>',
  up: '<path d="M12 19V6"/><path d="M6.5 11.5 12 6l5.5 5.5"/><rect x="4.5" y="4" width="15" height="2.6" rx="1.3"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>',
  doc: '<rect x="5.5" y="4" width="13" height="16" rx="1.6"/><path d="M9 9h6M9 12.5h6M9 16h4"/>',
  grid: '<rect x="4.5" y="4.5" width="6.4" height="6.4" rx="1"/><rect x="13.1" y="4.5" width="6.4" height="6.4" rx="1"/><rect x="4.5" y="13.1" width="6.4" height="6.4" rx="1"/><rect x="13.1" y="13.1" width="6.4" height="6.4" rx="1"/>',
  images: '<rect x="4" y="6" width="11" height="13" rx="1.6"/><path d="M8 6V4.6A1.6 1.6 0 0 1 9.6 3h8.8A1.6 1.6 0 0 1 20 4.6v10.8a1.6 1.6 0 0 1-1.6 1.6H17"/><circle cx="8" cy="10" r="1.4"/><path d="M4.5 17l3.5-3.5 2.5 2.5 2-2 2.5 3"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2.2"/>',
  backup: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.6"/><path d="M4.5 5.5v6c0 1.4 3.4 2.6 7.5 2.6s7.5-1.2 7.5-2.6v-6"/><path d="M4.5 11.5v6c0 1.4 3.4 2.6 7.5 2.6s7.5-1.2 7.5-2.6v-6"/>',
  store: '<path d="M4.5 8.5h15l-1 11a1.8 1.8 0 0 1-1.8 1.6H7.3a1.8 1.8 0 0 1-1.8-1.6z"/><path d="M8.5 8.5V7a3.5 3.5 0 0 1 7 0v1.5"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  case: '<rect x="4" y="8.2" width="16" height="11" rx="2.2"/><path d="M9.2 8V6.3a1.3 1.3 0 0 1 1.3-1.3h3a1.3 1.3 0 0 1 1.3 1.3V8M4 13.2h16"/>'
}

/** 生成内联 SVG（ActivityBar 用）；统一描边规格，颜色随 currentColor */
export function navIconSvg(id: string, size = 18): string {
  const body = NAV_ICONS[id] ?? ''
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}
