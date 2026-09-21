/**
 * 通用 TS 脚本运行器：esbuild 打包任意 tests/*.ts 后用 Node 执行。
 *   node scripts/run-ts.mjs tests/samples.ts collect
 *   node scripts/run-ts.mjs tests/smoke.ts
 *   node scripts/run-ts.mjs tests/bench.ts --quick
 *
 * 统一维护路径别名与打包参数，避免每个脚本各写一份。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = process.argv[2]
if (!entry) {
  console.error('用法：node scripts/run-ts.mjs <入口 .ts> [参数…]')
  process.exit(1)
}
if (!existsSync(join(root, entry))) {
  console.error(`入口不存在：${entry}`)
  process.exit(1)
}

const outDir = join(root, '.tmp', 'ts')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, basename(entry).replace(/\.ts$/, '.cjs'))
const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')

execFileSync(
  process.execPath,
  [
    esbuild,
    entry,
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=cjs',
    `--outfile=${bundle}`,
    '--external:electron',
    '--log-level=warning',
    '--alias:@shared=./packages/shared',
    '--alias:@scanner=./packages/scanner',
    '--alias:@junk=./packages/junk',
    '--alias:@graph-core=./packages/graph-core',
    '--alias:@rules=./packages/rules',
  '--alias:@native=./packages/native',
  '--alias:@main=./apps/desktop/src/main'
  ],
  { cwd: root, stdio: 'inherit' }
)

const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
  // libuv 线程池只在进程初始化时读取环境变量，必须在 spawn 时注入（并发遍历依赖它）
  env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '16' }
})
process.exit(r.status ?? 1)
