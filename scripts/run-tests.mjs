/**
 * 单元测试运行器：用 esbuild 把 tests/unit/*.test.ts 逐个打成 CJS，再用 node:test 执行。
 *
 * 为什么不用 vitest / jest：
 *   本项目的原则是「零原生依赖 + 依赖最小化」。node:test 是 Node 内置，
 *   esbuild 已作为构建链依赖存在，因此测试链路不引入任何新依赖。
 *
 *   npm test          跑全部单元测试
 *   npm test -- pe    只跑文件名含 pe 的测试
 */
import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'tests', 'unit')
const outDir = join(root, '.tmp', 'tests')

if (!existsSync(srcDir)) {
  console.error('找不到 tests/unit 目录')
  process.exit(1)
}

// 清空输出目录，避免残留旧版本用例造成误判
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const filter = process.argv[2]
const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => !filter || f.includes(filter))

if (files.length === 0) {
  console.error(filter ? `没有匹配 "${filter}" 的测试文件` : '没有测试文件')
  process.exit(1)
}

// 路径别名与 tsconfig 保持一致；esbuild 的 alias 按前缀替换
const aliases = [
  '--alias:@shared=./packages/shared',
  '--alias:@scanner=./packages/scanner',
  '--alias:@junk=./packages/junk',
  '--alias:@graph-core=./packages/graph-core',
  '--alias:@rules=./packages/rules',
  '--alias:@native=./packages/native'
]

const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')

console.log(`打包 ${files.length} 个测试文件…`)
const outputs = []
for (const f of files) {
  const out = join(outDir, basename(f).replace(/\.ts$/, '.cjs'))
  execFileSync(
    process.execPath,
    [
      esbuild,
      join(srcDir, f),
      '--bundle',
      '--platform=node',
      '--target=node20',
      '--format=cjs',
      `--outfile=${out}`,
      '--external:electron',
      '--log-level=warning',
      ...aliases
    ],
    { cwd: root, stdio: 'inherit' }
  )
  outputs.push(out)
}

console.log('运行 node:test …\n')
// 显式传入文件列表：node --test 直接给目录在部分版本上会被当成模块解析而报错
const r = spawnSync(process.execPath, ['--test', ...outputs], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
