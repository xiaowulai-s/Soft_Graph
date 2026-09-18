/**
 * 数据访问层
 * 对应技术设计方案 6.2 数据库表结构（SQLite）
 *
 * 路径检索（v3.0.0 · I-11）—— 与文档的关系要如实说清：
 *   文档只写了「FTS5 不可用时退化为 LIKE + 前缀索引」，但**此前这两样都不存在**
 *   （全仓零处 LIKE / fts5 实现，也没有任何检索入口）。本版把它真正落地。
 *
 *   实测（2026-09-18）：
 *     · `node:sqlite`（Node ≥ 22.5）支持 FTS5；`sql.js` **不支持**（`no such module: fts5`）
 *     · **打包应用恒走 sql.js**（Electron 33.4.11 = Node 20.18.3），因此 FTS5 只是可选路径
 *     · `LIKE 'prefix%'` 的查询计划是 `SCAN`（索引用不上）；
 *       `col >= ? AND col < ?` 才是 `SEARCH … USING INDEX`
 *     · `lower(full_path)` 这类写法会直接废掉索引 —— 因此这里落一对**小写派生列**
 *       （`full_path_lc` / `name_lc`）供范围查询使用，而不是在查询里套 lower()
 *
 *   检索策略：前缀（默认，走索引）→ 子串（显式启用；有 FTS5 时用 MATCH，否则全表）
 */

import type { Db, SqlValue } from './driver'
import type {
  DependencyEdge,
  FileNode,
  FileSearchHit,
  FileSearchOptions,
  FileSearchResult,
  JunkItem,
  JunkSummary,
  SoftwareItem,
  GraphModel
} from '@shared/types'
import { normKey } from '@shared/util'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS software (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  publisher TEXT,
  install_path TEXT,
  main_exe TEXT,
  icon_hash TEXT,
  source TEXT,
  size_bytes INTEGER DEFAULT 0,
  install_date INTEGER,
  portable_score INTEGER,
  portable_evidence TEXT,
  uninstall_string TEXT,
  arch TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_software_name ON software(name);
CREATE INDEX IF NOT EXISTS idx_software_source ON software(source);

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
  ref_count INTEGER DEFAULT 0,
  -- I-11：小写派生列 —— 范围查询走索引做「大小写不敏感的前缀检索」
  -- （不能在查询里套 lower()，那会让索引失效）
  full_path_lc TEXT,
  name_lc TEXT
);
CREATE INDEX IF NOT EXISTS idx_file_name ON file_index(name);
CREATE INDEX IF NOT EXISTS idx_file_path ON file_index(full_path);
-- 注意：idx_file_path_lc / idx_file_name_lc **不能**写在这里。
-- 老库的 file_index 没有派生列，对 full_path_lc 建索引会直接报「no such column」
-- 把整个 init() 打断（应用起不来）；而 CREATE TABLE IF NOT EXISTS 对已存在的表是
-- 空操作、补不了列。因此这两条索引只在 migrateLc() 里建 —— 那里已确保列存在。
-- 新建库也能覆盖到（migrateLc 在 init 里紧跟 SCHEMA 执行）。

CREATE TABLE IF NOT EXISTS dependency (
  id TEXT PRIMARY KEY,
  software_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  type TEXT,
  confidence REAL,
  evidence TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dep_software ON dependency(software_id);
CREATE INDEX IF NOT EXISTS idx_dep_file ON dependency(file_id);

CREATE TABLE IF NOT EXISTS pe_cache (
  path_hash TEXT PRIMARY KEY,
  path TEXT,
  size INTEGER,
  mtime INTEGER,
  imports_json TEXT,
  parse_status TEXT
);

CREATE TABLE IF NOT EXISTS graph_cache (
  software_id TEXT PRIMARY KEY,
  model_json TEXT,
  layout_json TEXT,
  built_at INTEGER
);

CREATE TABLE IF NOT EXISTS junk_item (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  full_path TEXT NOT NULL,
  name TEXT,
  size INTEGER DEFAULT 0,
  mtime INTEGER DEFAULT 0,
  risk TEXT,
  group_id TEXT,
  keep_flag INTEGER DEFAULT 0,
  is_dir INTEGER DEFAULT 0,
  scan_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_junk_cat ON junk_item(category_id);
CREATE INDEX IF NOT EXISTS idx_junk_scan ON junk_item(scan_id);
CREATE INDEX IF NOT EXISTS idx_junk_size ON junk_item(size);

CREATE TABLE IF NOT EXISTS junk_category (
  id TEXT PRIMARY KEY,
  name TEXT,
  risk TEXT,
  default_selected INTEGER,
  rule_json TEXT
);

CREATE TABLE IF NOT EXISTS scan_meta (
  id TEXT PRIMARY KEY,
  type TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  volume TEXT,
  usn_cursor TEXT,
  status TEXT,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS portable_mark (
  path_key TEXT PRIMARY KEY,
  is_portable INTEGER,
  updated_at INTEGER
);
`

export class Store {
  constructor(private db: Db) {}

  /** 小写派生列是否可用（迁移成功）—— 决定前缀检索能否走索引 */
  private lcReady = false
  /** FTS5 表是否需要重建（仅有 FTS5 的驱动会用到） */
  private ftsDirty = true

  /** 驱动是否支持 FTS5（只读暴露，供 UI / 诊断展示检索策略） */
  get supportsFts5(): boolean {
    return this.db.supportsFts5
  }

  /** 诊断用：FTS5 是否已建好 */
  private ftsReady = false

  get driverName(): string {
    return this.db.driverName
  }

  init(): void {
    this.db.exec(SCHEMA)
    this.migrateLc()
  }

  /**
   * 老库迁移（I-11）：给已存在的 file_index 补上两个小写派生列。
   *
   * `CREATE TABLE IF NOT EXISTS` 对已存在的表不生效，因此老数据库不会自动获得新列 ——
   * 必须显式 ALTER + 回填。迁移失败不阻塞启动：检索会退回「无索引全表」模式
   * （见 searchFiles 的 strategy 字段），功能可用、只是慢。
   */
  private migrateLc(): void {
    try {
      const cols = this.db.all<{ name: string }>('PRAGMA table_info(file_index)')
      const names = new Set(cols.map((c) => String(c.name)))
      if (!names.has('full_path_lc')) {
        this.db.exec('ALTER TABLE file_index ADD COLUMN full_path_lc TEXT')
      }
      if (!names.has('name_lc')) {
        this.db.exec('ALTER TABLE file_index ADD COLUMN name_lc TEXT')
      }
      // 回填只在确实有缺值时执行（避免每次启动都全表 UPDATE）
      const missing = this.db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM file_index WHERE full_path_lc IS NULL OR name_lc IS NULL'
      )
      if (Number(missing?.c ?? 0) > 0) {
        this.db.exec('UPDATE file_index SET full_path_lc = lower(full_path), name_lc = lower(name)')
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_file_path_lc ON file_index(full_path_lc)')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_file_name_lc ON file_index(name_lc)')
      this.lcReady = true
    } catch {
      this.lcReady = false
    }
  }

  // ── 软件 ──

  saveSoftware(items: SoftwareItem[]): void {
    if (items.length === 0) return
    const now = Date.now()
    this.db.runMany(
      `INSERT OR REPLACE INTO software
       (id,name,version,publisher,install_path,main_exe,icon_hash,source,size_bytes,install_date,portable_score,portable_evidence,uninstall_string,arch,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      items.map((i) => [
        i.id,
        i.name,
        i.version || '',
        i.publisher || '',
        i.installPath || '',
        i.mainExe || '',
        i.iconHash || '',
        i.source,
        i.sizeBytes || 0,
        i.installDate ?? null,
        i.portableScore ?? null,
        i.portableEvidence ? JSON.stringify(i.portableEvidence) : null,
        i.uninstallString || null,
        i.arch || null,
        now
      ])
    )
  }

  replaceSoftware(items: SoftwareItem[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM software')
      this.saveSoftware(items)
    })
  }

  listSoftware(): SoftwareItem[] {
    const rows = this.db.all<Record<string, any>>('SELECT * FROM software ORDER BY name COLLATE NOCASE')
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version || '',
      publisher: r.publisher || '',
      installPath: r.install_path || '',
      mainExe: r.main_exe || '',
      iconHash: r.icon_hash || '',
      source: r.source,
      sizeBytes: Number(r.size_bytes || 0),
      installDate: r.install_date ?? undefined,
      portableScore: r.portable_score ?? undefined,
      portableEvidence: r.portable_evidence ? JSON.parse(r.portable_evidence) : undefined,
      uninstallString: r.uninstall_string ?? undefined,
      arch: r.arch ?? undefined
    }))
  }

  getSoftware(id: string): SoftwareItem | undefined {
    return this.listSoftware().find((s) => s.id === id)
  }

  // ── 文件与依赖 ──

  saveFilesAndDeps(files: FileNode[], deps: DependencyEdge[]): void {
    const now = Date.now()
    this.db.transaction(() => {
      if (files.length) {
        this.db.runMany(
          `INSERT OR REPLACE INTO file_index
           (id,full_path,name,size,mtime,kind,ext,arch,version,sign_status,missing,parse_status,ref_count,full_path_lc,name_lc)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          files.map((f) => [
            f.id,
            f.fullPath,
            f.name,
            f.sizeBytes || 0,
            Math.round(f.mtime || 0),
            f.kind,
            f.ext || '',
            f.arch || null,
            f.version || null,
            f.signStatus || null,
            f.missing ? 1 : 0,
            f.parseStatus || null,
            f.refCount ?? 0,
            // I-11：小写派生列在**写入侧**算好，查询侧才能用纯范围比较命中索引
            normKey(f.fullPath),
            normKey(f.name || '')
          ])
        )
        // FTS5 表的内容随 file_index 变化 → 标记需重建（下次检索时惰性重建）
        this.ftsDirty = true
      }
      if (deps.length) {
        const swId = deps[0].sourceId
        this.db.run('DELETE FROM dependency WHERE software_id = ?', [swId])
        this.db.runMany(
          `INSERT OR REPLACE INTO dependency (id,software_id,file_id,type,confidence,evidence,created_at)
           VALUES (?,?,?,?,?,?,?)`,
          deps.map((d) => [
            `${d.sourceId}|${d.targetId}`,
            d.sourceId,
            d.targetId,
            d.type,
            d.confidence,
            JSON.stringify(d.evidence),
            now
          ])
        )
      }
    })
  }

  // ── 路径检索（I-11）──

  /**
   * 全库文件检索。
   *
   * 两条路径，默认走能命中索引的那条：
   *   · `prefix`（默认）：`col >= ? AND col < ?` 范围比较 —— 查询计划是
   *     `SEARCH … USING INDEX idx_file_path_lc / idx_file_name_lc`，
   *     且因为比较的是**小写派生列**，大小写不敏感又不牺牲索引。
   *     **不能用 `LIKE 'q%'`** —— 实测其查询计划是 `SCAN`，索引完全用不上。
   *   · `substring`：必然是全表扫描（`%q%` 无法用 B+Tree 索引）。
   *     有 FTS5 的驱动会改用 `MATCH`（分词匹配），否则退回全表 LIKE，
   *     并在 `strategy` 里如实标出，供 UI 提示代价。
   *
   * 返回的 `strategy` 不是装饰：UI 要据此告诉用户「当前这次检索是走索引还是全表」。
   */
  searchFiles(query: string, opts: FileSearchOptions = {}): FileSearchResult {
    const limit = Math.max(1, Math.min(Math.round(opts.limit ?? 50), 500))
    const mode = opts.mode ?? 'prefix'
    const q = normKey(String(query ?? '').trim())
    // 单字符前缀会把几乎整库捞回来，没有检索价值
    if (q.length < 2) return { hits: [], strategy: mode === 'substring' ? 'substring-scan' : 'prefix-index', total: 0 }

    if (mode === 'substring') {
      const viaFts = this.searchViaFts(q, limit)
      if (viaFts) return viaFts
      const rows = this.db.all<Record<string, any>>(
        `${FILE_SEARCH_COLUMNS}
         WHERE full_path_lc LIKE ? OR name_lc LIKE ?
         ORDER BY ref_count DESC, size DESC
         LIMIT ?`,
        [`%${q}%`, `%${q}%`, limit]
      )
      return { hits: rows.map(rowToSearchHit), strategy: 'substring-scan', total: rows.length }
    }

    // 前缀：两个独立索引各扫一段范围，再在内存里合并去重。
    // 不用 `OR` 把两个条件写进一条 SQL —— SQLite 对 OR + 双索引常退化为全表扫描。
    const lo = q
    const hi = q + '\uffff' // 前缀上界：比任何以 q 开头的字符串都大
    const byPath = this.db.all<Record<string, any>>(
      `${FILE_SEARCH_COLUMNS} WHERE full_path_lc >= ? AND full_path_lc < ? ORDER BY ref_count DESC, size DESC LIMIT ?`,
      [lo, hi, limit * 2]
    )
    const byName = this.db.all<Record<string, any>>(
      `${FILE_SEARCH_COLUMNS} WHERE name_lc >= ? AND name_lc < ? ORDER BY ref_count DESC, size DESC LIMIT ?`,
      [lo, hi, limit * 2]
    )

    const merged = new Map<string, FileSearchHit>()
    for (const r of [...byPath, ...byName]) {
      const hit = rowToSearchHit(r)
      if (!merged.has(hit.id)) merged.set(hit.id, hit)
    }
    const hits = [...merged.values()]
      .sort((a, b) => b.refCount - a.refCount || b.sizeBytes - a.sizeBytes)
      .slice(0, limit)
    // 迁移失败时范围比较仍能出结果，但走的是扫描 —— 如实标注，不假装走了索引
    return { hits, strategy: this.lcReady ? 'prefix-index' : 'unindexed-scan', total: merged.size }
  }

  /**
   * FTS5 检索（仅当驱动支持时可用）。
   *
   * 设计取舍：**不在写入路径上同步维护 FTS 表** —— 因为生产环境（sql.js）根本到不了这里，
   * 为一条永不执行的路径去改主写入链路的复杂度与风险都不划算。
   * 改为「脏标记 + 首次检索时惰性重建」，重建是一条 INSERT…SELECT，代价 O(n) 且只发生一次。
   */
  private searchViaFts(q: string, limit: number): FileSearchResult | null {
    if (!this.db.supportsFts5) return null
    try {
      if (this.ftsDirty || !this.ftsReady) {
        this.db.exec('DROP TABLE IF EXISTS file_fts')
        this.db.exec("CREATE VIRTUAL TABLE file_fts USING fts5(full_path, name, tokenize='unicode61')")
        this.db.exec('INSERT INTO file_fts(rowid, full_path, name) SELECT rowid, full_path, name FROM file_index')
        this.ftsDirty = false
        this.ftsReady = true
      }
      // FTS5 的 MATCH 语法：`q*` 表示「以 q 开头的词」；裸 q 表示整词匹配
      const rows = this.db.all<Record<string, any>>(
        `SELECT f.id AS id, f.full_path AS full_path, f.name AS name, f.size AS size, f.ext AS ext,
                f.kind AS kind, f.ref_count AS ref_count, f.missing AS missing
         FROM file_fts JOIN file_index f ON f.rowid = file_fts.rowid
         WHERE file_fts MATCH ?
         ORDER BY f.ref_count DESC, f.size DESC
         LIMIT ?`,
        [`${q}*`, limit]
      )
      return { hits: rows.map(rowToSearchHit), strategy: 'fts5', total: rows.length }
    } catch {
      // FTS5 建表/查询失败（例如被限制的构建）→ 退回调用方的全表路径
      return null
    }
  }

  /** 诊断用：检索策略与索引可用性快照 */
  searchDiagnostics(): { driver: string; supportsFts5: boolean; lcReady: boolean; fileRows: number } {
    const c = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM file_index')
    return {
      driver: this.db.driverName,
      supportsFts5: this.db.supportsFts5,
      lcReady: this.lcReady,
      fileRows: Number(c?.c ?? 0)
    }
  }

  /**
   * 全局引用计数：某文件被多少个软件引用。
   * 这是 7.1 共享惩罚 sharedPenalty 的输入，随扫描次数增加而愈发准确。
   */
  refCounts(): Map<string, number> {
    const rows = this.db.all<{ full_path: string; c: number }>(
      `SELECT f.full_path AS full_path, COUNT(DISTINCT d.software_id) AS c
       FROM dependency d JOIN file_index f ON f.id = d.file_id
       GROUP BY f.full_path`
    )
    const m = new Map<string, number>()
    for (const r of rows) m.set(normKey(r.full_path), Number(r.c))
    return m
  }

  refCountOf(path: string): number {
    const r = this.db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT d.software_id) AS c
       FROM dependency d JOIN file_index f ON f.id = d.file_id
       WHERE lower(f.full_path) = ?`,
      [normKey(path)]
    )
    return Number(r?.c ?? 0)
  }

  // ── 图谱缓存（布局坐标缓存，见 5.4.1 / 10.2） ──

  saveGraph(model: GraphModel, layout: Record<string, { x: number; y: number }> | null): void {
    this.db.run(
      `INSERT OR REPLACE INTO graph_cache (software_id,model_json,layout_json,built_at) VALUES (?,?,?,?)`,
      [model.softwareId, JSON.stringify(model), layout ? JSON.stringify(layout) : null, Date.now()]
    )
  }

  loadGraph(softwareId: string): { model: GraphModel; layout: Record<string, { x: number; y: number }> | null; builtAt: number } | null {
    const r = this.db.get<{ model_json: string; layout_json: string | null; built_at: number }>(
      'SELECT model_json, layout_json, built_at FROM graph_cache WHERE software_id = ?',
      [softwareId]
    )
    if (!r?.model_json) return null
    try {
      return {
        model: JSON.parse(r.model_json) as GraphModel,
        layout: r.layout_json ? JSON.parse(r.layout_json) : null,
        builtAt: Number(r.built_at)
      }
    } catch {
      return null
    }
  }

  invalidateGraph(softwareId?: string): void {
    if (softwareId) this.db.run('DELETE FROM graph_cache WHERE software_id = ?', [softwareId])
    else this.db.run('DELETE FROM graph_cache')
  }

  // ── 反向查询 / 下钻（v2.0.0 M4/D2+D4）──

  private rowToFile(r: Record<string, unknown>): FileNode {
    return {
      id: String(r.id),
      fullPath: String(r.full_path ?? ''),
      name: String(r.name ?? ''),
      sizeBytes: Number(r.size ?? 0),
      mtime: Number(r.mtime ?? 0),
      kind: (r.kind as FileNode['kind']) ?? 'dll',
      ext: String(r.ext ?? ''),
      arch: (r.arch as FileNode['arch']) ?? undefined,
      version: r.version ? String(r.version) : undefined,
      signStatus: (r.sign_status as FileNode['signStatus']) ?? undefined,
      missing: Number(r.missing ?? 0) === 1,
      refCount: Number(r.ref_count ?? 0)
    }
  }

  /** 按主键取文件节点 */
  fileById(id: string): FileNode | null {
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM file_index WHERE id = ?', [id])
    return r ? this.rowToFile(r) : null
  }

  /**
   * 反查：哪些软件引用了「该路径」的文件（去重后的最新一条边）。
   *
   * 按 full_path 而非 file_id 匹配 —— 不同软件扫描时对同一系统文件
   * （如 KERNEL32.dll）会产生不同的 file_index 行，但 full_path 相同；
   * refCount 也按路径聚合，两者必须语义一致（M4/D4 真机验证发现的不一致）。
   */
  referencingSoftware(fullPath: string): { swId: string; confidence: number; type: string; evidence: string[] }[] {
    const rows = this.db.all<{
      software_id: string
      confidence: number
      type: string
      evidence: string
    }>(
      `SELECT d.software_id AS software_id, d.confidence AS confidence, d.type AS type, d.evidence AS evidence
       FROM dependency d JOIN file_index f ON f.id = d.file_id
       WHERE lower(f.full_path) = lower(?) ORDER BY d.created_at DESC`,
      [fullPath]
    )
    const best = new Map<string, { swId: string; confidence: number; type: string; evidence: string[] }>()
    for (const r of rows) {
      const swId = String(r.software_id)
      if (best.has(swId)) continue // 首条即最新
      let evidence: string[] = []
      try {
        evidence = JSON.parse(String(r.evidence ?? '[]'))
      } catch {
        /* ignore */
      }
      best.set(swId, { swId, confidence: Number(r.confidence), type: String(r.type), evidence })
    }
    return [...best.values()].sort((a, b) => b.confidence - a.confidence)
  }

  /** 某软件的直接依赖（供下钻子图的 T2 层），按置信度降序取前 limit 条 */
  directDeps(
    softwareId: string,
    limit = 30
  ): { file: FileNode; confidence: number; type: string; evidence: string[] }[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT f.*, d.confidence AS dep_conf, d.type AS dep_type, d.evidence AS dep_evidence
       FROM dependency d JOIN file_index f ON f.id = d.file_id
       WHERE d.software_id = ? ORDER BY d.confidence DESC LIMIT ?`,
      [softwareId, limit]
    )
    return rows.map((r) => ({
      file: this.rowToFile(r),
      confidence: Number(r.dep_conf ?? 0),
      type: String(r.dep_type ?? 'imports'),
      evidence: (() => {
        try {
          return JSON.parse(String(r.dep_evidence ?? '[]'))
        } catch {
          return []
        }
      })()
    }))
  }

  // ── PE 缓存（key = 路径 + 大小 + 修改时间，见 10.2 缓存三层） ──

  getPeCache(path: string, size: number, mtime: number): { imports: string[]; parseStatus: string } | null {
    const r = this.db.get<{ imports_json: string; parse_status: string; size: number; mtime: number }>(
      'SELECT imports_json, parse_status, size, mtime FROM pe_cache WHERE path_hash = ?',
      [normKey(path)]
    )
    if (!r) return null
    if (Number(r.size) !== size || Math.abs(Number(r.mtime) - mtime) > 2000) return null
    try {
      return { imports: JSON.parse(r.imports_json), parseStatus: r.parse_status }
    } catch {
      return null
    }
  }

  setPeCache(path: string, size: number, mtime: number, imports: string[], parseStatus: string): void {
    this.db.run(
      'INSERT OR REPLACE INTO pe_cache (path_hash,path,size,mtime,imports_json,parse_status) VALUES (?,?,?,?,?,?)',
      [normKey(path), path, size, Math.round(mtime), JSON.stringify(imports), parseStatus]
    )
  }

  // ── 垃圾 ──

  saveJunk(scanId: string, items: JunkItem[], summary: JunkSummary): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM junk_item')
      if (items.length) {
        this.db.runMany(
          `INSERT OR REPLACE INTO junk_item
           (id,category_id,full_path,name,size,mtime,risk,group_id,keep_flag,is_dir,scan_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          items.map((i) => [
            i.id,
            i.categoryId,
            i.fullPath,
            i.name,
            i.sizeBytes || 0,
            Math.round(i.mtime || 0),
            i.risk,
            i.groupId || null,
            i.keep ? 1 : 0,
            i.isDir ? 1 : 0,
            scanId
          ])
        )
      }
      this.setKv('junk:summary', JSON.stringify(summary))
    })
  }

  junkSummary(): JunkSummary | null {
    const raw = this.getKv('junk:summary')
    if (!raw) return null
    try {
      return JSON.parse(raw) as JunkSummary
    } catch {
      return null
    }
  }

  junkItems(
    categoryId: string,
    offset = 0,
    limit = 200,
    sort: 'size' | 'mtime' | 'path' = 'size'
  ): { items: JunkItem[]; total: number } {
    const orderBy = sort === 'size' ? 'size DESC' : sort === 'mtime' ? 'mtime DESC' : 'full_path ASC'
    const total = Number(
      this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM junk_item WHERE category_id = ?', [categoryId])?.c ?? 0
    )
    const rows = this.db.all<Record<string, any>>(
      `SELECT * FROM junk_item WHERE category_id = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [categoryId, limit, offset]
    )
    return { items: rows.map(rowToJunk), total }
  }

  junkByIds(ids: string[]): JunkItem[] {
    if (ids.length === 0) return []
    const out: JunkItem[] = []
    // 分片查询，避免 SQL 变量数量上限
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const ph = chunk.map(() => '?').join(',')
      const rows = this.db.all<Record<string, any>>(
        `SELECT * FROM junk_item WHERE id IN (${ph})`,
        chunk as SqlValue[]
      )
      out.push(...rows.map(rowToJunk))
    }
    return out
  }

  junkByCategories(categoryIds: string[]): JunkItem[] {
    if (categoryIds.length === 0) return []
    const ph = categoryIds.map(() => '?').join(',')
    const rows = this.db.all<Record<string, any>>(
      `SELECT * FROM junk_item WHERE category_id IN (${ph})`,
      categoryIds as SqlValue[]
    )
    return rows.map(rowToJunk)
  }

  removeJunk(ids: string[]): void {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const ph = chunk.map(() => '?').join(',')
      this.db.run(`DELETE FROM junk_item WHERE id IN (${ph})`, chunk as SqlValue[])
    }
  }

  // ── 便携标记（用户纠正持久化，见 5.1.2） ──

  setPortableMark(pathKey: string, isPortable: boolean): void {
    this.db.run('INSERT OR REPLACE INTO portable_mark (path_key,is_portable,updated_at) VALUES (?,?,?)', [
      normKey(pathKey),
      isPortable ? 1 : 0,
      Date.now()
    ])
  }

  portableMarks(): Map<string, boolean> {
    const rows = this.db.all<{ path_key: string; is_portable: number }>('SELECT * FROM portable_mark')
    return new Map(rows.map((r) => [r.path_key, Number(r.is_portable) === 1]))
  }

  // ── KV ──

  getKv(k: string): string | null {
    const r = this.db.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k])
    return r?.v ?? null
  }

  setKv(k: string, v: string): void {
    this.db.run('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)', [k, v])
  }
  // ── 扫描元数据 ──

  recordScan(id: string, type: string, startedAt: number, finishedAt: number, status: string, payload?: unknown): void {
    this.db.run(
      'INSERT OR REPLACE INTO scan_meta (id,type,started_at,finished_at,volume,usn_cursor,status,payload) VALUES (?,?,?,?,?,?,?,?)',
      [id, type, startedAt, finishedAt, null, null, status, payload ? JSON.stringify(payload) : null]
    )
  }

  lastScan(type: string): { id: string; finished_at: number; status: string } | undefined {
    return this.db.get('SELECT id, finished_at, status FROM scan_meta WHERE type = ? ORDER BY finished_at DESC LIMIT 1', [
      type
    ])
  }

  async persist(): Promise<void> {
    await this.db.persist()
  }

  /**
   * 诊断用统计（v2.0.0 M3/C5）。
   * 只返回**计数**，不含任何路径或名称 —— 诊断包因此不需要额外脱敏。
   */
  dbStats(): { driver: string; tables: Record<string, number>; lastScans: Record<string, unknown> } {
    const tables = [
      'software',
      'file_index',
      'dependency',
      'pe_cache',
      'graph_cache',
      'junk_item',
      'junk_category',
      'scan_meta',
      'portable_mark'
    ]
    const counts: Record<string, number> = {}
    for (const t of tables) {
      try {
        counts[t] = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0
      } catch {
        counts[t] = -1
      }
    }
    const lastScans: Record<string, unknown> = {}
    for (const type of ['software', 'junk', 'graph']) {
      const r = this.lastScan(type)
      lastScans[type] = r ? { status: r.status, finishedAt: r.finished_at } : null
    }
    const summary = this.junkSummary()
    return {
      driver: this.db.driverName,
      tables: counts,
      lastScans: {
        ...lastScans,
        junkSummary: summary
          ? {
              totalBytes: summary.totalBytes,
              totalCount: summary.totalCount,
              scannedFiles: summary.scannedFiles,
              scanMs: summary.scanMs,
              categories: summary.categories.length
            }
          : null
      }
    }
  }

  async close(): Promise<void> {
    await this.db.close()
  }
}

// ───────────────── 文件检索的行映射（I-11） ─────────────────

/** 检索查询的列清单 —— 三处查询共用，避免列顺序漂移 */
const FILE_SEARCH_COLUMNS = `SELECT id, full_path, name, size, ext, kind, ref_count, missing
  FROM file_index`

function rowToSearchHit(r: Record<string, any>): FileSearchHit {
  return {
    id: String(r.id),
    fullPath: String(r.full_path ?? ''),
    name: String(r.name ?? ''),
    sizeBytes: Number(r.size || 0),
    ext: String(r.ext ?? ''),
    kind: String(r.kind ?? ''),
    refCount: Number(r.ref_count || 0),
    missing: Number(r.missing) === 1
  }
}

function rowToJunk(r: Record<string, any>): JunkItem {
  return {
    id: r.id,
    categoryId: r.category_id,
    fullPath: r.full_path,
    name: r.name,
    sizeBytes: Number(r.size || 0),
    mtime: Number(r.mtime || 0),
    risk: r.risk,
    groupId: r.group_id ?? undefined,
    keep: Number(r.keep_flag) === 1 ? true : undefined,
    isDir: Number(r.is_dir) === 1 ? true : undefined
  }
}
