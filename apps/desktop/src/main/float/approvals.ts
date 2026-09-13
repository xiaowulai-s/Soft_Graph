/**
 * 插件权限授权记录（F1）：声明了 fs/network/powershell 的插件，
 * 需要用户在 UI 上明确点过「授权」才会被调度采集。
 *
 * 存储为 JSON 文件（append-only 语义的记录集合，不存插件代码）：
 *   { "vendor.name": { permissions: ["fs","network"], approvedAt: 1694... } }
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PluginPermission } from './plugin-manifest'

export interface ApprovalRecord {
  permissions: PluginPermission[]
  approvedAt: number
}

type ApprovalMap = Record<string, ApprovalRecord>

export class PluginApprovals {
  private data: ApprovalMap = {}

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as ApprovalMap
      }
    } catch {
      this.data = {}
    }
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(join(this.file, '..'), { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch {
      /* 持久化失败不致命：下次启动重新授权 */
    }
  }

  /** 返回插件已获授权的能力列表（未授权过 = 空数组） */
  approvedFor(id: string): PluginPermission[] {
    return this.data[id]?.permissions ?? []
  }

  /** 声明了 permissions 但尚未（全部）授权 → 需要用户确认 */
  pendingFor(id: string, declared: PluginPermission[]): PluginPermission[] {
    const got = new Set(this.approvedFor(id))
    return declared.filter((p) => !got.has(p))
  }

  async approve(id: string, permissions: PluginPermission[]): Promise<void> {
    const prev = new Set(this.approvedFor(id))
    for (const p of permissions) prev.add(p)
    this.data[id] = { permissions: [...prev], approvedAt: Date.now() }
    await this.persist()
  }

  async revoke(id: string): Promise<void> {
    delete this.data[id]
    await this.persist()
  }
}
