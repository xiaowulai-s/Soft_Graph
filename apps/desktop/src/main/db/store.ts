/**
 * 数据访问层
 * 对应技术设计方案 6.2 数据库表结构（SQLite）
 *
 * 与文档差异：file_index.full_path 的 FTS5 虚拟表在 sql.js 默认构建中不含 FTS5 模块，
 * 因此路径检索退化为 LIKE + 前缀索引；若运行时命中 node:sqlite 驱动则可无损启用（预留 ensureFts）。
 */

import type { Db, SqlValue } from './driver'
import type {
  DependencyEdge,
  FileNode,
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
  ref_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file_name ON file_index(name);
CREATE INDEX IF NOT EXISTS idx_file_path ON file_index(full_path);

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

  get driverName(): string {
    return this.db.driverName
  }

  init(): void {
    this.db.exec(SCHEMA)
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
           (id,full_path,name,size,mtime,kind,ext,arch,version,sign_status,missing,parse_status,ref_count)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            f.refCount ?? 0
          ])
        )
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

  async close(): Promise<void> {
    await this.db.close()
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
