/**
 * 导航模块注册表（v3.4）：顶栏导航由本表驱动 —— 未来新功能**追加条目即可**入导航，
 * 不需要改动 App.vue 骨架。定位随功能演进（软件全生命周期管理），不再锁死单一叙事。
 */
export interface NavModule {
  id: string
  title: string
  icon: string
  desc: string
}

export const NAV_MODULES: NavModule[] = [
  { id: 'graph', title: '软件图谱', icon: '◈', desc: '认知：装了什么 · 文件属于谁 · 依赖关系' },
  { id: 'junk', title: '垃圾清理', icon: '🧹', desc: '行动：扫描发现文件 → 清理' },
  { id: 'maintenance', title: '维护中心', icon: '🧰', desc: '管理：软件升级 · 隔离区 · 相似图片 · 注册表 · 规则' }
]

/** 校验 mainView 合法性（防注册表遗漏导致白屏） */
export function isNavId(id: string): boolean {
  return NAV_MODULES.some((m) => m.id === id)
}
