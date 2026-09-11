/**
 * 通过 CDP（Chrome DevTools Protocol）连接已启动的 Electron 应用，做 UI 冒烟：
 *   - 读取渲染进程的 DOM 状态（顶栏 / 三栏 / 侧边栏 / 按钮）
 *   - 截取主界面与浮窗画面
 * 需要目标应用以 --remote-debugging-port=9222 启动。
 */
import { writeFileSync } from 'node:fs'

const PORT = Number(process.argv[2] ?? 9222)
const OUT = process.argv[3] ?? '.tmp'

type Conn = { ws: WebSocket; id: number; send: (m: string, p?: unknown) => Promise<unknown> }

async function connect(wsUrl: string): Promise<Conn> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('WebSocket 连接失败'))
    setTimeout(() => rej(new Error('WebSocket 连接超时')), 8000)
  })
  let id = 0
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  ws.onmessage = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } }
    if (!msg.id) return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.rej(new Error(msg.error.message))
    else p.res(msg.result)
  }
  const send = (method: string, params: unknown = {}): Promise<unknown> => {
    const mid = ++id
    ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((res, rej) => {
      pending.set(mid, { res, rej })
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error(`${method} 超时`))
        }
      }, 25000)
    })
  }
  return { ws, id, send } as Conn
}

async function fetchJson(url: string, tries = 6): Promise<unknown> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1200))
    }
  }
  throw lastErr
}

async function main(): Promise<void> {
  const list = (await fetchJson(`http://127.0.0.1:${PORT}/json/list`)) as {
    type: string
    title: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  console.log('调试目标：')
  for (const t of list) console.log(`  [${t.type}] ${t.title.slice(0, 60)}  ${t.url.slice(0, 70)}`)

  const pages = list.filter((t) => t.type === 'page')
  if (pages.length === 0) {
    console.error('没有可调试的页面目标')
    process.exit(1)
  }

  for (const page of pages) {
    const isFloat = page.url.includes('float.html')
    const label = isFloat ? '浮窗' : '主界面'
    console.log(`\n=== ${label} (${page.url.split('/').pop()}) ===`)
    const c = await connect(page.webSocketDebuggerUrl)
    await c.send('Page.enable')
    await c.send('Runtime.enable')

    const r = (await c.send('Runtime.evaluate', {
      expression: `(() => {
        const q = (s) => document.querySelector(s);
        const txt = (s) => (q(s)?.textContent || '').trim().replace(/\\s+/g,' ').slice(0,120);
        const n = (s) => document.querySelectorAll(s).length;
        return JSON.stringify({
          title: document.title,
          hasApp: !!q('#app') || !!q('#float'),
          appHtmlLen: (q('#app') || q('#float'))?.innerHTML.length ?? 0,
          brand: txt('.tb-name'),
          leftPanel: !!q('.sl'),
          canvas: !!q('.gc'),
          rightPanel: !!q('.js'),
          statusBar: txt('.sb'),
          softwareCount: n('.sl-item'),
          toolbarButtons: n('.tb button'),
          legendItems: n('.gc-legend-item'),
          junkEmpty: txt('.js-empty'),
          floatCards: n('.fw-card'),
          floatHead: txt('.fw-head'),
          bodyClasses: document.body.className,
          theme: document.documentElement.dataset.theme,
          visibleText: (document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 240)
        });
      })()`,
      returnByValue: true
    })) as { result?: { value?: string } }
    const val = r.result?.value ? JSON.parse(r.result.value) : null
    console.log('  DOM 状态：')
    if (val) for (const [k, v] of Object.entries(val)) console.log(`    ${k}: ${v}`)

    const shot = (await c.send('Page.captureScreenshot', { format: 'png' })) as { data?: string }
    if (shot.data) {
      const file = `${OUT}/cdp-${isFloat ? 'float' : 'main'}.png`
      writeFileSync(file, Buffer.from(shot.data, 'base64'))
      console.log(`  截图已保存：${file}  (${Math.round((shot.data.length * 3) / 4 / 1024)} KB)`)
    }
    c.ws.close()
  }
}

main().catch((e) => {
  console.error('CDP 冒烟失败：', e)
  process.exit(1)
})
