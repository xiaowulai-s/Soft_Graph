<script setup lang="ts">
/**
 * v6.2 备份同步 v2（审阅式镜像备份）：
 *   流程：建任务（源→目标映射对 / 盘符镜像）→ 预览差异报告 →
 *         选策略（是否删除目标多出）→ 执行（单向覆盖）。
 *   设备：进页自动检测 + 5s 轮询 + 手动刷新；拔盘自动暂停、插回续传。
 *   定时：settings.backupSchedule，无人值守安全策略（只增改不删）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import BackupFlowLine from '../BackupFlowLine.vue'
import { formatBytes } from '@shared/util'
import type { BackupDriveInfo, BackupLogEntry, BackupPreviewResult, BackupRunState, BackupTask } from '@shared/types'
import { Badge, Button, Card, Input, Separator } from '@renderer/components/ui'

const tasks = ref<BackupTask[]>([])
const drives = ref<BackupDriveInfo[]>([])
const states = ref<Record<string, BackupRunState>>({})
const log = ref<BackupLogEntry[]>([])
const toast = ref('')
const toastOk = ref(true)
const busy = ref(false)

// 预览报告（taskId → 结果）
const preview = ref<BackupPreviewResult | null>(null)
const previewingId = ref('')
const previewFiles = ref(0)
const previewCurrent = ref('')
const previewError = ref('')
const previewTab = ref<'add' | 'update' | 'extra'>('add')
const deleteExtras = ref(false)

// 定时
const schEnabled = ref(false)
const schHours = ref(24)

// 编辑表单
const editing = ref(false)
const editId = ref('')
const name = ref('')
const mode = ref<'explicit' | 'mirror'>('explicit')
const mappings = ref<{ from: string; to: string }[]>([])
const extraExcludes = ref<string[]>([])
const newExclude = ref('')
const volumeLabel = ref('')
const driveLetter = ref('')
const formErr = ref('')

const removable = computed(() => drives.value.filter((d) => d.driveType === 2 || d.driveType === 3))
const targetPresent = computed(() => {
  const vl = volumeLabel.value.trim()
  return drives.value.some((d) => (vl && d.label.toLowerCase() === vl.toLowerCase()) || d.letter.toLowerCase() === driveLetter.value.toLowerCase())
})

let toastTimer: ReturnType<typeof setTimeout> | null = null
function say(msg: string, ok = true): void {
  toast.value = msg
  toastOk.value = ok
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 5000)
}

async function load(): Promise<void> {
  try {
    ;[tasks.value, drives.value, states.value, log.value] = await Promise.all([
      window.api.backupTasks(),
      window.api.backupDrives(),
      window.api.backupState(),
      window.api.backupLog()
    ])
    try {
      const s = await window.api.getSettings()
      schEnabled.value = s.backupSchedule?.enabled ?? false
      schHours.value = s.backupSchedule?.intervalHours ?? 24
    } catch {
      /* ignore */
    }
  } catch (e) {
    say(`加载失败：${(e as Error).message}`, false)
  }
}

const unsubRun = window.api.onBackupProgress((s) => {
  const prev = states.value[s.taskId]
  states.value = { ...states.value, [s.taskId]: s }
  if (s.phase === 'done' || s.phase === 'stopped' || s.phase === 'error') void load()
  // v6.2 动效：完成瞬间触发流动线庆祝（3.2s 后自动收起）
  if (s.phase === 'done' && prev && prev.phase !== 'done') {
    celebrated.set(s.taskId, Date.now())
    setTimeout(() => celebrated.delete(s.taskId), 3400)
  }
})
const unsubPreview = window.api.onBackupPreviewProgress((p) => {
  if (previewingId.value === p.taskId) {
    previewFiles.value = p.files
    previewCurrent.value = p.current ?? ''
  }
})

// 设备热插拔感知：进页后 5s 一查 + 手动刷新
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  pollTimer = setInterval(async () => {
    try {
      drives.value = await window.api.backupDrives()
    } catch {
      /* ignore */
    }
  }, 5000)
})
onBeforeUnmount(() => {
  unsubRun()
  unsubPreview()
  if (pollTimer) clearInterval(pollTimer)
})

/** 错误详情展开状态（任务 id 集合） */
const errExpanded = reactive(new Set<string>())
/** v6.2 动效：完成庆祝展示中的任务（id → 触发时间） */
const celebrated = reactive(new Map<string, number>())

/** 流动线是否激活（预览中 / 运行中 / 暂停 / 完成庆祝窗口） */
function flowModeOf(id: string): 'preview' | 'run' | null {
  if (previewingId.value === id) return 'preview'
  const ph = stateOf(id)?.phase
  if (ph === 'running' || ph === 'paused' || (ph === 'done' && celebrated.has(id))) return 'run'
  return null
}

function flowSourceLabel(id: string): string {
  const t = tasks.value.find((x) => x.id === id)
  if (!t) return ''
  return t.mappings[0]?.from ?? ''
}

function flowTargetLabel(id: string): string {
  const t = tasks.value.find((x) => x.id === id)
  if (!t) return ''
  return t.mode === 'explicit' ? (t.mappings[0]?.to ?? '') : `${t.volumeLabel || t.driveLetter || '目标盘'} 镜像`
}
function toggleErrDetail(id: string): void {
  if (errExpanded.has(id)) errExpanded.delete(id)
  else errExpanded.add(id)
}

function stateOf(id: string): BackupRunState | null {
  return states.value[id] ?? null
}

function phaseBadge(st: BackupRunState | null): { text: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' } {
  if (!st) return { text: '未运行', variant: 'secondary' }
  if (st.phase === 'running') return { text: `备份中 · ${st.copied} 新增/更新 / ${st.skipped} 跳过${st.conflicts ? ` / ${st.conflicts} 删除多出` : ''}`, variant: 'default' }
  if (st.phase === 'paused') return { text: st.reason === 'device-lost' ? '已暂停（目标盘已拔出，插回自动续传）' : '已暂停（手动）', variant: 'warning' }
  if (st.phase === 'done') return { text: `完成 · 拷贝 ${st.copied} 个 / ${formatBytes(st.bytes)} · 删除多出 ${st.conflicts}`, variant: 'success' }
  if (st.phase === 'stopped') return { text: `已停止 · 已拷贝 ${st.copied} 个`, variant: 'secondary' }
  return { text: `错误 · ${st.errors[0] ?? '未知'}`, variant: 'destructive' }
}

function mappingText(t: BackupTask): string {
  return t.mappings.map((m) => (t.mode === 'mirror' ? m.from : `${m.from} → ${m.to}`)).join('  ·  ')
}

async function doPreview(id: string): Promise<void> {
  previewingId.value = id
  previewFiles.value = 0
  previewCurrent.value = ''
  preview.value = null
  previewError.value = ''
  try {
    const r = await window.api.backupPreview(id)
    if (r.cancelled) return
    if (!r.ok || !r.result) {
      previewError.value = r.error ?? '预览失败'
      say(previewError.value, false)
      return
    }
    preview.value = r.result
    previewTab.value = 'add'
    deleteExtras.value = false
    say(`预览完成：新增 ${r.result.add} · 更新 ${r.result.update} · 目标多出 ${r.result.deleteExtra}`)
    await load()
  } catch (e) {
    previewError.value = `预览异常：${(e as Error).message}`
    say(previewError.value, false)
  } finally {
    previewingId.value = ''
  }
}

async function cancelPreview(id: string): Promise<void> {
  await window.api.backupCancelPreview(id)
}

async function execute(id: string): Promise<void> {
  if (!preview.value || preview.value.taskId !== id) {
    say('请先预览差异', false)
    return
  }
  busy.value = true
  try {
    const r = await window.api.backupExecute(id, { deleteExtras: deleteExtras.value })
    if (!r.ok) say(r.error ?? '启动失败', false)
    else say('备份已开始')
    await load()
  } finally {
    busy.value = false
  }
}

async function act(id: string, op: 'pause' | 'resume' | 'stop' | 'delete'): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    let r: { ok: boolean; error?: string }
    if (op === 'delete') r = await window.api.backupDeleteTask(id)
    else if (op === 'pause') r = await window.api.backupPause(id)
    else if (op === 'resume') r = await window.api.backupResume(id)
    else r = await window.api.backupStop(id)
    if (!r.ok) say(r.error ?? '操作失败', false)
    if (op === 'delete' && preview.value?.taskId === id) preview.value = null
    await load()
  } finally {
    busy.value = false
  }
}

function startCreate(): void {
  editing.value = true
  editId.value = ''
  name.value = ''
  mode.value = 'explicit'
  mappings.value = [{ from: '', to: '' }]
  extraExcludes.value = []
  newExclude.value = ''
  volumeLabel.value = ''
  driveLetter.value = ''
  formErr.value = ''
}

function startEdit(t: BackupTask): void {
  editing.value = true
  editId.value = t.id
  name.value = t.name
  mode.value = t.mode
  mappings.value = t.mappings.map((m) => ({ from: m.from, to: m.to ?? '' }))
  extraExcludes.value = [...(t.excludeDirs ?? [])]
  volumeLabel.value = t.volumeLabel
  driveLetter.value = t.driveLetter ?? ''
  formErr.value = ''
  previewError.value = ''
  if (preview.value?.taskId === t.id) preview.value = null
}

async function pickSource(i: number): Promise<void> {
  const dir = await window.api.pickDir()
  if (!dir) return
  mappings.value[i].from = dir
  // 显式模式：目标默认给一个同名镜像建议（用户可改）
  if (mode.value === 'explicit' && !mappings.value[i].to) {
    const drv = drives.value.find((d) => d.driveType === 2)
    if (drv) mappings.value[i].to = drv.letter + '\\' + (dir.replace(/^[A-Za-z]:[\\/]/, '') || 'Backup')
  }
}

async function pickTarget(i: number): Promise<void> {
  const dir = await window.api.pickDir()
  if (dir) mappings.value[i].to = dir
}

function addMapping(): void {
  if (mappings.value.length < 20) mappings.value.push({ from: '', to: '' })
}

async function saveForm(): Promise<void> {
  formErr.value = ''
  try {
    const clean = mappings.value
      .filter((m) => m.from.trim())
      // 关键：展开为纯对象 —— Vue reactive 元素是 Proxy，Electron IPC 结构化克隆不支持 Proxy（静默 DataCloneError）
      .map((m) => ({ from: String(m.from), to: String(m.to ?? '') }))
    const r = await window.api.backupSaveTask({
      task: {
        id: editId.value || undefined,
        name: name.value.trim(),
        mode: mode.value,
        mappings: clean,
        excludeDirs: extraExcludes.value.slice(),
        volumeLabel: volumeLabel.value.trim(),
        driveLetter: driveLetter.value || undefined
      }
    })
    if (!r.ok) {
      formErr.value = r.error ?? '保存失败'
      return
    }
    editing.value = false
    say(editId.value ? '任务已更新（旧预览已失效）' : '任务已创建 —— 下一步：预览差异')
    await load()
  } catch (e) {
    formErr.value = `保存异常：${(e as Error).message}`
  }
}

async function saveSchedule(): Promise<void> {
  await window.api.setSettings({ backupSchedule: { enabled: schEnabled.value, intervalHours: schHours.value } } as never)
  say(schEnabled.value ? `定时备份已启用（每 ${schHours.value} 小时）` : '定时备份已关闭')
}

const EXCLUDE_DEFAULTS = ['node_modules', '.git', 'dist', 'build', 'cache', '__pycache__', '.gradle', '.idea', '.vscode', 'out', '.svn', '.hg', '.cache', '.next', '.nuxt']

function logText(e: BackupLogEntry): string {
  const d = new Date(e.ts)
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const labels: Record<string, string> = { run: '开始', pause: '暂停', resume: '续传', stop: '停止', done: '完成', error: '错误', 'device-lost': '拔盘', 'device-back': '插回' }
  return `${hh} [${labels[e.action] ?? e.action}] ${e.detail}`
}

const previewEntries = computed(() => {
  if (!preview.value) return []
  if (previewTab.value === 'add') return preview.value.sampleAdds
  if (previewTab.value === 'update') return preview.value.sampleUpdates
  return preview.value.sampleExtras
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-8 pb-10 pt-7">
    <div class="flex flex-col gap-0.5 pb-1">
      <h2 class="text-[19px] font-semibold tracking-tight text-foreground">备份同步</h2>
      <span class="text-[12.5px] text-muted-foreground">审阅式镜像备份：预览差异 → 确认策略 → 单向覆盖 · 拔盘暂停插回续传</span>
    </div>

    <!-- 目标设备状态条（5s 自动轮询） -->
    <Card class="flex flex-wrap items-center gap-3 px-4 py-3">
      <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">目标设备</span>
      <template v-if="removable.length">
        <Badge v-for="d in removable" :key="d.letter" variant="success">
          {{ d.letter }} {{ d.label || '未命名' }}（剩 {{ formatBytes(d.freeBytes) }}）
        </Badge>
      </template>
      <Badge v-else variant="warning">未检测到可移动磁盘 —— 插入后 5 秒内自动出现</Badge>
      <Button variant="ghost" size="sm" class="ml-auto" @click="load">↻ 刷新</Button>
    </Card>

    <!-- 操作条 -->
    <div class="flex items-center gap-2.5">
      <Button @click="startCreate">新建任务</Button>
      <Button v-if="editing" variant="ghost" @click="editing = false">取消编辑</Button>
      <span v-if="toast" class="text-xs" :class="toastOk ? 'text-primary' : 'text-destructive'">{{ toast }}</span>
    </div>

    <!-- 新建 / 编辑向导 -->
    <Card v-if="editing" class="flex flex-col gap-3 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <span class="w-20 flex-none text-xs text-muted-foreground">任务名</span>
        <Input v-model="name" placeholder="如：Demo 镜像" maxlength="60" class="w-64 flex-none" />
        <div class="flex gap-1.5">
          <Button size="sm" :variant="mode === 'explicit' ? 'default' : 'outline'" @click="mode = 'explicit'">显式「源→目标」映射</Button>
          <Button size="sm" :variant="mode === 'mirror' ? 'default' : 'outline'" @click="mode = 'mirror'">盘符镜像</Button>
        </div>
      </div>
      <div class="px-0.5 text-[11px] text-muted-foreground">
        {{ mode === 'explicit' ? '显式映射：目标路径由你指定（如 D:\\Demo → E:\\Demo），兼容手动拷贝的目录结构' : '盘符镜像：源 D:\\work\\app 自动落到目标盘 X:\\D\\work\\app' }}
      </div>

      <div class="flex flex-col gap-2">
        <div v-for="(m, i) in mappings" :key="i" class="flex items-center gap-2">
          <span class="w-6 flex-none text-center text-xs text-muted-foreground">{{ i + 1 }}.</span>
          <div class="flex flex-1 items-center gap-2">
            <Input
              :model-value="m.from"
              placeholder="源目录（绝对路径，点右侧选择）"
              readonly
              class="min-w-0 flex-1 cursor-pointer"
              @click="pickSource(i)"
            />
            <Button variant="outline" size="sm" class="flex-none" @click="pickSource(i)">选择…</Button>
            <template v-if="mode === 'explicit'">
              <span class="flex-none text-muted-foreground">→</span>
              <Input
                :model-value="m.to"
                placeholder="目标目录（绝对路径，点右侧选择）"
                readonly
                class="min-w-0 flex-1 cursor-pointer"
                @click="pickTarget(i)"
              />
              <Button variant="outline" size="sm" class="flex-none" @click="pickTarget(i)">选择…</Button>
            </template>
            <span v-else class="flex-1 truncate text-[11px] text-muted-foreground">自动镜像到目标盘</span>
          </div>
          <Button variant="ghost" size="sm" @click="mappings.splice(i, 1)">移除</Button>
        </div>
        <Button variant="outline" size="sm" class="self-start" @click="addMapping">＋ 添加映射对（最多 20）</Button>
      </div>

      <Separator />

      <!-- 排除规则 -->
      <div>
        <div class="pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">排除目录（默认已含以下，另可追加）</div>
        <div class="flex flex-wrap items-center gap-1.5 py-1">
          <Badge v-for="e in EXCLUDE_DEFAULTS" :key="e" variant="secondary">{{ e }}</Badge>
        </div>
        <div v-if="extraExcludes.length" class="flex flex-wrap items-center gap-1.5 py-1">
          <Badge v-for="e in extraExcludes" :key="e" variant="default">
            {{ e }}
            <button class="ml-1 opacity-70 hover:opacity-100" @click="extraExcludes = extraExcludes.filter((x) => x !== e)">✕</button>
          </Badge>
        </div>
        <div class="flex items-center gap-2 pt-1">
          <Input
            v-model="newExclude"
            placeholder="追加排除目录名，回车确认"
            class="w-64"
            @keydown.enter="(() => { const v = newExclude.trim(); if (v && !extraExcludes.includes(v)) extraExcludes.push(v); newExclude = '' })()"
          />
        </div>
      </div>

      <Separator />

      <div class="flex flex-wrap items-center gap-3">
        <span class="w-20 flex-none text-xs text-muted-foreground">目标盘</span>
        <Input v-model="volumeLabel" placeholder="卷标（如 Backup）" maxlength="32" class="w-48" />
        <select v-model="driveLetter" class="h-7 rounded-md border border-input bg-secondary px-2 text-xs">
          <option value="">备用盘符</option>
          <option v-for="d in drives" :key="d.letter" :value="d.letter">{{ d.letter }} {{ d.label }}</option>
        </select>
        <Badge v-if="targetPresent" variant="success">已接入</Badge>
        <Badge v-else-if="volumeLabel || driveLetter" variant="warning">未接入</Badge>
      </div>
      <div v-if="formErr" class="text-xs text-destructive">{{ formErr }}</div>
      <div><Button :disabled="!name.trim() || mappings.every((m) => !m.from.trim())" @click="saveForm">保存任务</Button></div>
    </Card>

    <!-- 空态引导 -->
    <Card v-if="tasks.length === 0 && !editing" class="border-dashed bg-transparent py-8 text-center shadow-none">
      <div class="text-sm text-muted-foreground">
        <p class="mb-2 font-medium text-foreground">三步开始备份</p>
        <p>① 插入移动硬盘 / U 盘（上方 5 秒内自动检测）</p>
        <p>② 新建任务：指定「源目录 → 目标目录」映射（如 D:\Demo → E:\Demo）</p>
        <p>③ 预览差异 → 确认策略 → 开始备份</p>
      </div>
    </Card>

    <!-- 任务列表 + 预览报告 -->
    <template v-for="t in tasks" :key="t.id">
      <Card class="px-4 py-3">
        <div class="flex items-start gap-4">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-[13px] font-semibold text-foreground">{{ t.name }}</span>
              <Badge :variant="t.mode === 'mirror' ? 'default' : 'secondary'">{{ t.mode === 'mirror' ? '盘符镜像' : '显式映射' }}</Badge>
              <Badge v-if="t.excludeDirs?.length" variant="outline">排除 {{ t.excludeDirs.length }} 项</Badge>
            </div>
            <div class="truncate font-mono text-[11px] text-muted-foreground" :title="mappingText(t)">{{ mappingText(t) }}</div>
            <div class="mt-0.5 flex items-center gap-2">
              <Badge :variant="phaseBadge(stateOf(t.id)).variant">{{ phaseBadge(stateOf(t.id)).text }}</Badge>
              <span class="text-[11px] text-muted-foreground">
                {{ t.lastRunAt ? `上次运行 ${new Date(t.lastRunAt).toLocaleString()}` : '尚未运行' }}
              </span>
            </div>
            <div v-if="previewingId === t.id" class="truncate font-mono text-[10.5px] text-muted-foreground" :title="previewCurrent">
              正在检查：{{ previewCurrent || '…' }}
            </div>
            <div v-else-if="stateOf(t.id)?.current && stateOf(t.id)?.phase === 'running'" class="truncate font-mono text-[10.5px] text-muted-foreground" :title="stateOf(t.id)?.current">
              {{ stateOf(t.id)?.current }}
            </div>
            <!-- v6.2 动效：备份过程可视化流动线 -->
            <BackupFlowLine
              v-if="flowModeOf(t.id)"
              :key="t.id + (flowModeOf(t.id) ?? '')"
              :mode="flowModeOf(t.id)!"
              :source="flowSourceLabel(t.id)"
              :target="flowTargetLabel(t.id)"
              :copied="stateOf(t.id)?.copied ?? 0"
              :bytes="stateOf(t.id)?.bytes ?? 0"
              :scanned="previewingId === t.id ? previewFiles : 0"
              :current="previewingId === t.id ? previewCurrent : (stateOf(t.id)?.current ?? '')"
              :paused="stateOf(t.id)?.phase === 'paused'"
              :celebrate="celebrated.get(t.id) ?? 0"
            />
            <!-- 运行错误详情：常驻可见，可展开 -->
            <div
              v-if="(stateOf(t.id)?.errors?.length ?? 0) > 0 && ['error', 'stopped', 'done', 'paused'].includes(stateOf(t.id)?.phase ?? '')"
              class="mt-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2"
            >
              <button class="flex w-full items-center gap-1 text-left text-[11px] font-medium text-destructive" @click="toggleErrDetail(t.id)">
                <span>{{ errExpanded.has(t.id) ? '▾' : '▸' }} 错误详情 {{ stateOf(t.id)!.errors.length }} 条</span>
              </button>
              <div v-if="errExpanded.has(t.id)" class="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono text-[10.5px] text-muted-foreground">
                <div v-for="(e, i) in stateOf(t.id)!.errors.slice(0, 50)" :key="i" class="break-all" :title="e">{{ e }}</div>
                <div v-if="stateOf(t.id)!.errors.length > 50" class="text-[10px]">…仅显示前 50 条，完整信息见任务日志</div>
              </div>
              <div v-else class="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground" :title="stateOf(t.id)!.errors[0]">{{ stateOf(t.id)!.errors[0] }}</div>
            </div>
          </div>
          <div class="flex flex-none flex-wrap justify-end gap-1.5">
            <Button size="sm" :disabled="previewingId === t.id || busy" @click="doPreview(t.id)">
              {{ previewingId === t.id ? `预览中… ${previewFiles}` : '预览差异' }}
            </Button>
            <Button v-if="previewingId === t.id" variant="ghost" size="sm" @click="cancelPreview(t.id)">取消预览</Button>
            <Button v-if="stateOf(t.id)?.phase === 'running'" variant="secondary" size="sm" :disabled="busy" @click="act(t.id, 'pause')">暂停</Button>
            <Button v-if="stateOf(t.id)?.phase === 'paused'" size="sm" :disabled="busy" @click="act(t.id, 'resume')">续传</Button>
            <Button v-if="['running', 'paused'].includes(stateOf(t.id)?.phase ?? '')" variant="secondary" size="sm" :disabled="busy" @click="act(t.id, 'stop')">停止</Button>
            <Button variant="ghost" size="sm" :disabled="busy" @click="startEdit(t)">编辑</Button>
            <Button variant="ghost" size="sm" class="text-destructive hover:bg-destructive/10 hover:text-destructive" :disabled="busy" @click="act(t.id, 'delete')">删除</Button>
          </div>
        </div>

        <!-- 预览失败：常驻显示（不随 toast 消失） -->
        <div v-if="previewError && preview?.taskId !== t.id" class="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[12px] text-warning">
          预览未完成：{{ previewError }}
          <div class="mt-1 text-[11px] text-muted-foreground">建议：重新插拔目标盘（可能休眠/接触不良）后，再点「预览差异」重试。</div>
        </div>

        <!-- 预览报告 -->
        <div v-if="preview && preview.taskId === t.id" class="mt-3 rounded-lg border border-border bg-secondary/50 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">差异报告</span>
            <span class="text-[10.5px] text-muted-foreground">预览于 {{ new Date(preview.at).toLocaleTimeString() }}</span>
            <span class="ml-auto flex flex-wrap gap-1.5">
              <Badge variant="success">新增 {{ preview.add }}（{{ formatBytes(preview.bytesToAdd) }}）</Badge>
              <Badge variant="warning">更新覆盖 {{ preview.update }}</Badge>
              <Badge variant="destructive">目标多出 {{ preview.deleteExtra }}</Badge>
              <Badge variant="secondary">一致跳过 {{ preview.same }}</Badge>
            </span>
          </div>

          <!-- 采样列表 -->
          <div class="mb-2 flex flex-wrap gap-1.5">
            <Button size="sm" :variant="previewTab === 'add' ? 'default' : 'ghost'" @click="previewTab = 'add'">新增</Button>
            <Button size="sm" :variant="previewTab === 'update' ? 'default' : 'ghost'" @click="previewTab = 'update'">更新</Button>
            <Button size="sm" :variant="previewTab === 'extra' ? 'default' : 'ghost'" @click="previewTab = 'extra'">目标多出</Button>
            <span class="self-center text-[10.5px] text-muted-foreground">
              {{ previewEntries.length ? `采样 ${previewEntries.length} 条` : '本区无条目' }}
            </span>
          </div>
          <div class="max-h-40 overflow-auto rounded-md border border-border bg-panel px-2 py-1">
            <div v-for="(e, i) in previewEntries" :key="i" class="flex items-center gap-2 border-b border-border py-1 font-mono text-[10.5px] text-muted-foreground last:border-b-0">
              <span class="min-w-0 flex-1 truncate" :title="e.path">{{ e.path }}</span>
              <span class="flex-none">{{ formatBytes(e.sizeBytes) }}</span>
            </div>
            <div v-if="!previewEntries.length" class="py-2 text-center text-[11px] text-muted-foreground">无</div>
          </div>

          <!-- 策略确认 -->
          <div class="mt-2 flex flex-wrap items-center gap-3">
            <label class="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <input v-model="deleteExtras" type="checkbox" class="h-3.5 w-3.5 accent-[var(--accent)]" :disabled="preview.deleteExtra === 0" />
              删除目标多出的 {{ preview.deleteExtra }} 个文件（审阅后删除）
            </label>
            <span class="text-[10.5px] text-muted-foreground">更新 = 以源为准单向覆盖（经你确认后执行）</span>
            <Button class="ml-auto" :disabled="busy" @click="execute(t.id)">
              开始备份（新增 {{ preview.add }} · 更新 {{ preview.update }}{{ deleteExtras ? ` · 删除 ${preview.deleteExtra}` : '' }}）
            </Button>
          </div>
          <div v-if="preview.errors.length" class="pt-1.5 text-[10.5px] text-warning">预览警告 {{ preview.errors.length }} 条：{{ preview.errors[0] }}</div>
        </div>
      </Card>
    </template>

    <!-- 定时备份 -->
    <Card class="flex flex-wrap items-center gap-3 px-4 py-3">
      <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">定时自动备份</span>
      <input v-model="schEnabled" type="checkbox" class="h-3.5 w-3.5 accent-[var(--accent)]" @change="saveSchedule" />
      <select v-model.number="schHours" class="h-6 rounded-md border border-input bg-secondary px-2 text-xs" @change="saveSchedule">
        <option :value="12">每 12 小时</option>
        <option :value="24">每 24 小时</option>
        <option :value="72">每 72 小时</option>
        <option :value="168">每 168 小时（每周）</option>
      </select>
      <span class="text-[11px] text-muted-foreground">到期且目标盘在线时自动执行；无人值守安全策略：只新增与更新覆盖，绝不删除</span>
    </Card>

    <!-- 日志 -->
    <Card v-if="log.length" class="px-4 py-3">
      <div class="pb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">任务日志（最近 {{ log.length }} 条）</div>
      <div
        v-for="(e, i) in log.slice(0, 30)"
        :key="i"
        class="break-all py-0.5 font-mono text-[11px] leading-relaxed"
        :class="e.action === 'error' || e.action === 'device-lost' ? 'text-warning' : 'text-muted-foreground'"
      >
        {{ logText(e) }}
      </div>
    </Card>
  </div>
</template>
