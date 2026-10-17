# SoftGraph v3.0.2 —— 规则更新全自动连接

一个聚焦的小版本：把「AI 工具缓存」链路收尾到零配置。

## 两个新规则上线（随规则包 v4 自动送达）

- **GC-16 AI IDE 缓存**：Trae / Cursor / Windsurf / WorkBuddy / Qoder / ZCode / Codeium 的 Electron 缓存族与应用日志（Cache / Code Cache / GPUCache / CachedData / CachedExtensionVSIXs / Crashpad / Service Worker 缓存 / logs）。实测单机命中 556 项 / 411MB
- **GC-14 回归本位**：本地模型工具缓存（HuggingFace / ModelScope / LM Studio / ComfyUI / conda）
- 明确不碰：extensions、workspaceStorage、会话（登录态）、binaries/plugins

## 规则在线更新：全自动

- **更新源留空 = 自动连接**：默认官方源，raw 失败自动切 jsDelivr 国内镜像，全部失败才报错（并提示尝试了几个源）
- 下载走 Electron net（系统代理生效）
- 签名公钥内置，Ed25519 验签 + SHA-256 + 版本单调 + 防毒丸结构校验，任何一步失败都不触碰现有规则

## 升级体验修复

- 旧版规则文件会永久遮蔽内置新规则 —— 现在启动时自动合并（只追加、保留用户自定义、幂等），升级即得新规则

## 下载

| 文件 | 说明 |
|---|---|
| SoftGraph-Setup-3.0.2.exe | 安装版（NSIS 向导） |
| SoftGraph-3.0.2-portable.exe | 便携版，免安装单文件 |

校验值见附件 SHA256SUMS.txt。测试 470/470 全绿。

> 未做代码签名（正式证书办理中），SmartScreen 提示选「仍要运行」。
