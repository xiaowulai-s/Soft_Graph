/**
 * 内核冒烟：用 esbuild 把 TS 测试打成 CJS 后交给 Node 运行。
 * 不启动 Electron，直接跑扫描内核（PE 解析 / 安全白名单 / 软件发现 / 依赖解析 / 垃圾规则）。
 *   npm run smoke
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.tmp')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
const bundle = join(outDir, 'smoke.cjs')

console.log('打包 tests/smoke.ts …')
execFileSync(process.execPath, [
  esbuild,
  'tests/smoke.ts',
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  `--outfile=${bundle}`,
  '--external:electron',
  '--log-level=warning'
], { cwd: root, stdio: 'inherit' })

console.log('运行冒烟测试 …\n')
const r = spawnSync(process.execPath, [bundle], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
