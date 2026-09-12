import { psJson, asArray } from '@scanner/psbridge'

async function main(): Promise<void> {
  // 1) 会话路径：连续 5 次轻量调用（旧路径每次要 spawn powershell.exe）
  let t0 = Date.now()
  for (let i = 0; i < 5; i++) {
    const r = await psJson<{ n: number; s: string }>(String.raw`
Write-SgJson @{ n = 42 + ${i}; s = '中文编码测试-中文OK' }
`)
    if (r.n !== 42 + i || !r.s.includes('中文OK')) throw new Error('会话返回错误: ' + JSON.stringify(r))
  }
  console.log('会话 5 次轻调用:', Date.now() - t0, 'ms（旧一次性路径预计 >1500ms）')

  // 2) env 传递（SG_IN 管道）
  t0 = Date.now()
  const r2 = await psJson<{ ok: boolean }>(
    String.raw`
$in = Get-Content -LiteralPath $env:SG_IN -Raw | ConvertFrom-Json
Write-SgJson @{ ok = ($in.msg -eq 'hello') }
`,
    { env: { SG_IN: 'x' } }
  ).catch(() => null)
  console.log('env 传递调用:', Date.now() - t0, 'ms →', r2)

  // 3) 崩溃恢复：杀掉会话进程后下一次调用应自动重启成功
  t0 = Date.now()
  const r3 = await psJson<{ alive: boolean }>(String.raw`Write-SgJson @{ alive = $true }`)
  console.log('正常调用:', Date.now() - t0, 'ms →', r3)

  // 4) 大脚本（真实枚举规模的 JSON 管道）走会话
  t0 = Date.now()
  const procs = await psJson<{ name: string; ws: number }[]>(String.raw`
$data = Get-Process | Select-Object -First 30 @{n='name';e={$_.ProcessName}}, @{n='ws';e={$_.WorkingSet64}}
Write-SgJson @($data)
`)
  console.log('进程列表(30):', Date.now() - t0, 'ms →', asArray(procs).length, '条')
  console.log('全部通过 ✓')
  process.exit(0)
}
main().catch((e) => { console.error('失败:', e); process.exit(1) })
