<script setup lang="ts">
/**
 * 设置抽屉：设置（FR-15）/ 浮窗（模块二控制面板）/ 隔离区（FR-11）/ 规则库 / 关于
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { AppInfo } from '@shared/ipc'
import type {
  AppSettings,
  FloatInstanceSettings,
  FloatPluginManifest,
  FloatSettings,
  QuarantineRecord,
  RegistryBackupInfo,
  RegistryScanResult
} from '@shared/types'
import { formatBytes, formatTime } from '@shared/util'
import { DEFAULT_INSTANCE_ID, nextInstanceId, normalizeInstances } from '@shared/float'

const props = defineProps<{ open: boolean; tab: TabKey }>()
type TabKey = 'settings' | 'float' | 'quarantine' | 'registry' | 'rules' | 'about'

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
  { key: 'registry', label: '注册表' },
  { key: 'rules', label: '垃圾规则' },
  { key: 'about', label: '关于' }
]

async function loadAll(): Promise<void> {
  settings.value = await window.api.getSettings()
  info.value = await window.api.appInfo()
  plugins.value = await window.api.floatPlugins()
  rules.value = await window.api.junkRules()
  await loadQuarantine()
  await loadRegistryBackups()
  window.api.auditRecent().then((a) => (audit.value = a)).catch(() => {})
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

// ── 多实例编辑（F4-UI）──
//
// 实例规范化用的是 @shared/float 的同一份实现（主进程建窗口前也用它），
// 因此「老配置折叠成单实例」在两侧口径一致，不会出现「设置页显示 2 个、
// 桌面只出来 1 个」这类漂移。

const editorInstances = computed(() => (float.value ? normalizeInstances(float.value) : []))
const activeId = ref<string>(DEFAULT_INSTANCE_ID)
const activeInstance = computed<FloatInstanceSettings | null>(
  () => editorInstances.value.find((i) => i.id === activeId.value) ?? editorInstances.value[0] ?? null
)

async function writeInstances(next: FloatInstanceSettings[]): Promise<void> {
  await patchFloat({ instances: next })
}

async function addInstance(): Promise<void> {
  const list = editorInstances.value
  if (list.length === 0) return
  const base = list[0]
  const id = nextInstanceId(list)
  // 位置错开，避免新窗口与已有窗口完全重叠（之后由用户拖拽定位）
  const next: FloatInstanceSettings = {
    ...base,
    id,
    plugins: [...base.plugins],
    x: base.x - 32 * list.length,
    y: base.y + 28 * list.length
  }
  await writeInstances([...list, next])
  activeId.value = id
  emit('toast', `已新增浮窗实例 ${id}（沿用 ${base.id} 的插件组合，拖动浮窗即可调整位置）`)
}

async function removeInstance(id: string): Promise<void> {
  const list = editorInstances.value
  if (list.length <= 1) {
    emit('toast', '至少要保留一个浮窗实例')
    return
  }
  const next = list.filter((i) => i.id !== id)
  await writeInstances(next)
  if (activeId.value === id) activeId.value = next[0]?.id ?? DEFAULT_INSTANCE_ID
  emit('toast', `已删除浮窗实例 ${id}`)
}

async function patchInstance(patch: Partial<FloatInstanceSettings>): Promise<void> {
  const cur = activeInstance.value
  if (!cur) return
  await writeInstances(editorInstances.value.map((i) => (i.id === cur.id ? { ...i, ...patch } : i)))
}

function instPluginEnabled(id: string): boolean {
  return activeInstance.value?.plugins.includes(id) ?? false
}

async function toggleInstPlugin(id: string): Promise<void> {
  const cur = activeInstance.value
  if (!cur) return
  const plugins = [...cur.plugins]
  const i = plugins.indexOf(id)
  if (i >= 0) plugins.splice(i, 1)
  else plugins.push(id)
  await patchInstance({ plugins })
}

async function moveInstPlugin(id: string, dir: -1 | 1): Promise<void> {
  const cur = activeInstance.value
  if (!cur) return
  const plugins = [...cur.plugins]
  const i = plugins.indexOf(id)
  if (i < 0) return
  const j = i + dir
  if (j < 0 || j >= plugins.length) return
  ;[plugins[i], plugins[j]] = [plugins[j], plugins[i]]
  await patchInstance({ plugins })
}

/** 当前实例：启用的插件按用户顺序排前，未启用的排后 */
const instOrderedPlugins = computed(() => {
  const order = activeInstance.value?.plugins ?? []
  const on = order.map((id) => plugins.value.find((p) => p.id === id)).filter(Boolean) as FloatPluginManifest[]
  const off = plugins.value.filter((p) => !order.includes(p.id))
  return [...on, ...off]
})

function openPluginDir(): void {
  void window.api.floatOpenPluginDir()
}

/** F1：插件尚未授权的能力 */
function pendingOf(p: FloatPluginManifest): string[] {
  return p.pendingPermissions ?? []
}

function permTitle(perm: string): string {
  const map: Record<string, string> = {
    fs: '文件系统（读写插件目录之外的文件）',
    network: '网络访问（发起 HTTP/HTTPS 请求）',
    powershell: 'PowerShell 执行（系统命令 / WMI 查询）'
  }
  return map[perm] ?? perm
}

async function approvePlugin(p: FloatPluginManifest): Promise<void> {
  busy.value = true
  try {
    const pending = pendingOf(p)
    plugins.value = await window.api.floatPluginApprove({ id: p.id, permissions: pending })
    emit('toast', `已授权 ${p.name}：${pending.join(' / ')}`)
  } finally {
    busy.value = false
  }
}

async function removePlugin(p: FloatPluginManifest): Promise<void> {
  busy.value = true
  try {
    const r = await window.api.floatPluginRemove(p.id)
    if (!r.ok) {
      emit('toast', `删除失败：${r.error}`)
      return
    }
    plugins.value = await window.api.floatPlugins()
    emit('toast', `已删除插件 ${p.name}`)
  } finally {
    busy.value = false
  }
}

const installUrl = ref('')
const installInput = ref<HTMLInputElement | null>(null)

function pickInstallFile(): void {
  installInput.value?.click()
}

async function installFromFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  if (f.size > 256 * 1024) {
    emit('toast', '插件超过 256KB 上限')
    return
  }
  busy.value = true
  try {
    const source = await f.text()
    const r = await window.api.floatPluginInstall({ source })
    handleInstallResult(r, f.name)
  } finally {
    busy.value = false
  }
}

async function installFromUrl(): Promise<void> {
  const url = installUrl.value.trim()
  if (!url) return
  busy.value = true
  try {
    const r = await window.api.floatPluginInstall({ url })
    handleInstallResult(r, url)
  } finally {
    busy.value = false
  }
}

function handleInstallResult(r: { ok: boolean; id?: string; name?: string; permissions?: string[]; error?: string }, origin: string): void {
  if (!r.ok) {
    emit('toast', `安装失败：${r.error}`)
    return
  }
  emit('toast', `已安装 ${r.name}（${origin}）${r.permissions?.length ? `，含能力：${r.permissions.join(' / ')}，待授权` : ''}`)
  installUrl.value = ''
  void reloadPlugins()
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

// ───────────────── 注册表残留清理（M4-UI / M4-RESTORE）─────────────────

const registry = ref<RegistryScanResult | null>(null)
const regBusy = ref(false)
const regText = ref('')
const regOk = ref(false)
const regChecked = ref<Set<string>>(new Set())
/** 三级确认：0 = 列表 / 1 = 影响清单 + 知悉勾选 / 2 = 输入确认文本 */
const regStep = ref<0 | 1 | 2>(0)
const regAck = ref(false)
const regTyped = ref('')
const REG_CONFIRM_TEXT = '清理注册表'

const regBackups = ref<RegistryBackupInfo[]>([])
const regRestoring = ref('')

const regSelected = computed(() => (registry.value?.residues ?? []).filter((r) => regChecked.value.has(r.keyPath)))
const regSelectedBytes = computed(() => regSelected.value.reduce((s, r) => s + r.sizeBytes, 0))
const regSelectedHklm = computed(() => regSelected.value.filter((r) => r.hive === 'HKLM').length)

function toggleReg(key: string): void {
  const n = new Set(regChecked.value)
  if (n.has(key)) n.delete(key)
  else n.add(key)
  regChecked.value = n
}

function regAll(on: boolean): void {
  regChecked.value = on ? new Set((registry.value?.residues ?? []).map((r) => r.keyPath)) : new Set()
  resetRegConfirm()
}

function resetRegConfirm(): void {
  regStep.value = 0
  regAck.value = false
  regTyped.value = ''
}

async function scanRegistry(): Promise<void> {
  regBusy.value = true
  regText.value = ''
  resetRegConfirm()
  try {
    const r = await window.api.registryScan()
    registry.value = r
    regChecked.value = new Set(r.residues.map((x) => x.keyPath))
    regOk.value = true
    emit(
      'toast',
      `注册表扫描完成：枚举 ${r.scanned} 个卸载项，疑似残留 ${r.residues.length} 项（${(r.scanMs / 1000).toFixed(1)}s）`
    )
  } catch (e) {
    regOk.value = false
    regText.value = `扫描失败：${(e as Error).message}`
  } finally {
    regBusy.value = false
  }
}

/** 推进三级确认；最后一步才真正执行删除 */
function regNext(): void {
  if (regSelected.value.length === 0) return
  if (regStep.value === 0) {
    regStep.value = 1
    return
  }
  if (regStep.value === 1) {
    if (!regAck.value) return
    regStep.value = 2
    return
  }
  void doRegistryClean()
}

async function doRegistryClean(): Promise<void> {
  const keys = regSelected.value.map((r) => r.keyPath)
  if (keys.length === 0) return
  regBusy.value = true
  regText.value = ''
  try {
    const r = await window.api.registryClean(keys)
    regOk.value = r.ok
    if (r.backupFailed) {
      regText.value = '备份失败，已拒绝删除 —— 注册表没有回收站，本工具不会在拿不到备份时动它。'
    } else if (r.needsElevation) {
      regText.value = `需要管理员权限：${keys.length} 个键未删除。以管理员身份重新启动本程序后可重试。`
    } else {
      const parts = [`已清理 ${r.removed} 个键`]
      if (r.failed > 0) parts.push(`${r.failed} 个失败`)
      if (r.rejected.length > 0) parts.push(`${r.rejected.length} 个被白名单拒绝`)
      if (r.backupFile) parts.push(`备份：${r.backupFile}`)
      regText.value = parts.join(' · ')
    }
    emit('toast', r.needsElevation ? '注册表清理需要管理员权限' : `注册表清理完成：${r.removed} 个键`)
    resetRegConfirm()
    // 清理后重新扫描一次，列表与实际状态对齐（用户不会看到已删掉的键）
    const again = await window.api.registryScan()
    registry.value = again
    regChecked.value = new Set(again.residues.map((x) => x.keyPath))
    await loadRegistryBackups()
  } catch (e) {
    regOk.value = false
    regText.value = `清理失败：${(e as Error).message}`
  } finally {
    regBusy.value = false
  }
}

async function loadRegistryBackups(): Promise<void> {
  try {
    regBackups.value = await window.api.registryBackups()
  } catch {
    regBackups.value = []
  }
}

async function restoreRegistry(file: string): Promise<void> {
  regBusy.value = true
  regRestoring.value = file
  regText.value = ''
  try {
    const r = await window.api.registryRestore(file)
    if (r.error) {
      regOk.value = false
      regText.value = r.error
    } else {
      regOk.value = r.failed === 0
      regText.value = `已还原 ${r.restored} 个键${r.failed ? `，${r.failed} 个失败` : ''}。重新扫描可确认。`
    }
    emit('toast', r.error ? `还原失败：${r.error}` : `已还原 ${r.restored} 个注册表键`)
    if (registry.value) {
      const again = await window.api.registryScan()
      registry.value = again
      regChecked.value = new Set(again.residues.map((x) => x.keyPath))
    }
  } catch (e) {
    regOk.value = false
    regText.value = `还原失败：${(e as Error).message}`
  } finally {
    regBusy.value = false
    regRestoring.value = ''
  }
}

/** 审计日志（E4） */
const audit = ref<{ ts: number; action: string; taskId: string; batchId?: string; freedBytes: number; results: { path: string; ok: boolean }[] }[]>([])
const AUDIT_LABEL: Record<string, string> = {
  clean: '隔离清理',
  'clean-direct': '直接删除',
  'clean-elevate': '提权清理',
  'reboot-delete': '登记重启删除',
  restore: '隔离还原',
  purge: '隔离销毁',
  'registry-clean': '注册表清理',
  'registry-restore': '注册表还原'
}

/** 规则库在线更新（E2） */
const rulesBusy = ref(false)
const rulesText = ref('')
const rulesOk = ref(false)

async function checkRulesUpdate(): Promise<void> {
  rulesBusy.value = true
  rulesText.value = ''
  try {
    const r = await window.api.rulesUpdate()
    rulesOk.value = r.ok
    if (r.ok) {
      rulesText.value = `✅ 规则库已更新到 v${r.version}（${r.ruleCount ?? '?'} 类）。重新扫描即生效。`
      emit('toast', `规则库已更新到 v${r.version}`)
      rules.value = await window.api.junkRules()
    } else {
      rulesText.value = `未更新：${r.reason ?? '未知原因'}`
    }
  } catch (e) {
    rulesOk.value = false
    rulesText.value = `检查失败：${(e as Error).message}`
  } finally {
    rulesBusy.value = false
  }
}

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
      diagText.value = `已生成：${r.file}（${formatBytes(r.bytes ?? 0)}，含 ${r.entries ?? 0} 个文件），已在资源管理器中定位`
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
            <!-- 规则库在线更新（E2）：签名 + 哈希 + 版本单调 + 结构校验 -->
            <div class="sd-row col">
              <label>规则库更新源（HTTPS，留空禁用在线更新）</label>
              <input
                class="mono"
                type="url"
                placeholder="https://example.com/softgraph-rules/"
                :value="settings.rulesUpdateUrl"
                @change="patch({ rulesUpdateUrl: ($event.target as HTMLInputElement).value.trim() })"
              />
              <div class="sd-actions">
                <button class="ghost" :disabled="rulesBusy" @click="checkRulesUpdate">
                  {{ rulesBusy ? '检查中…' : '检查规则更新' }}
                </button>
                <span class="sd-hint sd-inline">
                  更新包必须通过 Ed25519 签名（公钥内置）、SHA-256 校验、版本单调与安全结构检查，
                  任何一步失败都不会改动本机规则。
                </span>
              </div>
              <div v-if="rulesText" class="sd-hint" :class="rulesOk ? '' : 'warn'">{{ rulesText }}</div>
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
            <h4>
              浮窗实例
              <span class="dim" style="font-weight: 400; font-size: 11px">
                — 每个实例一个独立窗口，可放在不同显示器上，各显示不同内容
              </span>
            </h4>
            <ul class="sd-insts">
              <li v-for="(inst, i) in editorInstances" :key="inst.id" :class="{ on: inst.id === activeInstance?.id }">
                <button class="sd-inst-pick" @click="activeId = inst.id">
                  <span class="mono">{{ inst.id }}</span>
                  <span class="dim">· {{ inst.plugins.length }} 个插件 · {{ inst.theme }} · {{ inst.width }}px</span>
                  <span class="dim">· 位置 {{ Math.round(inst.x) }}, {{ Math.round(inst.y) }}</span>
                  <span v-if="i === 0" class="badge">主实例</span>
                </button>
                <button class="ghost" :disabled="editorInstances.length <= 1" title="删除该实例" @click="removeInstance(inst.id)">
                  删除
                </button>
              </li>
            </ul>
            <div class="sd-row">
              <button class="ghost" @click="addInstance">+ 新增实例</button>
              <span class="sd-hint sd-inline" style="margin: 0">
                新实例沿用主实例的插件组合；窗口位置直接拖动浮窗即可（拖拽结果会写回该实例）。
              </span>
            </div>
          </section>

          <section v-if="activeInstance" class="sd-sec">
            <h4>
              实例「<span class="mono">{{ activeInstance.id }}</span>」的行为
            </h4>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="activeInstance.autoHide"
                @change="patchInstance({ autoHide: ($event.target as HTMLInputElement).checked })"
              />
              <span>靠边自动隐藏（鼠标移入时再次显示）</span>
            </label>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="activeInstance.clickThrough"
                @change="patchInstance({ clickThrough: ($event.target as HTMLInputElement).checked })"
              />
              <span>鼠标穿透（点击直接作用于桌面，此时无法拖动浮窗）</span>
            </label>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="activeInstance.lockPosition"
                @change="patchInstance({ lockPosition: ($event.target as HTMLInputElement).checked })"
              />
              <span>锁定位置（防止误拖）</span>
            </label>
          </section>

          <section class="sd-sec">
            <h4>全局行为（所有实例共享）</h4>
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
            <div class="sd-hint">
              总开关、触发条宽度与置顶层级是应用级行为：多实例下共用一个值才有意义（总不能一个实例置顶另一个不置顶）。
            </div>
          </section>

          <section v-if="activeInstance" class="sd-sec">
            <h4>实例「<span class="mono">{{ activeInstance.id }}</span>」的外观</h4>
            <div class="sd-row">
              <label>主题</label>
              <select
                :value="activeInstance.theme"
                @change="patchInstance({ theme: ($event.target as HTMLSelectElement).value as FloatInstanceSettings['theme'] })"
              >
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
                :value="activeInstance.width"
                @change="patchInstance({ width: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="sd-val">{{ activeInstance.width }} px</span>
            </div>
            <div class="sd-row">
              <label>不透明度</label>
              <input
                type="range"
                min="0.3"
                max="1"
                step="0.02"
                :value="activeInstance.opacity"
                @change="patchInstance({ opacity: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="sd-val">{{ Math.round(activeInstance.opacity * 100) }}%</span>
            </div>
            <label class="sd-check">
              <input
                type="checkbox"
                :checked="activeInstance.compact"
                @change="patchInstance({ compact: ($event.target as HTMLInputElement).checked })"
              />
              <span>紧凑模式（更小的行高与字号）</span>
            </label>
          </section>

          <section v-if="activeInstance" class="sd-sec">
            <h4>
              实例「<span class="mono">{{ activeInstance.id }}</span>」的显示内容
              <span class="dim" style="font-weight: 400; font-size: 11px">
                — 勾选决定显示哪些卡片，箭头调整顺序
              </span>
            </h4>
            <ul class="sd-plugins">
              <li v-for="(p, idx) in instOrderedPlugins" :key="p.id" :class="{ on: instPluginEnabled(p.id) }">
                <input type="checkbox" :checked="instPluginEnabled(p.id)" @change="toggleInstPlugin(p.id)" />
                <div class="sd-plugin-body">
                  <div class="sd-plugin-t">
                    {{ p.name }}
                    <span class="badge">{{ p.builtin ? '内置' : '外部' }}</span>
                    <span class="badge">{{ p.view }}</span>
                    <span v-if="p.interval > 0" class="badge">{{ (p.interval / 1000).toFixed(p.interval < 1000 ? 1 : 0) }}s</span>
                    <span v-for="perm in p.permissions ?? []" :key="perm" class="badge" :class="pendingOf(p).includes(perm) ? 'risk-medium' : 'perm-ok'" :title="permTitle(perm)">
                      {{ perm }}
                    </span>
                  </div>
                  <div class="dim sd-plugin-d">{{ p.description }}</div>
                  <div v-if="pendingOf(p).length" class="sd-hint warn" style="margin: 4px 0 0">
                    待授权：{{ pendingOf(p).map(permTitle).join('；') }} —— 未授权前不会运行
                  </div>
                </div>
                <div class="sd-plugin-ord" style="flex-direction: column; gap: 4px">
                  <template v-if="instPluginEnabled(p.id)">
                    <button class="ghost" :disabled="idx === 0" @click="moveInstPlugin(p.id, -1)">▲</button>
                    <button class="ghost" @click="moveInstPlugin(p.id, 1)">▼</button>
                  </template>
                  <button v-if="pendingOf(p).length" class="ghost" :disabled="busy" @click="approvePlugin(p)">授权</button>
                  <button v-if="!p.builtin" class="ghost" :disabled="busy" @click="removePlugin(p)">删除</button>
                </div>
              </li>
            </ul>
            <div class="sd-row">
              <button class="ghost" :disabled="busy" @click="reloadPlugins">重载插件</button>
              <button class="ghost" @click="openPluginDir">打开插件目录</button>
              <button class="ghost" :disabled="busy" @click="pickInstallFile">从文件安装…</button>
              <input ref="installInput" type="file" accept=".js" style="display: none" @change="installFromFile" />
            </div>
            <div class="sd-row" style="margin-top: 6px">
              <input v-model="installUrl" type="text" placeholder="或粘贴 https:// 插件地址一键安装" style="flex: 1" @keydown.enter="installFromUrl" />
              <button class="ghost" :disabled="busy || !installUrl.trim()" @click="installFromUrl">安装</button>
            </div>
            <div class="sd-hint">
              插件目录内已放置示例插件 <code>example-hello.js</code> 与 <code>README.md</code>。
              新增一个 .js 文件即可扩展浮窗内容，点「重载插件」立即生效，无需重启。
              插件在主进程内执行、拥有 Node 能力，请只安装可信插件。
              插件授权与安装是插件级操作，对所有实例同时生效。
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

        <!-- ── 注册表残留 ── -->
        <template v-else-if="tab === 'registry'">
          <section class="sd-sec">
            <div class="sd-row">
              <label>卸载残留</label>
              <button class="primary" :disabled="regBusy" @click="scanRegistry">
                {{ regBusy ? '处理中…' : registry ? '重新扫描' : '扫描注册表残留' }}
              </button>
              <span v-if="registry" class="dim" style="font-size: 11px">
                枚举 {{ registry.scanned }} 个卸载项 · 疑似残留 {{ registry.residues.length }} 项 ·
                用时 {{ (registry.scanMs / 1000).toFixed(1) }}s
              </span>
            </div>
            <div class="sd-hint warn">
              注册表<b>没有回收站</b>：删除后无法从系统层面找回。本工具因此把「先备份后删除」做成硬约束 ——
              备份拿不到就拒绝删除。仅枚举三棵 <code>...\CurrentVersion\Uninstall</code> 子树，
              其余注册表位置一律不在白名单内。
            </div>
            <div class="sd-hint">
              判定会跳过四类「绝对不能碰」的项：<code>SystemComponent=1</code>（Windows 隐藏的内置组件）、
              MSI 管理的项、无 <code>DisplayName</code> 的键、卸载程序位于 Windows 目录内或发布者为微软的自带应用。
            </div>
            <div v-if="registry?.needsElevation" class="cd-note warn">
              检测结果含 HKLM 项，而当前未以管理员身份运行 —— 删除会返回「需要管理员权限」。仍然可以扫描与备份。
            </div>
          </section>

          <section v-if="registry" class="sd-sec">
            <div class="sd-row">
              <label>残留清单</label>
              <span class="dim" style="font-size: 11px">
                已选 {{ regSelected.length }} / {{ registry.residues.length }}
                <template v-if="regSelectedBytes > 0">· 目录占用 {{ formatBytes(regSelectedBytes) }}</template>
                <template v-if="regSelectedHklm > 0">· 其中 HKLM {{ regSelectedHklm }} 项</template>
              </span>
              <span class="sd-sp" />
              <button class="ghost" @click="regAll(true)">全选</button>
              <button class="ghost" @click="regAll(false)">全不选</button>
            </div>

            <div v-if="registry.residues.length === 0" class="sd-empty dim">
              未发现卸载残留（枚举 {{ registry.scanned }} 个卸载项，全部判定为正常安装）
            </div>

            <ul v-else class="sd-reg">
              <li v-for="r in registry.residues" :key="r.keyPath">
                <input type="checkbox" :checked="regChecked.has(r.keyPath)" @change="toggleReg(r.keyPath)" />
                <div class="sd-reg-body">
                  <div class="sd-reg-t">
                    {{ r.displayName }}
                    <span class="badge">{{ r.hive }}{{ r.view === '32' ? '/32' : '' }}</span>
                    <span v-if="r.displayVersion" class="badge">{{ r.displayVersion }}</span>
                    <span v-if="r.sizeBytes > 0" class="badge">{{ formatBytes(r.sizeBytes) }}</span>
                  </div>
                  <div class="mono sd-reg-key">{{ r.keyPath }}</div>
                  <div class="dim sd-reg-why">{{ r.reasons.join('；') }}</div>
                  <div v-if="r.publisher" class="dim sd-reg-why">发布者：{{ r.publisher }}</div>
                </div>
              </li>
            </ul>

            <!-- 三级确认：列表 → 影响清单（勾选知悉）→ 输入确认文本 -->
            <div v-if="registry.residues.length > 0" class="sd-actions" style="margin-top: 8px">
              <button class="danger" :disabled="regBusy || regSelected.length === 0" @click="regNext">
                {{ regStep === 0 ? `清理选中 ${regSelected.length} 项` : regStep === 1 ? '我已确认，继续' : '执行清理' }}
              </button>
              <button v-if="regStep > 0" class="ghost" @click="resetRegConfirm">取消</button>
            </div>

            <div v-if="regStep === 1" class="cd-typing" style="border-color: var(--risk-medium)">
              <div class="cd-typing-t risk-medium">
                将删除以下 {{ regSelected.length }} 个注册表键（前 20 条）：
              </div>
              <ul class="cd-list">
                <li v-for="r in regSelected.slice(0, 20)" :key="r.keyPath">
                  <span class="mono cd-p">{{ r.keyPath }}</span>
                </li>
              </ul>
              <div v-if="regSelected.length > 20" class="dim cd-more">还有 {{ regSelected.length - 20 }} 项…</div>
              <label class="sd-check" style="margin-top: 8px">
                <input v-model="regAck" type="checkbox" />
                <span>我已确认这些项不是需要保留的软件（删除前会自动生成 JSON 快照备份，可在下方「从备份还原」恢复）</span>
              </label>
            </div>

            <div v-if="regStep === 2" class="cd-typing">
              <div class="cd-typing-t risk-high">
                ⚠ 注册表删除不可逆，请手动输入「{{ REG_CONFIRM_TEXT }}」以执行
              </div>
              <input v-model="regTyped" type="text" :placeholder="REG_CONFIRM_TEXT" />
            </div>

            <div v-if="regText" class="sd-hint" :class="regOk ? '' : 'risk-medium'">{{ regText }}</div>
          </section>

          <section class="sd-sec">
            <h4>从备份还原</h4>
            <div class="sd-row">
              <span class="dim" style="font-size: 11px">共 {{ regBackups.length }} 份快照</span>
              <span class="sd-sp" />
              <button class="ghost" :disabled="regBusy" @click="loadRegistryBackups">刷新</button>
            </div>
            <div v-if="regBackups.length === 0" class="sd-empty dim">暂无备份快照</div>
            <ul v-else class="sd-q">
              <li v-for="b in regBackups" :key="b.file">
                <div class="sd-q-body">
                  <div class="mono sd-q-path">{{ b.file }}</div>
                  <div class="dim sd-q-meta">
                    {{ b.keyCount }} 个键 · {{ b.createdAt ? new Date(b.createdAt).toLocaleString() : '时间未知' }}
                  </div>
                </div>
                <button class="ghost" :disabled="regBusy" @click="restoreRegistry(b.file)">
                  {{ regRestoring === b.file ? '还原中…' : '还原' }}
                </button>
              </li>
            </ul>
            <div class="sd-hint">
              还原会把快照里的键与值重新写回注册表（不覆盖额外的既有值）。还原动作同样记入审计日志。
            </div>
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

            <!-- 审计日志（E4）：删除类动作的留痕 -->
            <div class="sd-row col">
              <h4 style="margin: 6px 0 0">审计记录（最近 {{ audit.length }} 条）</h4>
              <div class="sd-audit">
                <div v-for="(a, i) in audit" :key="i" class="sd-audit-row">
                  <span class="mono dim">{{ new Date(a.ts).toLocaleString() }}</span>
                  <span class="sd-audit-act" :class="a.action.includes('elevate') ? 'risk-medium' : ''">
                    {{ AUDIT_LABEL[a.action] ?? a.action }}
                  </span>
                  <span class="mono">{{ a.results.length }} 项</span>
                  <span class="mono dim">{{ formatBytes(a.freedBytes) }}</span>
                </div>
                <div v-if="audit.length === 0" class="dim" style="padding: 6px 0">
                  暂无记录 —— 所有删除 / 还原 / 提权动作都会在这里留痕
                </div>
              </div>
              <span class="sd-hint" style="padding: 0">
                审计文件位于数据目录 audit\audit.jsonl（追加写入、不脱敏、不随诊断包导出）。
              </span>
            </div>
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
.sd-audit {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
}
.sd-audit-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 10.5px;
  padding: 3px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
}
.sd-audit-act {
  font-weight: 600;
  min-width: 84px;
}
.sd-hint.sd-inline {
  margin: 0;
  flex: 1;
  min-width: 220px;
}
.sd-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.risk-medium {
  color: var(--risk-medium);
}
.badge.perm-ok {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
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
/* 浮窗实例列表（F4-UI） */
.sd-insts {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.sd-insts li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg);
}
.sd-insts li:last-child {
  border-bottom: none;
}
.sd-insts li.on {
  background: color-mix(in srgb, var(--accent) 9%, var(--bg));
}
.sd-inst-pick {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  background: transparent;
  border-color: transparent;
  text-align: left;
  font-size: 11.5px;
  padding: 3px 4px;
}
.sd-inst-pick:hover {
  border-color: transparent;
  background: transparent;
}
/* 注册表残留清单（M4-UI） */
.sd-reg {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  max-height: 42vh;
  overflow-y: auto;
}
.sd-reg li {
  display: flex;
  gap: 8px;
  padding: 6px 9px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg);
}
.sd-reg li:last-child {
  border-bottom: none;
}
.sd-reg-body {
  flex: 1;
  min-width: 0;
}
.sd-reg-t {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  flex-wrap: wrap;
}
.sd-reg-key {
  font-size: 10px;
  word-break: break-all;
  line-height: 1.45;
  margin-top: 2px;
  color: var(--text-2);
}
.sd-reg-why {
  font-size: 10px;
  margin-top: 2px;
  line-height: 1.45;
}
</style>
