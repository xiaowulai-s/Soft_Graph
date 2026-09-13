<script setup lang="ts">
/**
 * 设置抽屉：设置（FR-15）/ 浮窗（模块二控制面板）/ 隔离区（FR-11）/ 规则库 / 关于
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { AppInfo } from '@shared/ipc'
import type { AppSettings, FloatPluginManifest, FloatSettings, QuarantineRecord } from '@shared/types'
import { formatBytes, formatTime } from '@shared/util'

const props = defineProps<{ open: boolean; tab: TabKey }>()
type TabKey = 'settings' | 'float' | 'quarantine' | 'rules' | 'about'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'set-tab', t: TabKey): void
  (e: 'toast', msg: string): void
  (e: 'theme', v: 'dark' | 'light'): void
}>()

const settings = ref<AppSettings | null>(null)
const info = ref<AppInfo | null>(null)
const plugins = ref<FloatPluginManifest[]>([])
const quarantine = ref<QuarantineRecord[]>([])
const rules = ref<{ id: string; name: string; risk: string; defaultSelected: boolean; description?: string; roots?: string[] }[]>([])
const qChecked = ref<Set<string>>(new Set())
const busy = ref(false)

const TABS: { key: TabKey; label: string }[] = [
  { key: 'settings', label: '设置' },
  { key: 'float', label: '桌面浮窗' },
  { key: 'quarantine', label: '隔离区' },
  { key: 'rules', label: '垃圾规则' },
  { key: 'about', label: '关于' }
]

async function loadAll(): Promise<void> {
  settings.value = await window.api.getSettings()
  info.value = await window.api.appInfo()
  plugins.value = await window.api.floatPlugins()
  rules.value = await window.api.junkRules()
  await loadQuarantine()
}

async function loadQuarantine(): Promise<void> {
  quarantine.value = await window.api.quarantineList()
  qChecked.value = new Set()
}

onMounted(() => {
  if (props.open) void loadAll()
})
watch(
  () => props.open,
  (o) => {
    if (o) void loadAll()
  }
)

// ───────────────── 通用设置 ─────────────────

async function patch(p: Partial<AppSettings>): Promise<void> {
  settings.value = await window.api.setSettings(p)
  if (p.theme) emit('theme', p.theme)
}

async function addPortableRoot(): Promise<void> {
  const dir = await window.api.pickDir()
  if (!dir || !settings.value) return
  const next = [...new Set([...settings.value.portableRoots, dir])]
  await patch({ portableRoots: next })
}

async function removePortableRoot(p: string): Promise<void> {
  if (!settings.value) return
  await patch({ portableRoots: settings.value.portableRoots.filter((x) => x !== p) })
}

async function addExclude(): Promise<void> {
  const dir = await window.api.pickDir()
  if (!dir || !settings.value) return
  await patch({ excludePaths: [...new Set([...settings.value.excludePaths, dir])] })
}

async function removeExclude(p: string): Promise<void> {
  if (!settings.value) return
  await patch({ excludePaths: settings.value.excludePaths.filter((x) => x !== p) })
}

// ───────────────── 浮窗设置 ─────────────────

const float = computed<FloatSettings | null>(() => settings.value?.float ?? null)

async function patchFloat(p: Partial<FloatSettings>): Promise<void> {
  const next = await window.api.floatSetSettings(p)
  if (settings.value) settings.value = { ...settings.value, float: next }
}

async function toggleFloat(): Promise<void> {
  const on = await window.api.floatToggle()
  if (settings.value) settings.value = { ...settings.value, float: { ...settings.value.float, enabled: on } }
  emit('toast', on ? '桌面浮窗已开启' : '桌面浮窗已关闭')
}

function pluginEnabled(id: string): boolean {
  return float.value?.plugins.includes(id) ?? false
}

async function togglePlugin(id: string): Promise<void> {
  if (!float.value) return
  const cur = [...float.value.plugins]
  const i = cur.indexOf(id)
  if (i >= 0) cur.splice(i, 1)
  else cur.push(id)
  await patchFloat({ plugins: cur })
}

async function movePlugin(id: string, dir: -1 | 1): Promise<void> {
  if (!float.value) return
  const cur = [...float.value.plugins]
  const i = cur.indexOf(id)
  if (i < 0) return
  const j = i + dir
  if (j < 0 || j >= cur.length) return
  ;[cur[i], cur[j]] = [cur[j], cur[i]]
  await patchFloat({ plugins: cur })
}

function openPluginDir(): void {
  void window.api.floatOpenPluginDir()
}

async function reloadPlugins(): Promise<void> {
  busy.value = true
  try {
    plugins.value = await window.api.floatReloadPlugins()
    emit('toast', `已重新加载，共 ${plugins.value.length} 个插件`)
  } finally {
    busy.value = false
  }
}

/** 启用的插件按用户顺序排前，未启用的排后 */
const orderedPlugins = computed(() => {
  const order = float.value?.plugins ?? []
  const on = order.map((id) => plugins.value.find((p) => p.id === id)).filter(Boolean) as FloatPluginManifest[]
  const off = plugins.value.filter((p) => !order.includes(p.id))
  return [...on, ...off]
})

// ───────────────── 隔离区 ─────────────────

function toggleQ(id: string): void {
  const n = new Set(qChecked.value)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  qChecked.value = n
}

async function restoreSelected(): Promise<void> {
  if (qChecked.value.size === 0) return
  busy.value = true
  try {
    const r = await window.api.quarantineRestore({ ids: [...qChecked.value] })
    emit('toast', `已还原 ${r.ok} 项${r.failed.length ? `，${r.failed.length} 项失败` : ''}`)
    await loadQuarantine()
  } finally {
    busy.value = false
  }
}

async function purgeSelected(): Promise<void> {
  if (qChecked.value.size === 0) return
  busy.value = true
  try {
    const r = await window.api.quarantinePurge({ ids: [...qChecked.value] })
    emit('toast', `已彻底删除 ${r.ok} 项，释放 ${formatBytes(r.freed)}`)
    await loadQuarantine()
  } finally {
    busy.value = false
  }
}

async function purgeExpired(): Promise<void> {
  busy.value = true
  try {
    const r = await window.api.quarantinePurge({ expiredOnly: true })
    emit('toast', r.ok ? `已清理 ${r.ok} 项过期条目` : '没有过期条目')
    await loadQuarantine()
  } finally {
    busy.value = false
  }
}

const qTotal = computed(() => quarantine.value.reduce((s, r) => s + r.sizeBytes, 0))

/** 诊断包导出（C5） */
const diagBusy = ref(false)
const diagText = ref('')
const diagOk = ref(false)

async function exportDiag(): Promise<void> {
  diagBusy.value = true
  diagText.value = ''
  try {
    const r = await window.api.diagExport()
    diagOk.value = r.ok
    if (r.ok && r.file) {
      diagText.value = `已生成：${r.file}（${formatBytes(r.bytes ?? 0)}，含 ${r.entries?.length ?? 0} 个文件），已在资源管理器中定位`
    } else {
      diagText.value = `导出失败：${r.error ?? '未知原因'}`
    }
  } catch (e) {
    diagOk.value = false
    diagText.value = `导出失败：${(e as Error).message}`
  } finally {
    diagBusy.value = false
  }
}

function daysLeft(r: QuarantineRecord): string {
  const d = (r.keepUntil - Date.now()) / 86_400_000
  if (d <= 0) return '已过期'
  return `剩 ${Math.ceil(d)} 天`
}
</script>

<template>
  <div v-if="open" class="sd-mask" @click.self="emit('close')">
    <div class="sd">
      <header class="sd-head">
        <div class="sd-tabs">
          <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="emit('set-tab', t.key)">
            {{ t.label }}
          </button>
        </div>
        <button class="ghost" @click="emit('close')">✕</button>
      </header>

      <div class="sd-body">
        <!-- ── 设置 ── -->
        <template v-if="tab === 'settings' && settings">
          <section class="sd-sec">
            <h4>外观</h4>
            <div class="sd-row">
              <label>主题</label>
              <select :value="settings.theme" @change="patch({ theme: ($event.target as HTMLSelectElement).value as 'dark' | 'light' })">
                <option value="dark">深色（图谱对比度更佳）</option>
                <option value="light">浅色</option>
              </select>
            </div>
          </section>

          <section class="sd-sec">
            <h4>便携软件识别</h4>
            <div class="sd-row">
              <label>判定阈值</label>
              <input
                type="range"
                min="20"
                max="100"
                step="5"
                :value="settings.portableThreshold"
                @change="patch({ portableThreshold: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="sd-val">{{ settings.portableThreshold }} 分</span>
            </div>
            <div class="sd-hint">
              七类特征加权：目录自包含 +30、无卸载项 +20、存在本地配置 +15、目录可写 +10、无安装器痕迹 +10、版本资源完整
              +10、用户手动标记 +100。阈值越低识别越宽松。
            </div>
            <div class="sd-row col">
              <label>扫描目录</label>
              <div class="sd-tags">
                <span v-for="p in settings.portableRoots" :key="p" class="sd-tag">
                  <span class="mono">{{ p }}</span>
                  <button class="ghost" @click="removePortableRoot(p)">✕</button>
                </span>
                <span v-if="settings.portableRoots.length === 0" class="dim sd-hint" style="padding: 0">
                  未配置时自动探测各盘的 Tools / Portable / Green / Software 等常见目录
                </span>
              </div>
              <button class="ghost" @click="addPortableRoot">+ 添加目录</button>
            </div>
          </section>

          <section class="sd-sec">
            <h4>图谱</h4>
            <div class="sd-row">
              <label>依赖递归深度</label>
              <select :value="settings.maxDepth" @change="patch({ maxDepth: Number(($event.target as HTMLSelectElement).value) })">
                <option :value="1">1 层（仅主程序直接依赖，最快）</option>
                <option :value="2">2 层（含依赖的依赖，推荐）</option>
                <option :value="3">3 层（最完整，较慢）</option>
              </select>
            </div>
          </section>

          <section class="sd-sec">
            <h4>清理与安全</h4>
            <div class="sd-row">
              <label>隔离保留期</label>
              <span class="sd-inline">
                低/中风险
                <input
                  type="number"
                  min="1"
                  max="90"
                  :value="settings.quarantineKeepDaysLow"
                  @change="patch({ quarantineKeepDaysLow: Number(($event.target as HTMLInputElement).value) })"
                />
                天 · 高风险
                <input
                  type="number"
                  min="1"
                  max="180"
                  :value="settings.quarantineKeepDaysHigh"
                  @change="patch({ quarantineKeepDaysHigh: Number(($event.target as HTMLInputElement).value) })"
                />
                天
              </span>
            </div>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="settings.advancedMode"
                @change="patch({ advancedMode: ($event.target as HTMLInputElement).checked })"
              />
              <span>高级模式：允许勾选高风险分类（删除时仍需输入确认文本）</span>
            </label>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="settings.allowDirectDelete"
                @change="patch({ allowDirectDelete: ($event.target as HTMLInputElement).checked })"
              />
              <span>允许跳过隔离区直接删除（不可还原，谨慎开启）</span>
            </label>
            <div class="sd-row col">
              <label>排除路径</label>
              <div class="sd-tags">
                <span v-for="p in settings.excludePaths" :key="p" class="sd-tag">
                  <span class="mono">{{ p }}</span>
                  <button class="ghost" @click="removeExclude(p)">✕</button>
                </span>
                <span v-if="settings.excludePaths.length === 0" class="dim sd-hint" style="padding: 0">
                  排除的路径不会出现在垃圾扫描结果中
                </span>
              </div>
              <button class="ghost" @click="addExclude">+ 添加排除目录</button>
            </div>
            <div class="sd-hint warn">
              无论如何设置，系统关键路径（System32 / SysWOW64 / WinSxS / Program Files 等）的白名单硬拦截始终生效，
              该规则以纯函数固化在代码中，不读取配置文件。
            </div>
          </section>
        </template>

        <!-- ── 浮窗 ── -->
        <template v-else-if="tab === 'float' && float">
          <section class="sd-sec">
            <div class="sd-row">
              <label>桌面浮窗</label>
              <button :class="float.enabled ? 'danger' : 'primary'" @click="toggleFloat">
                {{ float.enabled ? '关闭浮窗' : '开启浮窗' }}
              </button>
              <span class="dim" style="font-size: 11px">{{ float.enabled ? '正在桌面显示' : '当前未显示' }}</span>
            </div>
            <div class="sd-hint">
              浮窗以无边框透明窗口悬浮在桌面，不占用任务栏。拖到屏幕边缘会自动吸附并隐藏，鼠标移到边缘触发条上即再次滑出。
            </div>
          </section>

          <section class="sd-sec">
            <h4>行为</h4>
            <label class="sd-check">
              <input type="checkbox" :checked="float.autoHide" @change="patchFloat({ autoHide: ($event.target as HTMLInputElement).checked })" />
              <span>靠边自动隐藏（鼠标移入时再次显示）</span>
            </label>
            <div class="sd-row">
              <label>触发条宽度</label>
              <input
                type="range"
                min="2"
                max="20"
                :value="float.peekSize"
                @change="patchFloat({ peekSize: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="sd-val">{{ float.peekSize }} px</span>
            </div>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="float.alwaysOnTop"
                @change="patchFloat({ alwaysOnTop: ($event.target as HTMLInputElement).checked })"
              />
              <span>始终置顶</span>
            </label>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="float.clickThrough"
                @change="patchFloat({ clickThrough: ($event.target as HTMLInputElement).checked })"
              />
              <span>鼠标穿透（点击直接作用于桌面，此时无法拖动浮窗）</span>
            </label>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="float.lockPosition"
                @change="patchFloat({ lockPosition: ($event.target as HTMLInputElement).checked })"
              />
              <span>锁定位置（防止误拖）</span>
            </label>
          </section>

          <section class="sd-sec">
            <h4>外观</h4>
            <div class="sd-row">
              <label>主题</label>
              <select :value="float.theme" @change="patchFloat({ theme: ($event.target as HTMLSelectElement).value as FloatSettings['theme'] })">
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="glass">毛玻璃</option>
              </select>
            </div>
            <div class="sd-row">
              <label>宽度</label>
              <input
                type="range"
                min="180"
                max="420"
                step="10"
                :value="float.width"
                @change="patchFloat({ width: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="sd-val">{{ float.width }} px</span>
            </div>
            <div class="sd-row">
              <label>不透明度</label>
              <input
                type="range"
                min="0.3"
                max="1"
                step="0.02"
                :value="float.opacity"
                @change="patchFloat({ opacity: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="sd-val">{{ Math.round(float.opacity * 100) }}%</span>
            </div>
            <label class="sd-check">
              <input type="checkbox" :checked="float.compact" @change="patchFloat({ compact: ($event.target as HTMLInputElement).checked })" />
              <span>紧凑模式（更小的行高与字号）</span>
            </label>
          </section>

          <section class="sd-sec">
            <h4>
              显示内容
              <span class="dim" style="font-weight: 400; font-size: 11px">
                — 勾选决定显示哪些卡片，箭头调整顺序
              </span>
            </h4>
            <ul class="sd-plugins">
              <li v-for="(p, idx) in orderedPlugins" :key="p.id" :class="{ on: pluginEnabled(p.id) }">
                <input type="checkbox" :checked="pluginEnabled(p.id)" @change="togglePlugin(p.id)" />
                <div class="sd-plugin-body">
                  <div class="sd-plugin-t">
                    {{ p.name }}
                    <span class="badge">{{ p.builtin ? '内置' : '外部' }}</span>
                    <span class="badge">{{ p.view }}</span>
                    <span v-if="p.interval > 0" class="badge">{{ (p.interval / 1000).toFixed(p.interval < 1000 ? 1 : 0) }}s</span>
                  </div>
                  <div class="dim sd-plugin-d">{{ p.description }}</div>
                </div>
                <div v-if="pluginEnabled(p.id)" class="sd-plugin-ord">
                  <button class="ghost" :disabled="idx === 0" @click="movePlugin(p.id, -1)">▲</button>
                  <button class="ghost" @click="movePlugin(p.id, 1)">▼</button>
                </div>
              </li>
            </ul>
            <div class="sd-row">
              <button class="ghost" :disabled="busy" @click="reloadPlugins">重载插件</button>
              <button class="ghost" @click="openPluginDir">打开插件目录</button>
            </div>
            <div class="sd-hint">
              插件目录内已放置示例插件 <code>example-hello.js</code> 与 <code>README.md</code>。
              新增一个 .js 文件即可扩展浮窗内容，点「重载插件」立即生效，无需重启。
              插件在主进程内执行、拥有 Node 能力，请只安装可信插件。
            </div>
          </section>
        </template>

        <!-- ── 隔离区 ── -->
        <template v-else-if="tab === 'quarantine'">
          <section class="sd-sec">
            <div class="sd-row">
              <label>隔离区</label>
              <span>{{ quarantine.length }} 条 · {{ formatBytes(qTotal) }}</span>
              <span class="sd-sp" />
              <button class="ghost" :disabled="busy" @click="loadQuarantine">刷新</button>
              <button class="ghost" :disabled="busy" @click="purgeExpired">清理过期</button>
            </div>
            <div class="sd-hint">
              删除的文件会先移入隔离区并保留原始目录结构；保留期内可完整还原。还原时若目标已存在，会自动重命名为
              <code>*.restored-xxxx</code> 而不是覆盖。
            </div>

            <div v-if="quarantine.length === 0" class="sd-empty dim">隔离区为空</div>

            <template v-else>
              <div class="sd-row">
                <button class="primary" :disabled="qChecked.size === 0 || busy" @click="restoreSelected">
                  还原选中 {{ qChecked.size || '' }}
                </button>
                <button class="danger" :disabled="qChecked.size === 0 || busy" @click="purgeSelected">
                  彻底删除选中
                </button>
              </div>
              <ul class="sd-q">
                <li v-for="r in quarantine" :key="r.id">
                  <input type="checkbox" :checked="qChecked.has(r.id)" @change="toggleQ(r.id)" />
                  <div class="sd-q-body">
                    <div class="mono sd-q-path">{{ r.originalPath }}</div>
                    <div class="dim sd-q-meta">
                      {{ formatBytes(r.sizeBytes) }} · {{ r.categoryId }} ·
                      <span :class="'risk-' + r.risk">{{ r.risk }}</span>
                      · 删除于 {{ formatTime(r.deletedAt) }} ·
                      <span :class="r.keepUntil <= Date.now() ? 'risk-medium' : ''">{{ daysLeft(r) }}</span>
                    </div>
                  </div>
                </li>
              </ul>
            </template>
          </section>
        </template>

        <!-- ── 规则库 ── -->
        <template v-else-if="tab === 'rules'">
          <section class="sd-sec">
            <h4>垃圾分类规则库（{{ rules.length }} 类）</h4>
            <div class="sd-hint">
              规则以 JSON 配置驱动，位于 <code>%LOCALAPPDATA%\SoftGraph\rules\junk-rules.json</code>，
              编辑后重启应用即生效；新增垃圾类型无需改动程序代码。
            </div>
            <table class="sd-table">
              <thead>
                <tr><th>编号</th><th>类别</th><th>风险</th><th>默认勾选</th><th>说明</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in rules" :key="r.id">
                  <td class="mono">{{ r.id }}</td>
                  <td>{{ r.name }}</td>
                  <td :class="'risk-' + r.risk">{{ r.risk }}</td>
                  <td>{{ r.defaultSelected ? '是' : '否' }}</td>
                  <td class="dim">{{ r.description }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>

        <!-- ── 关于 ── -->
        <template v-else-if="tab === 'about' && info">
          <section class="sd-sec">
            <h4>SoftGraph v{{ info.version }}</h4>
            <div class="sd-hint">软件图谱与磁盘清理工具 —— 依赖关系可视化 · 便携软件识别 · 垃圾空间治理</div>
            <table class="sd-table">
              <tbody>
                <tr><td>Electron</td><td class="mono">{{ info.electron }}</td></tr>
                <tr><td>Chromium</td><td class="mono">{{ info.chrome }}</td></tr>
                <tr><td>Node</td><td class="mono">{{ info.node }}</td></tr>
                <tr><td>平台</td><td class="mono">{{ info.platform }} / {{ info.arch }}</td></tr>
                <tr><td>数据库驱动</td><td class="mono">{{ info.dbDriver }}</td></tr>
                <tr><td>运行权限</td><td>{{ info.elevated ? '管理员' : '标准用户（推荐）' }}</td></tr>
                <tr><td>数据目录</td><td class="mono sel">{{ info.userData }}</td></tr>
              </tbody>
            </table>
            <div class="sd-hint">
              本工具完全离线运行：所有扫描、解析、统计均在本地完成，不向任何服务端发送文件路径、软件清单或硬件信息。
            </div>
            <div class="sd-hint">
              以标准用户权限运行即可完成绝大多数清理；受 TrustedInstaller 保护的目录（WinSxS 等）不做所有权接管，
              仅检测并提示，以避免破坏系统文件完整性。
            </div>
            <!-- 诊断包（C5）：一键导出脱敏运行日志，便于反馈问题 -->
            <div class="sd-row">
              <button class="ghost" :disabled="diagBusy" @click="exportDiag">
                {{ diagBusy ? '正在打包…' : '导出诊断包' }}
              </button>
              <span class="sd-hint sd-inline">
                生成脱敏 zip（环境信息 / 设置 / 数据库统计 / 最近日志）。
                日志在**写入磁盘前**已抹除用户名与计算机名；不含扫描明细与删除清单。
              </span>
            </div>
            <div v-if="diagText" class="sd-hint" :class="diagOk ? '' : 'risk-medium'">{{ diagText }}</div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sd-mask {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 14, 0.55);
  z-index: 150;
  display: flex;
  justify-content: flex-end;
}
.sd {
  width: 640px;
  max-width: 96vw;
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
}
.sd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.sd-tabs {
  display: flex;
  gap: 4px;
  flex: 1;
}
.sd-tabs button {
  background: transparent;
  font-size: 12px;
}
.sd-tabs button.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.sd-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px 40px;
  min-height: 0;
}
.sd-sec {
  margin-bottom: 22px;
}
.sd-sec h4 {
  margin: 0 0 9px;
  font-size: 12.5px;
  font-weight: 600;
}
.sd-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.sd-row.col {
  flex-direction: column;
  align-items: stretch;
}
.sd-row > label {
  width: 96px;
  flex: none;
  font-size: 11.5px;
  color: var(--text-2);
}
.sd-row.col > label {
  width: auto;
  margin-bottom: 2px;
}
.sd-row select,
.sd-row input[type='range'] {
  flex: 1;
  min-width: 120px;
}
.sd-row input[type='number'] {
  width: 60px;
}
.sd-val {
  width: 58px;
  text-align: right;
  font-size: 11.5px;
  flex: none;
}
.sd-sp {
  flex: 1;
}
.sd-inline {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
}
.sd-hint {
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-2);
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 7px 9px;
  margin: 6px 0 8px;
}
.sd-hint.warn {
  color: var(--risk-medium);
  background: color-mix(in srgb, var(--risk-medium) 10%, transparent);
}
.sd-hint code {
  font-family: var(--mono);
  font-size: 10.5px;
  background: var(--panel-2);
  padding: 1px 4px;
  border-radius: 3px;
}
.sd-hint.sd-inline {
  margin: 0;
  flex: 1;
  min-width: 220px;
}
.risk-medium {
  color: var(--risk-medium);
}
.sd-check {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 11.5px;
  line-height: 1.5;
  margin-bottom: 7px;
  cursor: pointer;
}
.sd-tags {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 5px;
}
.sd-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 3px 6px;
  font-size: 10.5px;
}
.sd-tag > span {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.sd-tag button {
  padding: 0 4px;
  font-size: 10px;
}
.sd-plugins {
  list-style: none;
  margin: 0 0 9px;
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.sd-plugins li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg);
}
.sd-plugins li:last-child {
  border-bottom: none;
}
.sd-plugins li.on {
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
}
.sd-plugin-body {
  flex: 1;
  min-width: 0;
}
.sd-plugin-t {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  flex-wrap: wrap;
}
.sd-plugin-d {
  font-size: 10.5px;
  line-height: 1.5;
  margin-top: 2px;
}
.sd-plugin-ord {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
}
.sd-plugin-ord button {
  padding: 0 5px;
  font-size: 9px;
  line-height: 1.5;
}
.sd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  margin-top: 6px;
}
.sd-table th,
.sd-table td {
  text-align: left;
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: top;
}
.sd-table th {
  color: var(--text-2);
  font-weight: 500;
}
.sd-table td:first-child {
  white-space: nowrap;
}
.sd-empty {
  padding: 26px;
  text-align: center;
  font-size: 12px;
}
.sd-q {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  max-height: 50vh;
  overflow-y: auto;
}
.sd-q li {
  display: flex;
  gap: 8px;
  padding: 6px 9px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg);
}
.sd-q li:last-child {
  border-bottom: none;
}
.sd-q-body {
  flex: 1;
  min-width: 0;
}
.sd-q-path {
  font-size: 10.5px;
  word-break: break-all;
  line-height: 1.45;
}
.sd-q-meta {
  font-size: 10px;
  margin-top: 2px;
}
</style>
