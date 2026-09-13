#!/usr/bin/env node
/**
 * 规则库签名发布工具（E2，维护者使用）
 *
 * 用法：
 *   SG_RULES_PRIVKEY=<hex> node scripts/publish-rules.mjs <rules.json> <outputDir>
 *
 * 产出：
 *   <outputDir>/manifest.json    { version, publishedAt, rulesSha256, signature }
 *   <outputDir>/junk-rules.json  原样复制的规则文件
 *
 * 私钥生成（一次）：
 *   node -e "const {generateRuleKeyPair}=require('./.tmp/rules-update.cjs');console.log(generateRuleKeyPair())"
 *   或在 Node 里调用 packages/junk/rules-update.ts 的 generateRuleKeyPair()
 *
 * 版本号：取自规则文件里的 `_version` 字段（缺省 1），每次发布必须递增。
 * 公钥：把 generateRuleKeyPair() 输出的 publicKeyHex 提交到
 *       packages/junk/rules-update.ts 的 RULES_SIGNING_PUBKEY。
 *       私钥放 CI Secret，绝不入库。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { createPrivateKey, sign as edSign, generateKeyPairSync } from 'node:crypto'

const args = process.argv.slice(2)
const rulesFile = args[0]
const outDir = args[1]

if (!rulesFile || !outDir) {
  console.error('用法：SG_RULES_PRIVKEY=<hex> node scripts/publish-rules.mjs <rules.json> <outputDir>')
  console.error('生成密钥对：node scripts/publish-rules.mjs --gen-keys')
  process.exit(1)
}

if (args[0] === '--gen-keys') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).toString('hex')
  const privateKeyHex = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex')
  console.log('PUBLIC_KEY_HEX（提交到 RULES_SIGNING_PUBKEY）:\n' + publicKeyHex)
  console.log('\nPRIVATE_KEY_HEX（放 CI Secret，勿入库）:\n' + privateKeyHex)
  process.exit(0)
}

const privHex = process.env.SG_RULES_PRIVKEY
if (!privHex) {
  console.error('缺少 SG_RULES_PRIVKEY 环境变量（Ed25519 pkcs8 DER hex）')
  process.exit(1)
}

const rulesText = readFileSync(resolve(rulesFile), 'utf8')
const parsed = JSON.parse(rulesText)
const version = Number(parsed._version ?? 1)
if (!Number.isFinite(version) || version <= 0) {
  console.error('规则文件缺少合法的 _version 字段')
  process.exit(1)
}

const sha = createHash('sha256').update(rulesText, 'utf8').digest('hex')
const payload = `softgraph-rules:${version}:${sha}`
const key = createPrivateKey({ key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8' })
const signature = edSign(null, Buffer.from(payload, 'utf8'), key).toString('hex')

mkdirSync(resolve(outDir), { recursive: true })
writeFileSync(
  join(resolve(outDir), 'manifest.json'),
  JSON.stringify({ version, publishedAt: Date.now(), rulesSha256: sha, signature }, null, 2)
)
writeFileSync(join(resolve(outDir), 'junk-rules.json'), rulesText, 'utf8')

console.log(`已产出 v${version} 规则包 → ${resolve(outDir)}`)
console.log(`  manifest.json（version=${version}, sha256=${sha.slice(0, 16)}…）`)
console.log('  junk-rules.json')
console.log('\n发布方式：把这两个文件上传到 HTTPS 静态托管（GitHub Release / OSS），')
console.log('并在应用的 设置 → 清理与安全 → 规则更新源 填入基础 URL。')
