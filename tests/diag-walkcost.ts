/**
 * 测量「未命中目录缓存」的理论收益：
 *   A. 完整遍历（readdir + 每个文件 stat）
 *   B. 只 readdir（不 stat 文件）
 *   C. 只 readdir 且记录目录 mtime（评估目录级缓存可行性）
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['D:\\下载']

async function walk(
  root: string,
  mode: 'full' | 'readdir',
  st: { dirs: number; files: number; bytes: number; dirMtimes: number[] }
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  st.dirs++
  for (const e of entries) {
    const full = join(root, e.name)
    if (e.isDirectory()) {
      await walk(full, mode, st)
    } else if (e.isFile()) {
      st.files++
      if (mode === 'full') {
        try {
          st.bytes += (await fs.stat(full)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
}

async function main(): Promise<void> {
  for (const root of ROOTS) {
    for (const mode of ['full', 'readdir'] as const) {
      const st = { dirs: 0, files: 0, bytes: 0, dirMtimes: [] as number[] }
      const t0 = Date.now()
      await walk(root, mode, st)
      const ms = Date.now() - t0
      console.log(
        `${root} [${mode}] ${(ms / 1000).toFixed(2)}s · 目录 ${st.dirs} · 文件 ${st.files} · 合计 ${(st.bytes / 1048576).toFixed(0)}MB`
      )
    }
  }
  process.exit(0)
}
void main()
