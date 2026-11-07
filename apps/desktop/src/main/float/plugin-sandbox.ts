/**
 * A1 插件沙箱（v5.3，渐进式）—— 外部插件在 node:vm 隔离上下文中加载与执行。
 *
 * 定位（诚实边界）：这是**纵深防御**，不是安全边界。
 *   - vm 上下文删除了 process / Buffer / 主机全局，插件顶层代码拿不到 Node 入口；
 *   - require 白名单只放行 node:path / node:os / node:url（只读工具模块）；
 *   - collect 的**同步段**受 vm timeout 保护（while(true) 会被打断），
 *     异步悬挂由注册表已有的 Promise.race 兜底；
 *   - 能力面仍然全部经由 ctx（psJson / app.*），继续受 F1 授权体系约束。
 *   真正的强隔离（子进程 + 结构化克隆 IPC）留待插件生态真实扩大后评估。
 *
 * 与内置插件的关系：内置插件受信任，直接在宿主运行（不走沙箱）。
 */

import * as vm from 'node:vm'
import type { FloatPlugin, PluginContext } from './plugin-api'

/** 插件代码可 require 的白名单（全为无副作用的工具模块） */
const REQUIRE_WHITELIST = new Set(['path', 'node:path', 'os', 'node:os', 'url', 'node:url'])

const SANDBOX_SOURCE_TIMEOUT = 2_000 // 插件顶层代码执行上限
const COLLECT_SYNC_TIMEOUT = 15_000 // collect 同步段上限（与注册表 COLLECT_TIMEOUT 一致）

export interface SandboxLoadResult {
  ok: boolean
  plugin?: FloatPlugin
  error?: string
  /** 沙箱上下文（内部用于带超时的 collect 调用） */
  sandbox?: PluginSandbox
}

/** 沙箱内 execute 的桥接脚本：调用目标方法并留下返回值（含 Promise 原样返回） */
const BRIDGE = `(function () {
  if (typeof __sgSelf !== 'object' || __sgSelf === null) throw new Error('插件导出不可用')
  const fn = __sgSelf[__sgMethod]
  if (typeof fn !== 'function') throw new Error('插件未实现 ' + __sgMethod)
  return fn.call(__sgSelf, __sgArg)
})()`

export class PluginSandbox {
  private readonly context: vm.Context
  readonly plugin: FloatPlugin

  constructor(source: string) {
    const module = { exports: {} as Partial<FloatPlugin> }
    const sandbox: Record<string, unknown> = {
      module,
      exports: module.exports,
      // 白名单 require：非白名单模块直接抛错（错误信息给出指引）
      require: (id: string): unknown => {
        if (typeof id !== 'string' || !REQUIRE_WHITELIST.has(id)) {
          throw new Error(`沙箱不允许 require("${String(id)}")（白名单：path / os / url）；如需系统能力请改用 ctx 提供的接口`)
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(id)
      },
      // 插件里的 console 只落到主进程控制台，且没有调试器等危险方法
      console: { log: (...a: unknown[]) => console.log('[plugin:sandbox]', ...a) },
      setTimeout,
      clearTimeout
    }
    vm.createContext(sandbox)
    this.context = sandbox as vm.Context
    try {
      vm.runInContext(source, this.context, { timeout: SANDBOX_SOURCE_TIMEOUT, filename: 'plugin.sandbox.js' })
    } catch (e) {
      throw new Error(`插件在沙箱中加载失败：${(e as Error).message}`)
    }
    const exp = (sandbox.module as { exports?: Partial<FloatPlugin> }).exports
    const plugin = (exp as { default?: FloatPlugin } | undefined)?.default ?? (exp as FloatPlugin | undefined)
    if (!plugin || typeof plugin !== 'object' || !plugin.manifest) {
      throw new Error('插件未导出 manifest（沙箱中拿不到 module.exports）')
    }
    this.plugin = plugin
  }

  /**
   * 带同步超时地调用插件方法（setup / collect / dispose）。
   * 返回值可能是 Promise —— 由调用方自行 await / race。
   * 传递的 ctx 是宿主对象：vm 内可调用其方法（能力面），但拿不到宿主全局。
   */
  call(method: 'setup' | 'collect' | 'dispose', ctx: PluginContext, timeoutMs = COLLECT_SYNC_TIMEOUT): Promise<unknown> {
    const sandbox = this.context as unknown as Record<string, unknown>
    sandbox.__sgSelf = this.plugin
    sandbox.__sgMethod = method
    sandbox.__sgArg = ctx
    return new Promise((resolve, reject) => {
      try {
        const result = vm.runInContext(BRIDGE, this.context, { timeout: timeoutMs, filename: `plugin.${method}.js` })
        resolve(result)
      } catch (e) {
        const err = e as Error
        if (err.message.includes('Script execution timed out')) {
          reject(new Error(`${method} 同步执行超过 ${Math.round(timeoutMs / 1000)}s（沙箱中断）`))
        } else {
          reject(new Error(`${method} 执行出错：${err.message}`))
        }
      }
    })
  }
}

/** 编译加载外部插件（registry 用）。失败返回结构化错误，不抛出。 */
export function loadPluginSandboxed(source: string): SandboxLoadResult {
  try {
    const sandbox = new PluginSandbox(source)
    return { ok: true, plugin: sandbox.plugin, sandbox }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
