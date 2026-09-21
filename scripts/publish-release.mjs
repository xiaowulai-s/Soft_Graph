#!/usr/bin/env node
/**
 * 一键发布 Release（G4：把 v1.0.0 手工验证过的 REST API 流程固化）
 *
 * 前置：
 *   1. 已 tag：git tag vX.Y.Z（脚本会用当前 package.json version 自动打 tag 并推送）
 *   2. 凭据：系统凭据管理器存有 GitHub PAT（scope 含 repo）——通过 `git credential fill` 获取
 *   3. 附件：release/<version>/ 下已有 electron-builder 产物（npm run pack:win）
 *
 * 用法：
 *   npm run release                          # 自动取 package.json version
 *   node scripts/publish-release.mjs --notes docs/RELEASE_NOTES_vX.Y.Z.md
 *
 * 行为：
 *   1. 取凭据（不打印）→ 创建/复用 Release
 *   2. 上传 release/<v>/ 下全部 .exe（重名跳过；422 = 已存在同名附件）
 *   3. 正文用 --notes 指定的 md（缺省 docs/RELEASE_NOTES_v<version>.md）
 *   4. 生成并**上传** SHA256SUMS.txt —— 发布说明里写的「见附件 SHA256SUMS.txt」
 *      必须真有其物，只在本地生成等于留一个假指引
 *   5. 网络失败自动重试（GitHub 直连时通时断，见 docs/05）
 *
 * `--dry-run` 是**全链路只读**：不创建 tag、不创建 Release、不上传附件，
 * 只打印将要做什么（含每个附件的 sha256 与体积）。发布前想核对就先跑它。
 *
 * 已知坑（v1.0.0 实测，脚本已处理）：
 *   - 附件名空格被 GitHub 归一化为点 → 上传前把本地文件名规范化为连字符
 *   - 大附件上传慢 → 超时 900s
 *   - 下载校验须走签名地址（匿名 HEAD 404 是正常现象）
 */

import { execFileSync, execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import https from 'node:https'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const OWNER = 'xiaowulai-s'
const REPO = 'Soft_Graph'

const args = process.argv.slice(2)
const notesIdx = args.indexOf('--notes')
const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : join(root, 'docs', `RELEASE_NOTES_${tag}.md`)

const log = (...a) => console.log(...a)

// ── 凭据（git credential fill，全程不打印） ──
function getToken() {
  const input = `protocol=https\nhost=github.com\n\n`
  const out = execFileSync('git', ['credential', 'fill'], { input, encoding: 'utf8' })
  const m = out.match(/password=(.+)/)
  if (!m) throw new Error('凭据管理器中未找到 GitHub PAT')
  return m[1].trim()
}

function req(path, { method = 'GET', body, host = 'api.github.com', token, raw = false, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null
    const r = https.request(
      {
        host,
        port: 443,
        path,
        method,
        timeout,
        headers: {
          'User-Agent': 'softgraph-release',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {})
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (d) => chunks.push(d))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const status = res.statusCode ?? 0
          if (status >= 400) {
            const err = new Error(`HTTP ${status}: ${buf.toString('utf8').slice(0, 300)}`)
            err.status = status
            return reject(err)
          }
          resolve(raw ? buf : JSON.parse(buf.toString('utf8') || '{}'))
        })
      }
    )
    r.on('error', reject)
    r.on('timeout', () => r.destroy(new Error('timeout')))
    if (data) r.write(data)
    r.end()
  })
}

async function withRetry(label, fn, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn()
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e
      log(`  ${label} 失败（${e.message?.slice(0, 80)}），${i < tries ? `10s 后重试 ${i}/${tries - 1}` : '放弃'}`)
      if (i < tries) await new Promise((r) => setTimeout(r, 10_000))
      else throw e
    }
  }
}

async function main() {
  const token = getToken()
  // dry-run 的含义是「对外什么都不产生」。原先它只挡上传，结果一次 --dry-run
  // 就会把 tag 和**公开 Release** 建出去 —— 这与它自己的提示语相反，也是发布流程里
  // 最容易误伤的一步，因此提前到这里判定。
  const dry = args.includes('--dry-run') || process.env.SG_RELEASE_DRY === '1'
  if (dry) log('（dry-run 模式：不创建 tag、不创建 Release、不上传附件）')
  log(`凭据就绪（PAT scope=repo）。发布 ${REPO} ${tag}`)

  // 1. 确保 tag 存在（无则创建并推送；404 = 尚不存在，属正常路径，不重试）
  let tags = null
  try {
    tags = await req(`/repos/${OWNER}/${REPO}/git/ref/tags/${tag}`, { token })
  } catch (e) {
    if (e.status !== 404) throw e
  }
  if (!tags?.object?.sha) {
    if (dry) log(`  [dry] 将在远端 main HEAD 上创建 tag ${tag}`)
    else {
    log(`创建 tag ${tag} …`)
    const commit = await req(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, { token })
    await withRetry('create tag', () =>
      req(`/repos/${OWNER}/${REPO}/git/refs`, {
        method: 'POST',
        token,
        body: { ref: `refs/tags/${tag}`, sha: commit.object.sha }
      })
    )
    }
  }

  // 2. 创建或复用 Release
  let release
  try {
    release = await req(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`, { token })
    log(`Release ${tag} 已存在（id=${release.id}），跳过创建`)
  } catch (e) {
    if (e.status !== 404) throw e
    if (dry) {
      log('  [dry] 将创建 Release（正文取发布说明文件）')
      release = { id: 0 }
    } else {
    const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : `SoftGraph ${tag}`
    log(`创建 Release ${tag} …`)
    release = await withRetry('create release', () =>
      req(`/repos/${OWNER}/${REPO}/releases`, {
        method: 'POST',
        token,
        body: { tag_name: tag, name: `SoftGraph ${tag}`, body: notes, draft: false, prerelease: false }
      })
    )
    }
  }

  // 3. 上传附件（跳过已存在的：按名字或按字节大小匹配，防止误传重复附件）
  const assetDir = join(root, 'release', version)
  if (!existsSync(assetDir)) throw new Error(`附件目录不存在：${assetDir}（先 npm run pack:win）`)
  const remote = release.id ? await req(`/repos/${OWNER}/${REPO}/releases/${release.id}/assets`, { token }) : []
  const byName = new Set(remote.map((a) => a.name))
  const bySize = new Map(remote.map((a) => [a.size, a.name]))

  const files = readdirSync(assetDir).filter((f) => f.endsWith('.exe') || f.endsWith('.zip'))

  // 校验值清单**先写好再进上传循环**：发布说明里写的是「见附件 SHA256SUMS.txt」，
  // 只在本地生成而不上传，等于让 Release 指向一个不存在的附件。
  const sumsFile = join(assetDir, 'SHA256SUMS.txt')
  writeFileSync(
    sumsFile,
    files.map((f) => `${createHash('sha256').update(readFileSync(join(assetDir, f))).digest('hex')}  ${f.replace(/\s+/g, '-')}`).join('\n') + '\n',
    'utf8'
  )
  log(`SHA256SUMS.txt 已生成（${files.length} 项）`)

  for (const f of [...files, 'SHA256SUMS.txt']) {
    const name = f.replace(/\s+/g, '-') // GitHub 会把空格归一化成点，主动规范化
    const buf = readFileSync(join(assetDir, f))
    if (byName.has(name)) {
      log(`  跳过（同名已存在）：${name}`)
      continue
    }
    if (bySize.has(buf.length)) {
      // 同大小不同名 = 同一文件的历史命名 —— 提示但跳过，避免产生重复附件
      log(`  跳过（同字节数已存在为 ${bySize.get(buf.length)}）：${name} —— 如确认是新文件请手动上传`)
      continue
    }
    const sha = createHash('sha256').update(buf).digest('hex')
    if (dry) {
      log(`  [dry] 将上传 ${name}（${(buf.length / 1024 / 1024).toFixed(2)} MB）sha256=${sha}`)
      continue
    }
    log(`  上传 ${name}（${(buf.length / 1024 / 1024).toFixed(2)} MB）…`)
    await withRetry(`upload ${name}`, () =>
      req(`/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        host: 'uploads.github.com',
        token,
        body: buf,
        raw: true,
        timeout: 900_000
      })
    )
    log(`  ✓ ${name} sha256=${sha}`)
  }

  log(dry ? `\n✅ dry-run 结束：未创建 tag / Release / 附件（本地 SHA256SUMS.txt 已生成）` : `\n✅ 发布完成：https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`)
  if (!dry) log(`附件含 SHA256SUMS.txt（本地副本：${sumsFile}）`)
}

main().catch((e) => {
  console.error('发布失败：', e.message)
  process.exit(1)
})
