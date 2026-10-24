/**
 * SoftGraph 官方浮窗插件：升级脉搏
 * 权限：network + powershell（psJson 调 winget，需用户授权）。
 * 每 30 分钟查一次 winget 可升级数量，结果缓存进 state。
 */
module.exports = {
  manifest: {
    id: 'update.pulse',
    name: '升级脉搏',
    description: '调用 winget 检查可升级软件数量（需授权 PowerShell / 网络能力）',
    interval: 30 * 60 * 1000,
    view: 'metric',
    icon: 'plugin',
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx) {
    const KEY = 'pending'
    try {
      const ps = [
        '$out = winget upgrade --disable-interactivity | Select-Object -Skip 2 |',
        "Where-Object { $_ -match '\\S' -and $_ -notmatch '^-|^Name' };",
        '[pscustomobject]@{ n = @($out).Count } | ConvertTo-Json'
      ].join(' ')
      const out = await ctx.psJson(ps, 60000)
      const n = Number(out && out.n) || 0
      ctx.state.set(KEY, { n, at: Date.now() })
    } catch {
      /* 失败沿用上次缓存 */
    }
    const cached = ctx.state.get(KEY) || { n: null, at: 0 }
    return [
      {
        label: '可升级软件',
        value: cached.n === null ? '待查询' : cached.n + ' 个',
        tone: cached.n > 5 ? 'warn' : cached.n > 0 ? 'normal' : 'good',
        hint: cached.at ? '上次检查 ' + new Date(cached.at).toLocaleTimeString() : undefined
      }
    ]
  }
}
