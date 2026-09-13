/**
 * E2 规则库在线更新测试
 *
 * 规则库决定删什么文件 —— 更新链路是本工具最容易被武器化的入口，
 * 这里逐环验证：签名 / 哈希 / 版本单调 / 结构安全 / 原子写入。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  generateRuleKeyPair,
  signRulesPayload,
  verifyRulesSignature,
  verifyRulesStructure,
  applyRulesUpdate,
  parseStoredVersion
} from '@junk/rules-update'
import { loadRulesSync } from '@junk/engine'
import type { JunkRule } from '@shared/types'

const { publicKeyHex, privateKeyHex } = generateRuleKeyPair()

function goodRules(): { schemaVersion: number; rules: JunkRule[] } {
  return {
    schemaVersion: 1,
    rules: [
      {
        id: 'GC-01',
        name: '回收站',
        description: '',
        risk: 'low',
        defaultSelected: true,
        match: { roots: ['C:\\$Recycle.Bin'], patterns: ['*'], maxDepth: 8 }
      }
    ]
  }
}

function makePackage(
  version: number,
  rulesObj: unknown,
  overrides: Partial<{ publishedAt: number; tamper: boolean; badSig: boolean; keyHex: string }> = {}
): { manifest: Record<string, unknown>; rulesText: string } {
  const rulesText = JSON.stringify(rulesObj, null, 2)
  const sha = createHash('sha256').update(rulesText, 'utf8').digest('hex')
  // tamper：签名用真内容算，但发布的文件内容被改（哈希不匹配场景）
  const published = overrides.tamper ? JSON.stringify(rulesObj, null, 2) + '\n// hacked' : rulesText
  const publishedSha = createHash('sha256').update(published, 'utf8').digest('hex')
  const signature =
    overrides.badSig
      ? 'ff'.repeat(64)
      : signRulesPayload(version, overrides.tamper ? sha : publishedSha, overrides.keyHex ?? privateKeyHex)
  return {
    manifest: {
      version,
      publishedAt: overrides.publishedAt ?? Date.now(),
      rulesSha256: overrides.tamper ? sha : publishedSha,
      signature
    },
    rulesText: published
  }
}

async function setupSite(
  dir: string,
  pkg: { manifest: Record<string, unknown>; rulesText: string }
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(pkg.manifest), 'utf8')
  await fs.writeFile(join(dir, 'junk-rules.json'), pkg.rulesText, 'utf8')
  const fileUrl = 'file:///' + dir.replace(/\\/g, '/')
  return fileUrl
}

describe('E2 签名（Ed25519，域分隔负载）', () => {
  it('正确签名通过验证', () => {
    const sha = 'ab'.repeat(32)
    const sig = signRulesPayload(3, sha, privateKeyHex)
    assert.equal(verifyRulesSignature(3, sha, sig, publicKeyHex), true)
  })

  it('任何字段被篡改都失败（version / sha / 公钥）', () => {
    const sha = 'ab'.repeat(32)
    const sig = signRulesPayload(3, sha, privateKeyHex)
    assert.equal(verifyRulesSignature(4, sha, sig, publicKeyHex), false, 'version 篡改')
    assert.equal(verifyRulesSignature(3, 'cd'.repeat(32), sig, publicKeyHex), false, 'sha 篡改')
    const wrong = generateRuleKeyPair()
    assert.equal(verifyRulesSignature(3, sha, sig, wrong.publicKeyHex), false, '公钥不符')
  })

  it('垃圾签名不抛异常', () => {
    assert.equal(verifyRulesSignature(1, 'ab'.repeat(32), 'zzzz', publicKeyHex), false)
    assert.equal(verifyRulesSignature(1, 'ab'.repeat(32), '', publicKeyHex), false)
  })
})

describe('E2 结构校验：防毒丸规则', () => {
  it('正常规则通过', () => {
    const rs = {
      schemaVersion: 1,
      updatedAt: '',
      rules: [{ ...goodRules().rules[0] }]
    }
    // 用真实引擎编译（loadRulesSync 在 applyRulesUpdate 内部调用；这里直接测结构函数）
    assert.equal(verifyRulesStructure(loadRulesSync(rs as never)).ok, true)
  })

  it('盘根 / Windows 本体作为根目录 → 拒绝', () => {
    const evil1 = loadRulesSync({
      schemaVersion: 1,
      rules: [{ ...goodRules().rules[0], id: 'GC-90', match: { roots: ['C:\\'], patterns: ['*.tmp'], maxDepth: 3 } }]
    } as never)
    const v1 = verifyRulesStructure(evil1)
    assert.equal(v1.ok, false)
    assert.ok(/盘根/.test(v1.reason ?? ''))

    const evil2 = loadRulesSync({
      schemaVersion: 1,
      rules: [{ ...goodRules().rules[0], id: 'GC-91', match: { roots: ['C:\\Windows'], patterns: ['*.tmp'], maxDepth: 3 } }]
    } as never)
    const v2 = verifyRulesStructure(evil2)
    assert.equal(v2.ok, false)
    assert.ok(/Windows 本体/.test(v2.reason ?? ''))
  })

  it('空清单 / 非法风险级 / id 不合规 → 拒绝', () => {
    assert.equal(verifyRulesStructure({ schemaVersion: 1, updatedAt: '', rules: [] } as never).ok, false)
    const badRisk = loadRulesSync({
      schemaVersion: 1,
      updatedAt: '',
      rules: [{ ...goodRules().rules[0], id: 'GC-92', risk: 'extreme' }]
    } as never)
    // loadRulesSync 的 risk 类型是字符串直通 → 结构校验应拦
    const v = verifyRulesStructure(badRisk)
    assert.equal(v.ok, false)
    assert.ok(/风险级别/.test(v.reason ?? ''))
    const badId = loadRulesSync({
      schemaVersion: 1,
      updatedAt: '',
      rules: [{ ...goodRules().rules[0], id: 'GARBAGE' }]
    } as never)
    assert.equal(verifyRulesStructure(badId).ok, false)
  })
})

describe('E2 applyRulesUpdate 端到端（本地包源 + 全链路校验）', () => {
  it('合法新版本：下载 → 验签 → 原子写入', async () => {
    const dir = join(tmpdir(), 'sg-e2-' + randomBytes(3).toString('hex'))
    const url = await setupSite(dir, makePackage(2, goodRules()))
    const target = join(dir, 'rules-out.json')
    const r = await applyRulesUpdate({
      currentVersion: 1,
      publicKeyHex,
      rulesFile: target,
      baseUrl: url,
      allowFileUrl: true
    })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.version, 2)
    const written = await fs.readFile(target, 'utf8')
    assert.ok(written.includes('GC-01'))
    // 临时文件应被 rename 消费掉
    await assert.rejects(fs.readFile(target + '.downloading'))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('未配置公钥 → 直接拒绝（防呆）', async () => {
    const dir = join(tmpdir(), 'sg-e2-' + randomBytes(3).toString('hex'))
    const url = await setupSite(dir, makePackage(2, goodRules()))
    const r = await applyRulesUpdate({ currentVersion: 1, publicKeyHex: '', rulesFile: join(dir, 'r.json'), baseUrl: url, allowFileUrl: true })
    assert.equal(r.ok, false)
    assert.ok(/公钥/.test(r.reason ?? ''))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('HTTP（非 HTTPS）源 → 拒绝', async () => {
    const r = await applyRulesUpdate({
      currentVersion: 1,
      publicKeyHex,
      rulesFile: 'x.json',
      baseUrl: 'http://example.com/rules',
      timeoutMs: 3000
    })
    assert.equal(r.ok, false)
    assert.ok(/HTTPS/.test(r.reason ?? ''))
  })

  it('内容被篡改（哈希不匹配）→ 拒绝且不触碰现有文件', async () => {
    const dir = join(tmpdir(), 'sg-e2-' + randomBytes(3).toString('hex'))
    const url = await setupSite(dir, makePackage(2, goodRules(), { tamper: true }))
    const target = join(dir, 'rules-out.json')
    await fs.writeFile(target, 'KEEP-OLD', 'utf8')
    const r = await applyRulesUpdate({ currentVersion: 1, publicKeyHex, rulesFile: target, baseUrl: url, allowFileUrl: true })
    assert.equal(r.ok, false)
    assert.ok(/哈希/.test(r.reason ?? ''))
    assert.equal(await fs.readFile(target, 'utf8'), 'KEEP-OLD', '现有规则必须原封不动')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('签名错误 → 拒绝', async () => {
    const dir = join(tmpdir(), 'sg-e2-' + randomBytes(3).toString('hex'))
    const url = await setupSite(dir, makePackage(2, goodRules(), { badSig: true }))
    const r = await applyRulesUpdate({ currentVersion: 1, publicKeyHex, rulesFile: join(dir, 'r.json'), baseUrl: url, allowFileUrl: true })
    assert.equal(r.ok, false)
    assert.ok(/签名/.test(r.reason ?? ''))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('版本回退 / 相同版本 → 拒绝（防重放）', async () => {
    const dir = join(tmpdir(), 'sg-e2-' + randomBytes(3).toString('hex'))
    const url = await setupSite(dir, makePackage(1, goodRules()))
    const r = await applyRulesUpdate({ currentVersion: 2, publicKeyHex, rulesFile: join(dir, 'r.json'), baseUrl: url, allowFileUrl: true })
    assert.equal(r.ok, false)
    assert.ok(/降级|重放|不高于/.test(r.reason ?? ''))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('过期签名（>180 天）→ 拒绝', async () => {
    const dir = join(tmpdir(), 'sg-e2-' + randomBytes(3).toString('hex'))
    const old = Date.now() - 200 * 24 * 3600 * 1000
    const url = await setupSite(dir, makePackage(9, goodRules(), { publishedAt: old }))
    const r = await applyRulesUpdate({ currentVersion: 1, publicKeyHex, rulesFile: join(dir, 'r.json'), baseUrl: url, allowFileUrl: true })
    assert.equal(r.ok, false)
    assert.ok(/过期/.test(r.reason ?? ''))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('毒丸规则（合法签名 + 盘根根目录）→ 结构校验拒绝', async () => {
    const dir = join(tmpdir(), 'sg-e2-' + randomBytes(3).toString('hex'))
    const evil = {
      schemaVersion: 1,
      rules: [
        {
          id: 'GC-99',
          name: 'evil',
          description: '',
          risk: 'low',
          defaultSelected: true,
          match: { roots: ['C:\\'], patterns: ['*'], maxDepth: 3 }
        }
      ]
    }
    const url = await setupSite(dir, makePackage(2, evil))
    const r = await applyRulesUpdate({ currentVersion: 1, publicKeyHex, rulesFile: join(dir, 'r.json'), baseUrl: url, allowFileUrl: true })
    assert.equal(r.ok, false)
    assert.ok(/结构校验|盘根/.test(r.reason ?? ''))
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('E2 版本存取', () => {
  it('parseStoredVersion：null / 非法 / 正常', () => {
    assert.equal(parseStoredVersion(null), 0)
    assert.equal(parseStoredVersion('not-json'), 0)
    assert.equal(parseStoredVersion(JSON.stringify('5')), 5)
    assert.equal(parseStoredVersion(JSON.stringify('-1')), 0)
  })
})
