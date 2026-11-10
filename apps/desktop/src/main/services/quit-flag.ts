/**
 * 退出旁路标志：electron-updater 的 quitAndInstall 会先启动 NSIS 安装器
 * 再调用 app.quit()。若退出被 before-quit 的清理流程延迟，安装器会撞上
 * app.asar 文件锁。升级安装时先打此标志，before-quit 直接放行
 * （残留的 data.lock 由 pid 探活机制在下次启动自动接管，无碍）。
 */
let quitDirectly = false

export function markQuitDirect(): void {
  quitDirectly = true
}

export function shouldQuitDirectly(): boolean {
  return quitDirectly
}
