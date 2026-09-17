/**
 * CI 用的端到端驱动（v3.0.0 · G1）
 * ============================================================
 * 为什么需要它：`npm run e2e` 只负责"连接 9222 端口驱动交互"，
 * 应用的启动与关闭一直是手工步骤 —— 这也是 v2.0.0 里 CDP E2E 始终没进 CI 的原因。
 *
 * 本脚本把三件事串成一条命令：
 *   1. 启动带调试端口的应用（后台，detached）
 *   2. 轮询 `/json/version` 直到 CDP 就绪（最多 waitMs）
 *   3. 跑 tests/e2e.ts，收集结果 → 关闭应用 → 按结果退出
 *
 *   npm run e2e:ci                 默认端口 9222，等待 90s
 *   npm run e2e:ci -- --port 9333
 */
import { spawn, spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const pick = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = pick('port', '9222')
const WAIT_MS = Number(pick('wait', '90000'))

const require_ = createRequire(import.meta.url)

function log(...a) {
  console.log(...a)
}

// ── 0. 前置检查 ────────────────────────────────────────────
const mainEntry = join(root, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) {
  console.error(`未找到构建产物 ${mainEntry} —— 请先执行 npm run build`)
  process.exit(1)
}

let electronBin
try {
  electronBin = require_('electron')
} catch {
  console.error('无法解析 electron 可执行文件路径（npm ci 是否成功？）')
  process.exit(1)
}
if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
  console.error(`electron 路径异常：${electronBin}`)
  process.exit(1)
}

// ── 1. 启动应用 ────────────────────────────────────────────
// CI runner 上 GPU/沙箱不可用是常态，这两个开关是 Electron 在容器里的标准配方
const electronArgs = [
  '.',
  `--remote-debugging-port=${PORT}`,
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage'
]

// 关键：某些宿主 shell（例如 Electron 应用的集成终端）会带上 ELECTRON_RUN_AS_NODE=1，
// 这个变量会让 electron.exe 退化成**纯 Node** 运行 —— 于是 require('electron') 返回
// 可执行文件路径字符串，主进程第一行访问 app 就崩，表现为「端口永远不就绪」。
// 启动应用时必须把它摘掉。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

log(`启动应用：${electronBin} ${electronArgs.join(' ')}`)
// 不看住 stdio 的话，启动失败只会表现为「端口一直不就绪」，完全无从排查
const appLog = []
const app = spawn(electronBin, electronArgs, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  detached: false,
  env
})
const collect = (chunk) => {
  const s = String(chunk)
  appLog.push(s)
  if (appLog.length > 200) appLog.shift()
}
app.stdout?.on('data', collect)
app.stderr?.on('data', collect)
app.on('exit', (code, sig) => log(`应用进程退出：code=${code} signal=${sig}`))

let finished = false
const shutdown = () => {
  if (finished) return
  finished = true
  try {
    app.kill()
  } catch {
    /* 已退出 */
  }
}
process.on('exit', shutdown)
process.on('SIGINT', () => {
  shutdown()
  process.exit(130)
})
process.on('SIGTERM', () => {
  shutdown()
  process.exit(143)
})

// ── 2. 等 CDP 就绪 ─────────────────────────────────────────
const deadline = Date.now() + WAIT_MS
let ready = false
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (res.ok) {
      const info = await res.json()
      log(`CDP 就绪：${info.Browser ?? 'Electron'} · ${info['Protocol-Version'] ?? ''}`)
      ready = true
      break
    }
  } catch {
    /* 尚未监听 */
  }
  await new Promise((r) => setTimeout(r, 1000))
}

if (!ready) {
  console.error(`等待 ${WAIT_MS}ms 后 CDP 仍未就绪（端口 ${PORT}）`)
  if (appLog.length > 0) {
    console.error('—— 应用输出（末尾 40 行）——')
    console.error(appLog.slice(-40).join('').trim())
  } else {
    console.error('应用没有任何输出：通常是 GUI 会话不可用（无桌面 / 容器环境），而非脚本问题')
  }
  shutdown()
  process.exit(1)
}

// ── 3. 打包并跑端到端 ──────────────────────────────────────
const outDir = join(root, '.tmp')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
const bundle = join(outDir, 'e2e.mjs')

log('打包 tests/e2e.ts …')
execFileSync(
  process.execPath,
  ['node_modules/esbuild/bin/esbuild', 'tests/e2e.ts', '--bundle', '--platform=node', '--target=node20', '--format=esm', `--outfile=${bundle}`, '--log-level=warning'],
  { cwd: root, stdio: 'inherit' }
)

log(`驱动真实交互（端口 ${PORT}）…\n`)
const r = spawnSync(process.execPath, [bundle, PORT, '.tmp'], { cwd: root, stdio: 'inherit' })
const status = r.status ?? 1

log(status === 0 ? '\n端到端通过' : `\n端到端失败（退出码 ${status}）`)
shutdown()
process.exit(status)
