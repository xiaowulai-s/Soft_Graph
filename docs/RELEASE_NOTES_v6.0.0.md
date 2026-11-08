# SoftGraph v6.0.0 —— 世代改版：Tailwind CSS v4 + shadcn-vue + Linear 系视觉

发布日期：2026-11-08

## 视觉世代升级（用户定稿：Linear 浅色 · 舒适密度 · 8px 圆角）

### 设计系统
- **接入 Tailwind CSS v4**（@tailwindcss/vite，CSS-first 配置）+ **shadcn-vue 组件体系**（cva 变体 + cn() 工具 + 语义色令牌桥接）
- 主题令牌全量重写为 **Linear 系**：浅色基准（冷灰底 `#f7f8fa` + 纯白面板 + 发丝描边 + accent 松绿 `#0f6e56`），深色伴生（`#0d1017` + 青荧 `#2dd4bf`）
- shadcn 语义色（--color-primary/card/muted/border…）通过 `@theme inline` 桥接到既有令牌 —— **浅深主题随 `data-theme` 自动切换**，全部组件自适应
- theme.css 包进 `@layer base`：Tailwind utilities 层可正确覆盖基样式（修复无层级样式压过层级样式的级联陷阱）
- 自定义 `dark` 变体挂 `data-theme='dark'`，与既有主题切换机制无缝

### 组件库（components/ui/）
- 新增 shadcn-vue 核心组件：**Button**（6 变体 × 4 尺寸）、**Card**（含 hoverable 微升变体）、**Badge**（6 变体含 success/warning）、**Input**、**Separator**
- 统一规格：8px 圆角、发丝边、`ring` 焦点环、150ms 缓动 —— 解决界面不齐、风格漂移

### 重制页面
- **侧栏**：190px、`--side` 独立底色、品牌渐变标、淡胶囊 active（Tailwind 重写）
- **仪表盘**：shadcn Card 重制 —— 指标卡（悬停微升）+ **磁盘概览**（盘符占用条，绿/黄/红分级）+ 快捷动作双栏 + 常用软件 + 系统动态（Badge 化）
- **备份同步**：shadcn 样板页 —— 状态 Badge 化（运行中/暂停/完成/错误/拔盘）、表单/任务卡/日志全面对齐
- 顶栏/状态栏发丝分隔、logo 统一渐变方块

## 质量

- 单元测试 **517/517 通过**，类型检查全绿
- 真机 CDP 截图验收：浅/深主题仪表盘、空间树图、垃圾清理、备份同步、图谱、插件市场

## 升级

5.x → 6.0.0：「设置 → 关于」→ 检查更新。视觉为纯渲染层改造，数据与功能零变化。
