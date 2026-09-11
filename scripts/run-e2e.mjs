/**
 * 真机端到端：把 tests/e2e.ts 打包后运行，通过 CDP 驱动已启动的应用。
 *
 * 前置条件（重要）：
 *   1. 先启动带调试端口的应用：
 *        electron . --remote-debugging-port=9222
 *      沙箱/受限环境下可能需要 --no-sandbox --disable-gpu 等开关。
 *   2. 本脚本需要能访问 127.0.0.1:9222（某些受限 shell 里 localhost 不可达，
 *      请在普通终端而不是沙箱 shell 中执行）。
 *
 *   npm run e2e
 */
import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] ?? '9222'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.tmp')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
const bundle = join(outDir, 'e2e.mjs')

console.log('打包 tests/e2e.ts …')
execFileSync(process.execPath, [
  esbuild,
  'tests/e2e.ts',
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=esm',
  `--outfile=${bundle}`,
  '--log-level=warning'
], { cwd: root, stdio: 'inherit' })

console.log(`连接 127.0.0.1:${port} 并驱动真实交互 …\n`)
const r = spawnSync(process.execPath, [bundle, port, '.tmp'], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
