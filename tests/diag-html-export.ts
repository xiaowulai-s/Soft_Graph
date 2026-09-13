/** D5 交互式 HTML 快照真机验证：从真实 graph_cache 导出并校验结构与转义 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../apps/desktop/src/main/db/driver'
import { Store } from '../apps/desktop/src/main/db/store'
import { resolvePaths, SettingsStore } from '../apps/desktop/src/main/services/env'
import { graphInteractiveHtml } from '../packages/graph-core/html-export'
import type { AppSettings } from '@shared/types'

async function main(): Promise<void> {
  const paths = resolvePaths()
  const db = await openDb({ file: paths.dbFile, wasmDir: 'node_modules/sql.js/dist' })
  const store = new Store(db)
  store.init()
  const settings = new SettingsStore(paths.settingsFile, {
    portableRoots: [],
    portableThreshold: 55,
    excludePaths: [],
    quarantineKeepDaysLow: 7,
    quarantineKeepDaysHigh: 14,
    theme: 'dark',
    maxDepth: 2,
    enabledJunkCategories: [],
    advancedMode: false,
    allowDirectDelete: false,
    rulesUpdateUrl: '',
    float: {
      enabled: false,
      plugins: [],
      x: 0,
      y: 0,
      width: 260,
      opacity: 0.96,
      autoHide: true,
      peekSize: 6,
      theme: 'dark',
      clickThrough: false,
      alwaysOnTop: true,
      compact: false,
      lockPosition: false
    }
  })
  void settings

  const sw = store.listSoftware()
  // 找一个有 graph_cache 的软件
  let target = sw[0]!
  for (const s of sw) {
    if (store.loadGraph(s.id)) {
      target = s
      break
    }
  }
  const cached = store.loadGraph(target.id)
  if (!cached) throw new Error('无 graph_cache 可测')
  console.log(`导出目标：${target.name}（${cached.model.stats.nodeCount} 节点 / ${cached.model.stats.edgeCount} 边，builtAt=${new Date(cached.builtAt).toLocaleString()}）`)

  const html = graphInteractiveHtml(target, cached.model)
  const out = join(paths.reportDir, 'softgraph-interactive-test.html')
  await fs.mkdir(paths.reportDir, { recursive: true })
  await fs.writeFile(out, html, 'utf8')
  console.log(`已写出：${out}（${(html.length / 1024).toFixed(1)} KB）`)

  // 结构校验
  const checks: [string, boolean][] = [
    ['DOCTYPE', html.includes('<!DOCTYPE html>')],
    ['内嵌 SVG', html.includes('<svg id="g"')],
    ['节点数量合理（<circle> 计数 ≥ stats.nodeCount 的 60%）', (html.match(/<circle /g) ?? []).length >= cached.model.stats.nodeCount * 0.6],
    ['缩放脚本', html.includes('wheel')],
    ['拖拽脚本', html.includes('mousedown')],
    ['悬停详情', html.includes('<title>')],
    ['HTML 转义（无裸 <script 注入）', !/<script(?!>| )/.test(html.replace('<script>', ''))],
    ['无外部资源引用（零依赖）', !/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org[^"']*/g, ''))]
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`${pass ? '✅' : '❌'} ${name}`)
    ok = ok && pass
  }
  console.log(ok ? '\n✅ D5 交互式快照验证通过' : '\n❌ 存在问题')
  process.exit(ok ? 0 : 1)
}

void main()
