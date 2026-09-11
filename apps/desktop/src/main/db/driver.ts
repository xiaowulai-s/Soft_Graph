/**
 * SQLite 驱动抽象（双驱动）
 * 对应技术设计方案 6.2 数据库表结构 / L1 数据层
 *
 * 与文档的实现差异（原生层降级）：
 *   文档选型为 better-sqlite3 + WAL。better-sqlite3 是原生模块，需针对 Electron ABI
 *   用 node-gyp / @electron/rebuild 重新编译，依赖 Visual Studio 构建工具链，
 *   在无构建环境的机器上安装即失败。因此这里做成双驱动：
 *     1) NodeSqliteDriver —— 若运行时提供 node:sqlite（Node ≥ 22.5 / 新版 Electron），直接用，行为与文档一致（含 WAL）；
 *     2) SqlJsDriver     —— 回退到 sql.js（SQLite 编译为 WASM），零原生依赖，
 *                            内存中执行，按防抖策略整库落盘，保证可用性。
 *   上层业务只依赖本文件的 Db 接口，未来换回 better-sqlite3 只需新增一个驱动。
 */

import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export type SqlValue = string | number | null | Uint8Array
export type Row = Record<string, SqlValue>

export interface Db {
  readonly driverName: string
  exec(sql: string): void
  run(sql: string, params?: SqlValue[]): void
  all<T = Row>(sql: string, params?: SqlValue[]): T[]
  get<T = Row>(sql: string, params?: SqlValue[]): T | undefined
  /** 批量执行同一条语句（性能关键路径：垃圾项与依赖批量写入） */
  runMany(sql: string, rows: SqlValue[][]): void
  transaction<T>(fn: () => T): T
  persist(): Promise<void>
  close(): Promise<void>
}

// ───────────────── node:sqlite 驱动 ─────────────────

class NodeSqliteDriver implements Db {
  readonly driverName = 'node:sqlite'
  private db: any
  /** 事务重入深度：transaction() 内再调 runMany() 时不再嵌套 BEGIN */
  private txDepth = 0

  constructor(file: string, DatabaseSync: any) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  run(sql: string, params: SqlValue[] = []): void {
    const st = this.db.prepare(sql)
    st.run(...params)
  }

  all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  get<T = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  runMany(sql: string, rows: SqlValue[][]): void {
    const st = this.db.prepare(sql)
    const nested = this.txDepth > 0
    if (!nested) this.db.exec('BEGIN')
    try {
      for (const r of rows) st.run(...r)
      if (!nested) this.db.exec('COMMIT')
    } catch (e) {
      if (!nested) this.db.exec('ROLLBACK')
      throw e
    }
  }

  transaction<T>(fn: () => T): T {
    const nested = this.txDepth > 0
    if (!nested) this.db.exec('BEGIN')
    this.txDepth++
    try {
      const r = fn()
      if (!nested) this.db.exec('COMMIT')
      return r
    } catch (e) {
      if (!nested) this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.txDepth--
    }
  }

  async persist(): Promise<void> {
    /* node:sqlite 直接落盘，无需额外操作 */
  }

  async close(): Promise<void> {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

// ───────────────── sql.js（WASM）驱动 ─────────────────

class SqlJsDriver implements Db {
  readonly driverName = 'sql.js (WASM)'
  private db: any
  private file: string
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  /** 事务重入深度：transaction() 内再调 runMany() 时不再嵌套 BEGIN */
  private txDepth = 0

  constructor(db: any, file: string) {
    this.db = db
    this.file = file
    this.db.run('PRAGMA foreign_keys = ON')
  }

  private markDirty(): void {
    this.dirty = true
    if (this.timer) return
    // 防抖落盘：整库导出成本随体积增长，避免每次写入都全量写文件
    this.timer = setTimeout(() => {
      this.timer = null
      void this.persist()
    }, 3000)
  }

  exec(sql: string): void {
    this.db.run(sql)
    this.markDirty()
  }

  run(sql: string, params: SqlValue[] = []): void {
    const st = this.db.prepare(sql)
    try {
      st.run(params as any)
    } finally {
      st.free()
    }
    this.markDirty()
  }

  all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
    const st = this.db.prepare(sql)
    const out: T[] = []
    try {
      st.bind(params as any)
      while (st.step()) out.push(st.getAsObject() as T)
    } finally {
      st.free()
    }
    return out
  }

  get<T = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    const rows = this.all<T>(sql, params)
    return rows[0]
  }

  runMany(sql: string, rows: SqlValue[][]): void {
    if (rows.length === 0) return
    const st = this.db.prepare(sql)
    const nested = this.txDepth > 0
    if (!nested) this.db.run('BEGIN')
    try {
      for (const r of rows) {
        st.run(r as any)
        st.reset()
      }
      if (!nested) this.db.run('COMMIT')
    } catch (e) {
      if (!nested) this.db.run('ROLLBACK')
      throw e
    } finally {
      st.free()
    }
    this.markDirty()
  }

  transaction<T>(fn: () => T): T {
    const nested = this.txDepth > 0
    if (!nested) this.db.run('BEGIN')
    this.txDepth++
    try {
      const r = fn()
      if (!nested) this.db.run('COMMIT')
      this.markDirty()
      return r
    } catch (e) {
      if (!nested) this.db.run('ROLLBACK')
      throw e
    } finally {
      this.txDepth--
    }
  }

  async persist(): Promise<void> {
    if (!this.dirty) return
    try {
      const data: Uint8Array = this.db.export()
      mkdirSync(dirname(this.file), { recursive: true })
      // 原子写：先写临时文件再改名，避免进程被杀导致数据库半截损坏
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, data)
      renameSync(tmp, this.file)
      this.dirty = false
    } catch {
      /* 落盘失败不应中断业务，下次仍会重试 */
    }
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.persist()
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

// ───────────────── 工厂 ─────────────────

export interface OpenDbOptions {
  file: string
  /** sql.js 的 wasm 文件所在目录 */
  wasmDir?: string
}

export async function openDb(opts: OpenDbOptions): Promise<Db> {
  // 1) 优先 node:sqlite（与文档选型行为一致，含 WAL）
  try {
    const mod = await import('node:sqlite')
    const DatabaseSync = (mod as any).DatabaseSync
    if (DatabaseSync) return new NodeSqliteDriver(opts.file, DatabaseSync)
  } catch {
    /* 当前运行时不提供 node:sqlite，回退 */
  }

  // 2) 回退 sql.js
  const initSqlJs = require('sql.js') as (config?: {
    locateFile?: (f: string) => string
  }) => Promise<any>

  const SQL = await initSqlJs({
    locateFile: (f: string) => {
      if (opts.wasmDir) {
        const p = require('node:path').join(opts.wasmDir, f)
        if (existsSync(p)) return p
      }
      try {
        return require.resolve(`sql.js/dist/${f}`)
      } catch {
        return f
      }
    }
  })

  let db: any
  if (existsSync(opts.file)) {
    try {
      db = new SQL.Database(readFileSync(opts.file))
    } catch {
      // 数据库损坏 → 备份后重建，不让用户卡死在启动阶段
      try {
        await fs.rename(opts.file, opts.file + `.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      db = new SQL.Database()
    }
  } else {
    db = new SQL.Database()
  }
  return new SqlJsDriver(db, opts.file)
}
