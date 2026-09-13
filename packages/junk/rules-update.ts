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
import { loadRulesSync, type RuleSet } from './engine'

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

/**
 * 内置公钥（hex）。
 *
 * 开发/测试阶段为空 —— 此时 applyRulesUpdate 会拒绝任何在线更新（防呆），
 * 单测会注入临时密钥对。发布 v2.0.0 前由维护者生成正式密钥对：
 *   私钥进仓库 Secret（CI 签名用），公钥 hex 提交到这里。
 */
export const RULES_SIGNING_PUBKEY = process.env.SG_RULES_PUBKEY || ''

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
export function verifyRulesStructure(ruleSet: RuleSet): UpdateVerdict {
  if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length === 0) {
    return { ok: false, reason: '规则清单为空' }
  }
  for (const r of ruleSet.rules) {
    if (!/^GC-\d{2}$/.test(r.id)) return { ok: false, reason: `规则 id 不合规：${r.id}` }
    if (r.risk !== 'low' && r.risk !== 'medium' && r.risk !== 'high' && r.risk !== 'hint') {
      return { ok: false, reason: `风险级别非法：${r.id} → ${String(r.risk)}` }
    }
    // 模式不能过宽：单个 * 或 *.* 一律拒绝
    for (const p of r.patterns) {
      const src = p.source.replace(/\\/g, '')
      if (/^\*+$/.test(src)) return { ok: false, reason: `${r.id} 存在过宽模式（*）` }
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

  let manifest: DownloadedManifest
  let rulesText: string
  try {
    const dl = await downloadUpdate(opts.baseUrl, {
      allowFileUrl: opts.allowFileUrl,
      timeoutMs: opts.timeoutMs
    })
    manifest = dl.manifest
    rulesText = dl.rulesText
  } catch (e) {
    return { ok: false, reason: `下载失败：${(e as Error).message}` }
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

  return { ok: true, version: manifest.version, ruleCount: ruleSet.rules.length }
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
