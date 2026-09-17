/**
 * 单元测试运行器：用 esbuild 把 tests/unit/*.test.ts 逐个打成 CJS，再用 node:test 执行。
 *
 * 为什么不用 vitest / jest：
 *   本项目的原则是「零原生依赖 + 依赖最小化」。node:test 是 Node 内置，
 *   esbuild 已作为构建链依赖存在，因此测试链路不引入任何新依赖。
 *
 *   npm test          跑全部单元测试
 *   npm test -- pe    只跑文件名含 pe 的测试
 *   npm run test:cov  跑测试并输出还原到 TS 源文件的覆盖率（v3.0.0 · G2）
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

// 清空输出目录，避免残留旧版本用例造成误判。
// 注意：某些受管控环境（沙箱 / 安全软件）会拒绝整目录删除，直接 rmSync 会把
// 整个测试链路打断在第一步。这里做降级：整目录删不掉就逐个清旧产物。
try {
  rmSync(outDir, { recursive: true, force: true })
} catch {
  try {
    if (existsSync(outDir)) {
      for (const f of readdirSync(outDir)) {
        if (f.endsWith('.cjs') || f.endsWith('.cjs.map')) {
          try {
            rmSync(join(outDir, f), { force: true })
          } catch {
            /* 单个文件删不掉也不该中断测试 */
          }
        }
      }
    }
  } catch {
    /* 目录不可读时跳过清理 */
  }
}
mkdirSync(outDir, { recursive: true })

// --coverage 与过滤参数可以共存：只有不以 -- 开头的参数才算过滤词
const wantCoverage = process.argv.includes('--coverage')
const covDir = join(root, '.tmp', 'coverage', 'v8')
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'))
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
      // 覆盖率需要 sourcemap 才能把产物行还原回 TS 源文件
      ...(wantCoverage ? ['--sourcemap'] : []),
      '--log-level=warning',
      ...aliases
    ],
    { cwd: root, stdio: 'inherit' }
  )
  outputs.push(out)
}

if (wantCoverage) {
  rmSync(covDir, { recursive: true, force: true })
  mkdirSync(covDir, { recursive: true })
}

console.log('运行 node:test …\n')
// 显式传入文件列表：node --test 直接给目录在部分版本上会被当成模块解析而报错
const r = spawnSync(process.execPath, ['--test', ...outputs], {
  cwd: root,
  stdio: 'inherit',
  env: wantCoverage ? { ...process.env, NODE_V8_COVERAGE: covDir } : process.env
})

let status = r.status ?? 1
if (wantCoverage && status === 0) {
  const c = spawnSync(process.execPath, [join(root, 'scripts', 'coverage.mjs'), covDir, outDir, '--md'], {
    cwd: root,
    stdio: 'inherit'
  })
  if (c.status !== 0) status = c.status ?? 1
}
process.exit(status)
