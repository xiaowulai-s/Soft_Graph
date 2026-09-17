/**
 * 覆盖率聚合器（v3.0.0 · G2）
 * ============================================================
 * 为什么自己写：
 *   测试链路用 esbuild 把 tests/unit/*.test.ts 打成单文件 CJS 再交给 node:test，
 *   Node 内置的 --experimental-test-coverage 报告的是 **打包产物** 的行覆盖率，
 *   不会按 sourcemap 还原到 TS 源文件 —— 报告里全是 .tmp/tests/xxx.cjs，没有参考价值。
 *
 *   本项目原则是「依赖最小化」，因此不引入 c8 / nyc / istanbul，而是：
 *     1. esbuild 打包时同时产出 .cjs.map
 *     2. 用 NODE_V8_COVERAGE 拿 V8 的字节级 range 覆盖率
 *     3. 把 range 的字节偏移 → 产物行列 → 经 sourcemap 还原为源文件行列
 *
 *   分母取「sourcemap 中出现过的（源文件, 行）」集合 —— 即真正生成了代码的行，
 *   注释与空行天然不进分母；分子取 V8 报告 count > 0 的行。
 *
 * 用法（由 run-tests.mjs 调用，也可单独跑）：
 *   node scripts/coverage.mjs <v8Dir> <bundleDir> [--md]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 VLQ 解码：sourcemap 的 mappings 字段 */
function parseMappings(mappings) {
  const lines = []
  let cur = []
  let genCol = 0
  let srcIdx = 0
  let srcLine = 0
  let srcCol = 0
  let i = 0

  while (i < mappings.length) {
    const c = mappings[i]
    if (c === ';') {
      lines.push(cur)
      cur = []
      genCol = 0
      i++
      continue
    }
    if (c === ',') {
      i++
      continue
    }
    // 连续读 1~5 个字段
    const fields = []
    while (i < mappings.length && mappings[i] !== ';' && mappings[i] !== ',') {
      let result = 0
      let shift = 0
      let cont = true
      while (cont) {
        const digit = B64.indexOf(mappings[i++])
        if (digit < 0) break
        cont = (digit & 32) !== 0
        result += (digit & 31) << shift
        shift += 5
      }
      fields.push(result & 1 ? -(result >>> 1) : result >>> 1)
    }
    if (fields.length === 0) break
    genCol += fields[0]
    if (fields.length >= 4) {
      srcIdx += fields[1]
      srcLine += fields[2]
      srcCol += fields[3]
    }
    cur.push({ genCol, srcIdx, srcLine, srcCol })
  }
  lines.push(cur)
  return lines
}

/** 按字节构建行首偏移表，用于字节 offset → 行列 */
function buildLineIndex(buf) {
  const starts = [0]
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) starts.push(i + 1)
  }
  starts.push(buf.length)
  return starts
}

function offsetToLine(starts, offset) {
  let lo = 0
  let hi = starts.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo, col: offset - starts[lo] }
}

/** 取一行内 col 落在 [fromCol, toCol] 的段 */
function segmentsInRow(row, fromCol, toCol) {
  if (!row || row.length === 0) return []
  const out = []
  for (const seg of row) {
    if (seg.genCol >= fromCol && seg.genCol <= toCol) out.push(seg)
  }
  return out
}

const SOURCE_CACHE = new Map()

function loadSourceMap(mapPath) {
  if (SOURCE_CACHE.has(mapPath)) return SOURCE_CACHE.get(mapPath)
  let parsed = null
  try {
    const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
    parsed = {
      sources: raw.sources || [],
      lines: parseMappings(raw.mappings || '')
    }
  } catch {
    parsed = null
  }
  SOURCE_CACHE.set(mapPath, parsed)
  return parsed
}

function main() {
  const v8Dir = process.argv[2]
  const bundleDir = process.argv[3]
  const wantMd = process.argv.includes('--md')
  if (!v8Dir || !bundleDir) {
    console.error('用法：node scripts/coverage.mjs <v8Dir> <bundleDir> [--md]')
    process.exit(1)
  }
  if (!existsSync(v8Dir)) {
    console.error(`V8 覆盖率目录不存在：${v8Dir}（测试进程未产出覆盖率？）`)
    process.exit(1)
  }

  const root = resolve(join(import.meta.dirname ?? '.', '..'))
  const bundleRoot = resolve(bundleDir)

  // ── 1. 扫描所有 bundle 的 sourcemap，得到分母（每个源文件生成了哪些行）
  const denom = new Map() // "relPath|line" → true
  const srcPathOf = new Map() // 源文件绝对键 → 相对路径
  const bundles = readdirSync(bundleRoot).filter((f) => f.endsWith('.cjs'))

  for (const b of bundles) {
    const mapPath = join(bundleRoot, b + '.map')
    if (!existsSync(mapPath)) continue
    const sm = loadSourceMap(mapPath)
    if (!sm) continue
    sm.lines.forEach((row) => {
      for (const seg of row) {
        const src = sm.sources[seg.srcIdx]
        if (!src) continue
        const abs = resolve(join(bundleRoot, src))
        const rel = relative(root, abs).split(sep).join('/')
        srcPathOf.set(abs, rel)
        denom.set(`${rel}|${seg.srcLine + 1}`, true)
      }
    })
  }

  // ── 2. 读 V8 覆盖率，把命中的 range 还原成源文件行
  const covered = new Set()
  const v8Files = readdirSync(v8Dir).filter((f) => f.endsWith('.json'))

  for (const f of v8Files) {
    let payload
    try {
      payload = JSON.parse(readFileSync(join(v8Dir, f), 'utf8'))
    } catch {
      continue
    }
    for (const entry of payload.result || []) {
      const url = entry.url || ''
      if (!url.startsWith('file://')) continue
      const abs = resolve(url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1'))
      if (!abs.startsWith(bundleRoot)) continue
      const mapPath = abs + '.map'
      if (!existsSync(mapPath)) continue
      const sm = loadSourceMap(mapPath)
      if (!sm) continue
      let buf
      try {
        buf = readFileSync(abs)
      } catch {
        continue
      }
      const starts = buildLineIndex(buf)
      const hit = new Uint8Array(buf.length)

      // 两遍法（V8 的 ranges 是嵌套的：ranges[0] 是函数整体，其后是块级子区间）：
      //   pass 1 标记 —— 函数整体 range 的 count>0 说明这个函数被调用过，
      //                  函数体内的顺序语句（常量数组、顶层赋值等）随之覆盖；
      //   pass 2 扣除 —— 任何 count=0 的区间（未执行的分支块、整个未被调用的函数）
      //                  从覆盖里挖掉，这样才是真实的分支覆盖率。
      // 匿名顶层包装函数（functionName 为空）不参与标记：它只代表「bundle 被加载」，
      // 采信它会让任何文件都显示 100%。
      const fns = entry.functions || []
      for (const fn of fns) {
        const r = (fn.ranges || [])[0]
        if (!r || !r.count) continue
        if (fn.functionName === '') continue
        for (let i = r.startOffset; i < r.endOffset && i < hit.length; i++) hit[i] = 1
      }
      for (const fn of fns) {
        for (const r of fn.ranges || []) {
          if (r.count) continue
          for (let i = r.startOffset; i < r.endOffset && i < hit.length; i++) hit[i] = 0
        }
      }

      // 把字节级覆盖转成「行 + 列范围」，再经 sourcemap 还原到源文件行
      let i = 0
      while (i < hit.length) {
        if (!hit[i]) {
          i++
          continue
        }
        let j = i
        while (j < hit.length && hit[j]) j++
        const a = offsetToLine(starts, i)
        const b = offsetToLine(starts, j)
        for (let line = a.line; line <= b.line; line++) {
          const fromCol = line === a.line ? a.col : 0
          const toCol = line === b.line ? b.col : Number.MAX_SAFE_INTEGER
          const row = sm.lines[line]
          if (!row) continue
          for (const seg of segmentsInRow(row, fromCol, toCol)) {
            const src = sm.sources[seg.srcIdx]
            if (!src) continue
            const srcAbs = resolve(join(bundleRoot, src))
            const rel = relative(root, srcAbs).split(sep).join('/')
            covered.add(`${rel}|${seg.srcLine + 1}`)
          }
        }
        i = j
      }
    }
  }

  // ── 3. 按文件聚合
  const perFile = new Map()
  for (const key of denom.keys()) {
    const idx = key.lastIndexOf('|')
    const rel = key.slice(0, idx)
    const line = Number(key.slice(idx + 1))
    // 只统计项目内源码，排除测试自身与构建产物
    if (!rel.startsWith('packages/') && !rel.startsWith('apps/')) continue
    if (rel.includes('/tests/') || rel.includes('/unit/')) continue
    // 非代码文件（规则 JSON 等）与纯类型声明文件编译后不产生可执行代码，不进分母
    if (!rel.endsWith('.ts')) continue
    if (rel.endsWith('.d.ts') || rel.endsWith('/types.ts')) continue
    let rec = perFile.get(rel)
    if (!rec) {
      rec = { file: rel, total: 0, covered: 0 }
      perFile.set(rel, rec)
    }
    rec.total++
    if (covered.has(key)) rec.covered++
  }

  const rows = [...perFile.values()].sort((a, b) => a.file.localeCompare(b.file))
  const sum = rows.reduce(
    (acc, r) => ({ total: acc.total + r.total, covered: acc.covered + r.covered }),
    { total: 0, covered: 0 }
  )
  const pct = sum.total > 0 ? (sum.covered / sum.total) * 100 : 0

  const pad = (s, n) => String(s).padEnd(n)
  const num = (n) => String(n).padStart(6)
  console.log('\n覆盖率（按源文件还原，分母 = sourcemap 中生成了代码的行）')
  console.log('─'.repeat(78))
  console.log(pad('文件', 56) + num('行%)') + '  覆盖/总行')
  console.log('─'.repeat(78))
  for (const r of rows) {
    const p = r.total > 0 ? ((r.covered / r.total) * 100).toFixed(1) : '0.0'
    const name = r.file.length > 54 ? '…' + r.file.slice(-53) : r.file
    console.log(pad(name, 56) + num(p) + `  ${r.covered}/${r.total}`)
  }
  console.log('─'.repeat(78))
  console.log(pad(`合计（${rows.length} 个文件）`, 56) + num(pct.toFixed(1)) + `  ${sum.covered}/${sum.total}`)

  mkdirSync(join(root, '.tmp', 'coverage'), { recursive: true })
  const outJson = join(root, '.tmp', 'coverage', 'summary.json')
  writeFileSync(
    outJson,
    JSON.stringify({ generatedAt: new Date().toISOString(), total: sum, percent: Number(pct.toFixed(2)), files: rows }, null, 2),
    'utf8'
  )
  console.log(`\n明细已写入 ${relative(root, outJson).split(sep).join('/')}`)

  if (wantMd) {
    const md = [
      '# 单元测试覆盖率（G2）',
      '',
      `生成时间：${new Date().toISOString()}`,
      '',
      `**整体行覆盖率：${pct.toFixed(1)}%**（${sum.covered}/${sum.total} 行）`,
      '',
      '> 口径：测试用 esbuild 打包后交给 node:test，Node 内置覆盖率只报打包产物；',
      '> 本表由 `scripts/coverage.mjs` 经 sourcemap 还原到 TS 源文件，分母为生成了代码的行。',
      '',
      '| 文件 | 行覆盖率 | 覆盖/总行 |',
      '|---|---:|---:|',
      ...rows.map((r) => `| \`${r.file}\` | ${r.total > 0 ? ((r.covered / r.total) * 100).toFixed(1) : '0.0'}% | ${r.covered}/${r.total} |`),
      ''
    ].join('\n')
    const mdPath = join(root, 'docs', 'benchmarks', `coverage-${new Date().toISOString().slice(0, 10)}.md`)
    writeFileSync(mdPath, md, 'utf8')
    console.log(`报告已写入 ${relative(root, mdPath).split(sep).join('/')}`)
  }

  return { pct, rows, sum }
}

main()
