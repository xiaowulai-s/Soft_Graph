/**
 * 审计日志（v2.0.0 M5/E4）
 *
 * 与 logger（诊断用途）的区别：
 *   - 审计回答「**谁在什么时候对哪些文件做了什么**」—— 是责任记录，不是调试信息
 *   - **不脱敏**：路径就是审计的价值所在（这是用户本机的私有记录，
 *     位于用户自己的数据目录）；导出诊断包时**不包含**审计文件
 *   - 只追加（append-only），每行一条 JSONL；损坏的行跳过不阻断读取
 *   - 覆盖动作：清理执行 / 提权清理 / 重启后删除 / 隔离区还原 / 隔离区销毁
 *
 * 留痕内容：时间、动作、任务 id、每个文件的结果（成功/失败原因）、
 * 隔离批次（可还原的依据）、释放字节。
 */

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditAction, AuditEntry } from '../shared/types'

export type { AuditAction, AuditEntry } from '../shared/types'

export class AuditLog {
  private dir: string
  private queue: AuditEntry[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  get file(): string {
    return join(this.dir, 'audit.jsonl')
  }

  async append(entry: AuditEntry): Promise<void> {
    this.queue.push(entry)
    // 审计条目低频但高价值 —— 500ms 内落盘即可（进程退出前由 flush 兜底）
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush()
      }, 500)
      this.timer.unref?.()
    }
  }

  /** 立即落盘（应用退出 / 审计查看前） */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    try {
      await mkdir(this.dir, { recursive: true })
      const text = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
      await appendFile(this.file, text, 'utf8')
    } catch {
      // 落盘失败不阻断主流程（但意味着该批操作未留痕 —— 与 logger 同策略）
    }
  }

  /** 读取最近 limit 条（新→旧）；损坏行跳过 */
  async recent(limit = 50): Promise<AuditEntry[]> {
    await this.flush()
    let raw = ''
    try {
      const st = await stat(this.file)
      if (st.size === 0) return []
      // 审计文件不大（每条 ~1KB × 动作数），直接整读；超过 16MB 只取尾部
      const buf = await readFile(this.file)
      raw = buf.subarray(Math.max(0, buf.length - 16 * 1024 * 1024)).toString('utf8')
    } catch {
      return []
    }
    const out: AuditEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as AuditEntry)
      } catch {
        /* 损坏行跳过 */
      }
    }
    return out.reverse().slice(0, limit)
  }
}
