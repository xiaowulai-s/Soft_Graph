/**
 * D1 真机 FPS 验证：CDP 连上 dev app → 注入合成大图 → 采样帧率 + 渐进渲染行为
 * 前提：app 以 `npm run dev` + --remote-debugging-port=9222 启动（本脚本不负责拉起 GUI）
 */
const PORT = Number(process.argv[2] ?? 9222)

async function fetchJson(url: string, tries = 10): Promise<any[]> {
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
  return { send }
}

async function evalJs(c: Conn, expr: string): Promise<any> {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败')
  return r.result?.value
}

async function main(): Promise<void> {
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = targets.find((t) => t.type === 'page' && /title/i.test(t.url + t.title) === false) ?? targets.find((t) => t.type === 'page')
  const mainPage = targets.find((t) => t.type === 'page' && !t.url.includes('float')) ?? page
  if (!mainPage) throw new Error('未找到主窗口页面')
  console.log('页面:', mainPage.title || mainPage.url)
  const c = await connect(mainPage.webSocketDebuggerUrl)

  // 0) 生产构建需要 localStorage 标记启用压测钩子：设置后重载
  await evalJs(c, `localStorage.setItem('sg-stress','1')`)
  await c.send('Page.enable')
  await c.send('Page.reload', { ignoreCache: true })
  await new Promise((r) => setTimeout(r, 3000))

  // 1) 注入 8000 节点合成图
  const injected = await evalJs(c, 'window.__sgStress ? window.__sgStress(8000) : "NO_HOOK"')
  console.log('注入:', injected)
  if (injected === 'NO_HOOK') throw new Error('__sgStress 钩子不存在（dev 构建才注入）')
  await new Promise((r) => setTimeout(r, 500))

  // 2) 观察渐进渲染：前 12 秒每 500ms 读一次状态栏
  const samples: string[] = []
  for (let i = 0; i < 24; i++) {
    const meta = await evalJs(c, `document.querySelector('.gc-meta')?.textContent?.trim() ?? '(无)'`)
    if (samples[samples.length - 1] !== meta) samples.push(meta)
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('渐进过程采样：')
  for (const s of samples) console.log('  ', s)

  // 3) FPS 采样：3 个 5 秒窗口（含交互模拟）
  for (const label of ['静止', '拖拽模拟（鼠标移动）', '静止（收敛后）']) {
    const fps = await evalJs(c, `(async () => {
      const frames = []
      const t0 = performance.now()
      const loop = () => { frames.push(performance.now()); if (performance.now() - t0 < 5000) requestAnimationFrame(loop) }
      requestAnimationFrame(loop)
      const move = () => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 + Math.random() * 400, clientY: 200 + Math.random() * 300, bubbles: true }))
      }
      const iv = setInterval(move, 50)
      await new Promise((r) => setTimeout(r, 5200))
      clearInterval(iv)
      const dt = frames[frames.length - 1] - frames[0]
      const n = frames.length - 1
      return { fps: +(n / (dt / 1000)).toFixed(1), frames: n, dropped: frames.filter((t, i) => i > 0 && t - frames[i - 1] > 33).length }
    })()`)
    console.log(`FPS[${label}]: ${fps.fps} fps · ${fps.frames} 帧 / 5s · 掉帧(>33ms): ${fps.dropped}`)
  }

  // 4) 最终状态
  const meta = await evalJs(c, `document.querySelector('.gc-meta')?.textContent?.trim() ?? '(无)'`)
  console.log('最终状态:', meta)
  console.log('D1-FPS-CHECK-DONE')
  process.exit(0)
}

main().catch((e) => {
  console.error('FAIL:', (e as Error).message)
  process.exit(1)
})
