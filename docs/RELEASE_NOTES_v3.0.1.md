# SoftGraph v3.0.1 —— AI 工具垃圾治理

一个聚焦的维护版本：针对「AI 工具用久了堆出一堆垃圾」这个真实痛点，新增两条专项规则，并激活规则在线更新链路。

## 新增规则（GC-14 / GC-15）

| 规则 | 定位 | 覆盖 |
|---|---|---|
| **GC-14 AI 工具缓存**（medium，默认不勾选） | 可再生内容清理 | HuggingFace hub、ModelScope hub、LM Studio 缓存、ComfyUI\temp、conda pkgs（.conda / miniconda3 / anaconda3） |
| **GC-15 AI 模型库盘点**（hint，**只盘点不删除**） | bigfile 算法 ≥50MB TOP 100 | Ollama models（含 blobs）、LM Studio models |

设计原则：**模型是不是垃圾只有用户能判断** —— 盘点规则永不自动勾选，程序只报告占用。

## 老用户升级体验修复

旧版把规则文件落地后**从不更新**（本地文件永久遮蔽内置新规则）。现在启动时会自动合并内置新增规则（只追加、保留用户自定义、幂等），升级即得 GC-14/15。

## 规则在线更新链路激活（E2）

- Ed25519 签名公钥固化进应用；规则包 v2 已发布（`packages/rules/dist/`）
- 设置 → 清理与安全 → 规则更新源，填入 `https://raw.githubusercontent.com/xiaowulai-s/Soft_Graph/main/packages/rules/dist`（国内镜像 `https://cdn.jsdelivr.net/gh/xiaowulai-s/Soft_Graph@main/packages/rules/dist`）后可在线收新规则
- 毒丸防线修复：裸 `*` 模式与根目录联合判定（伪造「扫 %USERPROFILE% 整树」的规则包会被结构校验拒绝）

## 其他

- `ensureRules` 升级合并 / `publish-rules.mjs --gen-keys` 参数解析修复
- 测试 **468/468** 全绿（新增毒丸防线 6 用例、规则合并 4 用例）

## 下载

| 文件 | 说明 |
|---|---|
| SoftGraph-Setup-3.0.1.exe | 安装版（NSIS 向导） |
| SoftGraph-3.0.1-portable.exe | 便携版，免安装单文件 |

校验值见附件 SHA256SUMS.txt。

> 未做代码签名（正式证书办理中），SmartScreen 提示选「仍要运行」。
