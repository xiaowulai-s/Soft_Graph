/**
 * D2/D4 反向子图真机验证：
 * 取 refCount 最高的共享文件，构建反向子图，验证结构与预期一致。
 */
import { openDb } from '../apps/desktop/src/main/db/driver'
import { Store } from '../apps/desktop/src/main/db/store'
import { ScanService } from '../apps/desktop/src/main/services/scan'
import { resolvePaths, SettingsStore } from '../apps/desktop/src/main/services/env'
import { normKey } from '@shared/util'

async function main(): Promise<void> {
  const paths = resolvePaths()
  const db = await openDb({ file: paths.dbFile, wasmDir: 'node_modules/sql.js/dist' })
  const store = new Store(db)
  store.init()
  // Node 环境下不能用 SettingsStore.load（其默认值依赖 electron.screen），手工构造
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
  const scan = new ScanService(store, paths, settings, () => {})

  // 取 refCount 最高的文件
  const sw = store.listSoftware()
  console.log(`软件库：${sw.length} 条`)
  const top = store.dbStats().tables['dependency'] ?? 0
  console.log(`依赖边总数：${top}`)

  // 从 graph_cache 找一个已知高引用文件（如 kernel32）
  const all = store.directDeps(sw[0]?.id ?? '', 1)
  console.log(`样例（${sw[0]?.name}）首个依赖：${all[0]?.file.name} refCount=${all[0]?.file.refCount}`)

  // 用 SQL 语义反查：直接选一个高引用文件（借助 referencingSoftware 的逆操作）
  // 简化：遍历首软件的依赖，找 refCount 最大者
  const deps = store.directDeps(sw[0]?.id ?? '', 200)
  deps.sort((a, b) => (b.file.refCount ?? 0) - (a.file.refCount ?? 0))
  const target = deps[0]
  if (!target) throw new Error('无可测文件')
  console.log(`\n下钻目标：${target.file.name}（refCount=${target.file.refCount}）`)

  const model = await scan.buildFileGraph(target.file.id)
  const t0 = model.nodes.filter((n) => n.tier === 0)
  const t1 = model.nodes.filter((n) => n.tier === 1)
  const t2 = model.nodes.filter((n) => n.tier === 2)
  console.log(`\n反向子图：T0=${t0.length}（${t0[0]?.label}）T1=${t1.length} T2=${t2.length} 边=${model.edges.length}`)
  console.log('T1 引用者（前 8）：')
  for (const n of t1.slice(0, 8)) {
    const e = model.edges.find((x) => x.target === target.file.id && x.source === n.id)
    console.log(`  ${n.label}（置信度 ${e?.confidence.toFixed(2)}，证据 ${e?.evidence.join('+') || '-'}）`)
  }
  console.log(`\n预期 T1 = ${target.file.refCount}（refCount），实际 ${t1.length} —— ${t1.length === (target.file.refCount ?? 0) ? '✅ 一致' : '⚠️ 不一致（可能是软件已被删除）'}`)
  console.log(`T2 上限检查：${t2.length} ≤ ${t1.length * 12} —— ${t2.length <= t1.length * 12 ? '✅' : '❌'}`)

  // 权威口径：refCounts() 按 full_path 聚合（ref_count 列是写入时的快照，可能过期）
  const realRefs = store.refCounts().get(normKey(target.file.fullPath)) ?? 0
  console.log(
    `引用者一致性：T1=${t1.length} vs refCounts=${realRefs} —— ${t1.length === realRefs ? '✅ 一致' : '❌ 不一致'}（ref_count 列=${target.file.refCount} 为旧快照仅供参考）`
  )

  // 二次下钻：T2 层节点再下钻（面包屑多级）
  const second = t2[0]
  if (second?.file) {
    const m2 = await scan.buildFileGraph(second.file.id)
    console.log(`\n二级下钻（${second.label}）：${m2.nodes.length} 节点 / ${m2.edges.length} 边 ✅`)
  }

  await store.close()
  process.exit(0)
}

void main()
