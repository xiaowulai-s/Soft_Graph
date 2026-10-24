/**
 * SoftGraph 官方浮窗插件：磁盘治理概览
 * 权限：无（只读 ctx.app 只读数据）。视图：bars。
 */
module.exports = {
  manifest: {
    id: 'disk.guard',
    name: '磁盘治理概览',
    description: '垃圾可释放 / 一键项 / 隔离区 / 已收录软件，四项一览',
    interval: 30000,
    view: 'bars',
    icon: 'plugin',
    version: '1.0.0',
    author: 'SoftGraph'
  },
  collect(ctx) {
    const total = ctx.app.junkTotalBytes()
    const oneClick = ctx.app.junkOneClickBytes()
    const quar = ctx.app.quarantineCount()
    return [
      {
        label: '垃圾可释放',
        value: ctx.formatBytes(total),
        ratio: Math.min(total / (2 * 1024 * 1024 * 1024), 100),
        tone: total > 1024 * 1024 * 1024 ? 'warn' : 'normal'
      },
      {
        label: '一键可清理',
        value: ctx.formatBytes(oneClick),
        ratio: total > 0 ? (oneClick / total) * 100 : 0,
        tone: 'good'
      },
      { label: '隔离区保留', value: quar + ' 项', ratio: Math.min(quar * 5, 100) },
      { label: '已收录软件', value: ctx.app.softwareCount() + ' 个', ratio: Math.min(ctx.app.softwareCount() / 3, 100) }
    ]
  }
}
