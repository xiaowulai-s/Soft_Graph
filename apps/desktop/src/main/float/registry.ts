/**
 * 插件注册表：内置插件 + 外部插件目录动态加载
 *
 * 外部插件目录：%APPDATA%\SoftGraph\plugins\
 *   支持两种布局：
 *     plugins\my-plugin.js
 *     plugins\my-plugin\index.js
 *
 * 隔离与容错原则（浮窗必须永远能显示）：
 *   - 加载失败的插件不阻塞其他插件；
 *   - collect 抛错或超时只影响该插件自身卡片，错误信息呈现在卡片上；
 *   - 单个插件的采集用 Promise.race 加超时，防止卡死整轮刷新。
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FloatPluginManifest, FloatPluginPayload } from '@shared/types'
import { formatBytes } from '@shared/util'
import { PluginApprovals } from './approvals'
import { BUILTIN_PLUGINS } from './builtin'
import { extractManifest, validateManifest, type PluginPermission } from './plugin-manifest'
import type { FloatPlugin, PluginContext } from './plugin-api'

const COLLECT_TIMEOUT = 15_000

export interface RegistryHost {
  junkTotalBytes(): number
  junkOneClickBytes(): number
  quarantineCount(): number
  softwareCount(): number
  lastJunkScanAt(): number | null
  psJson<T>(script: string, timeoutMs?: number): Promise<T>
}

export class PluginRegistry {
  private plugins = new Map<string, FloatPlugin>()
  private files = new Map<string, string>() // 插件 id → 外部文件绝对路径
  private states = new Map<string, Map<string, unknown>>()
  private lastPayload = new Map<string, FloatPluginPayload>()
  private lastRun = new Map<string, number>()
  private loadErrors: { file: string; error: string }[] = []
  approvals: PluginApprovals

  constructor(
    private pluginDir: string,
    private host: RegistryHost,
    approvalsFile?: string
  ) {
    this.approvals = new PluginApprovals(approvalsFile ?? join(pluginDir, '..', 'plugin-approvals.json'))
  }

  get externalDir(): string {
    return this.pluginDir
  }

  get errors(): { file: string; error: string }[] {
    return this.loadErrors
  }

  async load(): Promise<FloatPluginManifest[]> {
    this.plugins.clear()
    this.files.clear()
    this.loadErrors = []
    await this.approvals.load()

    for (const p of BUILTIN_PLUGINS) {
      this.plugins.set(p.manifest.id, p)
    }

    await this.ensureDirWithSample()
    await this.loadExternal()

    // setup 钩子（允许插件注册常驻采集器）；未获授权的插件不执行 setup
    for (const [id, p] of this.plugins) {
      if (!p.setup) continue
      if (this.pendingOf(p.manifest).length > 0) continue
      try {
        await p.setup(this.contextFor(id))
      } catch (e) {
        this.loadErrors.push({ file: id, error: `setup 失败：${(e as Error).message}` })
      }
    }
    return this.manifests()
  }

  /** 声明了但未获用户授权的能力（F1：非空则插件不被调度） */
  private pendingOf(m: FloatPluginManifest): string[] {
    if (m.builtin || !m.permissions?.length) return []
    return this.approvals.pendingFor(m.id, m.permissions as PluginPermission[])
  }

  private async loadExternal(): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.pluginDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const e of entries) {
      let file = ''
      if (e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_')) {
        file = join(this.pluginDir, e.name)
      } else if (e.isDirectory()) {
        const idx = join(this.pluginDir, e.name, 'index.js')
        if (existsSync(idx)) file = idx
      }
      if (!file) continue

      try {
        // 清除 require 缓存，实现「重载插件」而不用重启应用
        delete require.cache[require.resolve(file)]
        const mod = require(file) as FloatPlugin | { default: FloatPlugin }
        const plugin = (mod as { default?: FloatPlugin }).default ?? (mod as FloatPlugin)
        if (!plugin?.manifest?.id || typeof plugin.collect !== 'function') {
          this.loadErrors.push({ file, error: '插件缺少 manifest.id 或 collect 方法' })
          continue
        }
        // F1：严格 schema 校验 —— 格式非法的插件直接拒绝加载
        const check = validateManifest(plugin.manifest)
        if (!check.ok) {
          this.loadErrors.push({ file, error: `manifest 校验失败：${check.reason}` })
          continue
        }
        plugin.manifest.permissions = check.permissions
        if (this.plugins.has(plugin.manifest.id)) {
          this.loadErrors.push({ file, error: `插件 id 冲突：${plugin.manifest.id}` })
          continue
        }
        plugin.manifest.builtin = false
        this.plugins.set(plugin.manifest.id, plugin)
        this.files.set(plugin.manifest.id, file)
      } catch (err) {
        this.loadErrors.push({ file, error: (err as Error).message })
      }
    }
  }

  /** 首次运行写入一个示例插件，让「插件化」对用户可见可改 */
  private async ensureDirWithSample(): Promise<void> {
    try {
      await fs.mkdir(this.pluginDir, { recursive: true })
      const sample = join(this.pluginDir, 'example-hello.js')
      const readme = join(this.pluginDir, 'README.md')
      if (!existsSync(sample)) await fs.writeFile(sample, SAMPLE_PLUGIN, 'utf8')
      if (!existsSync(readme)) await fs.writeFile(readme, PLUGIN_README, 'utf8')
    } catch {
      /* 目录不可写时插件功能降级为仅内置，不影响主流程 */
    }
  }

  manifests(): FloatPluginManifest[] {
    return [...this.plugins.values()].map((p) => {
      const m = { ...p.manifest }
      const pending = this.pendingOf(m)
      m.pendingPermissions = pending
      if (this.files.has(m.id)) m.file = this.files.get(m.id)
      return m
    })
  }

  /**
   * F2 一键安装：接收插件源码（主进程已从 URL / 本地文件取回），
   * 先在沙箱中提取 manifest 做校验 —— **不落盘就不执行插件代码**。
   * 校验通过才写入插件目录并重载；声明了能力的插件装入后处于「待授权」态。
   */
  async installSource(source: string, origin?: string): Promise<{ ok: boolean; id?: string; name?: string; permissions?: string[]; error?: string }> {
    const got = extractManifest(source)
    if (!got.ok) return { ok: false, error: got.reason }
    const check = validateManifest(got.manifest)
    if (!check.ok) return { ok: false, error: `manifest 校验失败：${check.reason}` }
    const manifest = got.manifest as FloatPluginManifest
    if (this.plugins.has(manifest.id)) {
      return { ok: false, error: `插件 id 已存在（先卸载旧版本）：${manifest.id}` }
    }

    // 二次确认 collect 存在（沙箱执行后再 require 一遍正式加载路径，双保险）
    const fileName = `${manifest.id.replace(/[^\w.-]/g, '_')}.js`
    try {
      await fs.mkdir(this.pluginDir, { recursive: true })
      const banner = origin ? `// SoftGraph 已安装插件 · 来源：${origin} · 安装于 ${new Date().toISOString()}\n` : ''
      await fs.writeFile(join(this.pluginDir, fileName), banner + source, 'utf8')
    } catch (e) {
      return { ok: false, error: `写入插件目录失败：${(e as Error).message}` }
    }

    await this.load()
    const inst = this.plugins.get(manifest.id)
    if (!inst) {
      // load 后没加载上（例如 collect 缺失被拒）—— 回滚已写文件
      try {
        await fs.rm(join(this.pluginDir, fileName), { force: true })
      } catch {
        /* ignore */
      }
      const err = this.loadErrors.find((e) => e.file.endsWith(fileName))?.error
      return { ok: false, error: err ?? '安装后校验未通过，已回滚' }
    }
    return { ok: true, id: manifest.id, name: manifest.name, permissions: check.permissions }
  }

  /** F2：从 URL 安装（只接受 https / 本地 file 路径；上限 256KB） */
  async installFromUrl(url: string): Promise<{ ok: boolean; id?: string; name?: string; permissions?: string[]; error?: string }> {
    if (!/^https:\/\//i.test(url)) return { ok: false, error: '只允许 https:// 来源（防止明文传输被篡改的插件）' }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` }
      const text = await res.text()
      if (text.length > 256 * 1024) return { ok: false, error: '插件超过 256KB 上限' }
      return await this.installSource(text, url)
    } catch (e) {
      return { ok: false, error: `下载失败：${(e as Error).message}` }
    }
  }

  /** F2：删除外部插件文件并重载（内置插件拒绝） */
  async removeExternal(id: string): Promise<{ ok: boolean; error?: string }> {
    const file = this.files.get(id)
    const p = this.plugins.get(id)
    if (!p || !file) return { ok: false, error: '插件不存在或为内置插件' }
    if (p.manifest.builtin) return { ok: false, error: '内置插件不可删除' }
    try {
      await fs.rm(file, { force: true })
      await this.approvals.revoke(id)
      await this.load()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** F1：用户授权插件能力（授权 = 用户在 UI 上明确点击确认） */
  async approvePermissions(id: string, permissions: string[]): Promise<FloatPluginManifest[]> {
    await this.approvals.approve(id, permissions as PluginPermission[])
    await this.load()
    return this.manifests()
  }

  private contextFor(id: string): PluginContext {
    let st = this.states.get(id)
    if (!st) {
      st = new Map()
      this.states.set(id, st)
    }
    return {
      formatBytes,
      app: {
        junkTotalBytes: () => this.host.junkTotalBytes(),
        junkOneClickBytes: () => this.host.junkOneClickBytes(),
        quarantineCount: () => this.host.quarantineCount(),
        softwareCount: () => this.host.softwareCount(),
        lastJunkScanAt: () => this.host.lastJunkScanAt()
      },
      state: st,
      log: (...args: unknown[]) => console.log(`[plugin:${id}]`, ...args),
      psJson: (script, timeoutMs) => this.host.psJson(script, timeoutMs)
    }
  }

  /**
   * 采集指定插件的数据。
   * force=false 时按插件自身 interval 节流 —— 时钟 1s 刷新不应拖着磁盘 30s 的查询一起跑。
   */
  async tick(enabledIds: string[], force = false): Promise<FloatPluginPayload[]> {
    const now = Date.now()
    const out: FloatPluginPayload[] = []

    await Promise.all(
      enabledIds.map(async (id) => {
        const p = this.plugins.get(id)
        if (!p) return
        // F1：有未授权能力的外部插件不参与调度（卡片也不出现，避免用户误以为已在采集）
        if (this.pendingOf(p.manifest).length > 0) return
        const last = this.lastRun.get(id) ?? 0
        const due = force || p.manifest.interval <= 0 || now - last >= p.manifest.interval - 50
        if (!due) {
          const cached = this.lastPayload.get(id)
          if (cached) out.push(cached)
          return
        }
        this.lastRun.set(id, now)
        try {
          const data = await Promise.race([
            Promise.resolve(p.collect(this.contextFor(id))),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('采集超时')), COLLECT_TIMEOUT))
          ])
          const payload: FloatPluginPayload = {
            pluginId: id,
            ts: now,
            title: p.manifest.name,
            view: p.manifest.view,
            icon: p.manifest.icon,
            data: Array.isArray(data) ? data : []
          }
          this.lastPayload.set(id, payload)
          out.push(payload)
        } catch (e) {
          const payload: FloatPluginPayload = {
            pluginId: id,
            ts: now,
            title: p.manifest.name,
            view: 'text',
            icon: p.manifest.icon,
            data: [],
            error: (e as Error).message
          }
          this.lastPayload.set(id, payload)
          out.push(payload)
        }
      })
    )

    // 按 enabledIds 的顺序返回（顺序即用户配置的显示顺序）
    const order = new Map(enabledIds.map((id, i) => [id, i]))
    out.sort((a, b) => (order.get(a.pluginId) ?? 99) - (order.get(b.pluginId) ?? 99))
    return out
  }

  /** 最小刷新间隔：决定浮窗定时器频率 */
  minInterval(enabledIds: string[]): number {
    let min = 60_000
    for (const id of enabledIds) {
      const p = this.plugins.get(id)
      if (!p) continue
      if (this.pendingOf(p.manifest).length > 0) continue // 未授权插件不驱动定时器
      if (p.manifest.interval > 0) min = Math.min(min, p.manifest.interval)
    }
    return Math.max(min, 500)
  }

  dispose(): void {
    for (const p of this.plugins.values()) {
      try {
        p.dispose?.()
      } catch {
        /* ignore */
      }
    }
  }
}

const SAMPLE_PLUGIN = `/**
 * SoftGraph 浮窗插件示例
 * 把本文件复制改名即可创建自己的插件；在浮窗设置里点「重载插件」生效。
 *
 * view 可选：metric | gauge | bars | list | text
 * collect 返回数组，每项 { label, value, ratio?, hint?, tone? }
 *   ratio: 0~100，bars / gauge 视图用它画进度
 *   tone : normal | good | warn | danger，决定数值颜色
 */
module.exports = {
  manifest: {
    id: 'example.hello',
    name: '示例插件',
    description: '演示插件契约：显示当前分钟数与一个进度条',
    interval: 5000,
    view: 'bars',
    icon: 'plugin',
    version: '1.0.0',
    author: 'you'
  },

  collect(ctx) {
    const now = new Date()
    const sec = now.getSeconds()
    return [
      {
        label: '本分钟进度',
        value: sec + ' / 60 秒',
        ratio: (sec / 60) * 100,
        tone: sec > 50 ? 'warn' : 'normal'
      },
      {
        label: '已收录软件',
        value: ctx.app.softwareCount() + ' 个',
        ratio: Math.min(ctx.app.softwareCount() / 3, 100)
      }
    ]
  }
}
`

const PLUGIN_README = `# SoftGraph 浮窗插件目录

把插件放在这里，浮窗即可加载：

    plugins\\my-plugin.js
    plugins\\my-plugin\\index.js

## 插件结构

\`\`\`js
module.exports = {
  manifest: {
    id: 'vendor.name',   // 唯一 id，与内置插件冲突会被拒绝加载
    name: '显示名称',
    description: '一句话说明',
    interval: 3000,      // 采集间隔（毫秒），0 = 只在手动刷新时采集
    view: 'bars',        // metric | gauge | bars | list | text
    icon: 'plugin',
    version: '1.0.0',
    author: '作者'
  },
  async setup(ctx) {},   // 可选：启动常驻采集器
  async collect(ctx) {   // 必需：返回数据数组
    return [{ label: '标签', value: '值', ratio: 42, tone: 'normal' }]
  },
  dispose() {}           // 可选：释放资源
}
\`\`\`

## ctx 提供的能力

| 成员 | 说明 |
|---|---|
| \`ctx.formatBytes(n, digits)\` | 字节数格式化 |
| \`ctx.state\` | Map，跨轮次保存状态（例如上一次的计数器值，用于算速率） |
| \`ctx.app.softwareCount()\` | 已收录软件数 |
| \`ctx.app.junkTotalBytes()\` | 上次扫描的可释放空间 |
| \`ctx.app.junkOneClickBytes()\` | 一键可清理空间 |
| \`ctx.app.quarantineCount()\` | 隔离区条目数 |
| \`ctx.app.lastJunkScanAt()\` | 上次垃圾扫描时间戳，未扫描返回 null |
| \`ctx.psJson(script, timeoutMs)\` | 执行 PowerShell 并取 JSON（脚本内用 \`Write-SgJson\` 输出） |
| \`ctx.log(...)\` | 打日志 |

## 约束

- \`collect\` 超过 15 秒未返回会被判超时，错误显示在该卡片上，不影响其他插件。
- 插件抛错不会导致浮窗崩溃。
- 插件在主进程内执行，拥有 Node 全部能力 —— 只安装你信任的插件。
`
