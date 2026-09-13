/**
 * API Set 动态映射（v2.0.0 M2 / B5）
 *
 * 做法：**直接问 Windows 加载器**，而不是自己解析 schema 二进制。
 *
 *   LoadLibraryW("api-ms-win-core-file-l1-1-0.dll")  →  加载器按系统 API Set
 *   映射把虚拟名重定向到真实宿主 DLL（如 kernel32.dll / kernelbase.dll），
 *   再用 GetModuleFileNameW 取回宿主路径。
 *
 * 为什么不用解析 ApiSetSchema.dll：
 *   实测该文件的 schema 二进制布局随版本变化（header version=6，条目字段顺序
 *   与公开文档不一致，穷举候选起点无法得到自洽的条目表）。而加载器解析是
 *   **权威结果**，且成本极低（宿主 DLL 多数已加载，LoadLibrary 只是引用计数 +
 *   1；实测 700+ 条 <2s）。识别失败时调用方回退到静态前缀表。
 *
 * 缓存：结果落盘（默认 30 天），避免每次依赖解析都跑一遍加载器。
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { psJson, asArray } from './psbridge'

export interface ApiSetSchema {
  /** 小写虚拟名（含 .dll）→ 宿主 DLL 名（小写，含 .dll） */
  map: Map<string, string>
  /** 探测成功的映射条数 */
  entries: number
  /** 数据来源（加载器探测） */
  source: string
  /** 探测过的名字总数 */
  probed: number
}

const TTL_MS = 30 * 86_400_000
let cached: ApiSetSchema | null | undefined

/** 从 System32 / Downlevel 枚举 API set 名字（这些名字在磁盘上通常有占位文件） */
export async function listApiSetNames(): Promise<string[]> {
  const root = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const out = new Set<string>()
  for (const dir of [root, join(root, 'Downlevel')]) {
    try {
      const files = await fs.readdir(dir)
      for (const f of files) {
        if (/^(api-ms-win-|ext-ms-)/i.test(f) && /\.dll$/i.test(f)) out.add(f)
      }
    } catch {
      /* 目录不存在则跳过 */
    }
  }
  return [...out].sort()
}

const PROBE_SCRIPT = String.raw`
$names = Get-Content -LiteralPath $env:SG_IN -Raw -Encoding UTF8 | ConvertFrom-Json
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SgApiSet {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryW(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetModuleFileNameW(IntPtr h, StringBuilder buf, int size);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr h);
  public static string Resolve(string name) {
    IntPtr h = LoadLibraryW(name);
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(1024);
    int n = GetModuleFileNameW(h, sb, 1024);
    FreeLibrary(h);
    return n > 0 ? sb.ToString() : "";
  }
}
'@
try { if (-not ('SgApiSet' -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop } } catch { }
$out = New-Object System.Collections.ArrayList
foreach ($n in $names) {
  try {
    $p = [SgApiSet]::Resolve([string]$n)
    if (-not [string]::IsNullOrWhiteSpace($p)) {
      [void]$out.Add([pscustomobject]@{ name = [string]$n; host = [System.IO.Path]::GetFileName($p) })
    }
  } catch { }
}
Write-SgJson @($out)
`

/** 探测一批 API set 名字的真实宿主（走加载器） */
export async function probeApiSets(names: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (names.length === 0) return map
  const { promises: fsp } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { randomBytes } = await import('node:crypto')
  const inPath = join(tmpdir(), `sg-apiset-${randomBytes(5).toString('hex')}.json`)
  await fsp.writeFile(inPath, JSON.stringify(names), 'utf8')
  try {
    const rows = asArray(
      await psJson<{ name: string; host: string }[]>(PROBE_SCRIPT, {
        timeoutMs: 180_000,
        env: { SG_IN: inPath }
      })
    )
    for (const r of rows) {
      if (!r?.name || !r?.host) continue
      map.set(r.name.toLowerCase(), r.host.toLowerCase())
    }
  } finally {
    fsp.unlink(inPath).catch(() => {})
  }
  return map
}

function parseCache(raw: string): ApiSetSchema | null {
  try {
    const j = JSON.parse(raw) as { at: number; entries: number; probed: number; map: [string, string][] }
    if (!j?.at || Date.now() - j.at >= TTL_MS || !Array.isArray(j.map)) return null
    return { map: new Map(j.map), entries: j.entries, probed: j.probed, source: 'loader (cached)' }
  } catch {
    return null
  }
}

/**
 * 载入 API Set 映射（优先磁盘缓存 → 加载器探测）。
 * 失败返回 null，调用方回退静态前缀表。
 */
export async function loadApiSetSchema(cacheFile?: string): Promise<ApiSetSchema | null> {
  if (cached !== undefined) return cached

  if (cacheFile) {
    try {
      const hit = parseCache(await fs.readFile(cacheFile, 'utf8'))
      if (hit) {
        cached = hit
        return cached
      }
    } catch {
      /* 无缓存 */
    }
  }

  const names = await listApiSetNames()
  if (names.length === 0) {
    cached = null
    return null
  }
  let map: Map<string, string>
  try {
    map = await probeApiSets(names)
  } catch {
    cached = null
    return null
  }
  if (map.size === 0) {
    cached = null
    return null
  }
  cached = { map, entries: map.size, probed: names.length, source: 'loader' }

  if (cacheFile) {
    try {
      await fs.mkdir(dirname(cacheFile), { recursive: true })
      await fs.writeFile(
        cacheFile,
        JSON.stringify({ at: Date.now(), entries: map.size, probed: names.length, map: [...map] }),
        'utf8'
      )
    } catch {
      /* ignore */
    }
  }
  return cached
}

/** 内存态映射（供同步调用方使用；未加载时返回 null） */
export function apiSetMapSync(): Map<string, string> | null {
  return cached?.map ?? null
}

/**
 * 按需补全：磁盘上没有占位文件的 API set 名字（全量 schema 约 700 条，
 * 而 System32 只落盘一部分）无法被枚举到，但在 PE 导入表里会真实出现。
 * 由依赖解析在扫描开始前把所有遇到的 API set 名字一次性传进来补探。
 *
 * 结果并入内存缓存并回写磁盘，后续会话不再重复探测。
 */
export async function resolveApiSets(
  names: string[],
  cacheFile?: string
): Promise<Map<string, string>> {
  const base = (await loadApiSetSchema(cacheFile))?.map ?? new Map<string, string>()
  const missing = [...new Set(names.map((n) => n.toLowerCase()))].filter(
    (n) => n && !base.has(n)
  )
  if (missing.length === 0) return base
  const extra = await probeApiSets(missing)
  for (const [k, v] of extra) base.set(k, v)
  if (cached) cached.entries = base.size
  if (cacheFile && extra.size > 0) {
    try {
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          at: Date.now(),
          entries: base.size,
          probed: (cached?.probed ?? 0) + missing.length,
          map: [...base]
        }),
        'utf8'
      )
    } catch {
      /* ignore */
    }
  }
  return base
}

/** 测试用：重置内存缓存 */
export function resetApiSetCache(): void {
  cached = undefined
}
