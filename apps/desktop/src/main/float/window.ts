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
import { DEFAULT_INSTANCE_ID, floatInstanceTarget, instanceFromLegacy, normalizeInstances } from '@shared/float'
import { CH } from '@shared/ipc'

// 实例规范化与 URL 构造已提取到 @shared/float（渲染层设置页要用同一口径），
// 这里重新导出，保持既有导入路径与测试可用。
export { DEFAULT_INSTANCE_ID, floatInstanceTarget, instanceFromLegacy, normalizeInstances }

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
    private rendererFile: string,
    /** 本管理器负责的实例 id（F4）；不传即主实例，行为与单实例完全一致 */
    readonly instanceId: string = DEFAULT_INSTANCE_ID
  ) {}

  /**
   * 本实例的有效设置 = 全局设置（enabled / peekSize / alwaysOnTop）
   * 叠加该实例的覆盖字段（plugins / 位置 / 尺寸 / 主题 / 穿透…）。
   * 实例不存在时退回全局设置 —— 极端情况下也不会因为找不到配置而崩。
   */
  private settings(): FloatSettings {
    const g = this.host.getSettings()
    const inst = normalizeInstances(g).find((i) => i.id === this.instanceId)
    return inst ? ({ ...g, ...inst } as FloatSettings) : g
  }

  /** 位置等易变字段写回「实例」而非全局，避免多实例互相覆盖 */
  private persistPosition(x: number, y: number): void {
    const g = this.host.getSettings()
    const instances = normalizeInstances(g).map((i) => (i.id === this.instanceId ? { ...i, x, y } : i))
    this.host.patchSettings({ instances } as Partial<FloatSettings>)
  }

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
    const s = this.settings()
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

    // 把实例 id 交给渲染层（多实例下每个窗口必须知道「我是谁」才能取自己的主题与插件）
    if (this.rendererUrl) void this.win.loadURL(floatInstanceTarget(this.rendererUrl, this.instanceId))
    else void this.win.loadFile(this.rendererFile, { query: { instance: this.instanceId } })

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
      this.persistPosition(target.x, target.y)
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
    const s = this.settings()
    if (s.lockPosition) return
    this.dragging = true
    const b = this.win!.getBounds()
    this.win!.setBounds({ ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) })
  }

  endDrag(): void {
    if (!this.isOpen) return
    this.dragging = false
    const b = this.win!.getBounds()
    this.persistPosition(b.x, b.y)
    this.recomputeDock()
    const s = this.settings()
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
    const s = this.settings()
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
    const s = this.settings()
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
    const s = this.settings()
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
    const s = this.settings()
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

// ───────────────── 多实例控制器（F4）─────────────────

/**
 * 管理多个浮窗实例：每个实例一个独立窗口、独立插件组合、独立位置与主题。
 *
 * 为什么不让 index.ts 直接持有 Map：
 *   主进程里浮窗的调用点有十几处（拖拽、悬停、内容高度、设置变更…），
 *   让每处自己去找窗口会把「谁在操作哪个实例」的逻辑散落到全局。
 *   这里统一收口：**窗口来源明确的方法按来源分发，语义上全局的方法广播**。
 *
 * 对外方法与 FloatWindowManager 保持同名，因此单实例场景可直接替换。
 */
export class FloatWindows {
  private managers = new Map<string, FloatWindowManager>()
  /** webContents.id → 实例 id：IPC 回调里只有 sender，靠这张表定位窗口 */
  private byWebContents = new Map<number, string>()

  constructor(
    private host: FloatWindowHost,
    private preloadPath: string,
    private rendererUrl: string | null,
    private rendererFile: string
  ) {}

  /** 按当前设置同步实例集合：新增的创建、移除的关闭、已有的保留（不重建窗口） */
  sync(): void {
    const instances = normalizeInstances(this.host.getSettings())
    const wanted = new Set(instances.map((i) => i.id))

    for (const [id, mgr] of this.managers) {
      if (!wanted.has(id)) {
        mgr.close()
        this.forget(mgr)
        this.managers.delete(id)
      }
    }

    for (const inst of instances) {
      if (!this.managers.has(inst.id)) {
        this.managers.set(
          inst.id,
          new FloatWindowManager(this.host, this.preloadPath, this.rendererUrl, this.rendererFile, inst.id)
        )
      }
    }
  }

  private forget(mgr: FloatWindowManager): void {
    for (const [wcId, id] of this.byWebContents) {
      if (id === mgr.instanceId) this.byWebContents.delete(wcId)
    }
  }

  private track(mgr: FloatWindowManager): void {
    const wc = mgr.window?.webContents
    if (wc && !wc.isDestroyed()) this.byWebContents.set(wc.id, mgr.instanceId)
  }

  /** 所有实例的窗口都关闭 */
  get isOpen(): boolean {
    for (const m of this.managers.values()) if (m.isOpen) return true
    return false
  }

  get instanceIds(): string[] {
    return [...this.managers.keys()]
  }

  managerOf(webContentsId: number): FloatWindowManager | null {
    const id = this.byWebContents.get(webContentsId)
    return id ? (this.managers.get(id) ?? null) : null
  }

  managerById(instanceId: string): FloatWindowManager | null {
    return this.managers.get(instanceId) ?? null
  }

  /**
   * 把采集结果推给指定实例。
   * 多实例下每个窗口的插件组合可能不同 —— 广播会把 A 实例的插件数据塞给 B 实例。
   */
  pushTick(instanceId: string, payloads: unknown): void {
    const mgr = this.managers.get(instanceId)
    if (mgr) {
      this.track(mgr)
      mgr.pushTick(payloads)
    }
  }

  open(): void {
    this.sync()
    for (const m of this.managers.values()) {
      m.open()
      this.track(m)
    }
  }

  /**
   * 打开「已配置但窗口还没开」的实例（F4-UI 新增实例时用）。
   *
   * 为什么不能只靠 applySettings()：sync() 只会为新增实例**创建管理器**，
   * 窗口要显式 open 才会出现。浮窗已开启时新增一个实例，
   * 若不补这一步，用户会看到「列表里多了一个实例，桌面上什么都没有」。
   * 总开关关闭时不要调用本方法 —— 那会把浮窗整体点亮。
   */
  openMissing(): void {
    this.sync()
    for (const m of this.managers.values()) {
      if (m.isOpen) continue
      m.open()
      this.track(m)
    }
  }

  close(): void {
    for (const m of this.managers.values()) {
      m.close()
      this.forget(m)
    }
  }

  toggle(on?: boolean): boolean {
    const want = on ?? !this.isOpen
    if (want) this.open()
    else this.close()
    return this.isOpen
  }

  applySettings(s: FloatSettings): void {
    this.sync()
    for (const m of this.managers.values()) m.applySettings(s)
  }

  /** 设置变更广播：每个实例收到的是「全局设置 + 自己的覆盖」（由 manager 内部合成） */
  pushSettings(s: FloatSettings): void {
    for (const m of this.managers.values()) m.pushSettings(s)
  }

  // ── 以下为「窗口来源明确」的定向操作：多实例下必须按来源分发 ──

  dragBy(webContentsId: number, dx: number, dy: number): void {
    this.managerOf(webContentsId)?.dragBy(dx, dy)
  }

  endDrag(webContentsId: number): void {
    this.managerOf(webContentsId)?.endDrag()
  }

  beginDrag(webContentsId: number): void {
    this.managerOf(webContentsId)?.beginDrag()
  }

  setHovering(webContentsId: number, on: boolean): void {
    this.managerOf(webContentsId)?.setHovering(on)
  }

  setContentHeight(webContentsId: number, h: number): void {
    this.managerOf(webContentsId)?.setContentHeight(h)
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
