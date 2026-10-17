/**
 * 应用路径与设置
 * 数据位置遵循设计文档：%LOCALAPPDATA%\SoftGraph\
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { defaultFloatSettings } from '../float/window'

export interface AppPaths {
  root: string
  dataDir: string
  iconDir: string
  quarantineDir: string
  pluginDir: string
  dbFile: string
  settingsFile: string
  rulesFile: string
  /** v3.2 规则分区：社区区（Winapp2 导入 + 在线更新扩展区） */
  communityRulesFile: string
  /** v3.2 规则分区：用户自定义区（预留，永不覆盖） */
  userRulesFile: string
  reportDir: string
  /** 垃圾扫描增量缓存（M2/A5：目录签名水位） */
  junkCacheFile: string
  /** COM 反查索引缓存（M2/B4：证据 E6） */
  comIndexFile: string
  /** 临时工作目录（M2/C2：Worker 结果文件落盘处） */
  tmpDir: string
  /** API Set 动态映射缓存（M2/B5） */
  apiSetCacheFile: string
  /** 结构化日志目录（M3/C5） */
  logDir: string
  /** 注册表清理备份目录（v3.0.0 · M4：先备份后删除，备份是删除的前置条件） */
  registryBackupDir: string
  /** 便携目录扫描缓存（v3.0.0 · A3：目录级签名 → 复用评分结果） */
  portableCacheFile: string
}

export function resolvePaths(): AppPaths {
  const local = process.env.LOCALAPPDATA || app.getPath('appData')
  const root = join(local, 'SoftGraph')
  return {
    root,
    dataDir: join(root, 'data'),
    iconDir: join(root, 'cache', 'icons'),
    quarantineDir: join(root, 'Quarantine'),
    pluginDir: join(root, 'plugins'),
    dbFile: join(root, 'data', 'softgraph.db'),
    settingsFile: join(root, 'settings.json'),
    rulesFile: join(root, 'rules', 'junk-rules.json'),
    communityRulesFile: join(root, 'rules', 'community-rules.json'),
    userRulesFile: join(root, 'rules', 'user-rules.json'),
    reportDir: join(root, 'reports'),
    junkCacheFile: join(root, 'cache', 'junk-incremental.json'),
    comIndexFile: join(root, 'cache', 'com-index.json'),
    tmpDir: join(root, 'tmp'),
    apiSetCacheFile: join(root, 'cache', 'apiset-map.json'),
    logDir: join(root, 'logs'),
    registryBackupDir: join(root, 'registry-backups'),
    portableCacheFile: join(root, 'cache', 'portable-scan.json')
  }
}

export async function ensurePaths(p: AppPaths): Promise<void> {
  for (const d of [
    p.root,
    p.dataDir,
    p.iconDir,
    p.quarantineDir,
    p.pluginDir,
    join(p.root, 'rules'),
    join(p.root, 'cache'),
    p.tmpDir,
    p.reportDir,
    p.registryBackupDir
  ]) {
    await fs.mkdir(d, { recursive: true }).catch(() => {})
  }
}

export function defaultSettings(): AppSettings {
  return {
    portableRoots: [],
    portableThreshold: 55,
    excludePaths: [],
    quarantineKeepDaysLow: 7,
    quarantineKeepDaysHigh: 14,
    theme: 'dark',
    maxDepth: 2,
    enabledJunkCategories: [],
    advancedMode: false,
    allowDirectDelete: false,
    rulesUpdateUrl: '',
    junkSchedule: { enabled: false, intervalHours: 168 },
    extraScanDirs: [],
    float: defaultFloatSettings()
  }
}

export class SettingsStore {
  private data: AppSettings
  private file: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor(file: string, initial: AppSettings) {
    this.file = file
    this.data = initial
  }

  static async load(file: string): Promise<SettingsStore> {
    const base = defaultSettings()
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<AppSettings>
        return new SettingsStore(file, {
          ...base,
          ...raw,
          // 嵌套对象需要深合并，否则新增字段在老配置里会是 undefined
          float: { ...base.float, ...(raw.float ?? {}) }
        })
      } catch {
        /* 配置损坏 → 用默认值，不阻塞启动 */
      }
    }
    const s = new SettingsStore(file, base)
    void s.flush()
    return s
  }

  get(): AppSettings {
    return this.data
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    this.data = {
      ...this.data,
      ...patch,
      float: patch.float ? { ...this.data.float, ...patch.float } : this.data.float
    }
    this.scheduleSave()
    return this.data
  }

  patchFloat(patch: Partial<AppSettings['float']>): AppSettings['float'] {
    this.data = { ...this.data, float: { ...this.data.float, ...patch } }
    this.scheduleSave()
    return this.data.float
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 400)
  }

  async flush(): Promise<void> {
    try {
      await fs.mkdir(join(this.file, '..'), { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }
}

/**
 * 规则库落地（v3.2 分区模型）：
 *   - 运行时规则 = 内置（随应用打包）⊕ 社区区 ⊕ 用户区，按 id 去重、内置优先
 *   - 内置规则不再落盘（随应用更新走，A1 根除「本地遮蔽内置」问题）
 *   - 社区区文件承载 Winapp2 导入与在线更新扩展规则（A1 可整体重导更新）
 *   - 迁移：旧版合并式 junk-rules.json 里的「[社区]」规则迁入社区区（一次性）
 */
export async function ensureRules(p: AppPaths, builtinJson: unknown): Promise<string> {
  try {
    await fs.mkdir(join(p.root, 'rules'), { recursive: true })

    const communitySkeleton = JSON.stringify({ schemaVersion: 1, updatedAt: '', rules: [] }, null, 2)
    if (!existsSync(p.communityRulesFile)) {
      await fs.writeFile(p.communityRulesFile, communitySkeleton, 'utf8')
    }
    if (!existsSync(p.userRulesFile)) {
      await fs.writeFile(p.userRulesFile, JSON.stringify({ schemaVersion: 1, updatedAt: '', rules: [] }, null, 2), 'utf8')
    }

    // 一次性迁移：旧合并文件中的社区规则（Winapp2 导入）→ 社区区
    if (existsSync(p.rulesFile)) {
      const community = JSON.parse(await fs.readFile(p.communityRulesFile, 'utf8')) as {
        rules?: { id?: string; name?: string }[]
        updatedAt?: string
      }
      const known = new Set((community.rules ?? []).map((r) => `${r.id}\u0000${r.name ?? ''}`))
      const local = JSON.parse(await fs.readFile(p.rulesFile, 'utf8')) as {
        rules?: { id?: string; name?: string }[]
      }
      const legacyCommunity = (local.rules ?? []).filter(
        (r) => typeof r.name === 'string' && r.name.startsWith('[社区]')
      )
      const toMove = legacyCommunity.filter((r) => !known.has(`${r.id}\u0000${r.name ?? ''}`))
      if (toMove.length > 0) {
        community.rules = [...(community.rules ?? []), ...toMove]
        community.updatedAt = new Date().toISOString().slice(0, 10)
        await fs.writeFile(p.communityRulesFile, JSON.stringify(community, null, 2), 'utf8')
      }
      // 旧合并文件改名为 legacy 备份（运行时不再读取），只做一次
      const legacyMarker = p.rulesFile + '.legacy'
      if (!existsSync(legacyMarker)) {
        await fs.rename(p.rulesFile, legacyMarker).catch(() => {})
        await fs.writeFile(legacyMarker, 'migrated', 'utf8').catch(() => {})
      }
    }
  } catch {
    /* 迁移失败不阻塞启动；社区区/用户区缺失时运行时按空处理 */
  }
  return p.communityRulesFile
}

/** 是否以管理员权限运行（影响系统目录清理能力提示） */
export async function isElevated(): Promise<boolean> {
  try {
    const { psJson } = await import('@scanner/psbridge')
    const r = await psJson<{ elevated: boolean }>(
      `
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
Write-SgJson ([pscustomobject]@{ elevated = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) })
`,
      { timeoutMs: 15_000 }
    )
    return !!r?.elevated
  } catch {
    return false
  }
}
