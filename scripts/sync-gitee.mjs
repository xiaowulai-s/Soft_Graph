#!/usr/bin/env node
/**
 * v3.2 D1 收尾：把当前版本的 latest.yml + Setup 安装包同步到 Gitee 镜像
 * （tag 固定为 stable，应用 updater 的备用源指向它）。
 *
 * 前置：
 *   1. Gitee 建仓库 `softgraph-mirror`（与 updater.ts 的 FALLBACK_FEED 对应）
 *   2. 设置环境变量 GITEE_TOKEN（私人令牌，scope: projects）
 *   3. 先 `npm run pack:win`（本地有 release/<version>/latest.yml 与 Setup exe）
 *
 * 用法：node scripts/sync-gitee.mjs [version]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'

let GITEE_OWNER = 'xiaowulai-s' // 实际登录名在启动时动态获取覆盖
const GITEE_REPO = 'softgraph-mirror'
const TAG = 'stable'
const root = process.cwd()
const version = process.argv[2] ?? JSON.parse(readFileSync('package.json', 'utf8')).version
const FRESH = process.argv.includes('--fresh') // 删除现有 stable Release 重建（版本更替用）
const token = process.env.GITEE_TOKEN

if (!token) {
  console.error('缺少 GITEE_TOKEN 环境变量（Gitee 私人令牌）')
  process.exit(1)
}
const assetDir = join(root, 'release', version)
// 本地产物名带空格（SoftGraph Setup x.y.z.exe），Gitee/latest.yml 用横线规范名
const setupLocal = existsSync(join(assetDir, `SoftGraph-Setup-${version}.exe`))
  ? `SoftGraph-Setup-${version}.exe`
  : `SoftGraph Setup ${version}.exe`
const files = ['latest.yml', setupLocal].filter((f) => existsSync(join(assetDir, f)))
if (!files.includes('latest.yml')) {
  console.error(`latest.yml 不存在：${join(assetDir, 'latest.yml')}（先 npm run pack:win）`)
  process.exit(1)
}

function req(path, { method = 'GET', body, host = 'gitee.com' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = https.request(
      {
        host,
        port: 443,
        path,
        method,
        timeout: 600_000,
        headers: {
          'User-Agent': 'sg-sync',
          'Content-Type': 'application/json',
          Authorization: `token ${token}`,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let t = ''
        res.on('data', (d) => (t += d))
        res.on('end', () => resolve({ status: res.statusCode, text: t }))
      }
    )
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

/** Gitee 附件上传要求 multipart/form-data（file 字段） */
function uploadMultipart(uploadPath, filename, fileBuf) {
  const boundary = '----sgsync' + Date.now()
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  )
  const post = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([pre, fileBuf, post])
  const sep = uploadPath.includes('?') ? '&' : '?'
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: 'gitee.com',
        port: 443,
        path: `${uploadPath}${sep}access_token=${encodeURIComponent(token)}`,
        method: 'POST',
        timeout: 600_000,
        headers: {
          'User-Agent': 'sg-sync',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      },
      (res) => {
        let t = ''
        res.on('data', (d) => (t += d))
        res.on('end', () => resolve({ status: res.statusCode, text: t }))
      }
    )
    r.on('error', reject)
    r.write(body)
    r.end()
  })
}

async function ensureOwner() {
  const r = await req('/api/v5/user')
  if (r.status !== 200) throw new Error(`获取 Gitee 身份失败：HTTP ${r.status} ${r.text.slice(0, 200)}`)
  GITEE_OWNER = JSON.parse(r.text).login
  console.log(`Gitee 身份：${GITEE_OWNER}`)
}

let DEFAULT_BRANCH = 'master'
async function ensureRepo() {
  const r = await req(`/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}`)
  if (r.status === 200) {
    DEFAULT_BRANCH = JSON.parse(r.text).default_branch ?? 'master'
    console.log(`镜像仓库已存在（默认分支 ${DEFAULT_BRANCH}）`)
    return
  }
  console.log('创建镜像仓库 softgraph-mirror …')
  const c = await req('/api/v5/user/repos', {
    method: 'POST',
    body: {
      name: GITEE_REPO,
      description: 'SoftGraph 应用自更新 Gitee 镜像（stable Release 承载 latest.yml 与安装包）',
      private: false,
      auto_init: true
    }
  })
  if (c.status !== 201) throw new Error(`创建仓库失败：HTTP ${c.status} ${c.text.slice(0, 200)}`)
  console.log('✓ 仓库已创建')
  // Gitee 建仓默认私有且 private 参数不可靠 —— PATCH 转公开（私有仓库附件下载 403）
  const pub = await req(`/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}`, {
    method: 'PATCH',
    body: { name: GITEE_REPO, private: false, visibility: 'public' }
  })
  console.log(`${pub.status === 200 ? '✓' : '✗'} 仓库转公开（HTTP ${pub.status}）`)
}

async function main() {
  await ensureOwner()
  await ensureRepo()
  // 1. 找 stable release（存在则复用，不存在则创建）
  let release = null
  try {
    const r = await req(`/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/tags/${TAG}`)
    if (r.status === 200) release = JSON.parse(r.text)
  } catch {
    /* ignore */
  }
  if (release?.id && FRESH) {
    const d = await req(`/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release.id}`, { method: 'DELETE' })
    console.log(`删除旧 stable Release（HTTP ${d.status}）—— 附件随删`)
    release = null
  }
  if (!release?.id) {
    const r = await req(`/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases`, {
      method: 'POST',
      body: {
        tag_name: TAG,
        name: 'stable（自动更新镜像）',
        body: `SoftGraph ${version} 自更新镜像。latest.yml 指向本 Release 附件。`,
        target_commitish: DEFAULT_BRANCH,
        prerelease: false
      }
    })
    if (r.status !== 201) throw new Error(`创建 Release 失败：HTTP ${r.status} ${r.text.slice(0, 200)}`)
    release = JSON.parse(r.text)
    console.log('已创建 stable Release')
  }

  // 2. 逐个上传附件（同名跳过 —— Gitee 不支持覆盖，需先手工删除）
  for (const f of files) {
    const remoteName = f.replace(/\s+/g, '-') // 与 latest.yml 内 url 及 GitHub 规范一致
    const exists = release.assets?.some((a) => a.name === remoteName)
    if (exists) {
      console.log(`跳过（已存在）：${remoteName} —— Gitee 不支持覆盖，如需更新请先到 Gitee 删除该附件`)
      continue
    }
    const buf = readFileSync(join(assetDir, f))
    const r = await uploadMultipart(
      `/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release.id}/attach_files?filename=${encodeURIComponent(remoteName)}`,
      remoteName,
      buf
    )
    console.log(`${r.status === 201 ? '✓' : '✗'} 上传 ${remoteName}（HTTP ${r.status}）`)
  }
  console.log(`\n完成。应用备用源：${'https://gitee.com'}/${GITEE_OWNER}/${GITEE_REPO}/releases/download/${TAG}`)
}

main().catch((e) => {
  console.error('同步失败：', e.message)
  process.exit(1)
})
