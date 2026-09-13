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
  reportDir: string
  /** 垃圾扫描增量缓存（M2/A5：目录签名水位） */
  junkCacheFile: string
  /** COM 反查索引缓存（M2/B4：证据 E6） */
  comIndexFile: string
  /** 临时工作目录（M2/C2：Worker 结果文件落盘处） */
  tmpDir: string
  /** API Set 动态映射缓存（M2/B5） */
  apiSetCacheFile: string
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
    reportDir: join(root, 'reports'),
    junkCacheFile: join(root, 'cache', 'junk-incremental.json'),
    comIndexFile: join(root, 'cache', 'com-index.json'),
    tmpDir: join(root, 'tmp'),
    apiSetCacheFile: join(root, 'cache', 'apiset-map.json')
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
    p.reportDir
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
 * 规则库落地：首次运行把内置规则复制到用户目录，
 * 之后优先读用户目录（支持用户自行增改，对应「规则热更新」）。
 */
export async function ensureRules(p: AppPaths, builtinJson: unknown): Promise<string> {
  if (!existsSync(p.rulesFile)) {
    try {
      await fs.mkdir(join(p.root, 'rules'), { recursive: true })
      await fs.writeFile(p.rulesFile, JSON.stringify(builtinJson, null, 2), 'utf8')
    } catch {
      return ''
    }
  }
  return p.rulesFile
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
