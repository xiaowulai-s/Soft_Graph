/**
 * v3.2 B1：浏览器运行中时跳过隐私清理项（防止损坏 Cookie/会话数据）。
 * 纯函数，便于单测。
 */
export const BROWSER_PROCESSES = ['chrome.exe', 'msedge.exe', 'firefox.exe'] as const

export interface JunkItemLike {
  id: string
  categoryId: string
}

export interface BlockedItem {
  id: string
  reason: string
}

export function pickBrowserBlockedItems(
  items: JunkItemLike[],
  runningBrowsers: string[]
): BlockedItem[] {
  if (runningBrowsers.length === 0) return []
  return items
    .filter((i) => i.categoryId === 'GC-17')
    .map((i) => ({ id: i.id, reason: `浏览器正在运行（${runningBrowsers.join(' / ')}），已跳过以防损坏用户数据` }))
}
