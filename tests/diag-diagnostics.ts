/**
 * C5 诊断包真机验证
 *
 * 目的：确认导出的 zip 能被标准工具打开、内容完整、且**不含任何个人信息**。
 * 校验用 Python zipfile（外部权威实现），而不是我们自己的解析器。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { exportDiagnostics } from '../apps/desktop/src/main/services/diagnostics'
import { initLogger, makeRedactor, log } from '../apps/desktop/src/main/services/logger'
import { loadNativeCapabilities, describeCapabilities } from '@native/capabilities'
import { openDb } from '../apps/desktop/src/main/db/driver'
import { Store } from '../apps/desktop/src/main/db/store'
import { loadRulesSync } from '@junk/engine'
import { listQuarantine } from '@junk/cleaner'
import rulesJson from '../packages/rules/junk-rules.json'

async function main(): Promise<void> {
  const local = process.env.LOCALAPPDATA || ''
  const root = join(local, 'SoftGraph')
  const paths = {
    root,
    dataDir: join(root, 'data'),
    iconDir: join(root, 'cache', 'icons'),
    quarantineDir: join(root, 'Quarantine'),
    pluginDir: join(root, 'plugins'),
    dbFile: join(root, 'data', 'softgraph.db'),
    settingsFile: join(root, 'settings.json'),
    rulesFile: join(root, 'rules', 'junk-rules.json'),
    reportDir: join(root, 'reports'),
    junkCacheFile: join(root, 'cache', 'junk-incremental.json'),
    comIndexFile: join(root, 'cache', 'com-index.json'),
    tmpDir: join(root, 'tmp'),
    apiSetCacheFile: join(root, 'cache', 'apiset-map.json'),
    logDir: join(root, 'logs')
  }

  console.log('═══ 准备：写入若干条日志（含真实用户路径）═══')
  const lg = initLogger({ dir: paths.logDir, level: 'debug' })
  lg.setRedactor(makeRedactor({ userProfile: process.env.USERPROFILE, computerName: hostname() }))
  log.info('diag-test', '测试日志：扫描用户目录', { path: process.env.USERPROFILE })
  log.warn('diag-test', `路径 ${process.env.USERPROFILE}\\Documents\\a.txt 不存在`)
  log.debug('diag-test', '计算机名', { host: hostname() })
  await lg.flushNow()
  console.log('日志已写入（写入前即已脱敏）')

  const diskLog = await fs.readFile(join(paths.logDir, `softgraph-${dayStamp()}.jsonl`), 'utf8')
  const userName = (process.env.USERNAME || '').trim()
  console.log(`磁盘日志是否含用户名 "${userName}"：${userName && diskLog.includes(userName) ? '❌ 含（脱敏失败）' : '✅ 不含'}`)
  console.log(`磁盘日志是否含计算机名 "${hostname()}"：${diskLog.includes(hostname()) ? '❌ 含' : '✅ 不含'}`)

  console.log('\n═══ 收集诊断输入 ═══')
  let stats: unknown = { note: 'db 不可用（测试环境）' }
  let quarantine = { batches: 0, records: 0, totalBytes: 0 }
  try {
    const db = await openDb({ file: paths.dbFile, wasmDir: join(process.cwd(), 'node_modules', 'sql.js', 'dist') })
    const store = new Store(db)
    store.init()
    stats = store.dbStats()
    await store.close()
    console.log('数据库统计已采集（真实库）')
  } catch (e) {
    console.log('数据库统计采集跳过：', (e as Error).message)
  }
  try {
    const list = await listQuarantine(paths.quarantineDir)
    const batches = new Set(list.map((r) => r.quarantinedPath.replace(/\\[^\\]*$/, '')))
    quarantine = {
      batches: batches.size,
      records: list.length,
      totalBytes: list.reduce((s, r) => s + r.sizeBytes, 0)
    }
  } catch {
    /* 无隔离区 */
  }

  const rs = loadRulesSync(rulesJson as never)
  const rulesSummary = {
    schemaVersion: rs.schemaVersion,
    updatedAt: rs.updatedAt,
    ruleCount: rs.rules.length,
    rules: rs.rules.map((r) => ({ id: r.id, name: r.name, risk: r.risk, patterns: r.patterns.length }))
  }

  const settings = JSON.parse(await fs.readFile(paths.settingsFile, 'utf8').catch(() => '{}'))

  console.log('\n═══ 导出诊断包 ═══')
  const r = await exportDiagnostics({
    paths,
    appVersion: '2.0.0-dev',
    electronVersion: process.versions.electron ?? '(node)',
    nodeVersion: process.versions.node ?? '',
    chromeVersion: process.versions.chrome ?? '(n/a)',
    settings,
    capabilities: describeCapabilities(await loadNativeCapabilities()),
    stats,
    quarantine,
    rulesSummary,
    shellFolders: {},
    extraRedactions: [hostname()]
  })
  console.log('导出结果:', JSON.stringify({ ok: r.ok, bytes: r.bytes, entries: r.entries }, null, 2))
  if (!r.ok || !r.file) process.exit(1)
  await fs.writeFile('.tmp/diag-last.txt', r.file, 'utf8')
  process.exit(0)
}

function dayStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

void main()
