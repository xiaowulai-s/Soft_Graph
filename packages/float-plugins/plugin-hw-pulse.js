/**
 * SoftGraph 官方浮窗插件：硬件脉搏
 * 权限：powershell（CIM 查询，无需管理员）。视图：bars。
 * 每 20 秒采样 CPU 负载 / 内存占用 / 磁盘可用空间。
 */
module.exports = {
  manifest: {
    id: 'hw.pulse',
    name: '硬件脉搏',
    description: 'CPU 负载 / 内存占用 / 磁盘可用空间（CIM 查询，需授权 PowerShell）',
    interval: 20000,
    view: 'bars',
    icon: 'plugin',
    version: '1.0.0',
    author: 'SoftGraph'
  },
  async collect(ctx) {
    const KEY = 'hw'
    try {
      const ps = [
        '$c = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;',
        '$os = Get-CimInstance Win32_OperatingSystem;',
        '$mUsed = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2);',
        '$mTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2);',
        '$d = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Sort-Object FreeSpace | Select-Object -First 1;',
        '[pscustomobject]@{ cpu = [int]$c; mUsed = $mUsed; mTotal = $mTotal; dFree = [math]::Round($d.FreeSpace/1GB,1); dTotal = [math]::Round($d.Size/1GB,1) } | ConvertTo-Json'
      ].join(' ')
      const hw = await ctx.psJson(ps, 30000)
      if (hw && hw.mTotal) ctx.state.set(KEY, { ...hw, at: Date.now() })
    } catch {
      /* 沿用缓存 */
    }
    const hw = ctx.state.get(KEY)
    if (!hw) return [{ label: '硬件采样', value: '待查询', tone: 'normal' }]
    const mRatio = hw.mTotal ? (hw.mUsed / hw.mTotal) * 100 : 0
    return [
      {
        label: 'CPU 负载',
        value: hw.cpu + '%',
        ratio: hw.cpu,
        tone: hw.cpu > 85 ? 'danger' : hw.cpu > 60 ? 'warn' : 'normal'
      },
      {
        label: '内存',
        value: hw.mUsed + ' / ' + hw.mTotal + ' GB',
        ratio: mRatio,
        tone: mRatio > 90 ? 'warn' : 'normal'
      },
      {
        label: '系统盘可用',
        value: hw.dFree + ' GB / ' + hw.dTotal + ' GB',
        ratio: hw.dTotal ? ((hw.dTotal - hw.dFree) / hw.dTotal) * 100 : 0,
        tone: hw.dFree < 10 ? 'danger' : 'normal'
      }
    ]
  }
}
