# SoftGraph UI 重设计规范 · 冷调玻璃（Cool Glass）

> v5.0.0 设计基准 · 浅色优先，暗色为伴生主题 · 由「像素君 / UI Designer」出品
> 状态：**设计稿已确认方向（C），待最终确认后实施**

## 0. 设计决策记录

| 决策点 | 结论 |
|---|---|
| 动机 | 整体推翻重来（视觉 + 布局 + 交互） |
| 用户 | 极客自用，效率与信息密度优先，接受快捷键学习成本 |
| 骨架 | 左侧活动栏（VS Code 式），每视图自带上下文工具条 |
| IA | 大胆重构：三视图 → 仪表盘 / 图谱 / 清理 / 工具箱 / 设置 五区 + Ctrl+K |
| 首页 | 仪表盘（指标卡 + 快捷动作 + 最近动态） |
| 主题 | **浅色优先**精心设计，暗色为伴生适配 |
| 视觉方向 | C 冷调玻璃：冷白底 / 青蓝强调 / 细描边 / 分隔线列表（密度上限） |

## 1. 设计令牌（theme.css v2）

### 浅色（基准）

```css
:root {
  /* 表面 */
  --bg: #F2F7FA;            /* 页面底 */
  --surface: #FFFFFF;       /* 面板 / 侧栏 / 卡片 */
  --surface-2: #F7FAFC;     /* 次级填充（输入框、hover 行） */
  --canvas: #FBFDFE;        /* 图谱画布底 */

  /* 边框 —— 极细 0.5px 是本风格的签名 */
  --border: #B5D4F4;
  --border-soft: #DCE9F2;
  --border-hair: #EDF3F8;   /* 列表分隔线 */

  /* 文字（冷调三阶） */
  --text-1: #042C53;        /* 标题 / 主文（近海军蓝） */
  --text-2: #3B556B;        /* 次级 */
  --text-3: #888780;        /* 提示 / 占位 */

  /* 强调 */
  --accent: #0F6E56;        /* 主动作（青蓝绿） */
  --accent-soft: #E1F5EE;   /* 选中底 / 主按钮 hover 底 */
  --accent-2: #185FA5;      /* 链接 / 信息 / Ctrl K 徽标 */

  /* 语义（浅色底上加深一档保对比度） */
  --success: #3B6D11;
  --warning: #854F0B;
  --danger: #A32D2D;

  /* 形状与动效 */
  --radius-s: 6px; --radius-m: 8px; --radius-l: 14px;
  --dur-fast: 120ms; --dur: 200ms;
}
```

### 暗色（伴生）

```css
:root[data-theme='dark'] {
  --bg: #0E1620;
  --surface: #16202C;
  --surface-2: #1C2836;
  --canvas: #101B26;
  --border: #24384C;
  --border-soft: #1E3040;
  --border-hair: #1A2836;
  --text-1: #DCE8F2;
  --text-2: #93A8BC;
  --text-3: #5F7488;
  --accent: #2DD4BF;
  --accent-soft: #0E2B26;
  --accent-2: #60A5FA;
  --success: #4ADE80; --warning: #FBBF24; --danger: #F87171;
}
```

## 2. 字体与字阶

| 用途 | 规格 |
|---|---|
| UI 主字体 | system-ui 栈（Segoe UI Variable 优先） |
| **数字 / 路径 / 版本号** | 等宽（Cascadia Mono / JetBrains Mono）—— 极客签名，仪表盘大数字、列表元信息、路径一律等宽 |
| 页面标题 | 15px / 500 |
| 正文 / 列表 | 13px / 400 |
| 辅助 / 占位 | 12px / 400 |
| 卡内大数字 | 17–19px / 500 等宽 |

## 3. 布局刻度

- 间距 4pt 网格（4/8/12/16/24）
- 活动栏宽 **54px**（图标 36px 圆角块，激活态 = accent 填充白图标）
- 图谱三栏：150 / flex / 152（列表可折叠）
- 卡片圆角 10px，面板圆角 14px，按钮 6–8px

## 4. 组件状态清单

| 组件 | 状态 |
|---|---|
| 按钮 | primary（accent 填充）/ secondary（白底细描边）/ ghost（无框）；hover 加深 8%；focus-visible 2px accent 外圈 |
| 列表行 | 默认无底色 + hairline 分隔；hover = surface-2；选中 = accent-soft + 左侧 2px accent 条 |
| 复选框 | 勾选 = accent 填充；禁用 = border-soft（浏览器运行中跳过项） |
| 状态点 | 8px 圆点：签名/健康 = success，警告 = warning，危险/缺失 = danger，中性 = text-3 |
| 输入框 | surface-2 底 + 0.5px border；聚焦 = accent 描边 + 2px accent-soft 外圈 |
| 命令面板 | 居中 640px 白面板，顶部输入 + 分组结果（功能/软件/设置），↑↓ 选择 Enter 执行 |
| Toast | 底部居中，surface 底 + 左侧 3px 语义色条 |
| 空态 | 居中 text-3 + 一个 ghost 动作按钮 |

**无障碍基线**：text-1/bg ≈ 13.9:1，text-2/bg ≈ 7.8:1，白字/accent ≈ 5.6:1——全部超 WCAG AA；焦点环永不删除；键盘可达（活动栏 Ctrl+1..5、全局 Ctrl+K、Esc 关闭弹层）。

## 5. 五视图规格

1. **仪表盘**（默认）：问候行 + 4 指标卡（磁盘可释放 / 待升级 / 自启动 / 隔离区，点击直达对应视图）+ 快捷动作排（一键清理 / 重新扫描 / 升级全部 / 空间树图）+ 最近动态流（审计日志驱动的彩色状态点行）
2. **图谱**：三栏（筛选列表 / d3 画布 / 检查器）。检查器集中签名、依赖、归属与全部动作（▶ 启动应用为 primary）。画布节点色 = 冷调青绿梯度，缺失依赖红虚线；选中节点白描边 + 检查器联动
3. **清理**：单列任务流 —— 合计卡置顶 → 分类行（风险点 + 复选框 + mono 体积）→ 特殊工具入口（大文件/重复/空目录折叠）→ **主按钮置底**（清理已勾选 N 项）
4. **工具箱**：行式列表页 —— 每行 = 工具名 + 状态摘要 + 计数徽标 + ▸（自启动 / 升级 / 注册表 / 相似图片 / 插件市场 / 规则供给 / 定时调度）。行级直达，二级页沿用同列表语言
5. **设置**：分节表单（主题 / 浮窗 / 备份 / 规则源 / 关于），复用列表行 + 输入规范

## 6. 实施映射（v5.0.0）

| 层 | 动作 |
|---|---|
| `theme.css` | 令牌全量替换（浅基准 + 暗伴生），旧 Teal 变量名保留别名一版防遗漏 |
| `nav.ts` | 注册表重写为五区（dashboard/graph/junk/toolbox/settings），Ctrl+K 面板作为第 6 个"虚拟模块" |
| 新组件 | `ActivityBar.vue` / `DashboardHome.vue` / `CommandPalette.vue` / `ToolboxView.vue` |
| 迁移 | MaintenanceCenter 页面模式 → 拆入工具箱各行；SettingsDrawer → 设置视图；JunkSidebar 仪表盘卡 → 清理视图头部 |
| 回退 | Ctrl+K + Esc 交互全部走既有 IPC，零后端改动；旧 🧰/⟳ 浮层退役 |
