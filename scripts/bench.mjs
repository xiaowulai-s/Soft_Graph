/**
 * 性能基准运行器：把 tests/bench.ts 打成 CJS 后执行。
 *   npm run bench              完整基准
 *   npm run bench -- --quick   快速基准
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.tmp', 'bench')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
const bundle = join(outDir, 'bench.cjs')

console.log('打包 tests/bench.ts …')
execFileSync(
  process.execPath,
  [
    esbuild,
    'tests/bench.ts',
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
  '--alias:@native=./packages/native'
  ],
  { cwd: root, stdio: 'inherit' }
)

const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
