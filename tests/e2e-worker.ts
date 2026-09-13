/**
 * C2 验证：垃圾扫描跑在 utilityProcess 中，且 Worker 被杀后能重启续扫
 *
 * 步骤：
 *   1. 通过 renderer 发起强制全量扫描（force，确保不是缓存命中）
 *   2. 采集进度事件（应能看到规则级进度）
 *   3. 扫描中途杀掉 utility 子进程
 *   4. 继续采集，期望出现「扫描进程异常退出，正在重启并续扫」并最终完成
 *
 * 用法：node scripts/run-ts.mjs tests/e2e-worker.ts 9222 .tmp
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9222)
const OUT = process.argv[3] ?? '.tmp'

async function fetchJson(url: string, tries = 8): Promise<any[]> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      return (await res.json()) as any[]
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw lastErr
}

interface Conn {
  send: (method: string, params?: unknown) => Promise<any>
  ev: (expr: string) => Promise<any>
}

async function connect(wsUrl: string): Promise<Conn> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('ws 连接失败'))
    setTimeout(() => rej(new Error('ws 超时')), 10_000)
  })
  let id = 0
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>()
  ws.onmessage = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data))
    if (!msg.id) return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
  }
  const send = (method: string, params: unknown = {}): Promise<any> => {
    const mid = ++id
    ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((res, rej) => {
      pending.set(mid, { res, rej })
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error(`${method} 超时`))
        }
      }, 60_000)
    })
  }
  const ev = async (expr: string): Promise<any> =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value
  return { send, ev }
}

/** 读取扫描 Worker 自报的 PID（由 Worker 写盘，最可靠） */
function findUtilityPid(): number {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'SoftGraph', 'tmp', 'junk-scan-worker.pid')
  ]
  for (const f of candidates) {
    try {
      const pid = Number(readFileSync(f, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 0) return pid
    } catch {
      /* 换下一个 */
    }
  }
  return 0
}

async function main(): Promise<void> {
  const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = list.find((t) => t.type === 'page' && !t.url.includes('float'))
  if (!page) throw new Error('未找到主窗口页面')
  const conn = await connect(page.webSocketDebuggerUrl)

  // 进度事件：注入收集器（挂到 window 上，避免依赖应用自身状态）
  await conn.ev(`
    window.__phases = [];
    (() => {
      const orig = window.api.scanJunk;
      return true;
    })()
  `)

  console.log('→ 发起强制全量扫描（force）')
  const started = await conn.ev(`(async () => {
    window.__phases = [];
    window.api.onJunkProgress((p) => { window.__phases.push(p.phase + '|' + Math.round(p.percent)); });
    await window.api.scanJunk({ force: true });
    return 'ok';
  })()`)
  console.log('  扫描已启动:', started)

  // 等 20s 让扫描进入中段，然后杀掉 utility 进程
  await new Promise((r) => setTimeout(r, 25_000))
  const midPhases = await conn.ev(`window.__phases.slice(-3)`)
  console.log('  中段进度:', JSON.stringify(midPhases))

  const pid = findUtilityPid()
  console.log('  utility 进程 PID =', pid || '(未找到)')
  let killed = false
  if (pid) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true })
      killed = true
      console.log('  ✅ 已强制结束扫描进程（模拟崩溃）')
    } catch (e) {
      console.log('  ⚠️ 结束进程失败:', (e as Error).message.slice(0, 80))
    }
  }

  // 等待扫描完成（最多 6 分钟）
  let done = false
  let last = ''
  for (let i = 0; i < 72; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const phases: string[] = (await conn.ev(`window.__phases`)) ?? []
    last = phases.slice(-1)[0] ?? ''
    if (/扫描完成|扫描失败/.test(last)) {
      done = true
      break
    }
    if (i % 3 === 0) console.log(`  [${i * 5}s] ${last}`)
  }

  const phases: string[] = (await conn.ev(`window.__phases`)) ?? []
  const restarted = phases.some((p) => /重启并续扫/.test(p))
  // 规则级进度：进度文案形如「回收站 · 遍历|12」，统计不同规则名数量
  const ruleNames = new Set(phases.map((p) => p.split(' · ')[0]).filter((n) => n && !/准备|扫描完成|扫描失败|重启/.test(n)))
  const hasRuleProgress = ruleNames.size >= 3
  console.log('\n===== C2 验证结果 =====')
  console.log('扫描完成:', done, '· 尾部事件:', last)
  console.log('规则级进度可见:', hasRuleProgress, `（覆盖 ${ruleNames.size} 类）`)
  console.log('杀进程后触发重启续扫:', killed ? (restarted ? '✅ 是' : '❌ 未见续扫事件') : '(未杀进程，跳过)')
  console.log('事件总数:', phases.length)

  const summary = await conn.ev(`(async () => {
    const s = await window.api.junkSummary();
    return s ? { total: s.totalCount, bytes: s.totalBytes, files: s.scannedFiles } : null;
  })()`)
  console.log('最终结果:', JSON.stringify(summary))
  writeFileSync(`${OUT}/e2e-worker.json`, JSON.stringify({ done, restarted, phases: phases.slice(-30) }, null, 2))
  process.exit(done ? 0 : 1)
}

void main().catch((e) => {
  console.error('失败:', e)
  process.exit(1)
})
