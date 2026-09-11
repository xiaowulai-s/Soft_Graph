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
import { BUILTIN_PLUGINS } from './builtin'
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
  private states = new Map<string, Map<string, unknown>>()
  private lastPayload = new Map<string, FloatPluginPayload>()
  private lastRun = new Map<string, number>()
  private loadErrors: { file: string; error: string }[] = []

  constructor(
    private pluginDir: string,
    private host: RegistryHost
  ) {}

  get externalDir(): string {
    return this.pluginDir
  }

  get errors(): { file: string; error: string }[] {
    return this.loadErrors
  }

  async load(): Promise<FloatPluginManifest[]> {
    this.plugins.clear()
    this.loadErrors = []

    for (const p of BUILTIN_PLUGINS) {
      this.plugins.set(p.manifest.id, p)
    }

    await this.ensureDirWithSample()
    await this.loadExternal()

    // setup 钩子（允许插件注册常驻采集器）
    for (const [id, p] of this.plugins) {
      if (!p.setup) continue
      try {
        await p.setup(this.contextFor(id))
      } catch (e) {
        this.loadErrors.push({ file: id, error: `setup 失败：${(e as Error).message}` })
      }
    }
    return this.manifests()
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
        if (this.plugins.has(plugin.manifest.id)) {
          this.loadErrors.push({ file, error: `插件 id 冲突：${plugin.manifest.id}` })
          continue
        }
        plugin.manifest.builtin = false
        this.plugins.set(plugin.manifest.id, plugin)
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
    return [...this.plugins.values()].map((p) => ({ ...p.manifest }))
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
