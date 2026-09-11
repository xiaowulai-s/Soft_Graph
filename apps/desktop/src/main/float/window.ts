/**
 * 桌面浮窗窗口管理（模块二核心）
 *
 * 需求映射：
 *   「程序以浮窗形式悬浮在桌面上」→ 无边框 + 透明 + 置顶 + 不占任务栏的独立 BrowserWindow
 *   「可由用户自定义显示内容」→ 内容由启用的插件列表决定（见 registry.ts）
 *   「支持靠边自动隐藏，鼠标移入时再次显示」→ 本文件的贴边判定 + 滑动动画 + peek 触发条
 *
 * 靠边隐藏的实现要点：
 *   隐藏不是 hide()，而是把窗口移出屏幕、只在屏幕内保留 peekSize 像素的触发条。
 *   这样窗口仍然存在、仍能收到鼠标事件，渲染层的 mouseenter 就能唤回浮窗；
 *   若真的 hide()，就没有任何可以接收鼠标事件的载体了。
 */

import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import type { FloatEdge, FloatSettings } from '@shared/types'
import { CH } from '@shared/ipc'

const ANIM_MS = 190
const ANIM_STEP = 12
/** 贴边判定阈值：拖到距屏幕边缘多少像素内视为吸附 */
const DOCK_THRESHOLD = 28
/** 鼠标离开后延迟隐藏，避免指针擦边就立刻缩回 */
const LEAVE_DELAY = 450

export interface FloatWindowHost {
  getSettings(): FloatSettings
  patchSettings(patch: Partial<FloatSettings>): FloatSettings
  onOpenMain(): void
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export class FloatWindowManager {
  private win: BrowserWindow | null = null
  private docked: FloatEdge = 'none'
  private hidden = false
  private hovering = false
  private leaveTimer: NodeJS.Timeout | null = null
  private animTimer: NodeJS.Timeout | null = null
  private dragging = false
  private contentHeight = 220

  constructor(
    private host: FloatWindowHost,
    private preloadPath: string,
    private rendererUrl: string | null,
    private rendererFile: string
  ) {}

  get window(): BrowserWindow | null {
    return this.win
  }

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  // ───────────────── 生命周期 ─────────────────

  open(): BrowserWindow {
    if (this.isOpen) {
      this.win!.showInactive()
      return this.win!
    }
    const s = this.host.getSettings()
    const display = screen.getDisplayNearestPoint({ x: s.x, y: s.y })
    const wa = display.workArea

    // 位置越界保护（换显示器 / 改分辨率后配置可能落在屏幕外）
    const width = Math.max(180, Math.min(s.width, 520))
    let x = s.x
    let y = s.y
    if (x < wa.x - width + 20 || x > wa.x + wa.width - 20) x = wa.x + wa.width - width - 24
    if (y < wa.y - 20 || y > wa.y + wa.height - 40) y = wa.y + 80

    this.win = new BrowserWindow({
      width,
      height: this.contentHeight,
      x,
      y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true, // 不占任务栏
      alwaysOnTop: s.alwaysOnTop,
      focusable: false, // 不抢焦点，避免打断用户正在做的事
      hasShadow: false,
      show: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    // 置顶层级：screen-saver 级别可覆盖大部分全屏窗口
    if (s.alwaysOnTop) this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.win.setIgnoreMouseEvents(s.clickThrough, { forward: true })

    if (this.rendererUrl) void this.win.loadURL(this.rendererUrl)
    else void this.win.loadFile(this.rendererFile)

    this.win.once('ready-to-show', () => {
      this.win?.showInactive()
      this.applyOpacity(s.opacity)
      this.recomputeDock()
      if (s.autoHide && this.docked !== 'none') this.scheduleHide()
    })

    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    this.win.on('closed', () => {
      this.win = null
      this.clearTimers()
    })

    return this.win
  }

  close(): void {
    this.clearTimers()
    if (this.isOpen) {
      // 关闭前把当前位置写回配置
      const b = this.win!.getBounds()
      const target = this.hidden ? this.shownBounds(b) : b
      this.host.patchSettings({ x: target.x, y: target.y })
      this.win!.destroy()
    }
    this.win = null
  }

  toggle(on?: boolean): boolean {
    const want = on ?? !this.isOpen
    if (want) this.open()
    else this.close()
    return this.isOpen
  }

  private clearTimers(): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    if (this.animTimer) clearInterval(this.animTimer)
    this.leaveTimer = null
    this.animTimer = null
  }

  // ───────────────── 设置应用 ─────────────────

  applySettings(s: FloatSettings): void {
    if (!this.isOpen) return
    const win = this.win!
    this.applyOpacity(s.opacity)
    win.setAlwaysOnTop(s.alwaysOnTop, s.alwaysOnTop ? 'screen-saver' : 'normal')
    win.setIgnoreMouseEvents(s.clickThrough, { forward: true })

    const b = win.getBounds()
    const width = Math.max(180, Math.min(s.width, 520))
    if (b.width !== width) {
      win.setBounds({ ...b, width })
    }
    this.recomputeDock()
    if (!s.autoHide && this.hidden) this.slideIn()
    else if (s.autoHide && this.docked !== 'none' && !this.hovering && !this.hidden) this.scheduleHide()
    this.emitState()
  }

  private applyOpacity(op: number): void {
    // 透明度作用于整窗；低于 0.25 会导致无法看见也难以命中，做下限保护
    this.win?.setOpacity(Math.max(0.25, Math.min(1, op)))
  }

  /** 渲染层报告内容实际高度 → 自适应窗口高度 */
  setContentHeight(h: number): void {
    const height = Math.max(60, Math.min(Math.round(h), 900))
    this.contentHeight = height
    if (!this.isOpen) return
    const b = this.win!.getBounds()
    if (Math.abs(b.height - height) < 2) return
    // 隐藏状态下改高度要同时维持「露出 peek」的位置关系
    this.win!.setBounds({ ...b, height })
    if (this.hidden) this.applyHiddenPosition(false)
  }

  // ───────────────── 拖拽 ─────────────────

  beginDrag(): void {
    this.dragging = true
    if (this.hidden) this.slideIn()
  }

  dragBy(dx: number, dy: number): void {
    if (!this.isOpen) return
    const s = this.host.getSettings()
    if (s.lockPosition) return
    this.dragging = true
    const b = this.win!.getBounds()
    this.win!.setBounds({ ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) })
  }

  endDrag(): void {
    if (!this.isOpen) return
    this.dragging = false
    const b = this.win!.getBounds()
    this.host.patchSettings({ x: b.x, y: b.y })
    this.recomputeDock()
    const s = this.host.getSettings()
    if (s.autoHide && this.docked !== 'none' && !this.hovering) this.scheduleHide()
    this.emitState()
  }

  // ───────────────── 贴边与显隐 ─────────────────

  /** 依据当前位置判断吸附到哪条边 */
  private recomputeDock(): void {
    if (!this.isOpen) {
      this.docked = 'none'
      return
    }
    const b = this.hidden ? this.shownBounds(this.win!.getBounds()) : this.win!.getBounds()
    const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + 10 }).workArea

    const distLeft = b.x - wa.x
    const distRight = wa.x + wa.width - (b.x + b.width)
    const distTop = b.y - wa.y

    let edge: FloatEdge = 'none'
    let min = DOCK_THRESHOLD + 1
    if (distLeft <= DOCK_THRESHOLD && distLeft < min) {
      edge = 'left'
      min = distLeft
    }
    if (distRight <= DOCK_THRESHOLD && distRight < min) {
      edge = 'right'
      min = distRight
    }
    if (distTop <= DOCK_THRESHOLD && distTop < min) {
      edge = 'top'
      min = distTop
    }
    this.docked = edge
  }

  /** 由隐藏态的 bounds 反推完整显示时的 bounds */
  private shownBounds(b: Electron.Rectangle): Electron.Rectangle {
    const s = this.host.getSettings()
    const wa = screen.getDisplayNearestPoint({ x: b.x + 2, y: b.y + 2 }).workArea
    switch (this.docked) {
      case 'left':
        return { ...b, x: wa.x }
      case 'right':
        return { ...b, x: wa.x + wa.width - b.width }
      case 'top':
        return { ...b, y: wa.y }
      default:
        void s
        return b
    }
  }

  /** 计算隐藏态目标 bounds：只保留 peekSize 像素在屏幕内 */
  private hiddenBounds(b: Electron.Rectangle): Electron.Rectangle {
    const s = this.host.getSettings()
    const peek = Math.max(2, Math.min(s.peekSize, 24))
    const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + 10 }).workArea
    switch (this.docked) {
      case 'left':
        return { ...b, x: wa.x - b.width + peek }
      case 'right':
        return { ...b, x: wa.x + wa.width - peek }
      case 'top':
        return { ...b, y: wa.y - b.height + peek }
      default:
        return b
    }
  }

  private animateTo(target: Electron.Rectangle, done?: () => void): void {
    if (!this.isOpen) return
    if (this.animTimer) clearInterval(this.animTimer)
    const win = this.win!
    const from = win.getBounds()
    const t0 = Date.now()

    this.animTimer = setInterval(() => {
      if (!this.isOpen) {
        if (this.animTimer) clearInterval(this.animTimer)
        this.animTimer = null
        return
      }
      const t = Math.min(1, (Date.now() - t0) / ANIM_MS)
      const k = easeOutCubic(t)
      win.setBounds({
        x: Math.round(from.x + (target.x - from.x) * k),
        y: Math.round(from.y + (target.y - from.y) * k),
        width: target.width,
        height: target.height
      })
      if (t >= 1) {
        if (this.animTimer) clearInterval(this.animTimer)
        this.animTimer = null
        done?.()
      }
    }, ANIM_STEP)
  }

  private applyHiddenPosition(animate = true): void {
    if (!this.isOpen) return
    const b = this.win!.getBounds()
    const shown = this.shownBounds(b)
    const target = this.hiddenBounds(shown)
    if (animate) this.animateTo(target)
    else this.win!.setBounds(target)
  }

  private scheduleHide(): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null
      this.slideOut()
    }, LEAVE_DELAY)
  }

  slideOut(): void {
    if (!this.isOpen || this.dragging) return
    const s = this.host.getSettings()
    if (!s.autoHide) return
    this.recomputeDock()
    if (this.docked === 'none') return
    if (this.hidden) return
    this.hidden = true
    this.applyHiddenPosition(true)
    this.emitState()
  }

  slideIn(): void {
    if (!this.isOpen) return
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer)
      this.leaveTimer = null
    }
    if (!this.hidden) return
    this.hidden = false
    const target = this.shownBounds(this.win!.getBounds())
    this.animateTo(target)
    this.emitState()
  }

  /** 渲染层 mouseenter / mouseleave 驱动 */
  setHovering(entered: boolean): void {
    this.hovering = entered
    if (entered) {
      this.slideIn()
      return
    }
    const s = this.host.getSettings()
    if (s.autoHide && this.docked !== 'none') this.scheduleHide()
  }

  private emitState(): void {
    if (!this.isOpen) return
    this.win!.webContents.send(CH.FLOAT_STATE, { docked: this.docked, hidden: this.hidden })
  }

  pushTick(payloads: unknown): void {
    if (!this.isOpen) return
    this.win!.webContents.send(CH.FLOAT_TICK, payloads)
  }

  pushSettings(s: FloatSettings): void {
    if (!this.isOpen) return
    this.win!.webContents.send(CH.FLOAT_SETTINGS_CHANGED, s)
  }

  openMain(): void {
    this.host.onOpenMain()
  }
}

export function defaultFloatSettings(): FloatSettings {
  const primary = screen.getPrimaryDisplay()
  const wa = primary.workArea
  return {
    enabled: false,
    plugins: ['sys.cpumem', 'sys.disk', 'sg.junk', 'sys.clock'],
    x: wa.x + wa.width - 260 - 24,
    y: wa.y + 80,
    width: 260,
    opacity: 0.96,
    autoHide: true,
    peekSize: 6,
    theme: 'dark',
    clickThrough: false,
    alwaysOnTop: true,
    compact: false,
    lockPosition: false
  }
}

export function floatRendererTarget(devUrl: string | undefined, outDir: string): {
  url: string | null
  file: string
} {
  if (devUrl) return { url: `${devUrl}/float.html`, file: '' }
  return { url: null, file: join(outDir, 'float.html') }
}
