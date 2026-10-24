# SoftGraph v4.0.0 —— 自启动管理（生命周期闭环）

> 路线图：功能灵感地图（docs/13）组合 C 的第一项 S1 落地。软件生命周期
> 「安装 → 升级 → **自启** → 清理 → 卸载」从此完整。

## 新功能：自启动管理（维护中心 → 自启动）

- **多源枚举**：注册表 Run / RunOnce（HKCU + HKLM）+ 启动文件夹（当前用户 / 所有用户），
  一键列出全部开机自启项
- **每项显示**：名称、来源标签（HKCU:Run / StartupFolder:AllUsers …）、完整命令、
  **签名状态色点**（绿=已签名含发布者 / 灰=未签名 / amber=未知）、目标文件是否缺失
- **可逆启停**：禁用 = 移入 `AutorunsDisabled`（与 Sysinternals Autoruns 完全兼容，
  随时恢复）；启用 = 移回原位。HKLM 项自动弹 UAC
- **安全观感**：目标文件已缺失的残留启动项一眼可见

## 说明

- v1 范围对齐 fancyStart（Run 键 + 启动文件夹）；计划任务/服务/WMI 深源
  （BootLens 风格 562 项级别）列入 v4.1 候选
- 新增 shared/startup.ts 纯函数（命令行 exe 解析 / 来源判定）+ 3 组单测

## 下载

| 文件 | 说明 |
|---|---|
| SoftGraph-Setup-4.0.0.exe | 安装版（推荐） |
| SoftGraph-4.0.0-portable.exe | 便携版 |

测试 **494/494** 全绿。校验值见 SHA256SUMS.txt。
