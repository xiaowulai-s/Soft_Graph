/**
 * CDP 交互式端到端验证：
 *   1. 点击「扫描软件」→ 轮询等待完成
 *   2. 选中第一个软件 → 等图谱构建
 *   3. 截图（图谱态）
 *   4. 点击「开始扫描」垃圾 → 等完成 → 截图（侧边栏数据态）
 *   5. 输出 DOM 统计
 */
import { writeFileSync } from 'node:fs'

const PORT = Number(process.argv[2] ?? 9222)
const OUT = process.argv[3] ?? '.tmp'

async function fetchJson(url: string, tries = 8): Promise<any[]> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      // fetch 的 json() 返回 unknown，先断言再返回（本文件只在测试脚本中消费）
      return (await res.json()) as any[]
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw lastErr
}

interface Conn {
  ws: WebSocket
  send: (method: string, params?: unknown) => Promise<any>
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
      }, 30_000)
    })
  }
  return { ws, send }
}

async function evalJs(c: Conn, expr: string): Promise<any> {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败')
  return r.result?.value
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function shot(c: Conn, name: string): Promise<void> {
  const s = await c.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/e2e-${name}.png`, Buffer.from(s.data, 'base64'))
  console.log(`  截图: e2e-${name}.png`)
}

async function main(): Promise<void> {
  const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = list.find((t: any) => t.type === 'page' && !t.url.includes('float'))
  if (!page) throw new Error('找不到主界面页面')
  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Runtime.enable')

  // 1. 触发软件扫描
  console.log('1. 触发软件扫描…')
  await evalJs(c, `(() => { const b=[...document.querySelectorAll('.tb button')].find(x=>/扫描软件|重新扫描/.test(x.textContent)); b?.click(); return !!b })()`)
  await shot(c, 'scanning')

  // 等待扫描完成：左栏出现软件条目且按钮恢复「重新扫描」
  let items = 0
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    items = await evalJs(c, `document.querySelectorAll('.sl-item').length`)
    const btn = await evalJs(c, `[...document.querySelectorAll('.sl button')].some(x=>/刷新|扫描/.test(x.textContent)) && !document.querySelector('.sl-progress')`)
    console.log(`   t+${(i + 1) * 5}s 软件条目=${items} 进行中=${!btn}`)
    if (items > 0 && btn) break
  }
  console.log(`   软件扫描完成：${items} 个条目`)

  // 2. 选中体积相关的一个软件（点第 2 个条目，避免恰好是驱动包）
  console.log('2. 选择软件并构建图谱…')
  const picked = await evalJs(c, `(() => {
    const rows = [...document.querySelectorAll('.sl-item')];
    const target = rows.find(r => /chrome|edge|notepad|计算器|terminal|code|zip|7-zip/i.test(r.textContent)) ?? rows[Math.min(2, rows.length-1)];
    target?.click();
    return target?.querySelector('.sl-name')?.textContent ?? '(未找到)';
  })()`)
  console.log(`   选中：${picked}`)

  // 等图谱构建完成（loading 遮罩消失且画布出现节点）
  let nodes = 0
  for (let i = 0; i < 30; i++) {
    await sleep(4000)
    const st = await evalJs(c, `(() => ({
      loading: !!document.querySelector('.gc-mask'),
      nodes: document.querySelectorAll('.gc-node').length,
      meta: (document.querySelector('.gc-meta')?.textContent || '').trim()
    }))()`)
    nodes = st.nodes
    console.log(`   t+${(i + 1) * 4}s loading=${st.loading} 节点=${nodes} ${st.meta.slice(0, 60)}`)
    if (!st.loading && nodes > 0) break
  }
  await shot(c, 'graph')

  // 3. 垃圾扫描
  console.log('3. 触发垃圾扫描…')
  await evalJs(c, `(() => { const b=[...document.querySelectorAll('.js button')].find(x=>/开始扫描|重新扫描/.test(x.textContent)); b?.click(); return !!b })()`)
  let junkDone = false
  for (let i = 0; i < 40; i++) {
    await sleep(5000)
    const st = await evalJs(c, `(() => ({
      scanning: !!document.querySelector('.js-progress'),
      cats: document.querySelectorAll('.js-cat').length,
      donut: document.querySelectorAll('.js-arc').length,
      total: (document.querySelector('.js-donut-val')?.textContent || '').trim()
    }))()`)
    console.log(`   t+${(i + 1) * 5}s scanning=${st.scanning} 分类=${st.cats} 扇区=${st.donut} 总计=${st.total}`)
    if (!st.scanning && st.cats > 0) {
      junkDone = true
      break
    }
  }
  await shot(c, 'junk')

  // 4. 悬停验证：给第一个文件节点派发 mouseenter，检查悬停卡片
  console.log('4. 悬停浮层验证…')
  const hover = await evalJs(c, `(() => {
    const n = [...document.querySelectorAll('.gc-node')].find(x => x.querySelector('circle') && !x.querySelector('image'));
    if (!n) return { ok: false, why: '无文件节点' };
    n.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return { ok: true };
  })()`)
  await sleep(600)
  const card = await evalJs(c, `(() => {
    const c = document.querySelector('.hover-card');
    if (!c) return { present: false };
    return {
      present: true,
      title: c.querySelector('.hc-name')?.textContent,
      path: c.querySelector('.hc-path')?.textContent?.slice(0, 100),
      hasCopy: !!([...c.querySelectorAll('button')].find(b => /复制路径/.test(b.textContent)))
    };
  })()`)
  console.log(`   悬停触发=${hover.ok} 浮层出现=${card.present} 标题=${card.title ?? '-'} 带复制按钮=${card.hasCopy}`)
  if (card.path) console.log(`   路径：${card.path}`)
  await shot(c, 'hover')

  console.log(`\\n端到端结果：软件条目=${items} 图谱节点=${nodes} 垃圾扫描完成=${junkDone} 悬停浮层=${card.present}`)
  writeFileSync(
    `${OUT}/e2e-summary.json`,
    JSON.stringify({ items, nodes, junkDone, hoverCard: card }, null, 2)
  )
}

main().catch((e) => {
  console.error('E2E 失败：', e)
  process.exit(1)
})
