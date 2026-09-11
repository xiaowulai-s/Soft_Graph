const net = require('net')
const dns = require('dns')
const http = require('http')

function tcp(host, port, label, timeout = 8000) {
  return new Promise((resolve) => {
    const t = Date.now()
    const s = net.connect({ host, port })
    const done = (msg) => {
      s.destroy()
      resolve(`${label} ${host}:${port} -> ${msg} (${Date.now() - t}ms)`)
    }
    s.setTimeout(timeout)
    s.on('connect', () => done('OK'))
    s.on('error', (e) => done('ERR ' + e.code))
    s.on('timeout', () => done('TIMEOUT'))
  })
}

function resolve(host) {
  return new Promise((r) => dns.lookup(host, { all: true }, (e, a) => r(`${host} -> ${e ? 'ERR ' + e.code : a.map((x) => x.address).join(', ')}`)))
}

function connectVia(proxyPort, target, label, timeout = 8000) {
  return new Promise((resolve) => {
    const t = Date.now()
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target, timeout })
    req.on('connect', (res, socket) => {
      socket.destroy()
      resolve(`${label} ${target} -> HTTP ${res.statusCode} (${Date.now() - t}ms)`)
    })
    req.on('error', (e) => resolve(`${label} ${target} -> ERR ${e.code}`))
    req.on('timeout', () => {
      req.destroy()
      resolve(`${label} ${target} -> TIMEOUT`)
    })
    req.end()
  })
}

;(async () => {
  console.log('— DNS —')
  for (const h of ['github.com', 'ssh.github.com', 'codeload.github.com', 'raw.githubusercontent.com']) console.log(await resolve(h))

  console.log('\n— 直连 TCP —')
  console.log(await tcp('github.com', 443, '[dns]'))
  console.log(await tcp('ssh.github.com', 443, '[dns]'))
  for (const ip of ['20.205.243.166', '140.82.112.3', '140.82.121.4', '20.27.177.113']) {
    console.log(await tcp(ip, 443, '[ip]'))
  }
  console.log(await tcp('140.82.112.35', 443, '[ip ssh443]'))

  console.log('\n— 本地代理 CONNECT —')
  for (const t of ['github.com:443', 'ssh.github.com:443', 'codeload.github.com:443', 'api.github.com:443']) {
    console.log(await connectVia(6711, t, '[6711]'))
  }
  for (const t of ['github.com:443', 'ssh.github.com:443']) {
    console.log(await connectVia(2621, t, '[2621]'))
  }
})()
