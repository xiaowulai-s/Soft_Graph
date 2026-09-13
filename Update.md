# Update — SoftGraph 变更记录与排期

> 维护约定：每次重大变更后更新；已完成项移入「已交付」，剩余项重新排期，新增项追加到对应阶段。

## 当前版本：v1.0.0（2026-09-11 发布）

首个可交付版本。依据《SoftGraph 软件图谱与磁盘清理工具 技术设计方案 V1.0》实现，
并新增需求「桌面浮窗监控（插件化）」。

- 仓库：https://github.com/xiaowulai-s/Soft_Graph
- 发布页：https://github.com/xiaowulai-s/Soft_Graph/releases/tag/v1.0.0
  - `SoftGraph-1.0.0-setup.exe`（85.36 MB，NSIS 安装包）
  - `SoftGraph-1.0.0-portable.exe`（85.14 MB，免安装便携版）
- Release 说明全文：`docs/RELEASE_NOTES_v1.0.0.md`

**下一版本**：v2.0.0（规划中）— 见 [`docs/06-v2.0.0-开发计划.md`](docs/06-v2.0.0-开发计划.md)
**当前待决策**：是否引入可选原生模块（决定 USN 增量 / Restart Manager / API Set 动态映射的实现路线）

---

## 已交付

### 阶段 P0 —— 工程骨架（✅ 完成）

| 项 | 内容 |
|---|---|
| P0-1 | 按文档附录 A 建立 monorepo 结构：`apps/desktop` + `packages/{shared,scanner,junk,graph-core,rules}` |
| P0-2 | electron-vite + Vue 3 + TS 双 tsconfig（node/web）构建链路，路径别名与文档目录一致 |
| P0-3 | SQLite 双驱动抽象（`node:sqlite` 优先，sql.js WASM 回退），8 张表 + 索引 |
| P0-4 | Preload `contextBridge` 白名单 + 全量 IPC 协议类型（对齐文档 6.3） |

### 阶段 P1 —— 软件发现与依赖内核（✅ 完成）

| 项 | 内容 |
|---|---|
| P1-1 | 五来源枚举（卸载项 / MSI / App Paths / Store / 服务），PowerShell 通道规避 GBK 乱码 |
| P1-2 | 便携软件七特征加权评分；用户手动标记持久化 |
| P1-3 | 纯 TS PE 解析器（导入表 / 延迟导入 / .NET 元数据 / SxS / 版本资源），惰性分页读取 |
| P1-4 | API Set 映射、KnownDLLs、WinSxS 重定向、WOW64 位数感知的 DLL 搜索路径 |
| P1-5 | 八类证据融合 + 置信度打分（含共享惩罚与冷启动基线） |
| P1-6 | 缺失依赖识别与修复建议（FR-16） |

### 阶段 P2 —— 图谱与垃圾治理（✅ 完成）

| 项 | 内容 |
|---|---|
| P2-1 | 径向分层布局（d3-force + 角度分散力），Web Worker 计算，坐标缓存 |
| P2-2 | SVG(≤1500)/Canvas(>1500) 双渲染、视口裁剪、标签 LOD、批量绘制 |
| P2-3 | 悬停七区块详情浮层（完整路径可复制）、右键菜单、导出 PNG |
| P2-4 | 13 类垃圾规则引擎（JSON 驱动、可热更新）+ 重复文件三级过滤 |
| P2-5 | 侧边栏环形图 + 分类列表 + 明细抽屉 + 三级确认删除流程 |
| P2-6 | 隔离区 + manifest + 还原 + 到期清理 |

### 阶段 P3 —— 桌面浮窗（新增需求，✅ 完成）

| 项 | 内容 |
|---|---|
| P3-1 | 无边框透明置顶浮窗，不占任务栏、不抢焦点 |
| P3-2 | 靠边吸附 + 自动隐藏 + peek 触发条 + 缓动滑出 |
| P3-3 | 插件化架构：外部 `plugins\*.js` 动态加载、热重载、错误隔离 |
| P3-4 | 内置 7 插件 + 设置面板（启用/排序/宽度/透明度/主题/紧凑/穿透/锁定） |

### 阶段 P4 —— 验证与打包（✅ 完成）

| 项 | 内容 |
|---|---|
| P4-1 | 内核冒烟测试（PE / 白名单 / 发现 / 依赖 / 垃圾） |
| P4-2 | CDP 真机端到端（扫描 → 图谱 → 悬停 → 右键 → 垃圾侧栏） |
| P4-3 | NSIS 安装包 + portable 免安装版 |
| P4-4 | README 与 docs/ 文档体系（需求对照 / 架构 / 插件 / 验证报告） |

---

## 真机验证缺陷修复记录

| 编号 | 缺陷 | 根因 | 状态 |
|---|---|---|---|
| BUG-01 | 222MB 单体 exe 导入表为空 | `MAX_PE_BYTES=64MB` 误拦 | ✅ 已修（惰性分页读取） |
| BUG-02 | 扫描后软件列表清零 | sql.js 事务嵌套 `BEGIN` | ✅ 已修（驱动层重入保护） |
| BUG-03 | KnownDLLs 读取失败 | `reg.exe` 被安全策略拦截 | ✅ 已修（改 PowerShell） |
| BUG-04 | 图谱构建分钟级 | E6 遍历上万 CLSID | ✅ 已修（默认关闭 E6） |

---

## v2.0.0 开发计划（规划中，待批准）

详细计划见 [`docs/06-v2.0.0-开发计划.md`](docs/06-v2.0.0-开发计划.md)。

v1.0.0 实测遗留的 14 项问题（I-01 ~ I-14）、7 条工作主线（A 性能 / B 原生能力 / C 稳定兼容 / D 体验 / E 安全交付 / F 浮窗生态 / G 工程化）与 6 个里程碑（M0 ~ M5，12+1 周）均已在该文档中量化规划。

此前 v1.0.0 阶段列出的 M1 ~ M5 事项已**全部并入**，对应关系：

| v1.0.0 计划项 | 并入 v2.0.0 后 |
|---|---|
| M1-1 PowerShell 采集并行化 + 图标懒加载 | A1 / A2 / A3 |
| M1-2 依赖解析缓存复用 | A6 / D1 |
| M1-3 垃圾扫描分片提速 | A4 |
| M2-1 USN Journal 增量 | B1（取决于「是否引入可选原生模块」这一关键决策） |
| M2-2 Restart Manager 占用检测 | B3 |
| M2-3 API Set 动态映射 | B5 |
| M3-1 Win10 / Win11 双基线回归 | C1 |
| M3-2 多语言 / 多账户路径 | C3 |
| M3-3 超大图谱压测 | C4 / D1 |
| M4-1 代码签名 | E1 |
| M4-2 规则库在线更新 | E2 |
| M4-3 自动化 UI 测试 | G1（CDP + Playwright 双轨） |
| M5-3 浮窗插件市场 | F2 |

**未纳入 v2.0.0、顺延至 v2.1 候选**：

| 项 | 顺延理由 |
|---|---|
| 注册表清理（文档二期能力） | 风险高于文件清理，需先完成审计日志（E4）与提权规范化（E3） |
| ETW 运行时依赖证据（E8） | 需管理员权限常驻，价值集中在小众场景 |
| Tauri 方案评估（文档 R7） | 先拿到 v2.0.0 的内存与体积数据再评估才有意义 |

**当前唯一待决策项**：是否为 USN/RM/API Set 引入可选原生模块 —— ✅ **已决策：采用双轨方案**（`optionalDependencies` + 运行时探测 + 缺失自动降级），详见计划文档第四章。

---

## v2.0.0 进展

### M0 备战（✅ 已完成 · 2026-09-12）

| 项 | 交付物 | 验证 |
|---|---|---|
| 性能基准 | `npm run bench` / `bench:quick` | 产出 `docs/benchmarks/baseline-*.md`，含与性能目标的逐项达标对照 |
| 单元测试 | `npm test`（esbuild + node:test，零新增依赖） | **174 用例 / 40 套件全绿** |
| 测试范围 | 安全白名单（含 fuzz）、置信度打分、路径与 glob、PE 解析、图谱构建与布局、规则库、原生能力探针 + 架构守护 | — |
| 样本库 | `npm run samples:collect` / `samples:verify` | 采集 **19 个**样本（x64/x86 EXE、DLL、.NET 汇编、零导入低层模块）；回归 **19/19 零漂移** |
| CI 骨架 | `.github/workflows/ci.yml` | typecheck → test → smoke → build → 上传产物；另有非阻塞快速基准 |
| 原生能力骨架 | `packages/native/capabilities.ts` | 探针 + 三项能力的降级策略表 + 诊断报告；架构守护用例禁止静态 import |

**M0 期间修复的缺陷（均由新写的测试与基准暴露）**

| 编号 | 缺陷 | 严重度 |
|---|---|---|
| BUG-05 | 环境变量缺失时规则根目录退化成 `\Temp` 这类盘根相对路径，会放大扫描范围 | 高 |
| BUG-06 | 零导入的系统低层模块（`ntdll.dll`、`KernelBase.dll`）被误判为「疑似加壳」 | 中 |
| BUG-07 | 共享运行库未按文档 5.3 默认成组，图谱噪声偏多 | 中 |
| BUG-08 | 图例「共享运行库」点击无效（伪类型未参与过滤） | 低 |
| BUG-09 | **用户库目录按英文名写死**：中文系统 / OneDrive / 重定向到其它盘时全部落空，GC-11 与 GC-12 静默失效 | 高 |
| BUG-10 | 规则多个根目录重叠时同一文件被统计两次 | 低 |

**M0 基准结论（`docs/benchmarks/baseline-2026-09-12.md`）**

| 指标 | v2.0.0 目标 | 实测 | 结论 |
|---|---|---|---|
| 软件清单枚举 | ≤ 6 s | 9.98 s | ⚠️ 未达标 → M1 主攻 |
| 全盘垃圾扫描 | ≤ 100 s | 106.81 s | ⚠️ 未达标 → M1 主攻 |
| 图谱缓存读取 | ≤ 400 ms | 1 ms | ✅ 达标 |

单机实测：319 个软件 / 垃圾 **32.78 GB · 24898 项**；其中 GC-12（62.6 s）、GC-11（23.6 s）、GC-08（11.9 s）为耗时前三，是 M1 优化的靶点。

> **BUG-09 修复的直接影响**：垃圾扫描可发现量从 v1.0.0 报告的 17.32 GB → **32.78 GB**。
> 差额来自此前从未被扫描的 D 盘用户库目录（文档/图片/桌面/视频/音乐），
> 说明修复前有近一半真实数据目录处于扫描盲区。

### M1 性能达标（🔄 进行中 · 2026-09-12 第一波完成）

| 项 | 内容 | 结果 |
|---|---|---|
| A1（部分） | PowerShell 常驻会话池：stdin 单行 base64 协议、池大小 2、崩溃自动重启、**超时不重跑不降级**、启动失败自动退回一次性路径（v1.0.0 行为兜底） | ✅ 稳态单次调用 4~57ms（原每次 0.3~0.6s 冷启动）；应用退出统一回收（`shutdownPsPool`） |
| A6（部分） | `walkRule` 目录级并发：信号量（默认 8，`SG_WALK_CONCURRENCY`）+ 同步预计数完成检测 + NaN 防御；运行器注入 `UV_THREADPOOL_SIZE=16` | ✅ GC-12 **62.6s → 16.3s（−74%）**、GC-11 23.6s → 9.7s（−59%）、GC-10 2.3s → 0.7s、GC-13 1.7s → 0.4s |
| 垃圾扫描合计 | 106.81s → **44.98s（−58%）** | ✅ **达标（≤100s）** |
| 软件发现 | 11.06s（目标 ≤6s） | ⏳ 未达标 —— 下一步：A2 图标懒加载、A3 便携目录 mtime 缓存 |
| 测试 | 新增 `tests/unit/junkwalk.test.ts`（并发/串行结果一致性、深度、过滤、取消、根文件） | 187 用例 / 43 套件全绿 |

**M1 第二波（同日完成，验收清单全绿）**

| 项 | 内容 | 结果 |
|---|---|---|
| 便携扫描并发化 | `scanPortable` 改 worker 池拉取共享 BFS 队列（并发 8）；`dirSize` 文件 stat 分块并行；**体积延迟补算**（评分不再无条件跑最贵的 dirSize，命中后才并行补算） | scanPortable 6.55s → 2.26s（−65%） |
| 已安装解析并发化 | `scanInstalled` 的 280 项 `findMainExe`（目录深度 2 遍历 + 逐 exe stat）与 Store 应用解析改 `mapPool` 并发池 | scanInstalled 1.45s → 0.50s（−65%） |
| 五来源枚举拆分并行 | CORE（4 个纯注册表来源）与 STORE（Get-AppxPackage）拆两个脚本，经会话池双会话并行；热会话 CORE 仅 141ms | 枚举 3.07s → 2.67s |
| **验收结论** | **软件发现 11.06s → 4.46s（✅ ≤6s）· 垃圾扫描 48.46s（✅ ≤100s）· 图谱缓存 1ms（✅）** | **v2.0.0 三项性能验收全绿** |

**M1 顺延项**（不在验收清单内或收益有限）：图标懒加载（A2，本就在 done 事件后执行不阻塞）、便携 mtime 缓存（A3，冷路径达标后降级为应用内二次扫描提速项）、依赖解析 worker 并行（12.8s，非验收项）。

### M2 原生能力（🔄 进行中 · 2026-09-13）

| 项 | 内容 | 结果 |
|---|---|---|
| **B3 占用检测** | `packages/junk/locks.ts`：PowerShell `Add-Type` P/Invoke 调 Restart Manager（RmStartSession/RmRegisterResources/RmGetList/RmEndSession），替代 v1.0.0 的「遍历所有进程模块列表」 | ✅ 真机验证：独立进程以 `FileShare.None` 持句柄期间精确查出 PID（appType=1），删除尝试 `EBUSY` 一致；释放后 0 条无误报 |
| **B2 重启后删除** | P/Invoke `MoveFileExW` + `MOVEFILE_DELAY_UNTIL_REBOOT`（目标路径用 `IntPtr` 重载表达 NULL）；校验 `PendingFileRenameOperations` | ✅ 非提权环境明确返回 `needsElevation`（Win32 错误 5）；接线至清理结果页「查占用 / 重启后删除」 |
| **B4 E6 证据默认开启** | `deps.ts`：COM 反查索引加 7 天磁盘缓存（0.41MB）+ 启动后台预热 + 并发共享同一次构建；`enableComEvidence` 由 false 改回 true | ✅ 新进程读缓存 **0.01s**（重建 1.60s，快 160 倍）；E6 边已产出（PotPlayer 等）；图谱构建仍 ≤3s |
| **A5 增量扫描** | `packages/junk/incremental.ts`：目录签名水位（目录 mtime + 条目数），未变则复用结果、仅重新 stat 命中项 | ✅ GC-11+GC-12 二次扫描 **45.2s → 15.6s（−65%）**，结果完全一致（429 项 / 21.49 GB） |

| **B1 USN 增量（第 1 级：卷哨兵）** | `packages/junk/usn.ts` + 缓存 `volumes` 字段：`fsutil usn queryjournal` 取卷级 `nextUsn`（**无需提权**），两次扫描间未变 ⇒ 整卷零写入 ⇒ 连目录签名遍历都跳过 | ✅ 实测：`GC-11:volume` 命中（D 盘静止）→ 三轮 38.7s / 30.0s / **10.8s（−72%）**，结果一致（429 项 / 21.49 GB） |
| B1 USN 增量（第 2 级：变更记录） | `readJournal` 读取变更路径，精确到目录级失效。**本机实测 `fsutil usn readjournal` 返回错误 5（需提权）**，因此实现完成后默认关闭，待提权环境验证 | ⏳ 待提权验证（解析器按中英文双套关键字 + 位置兜底） |

| **B5 API Set 动态映射** | `packages/scanner/apiset.ts`：不再靠静态前缀表猜宿主 —— 用 Windows **加载器**（`LoadLibraryW` + `GetModuleFileNameW`）探测每个 API set 的真实宿主，缓存 30 天；磁盘无占位文件的名字（全量 schema 约 700 条）由依赖解析按需补探；静态表降为未加载时的兜底 | ✅ 实测 112 条全部解析成功、宿主存在率 100%、缓存 1ms；**静态表 5 条抽样中 2 条猜错**（`api-ms-win-power-base` 猜 kernelbase 实为 **powrprof**、`processthreads` 猜 kernelbase 实为 **kernel32**），动态映射全部纠正 |

| **C2 扫描进程隔离与自愈** | `apps/desktop/src/main/workers/junk-scan-worker.ts` + `services/junk-worker.ts`：垃圾扫描跑在 Electron `utilityProcess`；主进程只收进度与摘要，**命中项走文件不过 IPC**（实测结果文件 7.4MB / 2.8 万条）；Worker 崩溃自动重启并**续扫**（缓存按规则落盘，节流 10s）；非 Electron 环境或连续崩溃自动回退进程内扫描 | ✅ 真机验证：扫描全程在 Worker 中执行（`tmp/junk-*.json` + `cache/junk-incremental.json` 均由 Worker 落盘）；**强杀 Worker 后触发「重启并续扫」，扫描最终完成**（28023 项 / 18.26 GB，事件 1128 条） |

**B5 的探索记录（为什么不用解析 ApiSetSchema.dll）**：实测该系统上 `ApiSetSchema.dll` 的 schema 为 header version=6，条目字段顺序与公开文档不符，穷举候选起点（步长/字段位置/24~32 字节记录）均无法得到自洽条目表；改为「问加载器」后 112/112 命中。

**B1 过程中修掉的缺陷**

| 编号 | 缺陷 | 严重度 |
|---|---|---|
| BUG-14 | `fsutil.exe` 用相对名依赖 PATH，本环境 PATH 为 MSYS 风格 → ENOENT 被 catch 吞掉，表现为「USN 静默不可用」 | 高 |
| BUG-15 | fsutil 输出走控制台代码页（中文系统 **GBK**），按 utf8 解码成乱码，关键字匹配必然失败 → 改 buffer + `TextDecoder('gbk')` | 高 |
| BUG-16 | 单元测试里 `if (!info) return` 的空断言，让 BUG-14/15 长期逃过测试 → 改为断言非空 | 高 |
| BUG-17 | 增量基线取「扫描开始时」的值，把整轮扫描窗口算进差异 → 哨兵几乎永不命中；改为取扫描结束时 | 中 |
| BUG-18 | 抖动目录（Temp/着色器缓存）导致「采签名 → 不匹配 → 仍全量扫」白付一次遍历（GC-12 约 10s，比全量还慢）→ 连续 2 次未命中熔断，强制重扫重置 | 中 |

**A5 的关键实测依据**：本机 `D:\下载`（5353 目录 / 39770 文件）—— 完整遍历 8.82s，仅 readdir 1.33s → **85% 的耗时来自逐文件 stat**。因此增量不是「跳过遍历」，而是**仍走 readdir 算签名、跳过逐文件 stat 与算法级处理**。

**A5 过程中修掉的缺陷**：`collectSignatures` 未套用 `walkRule` 的剪枝（`SKIP_DIR_NAMES` / `isScannable`），GC-12 要走 77261 个目录、18.4s，比它自己的完整扫描还慢；对齐剪枝后 50528 目录 / 10.0s。

**已知边界（已写入代码注释与 UI）**：
1. 目录内文件被**原地覆写**时不改目录 mtime → 该分类在 TTL（3 天）内可能沿用旧结果；UI 提供「强制重扫」按钮与 `force` 通道绕过缓存
2. `%USERPROFILE%` 下的 `Temp` / 着色器缓存目录持续写入（实测每轮 3 个目录变化），会使其所属分类无法命中缓存 —— 这是 USN（B1）才能真正解决的场景

**M1 第一波过程中发现并修复的缺陷**

| 编号 | 缺陷 | 严重度 |
|---|---|---|
| BUG-11 | 并发遍历完成检测的竞态：根任务 `stat` 期间 `pending` 短暂为 0 会被误判为「已全部完成」；改为根任务同步预计数 | 高（挂起类） |
| BUG-12 | 会话池请求超时会触发一次性路径重跑，长脚本（180s 枚举）超时后耗时翻倍；超时错误与会话崩溃错误分离，超时绝不重跑 | 高 |
| BUG-13 | `process.env.X = undefined` 在 Node 中写入字符串 `"undefined"`，`Number()` 得 NaN 使信号量 `active < NaN` 恒假 → 并发遍历死锁；引擎侧加 `Number.isFinite` 兜底 | 高（挂起类） |

### M3 兼容与交付（🔄 进行中 · 2026-09-13）

> 按用户指示，**C1 双基线回归暂缓**（需要 Win10 测试机），其余项照常推进。

| 项 | 内容 | 结果 |
|---|---|---|
| **C5 本地诊断包** | `services/logger.ts`（结构化 JSONL 日志，**写入前脱敏**、批量落盘、7 天轮转、单文件 8MB 上限）+ `services/diagnostics.ts`（收集环境/设置/能力/统计/隔离区摘要/规则摘要/最近日志）+ `services/zip.ts`（**零依赖** store 模式 ZIP 写入器） | ✅ 真机验证见下 |
| **E3 提权子进程规范化** | `packages/junk/elevated.ts`（纯策略层）+ `elevated-helper.ts`（提权侧脚本）+ `services/elevate.ts`（调度）：提权通道**只接收明确的文件清单**，不接受通配符 / 脚本 / 命令字符串；清单在生成侧与执行侧**各校验一次**；helper 脚本内容内嵌于代码、落盘前比对 hash；启动命令行里只有两个常量路径（经环境变量传递，杜绝参数注入） | ✅ 真机验证见下 |

**E3 验证细节（真机）**

| 验证项 | 结果 |
|---|---|
| helper 脚本语法 | AST 解析 **0 语法错误**（5208 B） |
| 清单分流 | 合法 2 条通过；`evil.ps1` → 「提权通道不接受 .ps1 类型」；不存在的文件 → 「文件已不存在」 |
| 执行侧整任务校验 | 通过（版本 / 动作 / taskId / batchId / 隔离区归属 / 条目逐条） |
| helper 实跑（当前权限直接执行，逻辑与提权一致） | 退出码 0，成功移动 2 项、释放 4096 B、失败 0；原位置已消失 |
| 隔离区与还原能力 | `Quarantine\<batchId>\00001_a.tmp / 00002_b.log` + `manifest.json`（`elevated=true`，records=2）；**与普通删除同一格式，可被隔离区页面还原** |
| 篡改防护 | 把条目改成 `C:\Windows\System32\kernel32.dll` → 执行侧拒绝；改成通配符路径 → 拒绝 |
| 单元测试 | 新增 `tests/unit/elevated.test.ts`：23 个用例（通配符 / UNC / 相对段 / 脚本类型 / 受保护路径 / 非法字段 / 任务级校验 / 启动命令构造 / 清单分流 / 保留期分级），全绿 |

**C5 验证细节（真机）**

| 验证项 | 结果 |
|---|---|
| ZIP 合法性 | Python 标准库 `zipfile` 打开：**CRC 全条目通过**、9 个条目（README / environment / paths / settings / capabilities / stats / quarantine / rules-summary / logs） |
| 脱敏彻底性 | 全包文本搜索用户名、计算机名、用户目录 → **零残留**；路径呈现为 `C:\Users\%USER%\AppData\Local\SoftGraph` |
| 日志脱敏时机 | 直接读磁盘 JSONL 校验：**写入磁盘时已不含**用户名/计算机名（不是导出时才处理） |
| 内容有用性 | 实测包内含：318 个软件、file_index 2602 / dependency 2735 条、垃圾 28023 项 · 18.26 GB · 扫描 80.4s、13 条规则摘要、原生能力降级表；环境含 OS 版本 / CPU 核数 / 内存 / 时区 / 运行时版本 |
| 单元测试 | 新增 `tests/unit/diagnostics.test.ts`：10 个用例（ZIP 读回 / 中文文件名 / CRC 标准向量 0xCBF43926 / 空包 / 二进制 / 脱敏五类 / 递归脱敏 / 幂等），全绿 |
| 实现差异 | ZIP 未引入压缩库（archiver / jszip）—— 诊断包都是文本，store 模式足够，保住「零原生依赖、单 exe 分发」原则 |

| **C3 路径健壮性** | 构造含中文/空格/特殊字符/emoji、507 字符长路径（30 层）、UNC、多用户目录的测试树，端到端探测「创建 → 安全判定 → 扫描 → 隔离 → 提权判定」全链路；`guardPath` 新增 Windows 子树收紧判定 | ✅ 真机 16/16 通过，详见下表；发现并修复 **BUG-21**（普通通道版白名单缺口） |

| **C4 压力测试** | 合成图谱（buildGraph 12000 依赖 / layoutGraph 1350~13500 节点）+ 5 万真实文件树三轮扫描，采样 RSS/堆/句柄曲线，验证无泄漏 | ✅ 全部达标，报告 `docs/benchmarks/stress-2026-09-13.md`，详见下表 |

**C4 验证细节（真机）**

| 压力面 | 结果 |
|---|---|
| buildGraph（单软件 12000 依赖） | **25ms**，内存 Δ10.5MB；maxNodes=8000 折叠上限生效（输出 8000 节点） |
| layoutGraph 1350 节点（力布局） | **2.09s**（运行在 Web Worker，不阻塞 UI；折叠后实际图谱远小于此） |
| layoutGraph 3150 / 6750 / 13500 节点（超阈值） | 走近似布局 **3~4ms**，内存平稳 |
| 扫描 5 万文件 × 3 轮 | 每轮 **2.2s**（≈2.3 万文件/秒，外推 100 万文件约 44s）；**RSS 三轮 Δ-0.0MB，句柄 1→1 —— 无泄漏** |
| 说明 | 堆内存每轮 +5MB 是 V8 延迟 GC（未开 --expose-gc），RSS 与句柄稳定证明无真实泄漏 |

**C3 验证细节（真机）**

| 场景 | 结果 |
|---|---|
| 中文/空格/特殊字符（`中文 目录 #1`、`a&b;c=d#1.tmp`、emoji 文件名） | ✅ Node 创建/读回/扫描 5 项全命中/隔离 5 项 0 失败；guardPath 与提权通道判定正确 |
| 长路径（**507 字符** / 30 层目录） | ✅ Node 创建与 stat 正常；guardPath/提权通道正常；本机 `LongPathsEnabled=1`，PowerShell Test-Path 亦正常 |
| UNC 路径 | ✅ 普通通道与提权通道均明确拒绝 |
| 多用户 | ✅ 其他用户的 `AppData\Local\Temp`：普通+提权通道均放行（提权的真实用武之地）；其他用户的桌面：提权拒绝（非垃圾目录） |

**C3 发现并修复的安全缺口（BUG-21，普通通道版白名单缺口）**

> E3 已发现提权通道版缺口（BUG-19）并修复，本项探测发现**普通删除通道存在同类问题**：
> `C:\Windows\中 文\x.tmp`、`C:\Windows\notepad.exe.bak` 这类 Windows 子树内的
> 非缓存目录文件能通过 guardPath（GC-05 需要清 Windows\Temp，因此 Windows 整树不可能列为受保护）。
> 修复：`guardPath` 新增收紧判定 —— **Windows 子树内只允许 CLEANABLE_EXCEPTIONS 明确列出的缓存目录**
> （Temp / SoftwareDistribution\Download / Installer / Logs / Prefetch / Minidump / Windows.old / $WINDOWS.~BT），
> 其余一律拦截。已用脚本验证 13 条规则的根子项**零误伤**（`tests/diag-rulecheck.ts`），
> 并固化为 6 个单元用例（252 用例全绿）。

**E3 中发现并修复的安全缺口（BUG-19，已固化为测试用例）**

> 普通删除通道允许清理 `C:\Windows` 的子目录（Temp / Logs / Installer …，见规则 GC-05），
> 因此安全层不能把整棵 `C:\Windows` 列为受保护树 —— 但这同时意味着
> `C:\Windows\notepad.exe.bak` 这类 **Windows 根目录下的文件**能通过普通白名单。
> 对普通通道可以接受（用户可能确实要删那里的垃圾），但**提权通道拥有管理员权限，边界必须更窄**。
> 修复：新增「提权可清理区」白名单（`isElevationAllowed`）—— 只允许系统级垃圾目录、
> 任意用户的 `AppData\Local\Temp` / 崩溃转储 / 回收站，以及明确的少数文件（MEMORY.DMP 等）。




