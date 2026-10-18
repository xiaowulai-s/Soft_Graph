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

const GITEE_OWNER = 'xiaowulai-s'
const GITEE_REPO = 'softgraph-mirror'
const TAG = 'stable'
const root = process.cwd()
const version = process.argv[2] ?? JSON.parse(readFileSync('package.json', 'utf8')).version
const token = process.env.GITEE_TOKEN

if (!token) {
  console.error('缺少 GITEE_TOKEN 环境变量（Gitee 私人令牌）')
  process.exit(1)
}
const assetDir = join(root, 'release', version)
const files = ['latest.yml', `SoftGraph-Setup-${version}.exe`].filter((f) => existsSync(join(assetDir, f)))
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

async function main() {
  // 1. 找 stable release（存在则复用，不存在则创建）
  let release = null
  try {
    const r = await req(`/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/tags/${TAG}`)
    if (r.status === 200) release = JSON.parse(r.text)
  } catch {
    /* ignore */
  }
  if (!release?.id) {
    const r = await req(`/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases`, {
      method: 'POST',
      body: {
        tag_name: TAG,
        name: 'stable（自动更新镜像）',
        body: `SoftGraph ${version} 自更新镜像。latest.yml 指向本 Release 附件。`,
        target_commitish: 'master',
        prerelease: false
      }
    })
    if (r.status !== 201) throw new Error(`创建 Release 失败：HTTP ${r.status} ${r.text.slice(0, 200)}`)
    release = JSON.parse(r.text)
    console.log('已创建 stable Release')
  }

  // 2. 逐个上传附件（同名跳过 —— Gitee 不支持覆盖，需先手工删除）
  for (const f of files) {
    const exists = release.assets?.some((a) => a.name === f)
    if (exists) {
      console.log(`跳过（已存在）：${f} —— Gitee 不支持覆盖，如需更新请先到 Gitee 删除该附件`)
      continue
    }
    const buf = readFileSync(join(assetDir, f))
    const r = await req(
      `/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release.id}/attach_files?filename=${encodeURIComponent(f)}`,
      { method: 'POST', body: { file: buf.toString('base64') } }
    )
    console.log(`${r.status === 201 ? '✓' : '✗'} 上传 ${f}（HTTP ${r.status}）`)
  }
  console.log(`\n完成。应用备用源：${'https://gitee.com'}/${GITEE_OWNER}/${GITEE_REPO}/releases/download/${TAG}`)
}

main().catch((e) => {
  console.error('同步失败：', e.message)
  process.exit(1)
})
