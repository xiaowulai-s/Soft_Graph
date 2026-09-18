/**
 * 全库文件检索（v3.0.0 · I-11）
 *
 * 这个套件要钉死三件事：
 *   1. **大小写不敏感且走索引**：靠的是小写派生列 + 范围比较，而不是 `lower()` + `LIKE`
 *      （后者实测查询计划是 `SCAN`，索引完全用不上）
 *   2. **两条驱动分支都能工作**：sql.js（**打包应用实际走的**，无 FTS5）与
 *      node:sqlite（有 FTS5）。只测一条等于没测 —— 另一条才是用户会遇到的
 *   3. **老库能迁移**：已存在的 file_index 没有派生列，init() 必须补列并回填
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../apps/desktop/src/main/db/driver'
import { Store } from '../../apps/desktop/src/main/db/store'
import type { FileNode } from '@shared/types'

const WASM_DIR = join(process.cwd(), 'node_modules', 'sql.js', 'dist')

/** 造一条 file_index 记录所需的最小 FileNode */
function file(over: Partial<FileNode> & { id: string; fullPath: string }): FileNode {
  return {
    name: over.fullPath.slice(over.fullPath.lastIndexOf('\\') + 1),
    sizeBytes: 1024,
    mtime: Date.now(),
    kind: 'dll',
    ext: '.dll',
    refCount: 1,
    ...over
  } as FileNode
}

const FIXTURES: FileNode[] = [
  file({ id: 'f1', fullPath: 'C:\\Windows\\System32\\KERNEL32.DLL', refCount: 9 }),
  file({ id: 'f2', fullPath: 'C:\\Windows\\SysWOW64\\kernel32.dll', refCount: 5 }),
  file({ id: 'f3', fullPath: 'C:\\Windows\\System32\\KernelBase.dll', refCount: 7 }),
  file({ id: 'f4', fullPath: 'C:\\Program Files\\App\\KernelBridge.dll', refCount: 2 }),
  file({ id: 'f5', fullPath: 'D:\\Tools\\unrelated\\readme.txt', refCount: 0 }),
  file({ id: 'f6', fullPath: 'C:\\Windows\\System32\\USER32.dll', refCount: 11 })
]

let dir = ''
async function makeStore(prefer: 'sqljs' | 'node-sqlite'): Promise<{ store: Store; db: Db; file: string }> {
  const file = join(dir, `${prefer}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
  const db = await openDb({ file, wasmDir: WASM_DIR, prefer })
  const store = new Store(db)
  store.init()
  return { store, db, file }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sg-filesearch-'))
})

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('文件检索 · sql.js 驱动（打包应用实际路径，无 FTS5）', () => {
  let store: Store
  let db: Db

  before(async () => {
    const s = await makeStore('sqljs')
    store = s.store
    db = s.db
    store.saveFilesAndDeps(FIXTURES, [])
  })

  after(async () => {
    await db.close()
  })

  it('该驱动确实不支持 FTS5（这是前提，不是结论）', () => {
    assert.equal(db.supportsFts5, false, 'sql.js 标准构建没有 fts5 模块')
  })

  it('前缀检索大小写不敏感：小写查询能命中大写文件名', () => {
    const r = store.searchFiles('kernel32')
    const names = r.hits.map((h) => h.name.toLowerCase())
    assert.ok(names.includes('kernel32.dll'), `应命中 kernel32.dll，实际 ${names.join(',')}`)
    assert.ok(r.hits.length >= 1)
    assert.ok(r.strategy === 'prefix-index' || r.strategy === 'unindexed-scan')
  })

  it('前缀检索按路径前缀也能命中（两种前缀来源都覆盖）', () => {
    const r = store.searchFiles('c:\\windows\\sys')
    const paths = r.hits.map((h) => h.fullPath.toLowerCase())
    assert.ok(paths.some((p) => p.includes('system32\\kernel32.dll')), '应命中 System32 下的文件')
    assert.ok(paths.some((p) => p.includes('syswow64\\kernel32.dll')), '应命中 SysWOW64 下的文件')
  })

  it('结果按引用数降序（共享运行库排前面）', () => {
    const r = store.searchFiles('c:\\windows\\')
    const refs = r.hits.map((h) => h.refCount)
    for (let i = 1; i < refs.length; i++) assert.ok(refs[i - 1] >= refs[i], `应降序：${refs.join(',')}`)
    assert.equal(r.hits[0].refCount, 11)
  })

  it('前缀模式不返回「非开头匹配」的结果（语义边界要清楚）', () => {
    // 'ernel' 是 kernel32.dll 的子串，但不是它的前缀 —— 前缀模式不应命中
    const r = store.searchFiles('ernel')
    assert.equal(r.hits.length, 0, `前缀模式不该命中子串（实际 ${r.hits.map((h) => h.name).join(',')}）`)
  })

  it('子串模式能命中前缀模式找不到的结果，并如实标注全表扫描', () => {
    const r = store.searchFiles('ernel', { mode: 'substring' })
    assert.ok(r.hits.length >= 1, `子串模式应命中 kernel32，实际 ${r.hits.length}`)
    assert.ok(r.hits.some((h) => h.name.toLowerCase() === 'kernel32.dll'))
    assert.equal(r.strategy, 'substring-scan', '无 FTS5 时子串必然是全表扫描')
  })

  it('limit 生效，且 total 反映合并去重后的候选数', () => {
    const all = store.searchFiles('c:\\', { limit: 100 })
    assert.ok(all.hits.length >= 4)
    const capped = store.searchFiles('c:\\', { limit: 2 })
    assert.equal(capped.hits.length, 2)
    assert.ok(capped.total >= capped.hits.length)
  })

  it('不足 2 字不检索（避免把整库捞回来）', () => {
    for (const q of ['', 'a', ' c ', '   ']) {
      const r = store.searchFiles(q)
      assert.equal(r.hits.length, 0, `"${q}" 不应返回结果`)
      assert.equal(r.total, 0)
    }
  })

  it('路径与名称同时命中同一行时只返回一次（去重）', () => {
    // 'kernel32.dll' 既是 f1/f2 的名称前缀，也出现在它们的路径里
    const r = store.searchFiles('kernel32.dll', { limit: 100 })
    const ids = r.hits.map((h) => h.id)
    assert.equal(new Set(ids).size, ids.length, `不应有重复行：${ids.join(',')}`)
  })

  it('未命中返回空数组而不是报错', () => {
    const r = store.searchFiles('这个文件肯定不存在zzz')
    assert.deepEqual(r.hits, [])
    assert.equal(r.total, 0)
  })

  it('诊断快照反映驱动与派生列状态', () => {
    const d = store.searchDiagnostics()
    assert.equal(d.driver, 'sql.js (WASM)')
    assert.equal(d.supportsFts5, false)
    assert.equal(d.lcReady, true)
    assert.equal(d.fileRows, FIXTURES.length)
  })
})

describe('文件检索 · node:sqlite 驱动（有 FTS5 时的分支）', () => {
  let store: Store | null = null
  let db: Db | null = null
  let available = false

  before(async () => {
    const s = await makeStore('node-sqlite')
    // 运行时若没有 node:sqlite，openDb 会静默回退到 sql.js —— 那种情况下跳过本组
    available = s.db.driverName === 'node:sqlite'
    if (available) {
      store = s.store
      db = s.db
      store.saveFilesAndDeps(FIXTURES, [])
    } else {
      await s.db.close()
    }
  })

  after(async () => {
    if (db) await db.close()
  })

  it('驱动能力：node:sqlite 支持 FTS5', () => {
    if (!available) return // 运行时无 node:sqlite：本组不适用
    assert.equal(db!.supportsFts5, true)
    assert.equal(store!.searchDiagnostics().lcReady, true)
  })

  it('前缀检索与 sql.js 分支结果一致（同一份数据、同一套语义）', () => {
    if (!available) return
    const r = store!.searchFiles('kernel32')
    assert.ok(r.hits.some((h) => h.name.toLowerCase() === 'kernel32.dll'))
    const byPath = store!.searchFiles('c:\\windows\\sys')
    assert.ok(byPath.hits.length >= 2)
  })

  it('子串模式走 FTS5（MATCH），strategy 如实上报', () => {
    if (!available) return
    const r = store!.searchFiles('kernel', { mode: 'substring' })
    assert.equal(r.strategy, 'fts5', '有 FTS5 时应走 MATCH 而不是全表 LIKE')
    assert.ok(r.hits.length >= 1, 'FTS5 前缀词匹配应命中 kernel32 / KernelBase')
    // FTS5 的分词语义：'ernel' 不是任何独立词的前缀 → MATCH 不应命中
    // （这正是 FTS5 与子串 LIKE 的语义差异，要如实暴露而不是假装一样）
    const mid = store!.searchFiles('ernel', { mode: 'substring' })
    assert.equal(mid.strategy, 'fts5')
    assert.equal(mid.hits.length, 0, 'FTS5 是分词前缀匹配，不做任意位置子串')
  })

  it('FTS5 表随写入失效并惰性重建（新数据立即可检索）', () => {
    if (!available) return
    assert.equal(store!.searchFiles('zznewfile', { mode: 'substring' }).hits.length, 0)
    store!.saveFilesAndDeps([file({ id: 'f7', fullPath: 'C:\\X\\zznewfile_alpha.dll' })], [])
    const r = store!.searchFiles('zznewfile', { mode: 'substring' })
    assert.equal(r.strategy, 'fts5')
    assert.ok(r.hits.some((h) => h.name === 'zznewfile_alpha.dll'), '重建后应能检索到新写入的文件')
  })
})

describe('文件检索 · 老库迁移（补列 + 回填）', () => {
  it('已存在的 file_index 缺少派生列时，init() 会补列并回填，检索立即可用', async () => {
    const f = join(dir, `legacy-${Date.now()}.db`)
    const db = await openDb({ file: f, wasmDir: WASM_DIR, prefer: 'sqljs' })
    // 1) 先造一个「老版本」的 file_index：没有 full_path_lc / name_lc
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        id TEXT PRIMARY KEY,
        full_path TEXT NOT NULL,
        name TEXT,
        size INTEGER DEFAULT 0,
        mtime INTEGER DEFAULT 0,
        kind TEXT,
        ext TEXT,
        arch TEXT,
        version TEXT,
        sign_status TEXT,
        missing INTEGER DEFAULT 0,
        parse_status TEXT,
        ref_count INTEGER DEFAULT 0
      )`)
    await db.get('SELECT 1') // 触发一次读，确保表已建
    db.run(
      `INSERT INTO file_index (id,full_path,name,size,ref_count) VALUES (?,?,?,?,?)`,
      ['legacy1', 'C:\\Windows\\System32\\LEGACYFILE.dll', 'LEGACYFILE.dll', 2048, 4]
    )

    // 2) 此时检索不到（没有派生列、也没有索引）
    const store = new Store(db)
    store.init() // ← 迁移发生在这里

    const d = store.searchDiagnostics()
    assert.equal(d.lcReady, true, '迁移应成功')
    assert.equal(d.fileRows, 1)

    // 3) 回填后大小写不敏感的前缀检索可用
    const r = store.searchFiles('legacyfile')
    assert.equal(r.hits.length, 1, '回填后应能命中历史数据')
    assert.equal(r.hits[0].id, 'legacy1')
    assert.equal(r.strategy, 'prefix-index')

    // 4) 幂等：再 init 一次不应报错、也不应改变结果
    store.init()
    assert.equal(store.searchFiles('legacyfile').hits.length, 1)

    await db.close()
  })

  it('老库缺少派生列时 init() 不抛异常（SCHEMA 里不能有依赖新列的索引）', async () => {
    const f = join(dir, `broken-${Date.now()}.db`)
    const db = await openDb({ file: f, wasmDir: WASM_DIR, prefer: 'sqljs' })
    // 造一个只有三列的老表：若 SCHEMA 里写了 `CREATE INDEX … ON file_index(full_path_lc)`，
    // 这里会在建索引时抛「no such column」→ 整个 init() 失败 → 应用起不来
    db.exec('CREATE TABLE IF NOT EXISTS file_index (id TEXT PRIMARY KEY, full_path TEXT NOT NULL, name TEXT)')
    const store = new Store(db)
    assert.doesNotThrow(() => store.init(), 'init() 不应因老库缺列而抛异常')
    // 列补齐后迁移应视为成功
    const cols = db.all<{ name: string }>('PRAGMA table_info(file_index)').map((c) => c.name)
    assert.ok(cols.includes('full_path_lc'))
    assert.ok(cols.includes('name_lc'))
    assert.equal(store.searchDiagnostics().lcReady, true)
    await db.close()
  })
})
