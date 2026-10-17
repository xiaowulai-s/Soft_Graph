/**
 * v3.1 P0-1 定时静默清理（借鉴 UniGetUI 调度思路）
 *
 * 到期判定：enabled && now - lastRunAt >= intervalHours。
 * 执行：扫描 defaultSelected 分类（低风险直清项）→ 隔离清理 → 审计（clean 动作自带留痕）。
 * 约束：扫描进行中/清理进行中不重复触发；失败不影响下次判定（lastRunAt 仅在成功后更新）。
 */
export interface ScheduleCheck {
  due: boolean
  reason: string
}

export function isScheduleDue(
  s: { enabled: boolean; intervalHours: number },
  lastRunAt: number,
  now = Date.now()
): ScheduleCheck {
  if (!s.enabled) return { due: false, reason: '定时清理未启用' }
  if (!Number.isFinite(s.intervalHours) || s.intervalHours < 1) {
    return { due: false, reason: '间隔非法（至少 1 小时）' }
  }
  if (!lastRunAt) return { due: true, reason: '从未运行过' }
  const due = now - lastRunAt >= s.intervalHours * 3600_000
  return { due, reason: due ? '已到期' : '未到期' }
}

/** winget upgrade 文本输出解析（GBK 控制台码页；表头两行 + 对齐列） */
export function parseWingetUpgradeOutput(text: string): { id: string; name: string; version: string; available: string }[] {
  const out: { id: string; name: string; version: string; available: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('  ') || line.trim().startsWith('-')) continue
    // 数据行：至少 4 列以 2+ 空格分隔；跳过表头（中英文）
    if (/^(名称|Name)\s/i.test(line)) continue
    if (/^-{3,}/.test(line.trim())) continue
    const cols = line.trim().split(/\s{2,}/)
    if (cols.length < 3) continue
    // winget upgrade 列序：Name Id Version Available [Source]
    const [name, id, version, available] = cols
    if (!id || !version || !available || available === version) continue
    if (/(可用|Available|升级|版本)/i.test(name) && cols.length < 4) continue
    out.push({ name, id, version, available })
  }
  return out
}
