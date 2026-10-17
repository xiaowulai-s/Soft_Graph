/**
 * 规则库在线更新（v2.0.0 M3/E2）
 *
 * 威胁模型：规则库决定「哪些文件会被删」。如果攻击者能替换规则
 * （例如把某个目录改成要删除的目标），本工具就会变成删文件武器。
 * 因此更新必须同时满足：
 *   1. **Ed25519 签名验证** —— 公钥内置在程序里，没有私钥就无法发布合法规则
 *   2. **内容哈希一致** —— manifest 里的 sha256 必须匹配规则文件本体
 *   3. **版本单调** —— 不允许降级到旧版本（防止重放旧规则包）
 *   4. **结构性校验** —— 更新后的规则必须通过本地编译与安全检查（防毒丸规则），
 *      再原子写入（先写临时文件再 rename）
 *
 * 包格式（由维护者的发布脚本产出）：
 *   <url>/manifest.json  { version, publishedAt, rulesSha256, signature }
 *   <url>/junk-rules.json
 *   signature = Ed25519(`softgraph-rules:${version}:${rulesSha256}`) 的 hex
 */

import { createHash, verify, generateKeyPairSync, sign as edSign, createPrivateKey, createPublicKey } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadRulesSync, expandRoots, type RuleSet } from './engine'

export const RULES_UPDATE_VERSION = 1

/** Ed25519 签名负载的前缀（域分隔，防跨用途重放） */
const SIGN_PREFIX = 'softgraph-rules'

export interface RulesManifest {
  version: number
  publishedAt: number
  rulesSha256: string
  signature: string
}

export interface UpdateVerdict {
  ok: boolean
  reason?: string
}

/** 官方规则更新源与镜像（v3.0.2 起：更新源留空即自动使用，raw 失败自动切镜像） */
export const RULES_UPDATE_FALLBACKS = [
  'https://raw.githubusercontent.com/xiaowulai-s/Soft_Graph/main/packages/rules/dist',
  'https://cdn.jsdelivr.net/gh/xiaowulai-s/Soft_Graph@main/packages/rules/dist'
]

/**
 * 内置公钥（hex）。
 *
 * 正式公钥已内置（2026-10-16 生成，Ed25519 SPKI DER hex）——
 * 内置值保证发布版应用可直接验签；环境变量 SG_RULES_PUBKEY 仅用于
 * 开发/测试覆盖（单测注入临时密钥对）。私钥不在仓库，由维护者本地保管。
 */
export const RULES_SIGNING_PUBKEY = process.env.SG_RULES_PUBKEY || '302a300506032b657003210059039f2969afde88cb219df1d0e326a12ec68226c83ad2b7dcbe2156ed31685c'

export function generateRuleKeyPair(): { publicKeyHex: string; privateKeyHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyHex: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    privateKeyHex: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex')
  }
}

export function signRulesPayload(
  version: number,
  rulesSha256: string,
  privateKeyHex: string
): string {
  const payload = `${SIGN_PREFIX}:${version}:${rulesSha256}`
  // 注意：Node 22 的 crypto.sign 不接受裸 DER Buffer 作为 Ed25519 密钥
  // （报 DECODER unsupported），必须先转 KeyObject
  const key = createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' })
  const sig = edSign(null, Buffer.from(payload, 'utf8'), key)
  return sig.toString('hex')
}

/** 签名验证（纯函数） */
export function verifyRulesSignature(
  version: number,
  rulesSha256: string,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  if (!publicKeyHex || !signatureHex) return false
  try {
    const payload = Buffer.from(`${SIGN_PREFIX}:${version}:${rulesSha256}`, 'utf8')
    const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' })
    return verify(null, payload, key, Buffer.from(signatureHex, 'hex'))
  } catch {
    return false
  }
}

/**
 * 结构校验：更新后的规则在**编译进内存**后必须满足安全底线。
 *
 * 防的攻击：合法私钥泄露（或维护者失误）发布毒丸规则，
 * 例如把 C:\Windows 列进 roots、把 * 作为 pattern、删掉 minSizeBytes 限制。
 */
/**
 * 「已知安全清理区」白名单（原始 %VAR% 形式，小写比较）。
 *
 * walk 类规则（树级删除语义）若允许裸 `*` 模式 + 任意根目录，
 * 一个被伪造的规则包就能把 `%USERPROFILE%` 整树标成垃圾 —— 这就是毒丸。
 * 因此裸 `*` 只允许出现在删除树级内容也安全的目录（TEMP / 回收站 /
 * 浏览器缓存 / Windows 更新缓存 / 旧系统残留 / 开发与 AI 工具缓存）。
 *
 * 新增规则若需要在新目录上用裸 `*`，必须同步扩充此白名单并随应用发版；
 * file 级语义的特殊算法（duplicate / bigfile / deadlink / orphan）不受此限。
 */
const WIDE_PATTERN_SAFE_PREFIXES = [
  '%temp%',
  '%windir%\\temp',
  '%localappdata%\\temp',
  '%sg_drives%\\$recycle.bin',
  // 浏览器缓存（GC-04）
  '%localappdata%\\google\\chrome\\user data\\default\\cache',
  '%localappdata%\\google\\chrome\\user data\\default\\code cache',
  '%localappdata%\\google\\chrome\\user data\\default\\gpucache',
  '%localappdata%\\google\\chrome\\user data\\default\\service worker\\cachestorage',
  '%localappdata%\\microsoft\\edge\\user data\\default\\cache',
  '%localappdata%\\microsoft\\edge\\user data\\default\\code cache',
  '%localappdata%\\microsoft\\edge\\user data\\default\\gpucache',
  '%localappdata%\\microsoft\\edge\\user data\\default\\service worker\\cachestorage',
  '%localappdata%\\bravesoftware\\brave-browser\\user data\\default\\cache',
  '%localappdata%\\mozilla\\firefox\\profiles',
  '%appdata%\\mozilla\\firefox\\profiles',
  // Windows 更新缓存与旧系统残留（GC-05/06）
  '%windir%\\softwaredistribution\\download',
  '%systemdrive%\\windows.old',
  '%systemdrive%\\$windows.~bt',
  '%systemdrive%\\$windows.~ws',
  '%systemdrive%\\$windows.~q',
  // 开发缓存（GC-10）
  '%localappdata%\\npm-cache\\_cacache',
  '%appdata%\\npm-cache\\_cacache',
  '%localappdata%\\pip\\cache',
  '%localappdata%\\yarn\\cache',
  '%userprofile%\\.nuget\\packages',
  '%userprofile%\\.m2\\repository',
  '%userprofile%\\.gradle\\caches',
  '%userprofile%\\.cargo\\registry\\cache',
  '%localappdata%\\pnpm\\store',
  '%localappdata%\\go-build',
  // AI 工具缓存（GC-14）与模型库（GC-15，bigfile 本身文件级）
  '%userprofile%\\.cache\\huggingface\\hub',
  '%userprofile%\\.cache\\modelscope\\hub',
  '%userprofile%\\.cache\\lm-studio',
  '%appdata%\\comfyui\\temp',
  '%userprofile%\\.conda\\pkgs',
  '%userprofile%\\miniconda3\\pkgs',
  '%userprofile%\\anaconda3\\pkgs',
  '%userprofile%\\.ollama\\models',
  '%userprofile%\\.lmstudio\\models'
]

/**
 * AI IDE（Trae / Cursor / Windsurf / WorkBuddy / Qoder / ZCode / Codeium）
 * 的 Electron 缓存族目录：任意已知应用目录下的标准缓存子目录视为安全清理区。
 * 只匹配「应用名 + 缓存族」两层，绝不放行应用目录本身（extensions / User /
 * WebStorage / session 等用户数据不在其中）。
 */
const AI_IDE_CACHE_FAMILY = new Set([
  'cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache',
  'dawnwebgpucache', 'shadercache', 'cacheddata', 'cachedextensionvsixs',
  'cachedprofilesdata', 'crashpad', 'logs', 'service worker\\cachestorage'
])
const AI_IDE_NAMES = new Set(['trae', 'cursor', 'windsurf', 'workbuddy', 'qoder', 'zcode', 'codeium'])

/** 根目录是否为「AI IDE 应用目录 + 缓存族子目录」结构 */
function isAiIdeCacheRoot(lower: string): boolean {
  // %appdata%\<app>\<cache-family>（可带更深层：service worker\cachestorage）
  let m = /^%(?:appdata|localappdata)%\\([a-z0-9 .-]+)\\([a-z0-9 ]+(?:\\[a-z0-9 ]+)?)(?:\\|$)/.exec(lower)
  if (m && AI_IDE_NAMES.has(m[1]) && AI_IDE_CACHE_FAMILY.has(m[2])) return true
  // %userprofile%\.<app>\logs
  m = /^%userprofile%\\\.([a-z0-9-]+)\\logs(?:\\|$)/.exec(lower)
  if (m && AI_IDE_NAMES.has(m[1])) return true
  // 展开后的字面路径：C:\users\…\appdata\roaming\<app>\<cache-family>
  const ex = /^c:\\users\\[^\\]+\\appdata\\(?:roaming|local)\\([a-z0-9 .-]+)\\([a-z0-9 ]+(?:\\[a-z0-9 ]+)?)(?:\\|$)/.exec(lower)
  if (ex && AI_IDE_NAMES.has(ex[1]) && AI_IDE_CACHE_FAMILY.has(ex[2])) return true
  return false
}

/** 特殊算法：文件级选择语义，不整树删除，不受裸 `*` 限制 */
const FILE_LEVEL_ALGORITHMS = new Set(['duplicate', 'bigfile', 'deadlink', 'orphan'])

/**
 * 根目录是否落在安全清理区。两种命中方式（夹具/在线包可能用字面路径或 %VAR%）：
 *  1. 原始 %VAR% 形式直接前缀匹配白名单
 *  2. 展开后（expandRoots）与白名单前缀的展开结果做前缀比较
 */
/** expandRoots 的 token 是大写敏感的（%SG_DRIVES%），这里统一把 token 大写化后再展开 */
function expandTokensUpper(x: string): string[] {
  const up = x.replace(/%([a-z_][a-z0-9_]*)%/g, (_m, t: string) => `%${t.toUpperCase()}%`)
  return expandRoots(up)
}

/** 白名单前缀的展开结果（模块级缓存，避免每条规则重复展开全部盘符） */
let _expandedSafePrefixes: string[] | null = null
function expandedSafePrefixes(): string[] {
  if (!_expandedSafePrefixes) {
    _expandedSafePrefixes = WIDE_PATTERN_SAFE_PREFIXES.flatMap((prefix) => {
      try {
        return expandTokensUpper(prefix)
      } catch {
        return []
      }
    }).map((e) => e.toLowerCase().replace(/\//g, '\\'))
  }
  return _expandedSafePrefixes
}

function rootInSafeZone(rawRoot: string): boolean {
  const lower = rawRoot.toLowerCase().replace(/\//g, '\\')
  if (WIDE_PATTERN_SAFE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  if (isAiIdeCacheRoot(lower)) return true
  try {
    const expanded = expandTokensUpper(rawRoot).map((e) => e.toLowerCase().replace(/\//g, '\\'))
    const prefixes = expandedSafePrefixes()
    return expanded.length > 0 && expanded.every((el) => prefixes.some((prefix) => el.startsWith(prefix)))
  } catch {
    return false
  }
}

export function verifyRulesStructure(ruleSet: RuleSet): UpdateVerdict {
  if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length === 0) {
    return { ok: false, reason: '规则清单为空' }
  }
  for (const r of ruleSet.rules) {
    if (!/^GC-\d{2}$/.test(r.id)) return { ok: false, reason: `规则 id 不合规：${r.id}` }
    if (r.risk !== 'low' && r.risk !== 'medium' && r.risk !== 'high' && r.risk !== 'hint') {
      return { ok: false, reason: `风险级别非法：${r.id} → ${String(r.risk)}` }
    }
    // 模式宽度与根目录联合判定：
    //  - 特殊算法（文件级语义）不限制模式宽度
    //  - walk 类规则用裸 `*`（整树删除语义）时，所有根必须落在已知安全清理区，
    //    否则一个伪造包就能把 %USERPROFILE% 整树标成垃圾（毒丸）
    const fileLevel = FILE_LEVEL_ALGORITHMS.has(String((r as { algorithm?: string }).algorithm ?? ''))
    // 注意：用 raw 原始模式判定 —— glob '*' 编译后的正则源是 [^\\]*，
    // 对编译产物做 /^\*+$/ 判断永远不命中（旧实现因此一直是死代码）
    const rawPatterns = (r as { raw?: { match?: { patterns?: string[] } } }).raw?.match?.patterns ?? []
    const hasBareStar = rawPatterns.some((pat) => /^\*+$/.test(String(pat).trim()))
    if (hasBareStar && !fileLevel) {
      const rawRoots = (r as { raw?: { match?: { roots?: string[] } } }).raw?.match?.roots ?? []
      const allSafe = rawRoots.length > 0 && rawRoots.every(rootInSafeZone)
      if (!allSafe) {
        return { ok: false, reason: `${r.id} 存在过宽模式（*）：根目录不在已知安全清理区白名单` }
      }
    }
    // 根目录不允许是盘根或 Windows 本体
    for (const root of r.roots) {
      if (/^[a-z]:\\?$/i.test(root)) return { ok: false, reason: `${r.id} 根目录是盘根` }
      const w = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
      if (root.toLowerCase() === w) return { ok: false, reason: `${r.id} 根目录是 Windows 本体` }
    }
  }
  return { ok: true }
}

export interface DownloadedManifest {
  version: number
  publishedAt: number
  rulesSha256: string
  signature: string
}

/**
 * 从 URL 拉取 manifest 与规则文件。
 * 独立出来便于测试（单测注入本地内容，不经网络）。
 */
export async function downloadUpdate(
  baseUrl: string,
  opts: { allowFileUrl?: boolean; timeoutMs?: number } = {}
): Promise<{ manifest: DownloadedManifest; rulesText: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const fetchText = async (path: string): Promise<string> => {
    const url = baseUrl.endsWith('/') ? baseUrl + path : `${baseUrl}/${path}`
    if (url.startsWith('file://')) {
      if (!opts.allowFileUrl) throw new Error('file:// 协议未启用（仅限测试）')
      return fs.readFile(fileURLToPath(url), 'utf8')
    }
    if (!url.startsWith('https://')) throw new Error('仅允许 HTTPS 更新源')
    // Electron 主进程优先用 net.fetch：走 Chromium 网络栈（系统代理 / 证书库）。
    // 全局 fetch（undici）不读系统代理 —— 配了代理的用户会直接 fetch failed。
    try {
      const electron = (await import('electron')) as unknown as {
        net?: { fetch?: (url: string, init?: unknown) => Promise<Response> }
      }
      if (electron.net?.fetch) {
        const res = await electron.net.fetch(url, { signal: AbortSignal.timeout(timeoutMs) } as never)
        if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`)
        return await res.text()
      }
    } catch (e) {
      // net.fetch 内的 HTTP 错误（如 404）应直接上抛；仅对「electron 不可用」
      // 的环境（单测 / worker）回退全局 fetch
      if (/HTTP \d+/.test(String((e as Error).message))) throw e
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`)
    return res.text()
  }
  const manifest = JSON.parse(await fetchText('manifest.json')) as DownloadedManifest
  const rulesText = await fetchText('junk-rules.json')
  return { manifest, rulesText }
}

export interface ApplyOptions {
  /** 当前已安装规则的版本（kv 里存的） */
  currentVersion: number
  /** 当前内容哈希（语义哈希）；与下载内容一致时跳过应用（A2：哈希即真相） */
  expectedContentHash?: string
  /** 备用更新源：主源下载失败时按序尝试（raw → jsDelivr 镜像） */
  fallbackUrls?: string[]
  /** 内置公钥（hex）；为空则拒绝一切在线更新 */
  publicKeyHex?: string
  rulesFile: string
  baseUrl: string
  allowFileUrl?: boolean
  timeoutMs?: number
  /** 下载后（写入前）可注入额外校验 */
  now?: () => number
}

export interface ApplyResult {
  ok: boolean
  version?: number
  reason?: string
  /** 更新前后规则数（供日志） */
  ruleCount?: number
  /** 下载内容与当前一致而跳过（A2） */
  skippedSame?: boolean
  /** 下载内容的语义哈希（A2：成功/跳过时都返回） */
  contentHash?: string
}

/**
 * 完整更新流程：下载 → 签名 → 哈希 → 版本单调 → 结构校验 → 原子写入。
 * 任何一步失败都**不触碰现有规则文件**。
 */
export async function applyRulesUpdate(opts: ApplyOptions): Promise<ApplyResult> {
  const pubkey = opts.publicKeyHex ?? RULES_SIGNING_PUBKEY
  const now = opts.now ?? ((): number => Date.now())

  if (!pubkey) return { ok: false, reason: '未配置规则签名公钥，在线更新已禁用' }
  if (!/^https:\/\//.test(opts.baseUrl) && !opts.allowFileUrl) {
    return { ok: false, reason: '更新源必须是 HTTPS' }
  }

  const urls = [opts.baseUrl, ...(opts.fallbackUrls ?? [])].filter(
    (u, i, a) => u && a.indexOf(u) === i
  )
  let manifest: DownloadedManifest | null = null
  let rulesText: string | null = null
  let lastErr: Error | null = null
  for (const u of urls) {
    try {
      const dl = await downloadUpdate(u, {
        allowFileUrl: opts.allowFileUrl,
        timeoutMs: opts.timeoutMs
      })
      manifest = dl.manifest
      rulesText = dl.rulesText
      break
    } catch (e) {
      lastErr = e as Error
    }
  }
  if (!manifest || rulesText === null) {
    return { ok: false, reason: `下载失败：${lastErr?.message ?? '全部更新源不可达'}（已尝试 ${urls.length} 个源）` }
  }

  // A2：语义哈希一致 → 内容没变，跳过（不写盘、不推进版本）
  const contentHash = semHash(rulesText)
  if (opts.expectedContentHash && contentHash === opts.expectedContentHash) {
    return { ok: false, skippedSame: true, contentHash, reason: '内容与当前一致，无需更新' }
  }

  if (typeof manifest.version !== 'number' || manifest.version <= 0) {
    return { ok: false, reason: `版本号非法：${String(manifest.version)}` }
  }
  if (manifest.version <= opts.currentVersion) {
    return { ok: false, reason: `远端版本 ${manifest.version} 不高于当前 ${opts.currentVersion}（拒绝降级/重放）` }
  }
  // manifest 自身时效：超过 180 天的签名视为过期（强制维护者滚动发布）
  if (typeof manifest.publishedAt === 'number' && now() - manifest.publishedAt > 180 * 24 * 3600 * 1000) {
    return { ok: false, reason: '规则包签名已过期（>180 天），请等待新版本' }
  }

  const rulesSha256 = createHash('sha256').update(rulesText, 'utf8').digest('hex')
  if (manifest.rulesSha256 !== rulesSha256) {
    return { ok: false, reason: '内容哈希不匹配（下载可能被篡改）' }
  }
  if (!verifyRulesSignature(manifest.version, rulesSha256, manifest.signature, pubkey)) {
    return { ok: false, reason: '签名验证失败（来源不可信）' }
  }

  // 结构校验：先在内存里编译成功且通过安全底线，才允许落盘
  let parsed: unknown
  try {
    parsed = JSON.parse(rulesText)
  } catch {
    return { ok: false, reason: '规则文件不是合法 JSON' }
  }
  const raw = parsed as { schemaVersion?: number }
  if (raw.schemaVersion !== 1) return { ok: false, reason: `schemaVersion 不支持：${String(raw.schemaVersion)}` }
  let ruleSet: RuleSet
  try {
    ruleSet = loadRulesSync(parsed as never)
  } catch (e) {
    return { ok: false, reason: `规则编译失败：${(e as Error).message}` }
  }
  const structure = verifyRulesStructure(ruleSet)
  if (!structure.ok) return { ok: false, reason: `结构校验失败：${structure.reason}` }

  // 原子写入：临时文件 + rename
  const tmp = opts.rulesFile + '.downloading'
  await fs.writeFile(tmp, rulesText, 'utf8')
  await fs.rename(tmp, opts.rulesFile)

  return { ok: true, version: manifest.version, ruleCount: ruleSet.rules.length, contentHash }
}

/** 当前规则版本（kv），无记录或值损坏视为内置版本 0 */
export function parseStoredVersion(raw: string | null): number {
  if (!raw) return 0
  try {
    const n = Number(JSON.parse(raw))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** A2 语义哈希：排序键稳定序列化 + SHA-256（对键序/换行/空白不敏感；非法 JSON 退化为原文哈希） */
export function semHash(text: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  let norm: string
  try {
    norm = stableStringify(JSON.parse(text))
  } catch {
    norm = text
  }
  return createHash('sha256').update(norm).digest('hex')
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map((x) => stableStringify(x)).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}
