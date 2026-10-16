/**
 * E2 在线更新真机验证：用「内置公钥」走完整更新链路
 *  1. 模拟老客户端（本地规则版本 0）从本地包源应用 v2 包 → 成功 15 条
 *  2. 幂等/防降级：同版本重放 → 拒绝
 *  3. 篡改检测：改动一个字节 → 哈希不匹配拒绝
 *  4. 毒丸防线：伪造包（walk + 裸 * + 危险根）→ 结构校验拒绝
 */
import { mkdtemp, writeFile, readFile, cp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyRulesUpdate } from '@junk/rules-update'

async function main(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'sg-e2-live-'))
  try {
    const site = join(base, 'site')
    const target = join(base, 'rules-out.json')
    await mkdir(site, { recursive: true })
    await cp('packages/rules/dist/manifest.json', join(site, 'manifest.json'))
    await cp('packages/rules/dist/junk-rules.json', join(site, 'junk-rules.json'))
    const url = pathToFileURL(join(site, 'x')).href.replace(/x$/, '')

    // 1) 老客户端（version 0）应用 v2 包 —— 使用内置公钥（不传 publicKeyHex）
    const r1 = await applyRulesUpdate({
      currentVersion: 0,
      rulesFile: target,
      baseUrl: url,
      allowFileUrl: true
    })
    console.log('1) 应用 v2 包:', JSON.stringify(r1))
    if (!r1.ok || r1.ruleCount !== 15) throw new Error('应用失败')
    const written = JSON.parse(await readFile(target, 'utf8')) as { rules: { id: string }[] }
    const ids = written.rules.map((r) => r.id)
    if (!ids.includes('GC-14') || !ids.includes('GC-15')) throw new Error('GC-14/15 未到达')
    console.log('   规则数:', ids.length, '| 含 GC-14:', ids.includes('GC-14'), '| 含 GC-15:', ids.includes('GC-15'))

    // 2) 防降级/重放：currentVersion 已是 2
    const r2 = await applyRulesUpdate({ currentVersion: 2, rulesFile: target, baseUrl: url, allowFileUrl: true })
    console.log('2) 重放防御:', r2.ok ? '❌ 不应成功' : `✅ ${r2.reason}`)

    // 3) 篡改：改规则文件一个字节
    const tampered = join(base, 'tampered')
    await mkdir(tampered, { recursive: true })
    await cp(join(site, 'manifest.json'), join(tampered, 'manifest.json'))
    const rules = await readFile(join(site, 'junk-rules.json'), 'utf8')
    await writeFile(join(tampered, 'junk-rules.json'), rules.replace('"_version": 2', '"_version": 9'))
    const r3 = await applyRulesUpdate({
      currentVersion: 0,
      rulesFile: join(base, 'out3.json'),
      baseUrl: pathToFileURL(join(tampered, 'x')).href.replace(/x$/, ''),
      allowFileUrl: true
    })
    console.log('3) 篡改防御:', r3.ok ? '❌ 不应成功' : `✅ ${r3.reason}`)

    // 4) 毒丸：伪造 walk + 裸 * + %USERPROFILE% 根（合法结构但不进白名单）
    const evilSite = join(base, 'evil')
    await mkdir(evilSite, { recursive: true })
    const evilRules = {
      schemaVersion: 1,
      updatedAt: '2026-10-16',
      rules: [
        {
          id: 'GC-16',
          name: '恶意清理',
          description: '毒丸',
          risk: 'low',
          defaultSelected: true,
          match: { roots: ['%USERPROFILE%'], patterns: ['*'], maxDepth: 8 }
        }
      ]
    }
    const evilText = JSON.stringify(evilRules)
    const { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign } = await import('node:crypto')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubHex = publicKey.export({ format: 'der', type: 'spki' }).toString('hex')
    const priv = createPrivateKey({ key: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer, format: 'der', type: 'pkcs8' })
    const sha = createHash('sha256').update(evilText, 'utf8').digest('hex')
    const sig = sign(null, Buffer.from(`softgraph-rules:3:${sha}`, 'utf8'), priv).toString('hex')
    // 用「内置公钥」验不了伪造者自己的签名 —— 但为了验证结构防线本身，用内置公钥签一份合法结构的毒丸
    // 真实防线有两层：签名（内置公钥）+ 结构校验。此处直接测结构校验这一层。
    const pubkeyEmbedded = '302a300506032b657003210059039f2969afde88cb219df1d0e326a12ec68226c83ad2b7dcbe2156ed31685c'
    void pubHex
    // 用内嵌公钥对应的假想私钥我们拿不到 —— 所以毒丸测试走结构函数（签名层由单测覆盖）
    const { loadRulesSync } = await import('@junk/engine')
    const { verifyRulesStructure } = await import('@junk/rules-update')
    void pubkeyEmbedded
    const parsed = JSON.parse(evilText)
    const compiled = loadRulesSync(parsed as never)
    const v4 = verifyRulesStructure(compiled)
    console.log('4) 毒丸结构防线:', v4.ok ? '❌ 不应通过' : `✅ ${v4.reason}`)

    console.log('E2-LIVE-CHECK-DONE')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL:', (e as Error).message)
  process.exit(1)
})
