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
  { id: 'dashboard', title: '仪表盘', icon: '⌂', desc: '系统概览 · 快捷动作 · 最近动态' },
  { id: 'graph', title: '软件图谱', icon: '◈', desc: '认知：装了什么 · 文件属于谁 · 依赖关系' },
  { id: 'junk', title: '清理', icon: '🧹', desc: '行动：扫描发现文件 → 勾选 → 隔离清理' },
  { id: 'toolbox', title: '工具箱', icon: '🧰', desc: '自启动 · 升级 · 注册表 · 相似图片 · 插件市场 · 规则' },
  { id: 'settings', title: '设置', icon: '⚙', desc: '主题 · 浮窗 · 备份 · 规则源 · 关于' }
]

/** 校验 mainView 合法性（防注册表遗漏导致白屏） */
export function isNavId(id: string): boolean {
  return NAV_MODULES.some((m) => m.id === id)
}
