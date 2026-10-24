/**
 * SoftGraph 官方浮窗插件：时钟
 * 权限：无（纯本地）。视图：metric。
 */
module.exports = {
  manifest: {
    id: 'system.clock',
    name: '时钟',
    description: '当前时间与日期，每秒刷新',
    interval: 1000,
    view: 'metric',
    icon: 'plugin',
    version: '1.0.0',
    author: 'SoftGraph'
  },
  collect() {
    const n = new Date()
    const pad = (x) => String(x).padStart(2, '0')
    const week = ['日', '一', '二', '三', '四', '五', '六'][n.getDay()]
    return [
      { label: '时间', value: `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}` },
      { label: '日期', value: `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} 周${week}` }
    ]
  }
}
