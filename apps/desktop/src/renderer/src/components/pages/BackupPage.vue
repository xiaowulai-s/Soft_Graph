<script setup lang="ts">
/**
 * v6.1 备份同步（shadcn-vue 样板页）：开发文件夹 → 移动硬盘增量备份。
 * 语义：只增不改不删；拔盘自动暂停、插回自动续传（主进程 5s 探活）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { BackupDriveInfo, BackupLogEntry, BackupRunState, BackupTask } from '@shared/types'
import { Badge, Button, Card, Input, Separator } from '@renderer/components/ui'

const tasks = ref<BackupTask[]>([])
const drives = ref<BackupDriveInfo[]>([])
const states = ref<Record<string, BackupRunState>>({})
const log = ref<BackupLogEntry[]>([])
const toast = ref('')
const busy = ref(false)

const editing = ref(false)
const editId = ref('')
const name = ref('')
const sources = ref<string[]>([])
const volumeLabel = ref('')
const driveLetter = ref('')
const formErr = ref('')

const removable = computed(() => drives.value.filter((d) => d.driveType === 2 || d.driveType === 3))
const targetPresent = computed(() => {
  const vl = volumeLabel.value.trim()
  return drives.value.some((d) => (vl && d.label.toLowerCase() === vl.toLowerCase()) || d.letter.toLowerCase() === driveLetter.value.toLowerCase())
})

let toastTimer: ReturnType<typeof setTimeout> | null = null
function say(msg: string): void {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 4000)
}

async function load(): Promise<void> {
  try {
    ;[tasks.value, drives.value, states.value, log.value] = await Promise.all([
      window.api.backupTasks(),
      window.api.backupDrives(),
      window.api.backupState(),
      window.api.backupLog()
    ])
  } catch (e) {
    say(`加载失败：${(e as Error).message}`)
  }
}

const unsub = window.api.onBackupProgress((s) => {
  states.value = { ...states.value, [s.taskId]: s }
  if (s.phase === 'done' || s.phase === 'stopped' || s.phase === 'error') void load()
})

function stateOf(id: string): BackupRunState | null {
  return states.value[id] ?? null
}

function phaseBadge(st: BackupRunState | null): { text: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' } {
  if (!st) return { text: '未运行', variant: 'secondary' }
  if (st.phase === 'running') return { text: `备份中 · ${st.copied} 新增 / ${st.skipped} 跳过 / ${st.conflicts} 冲突`, variant: 'default' }
  if (st.phase === 'paused') return { text: st.reason === 'device-lost' ? '已暂停（目标盘已拔出，插回自动续传）' : '已暂停（手动）', variant: 'warning' }
  if (st.phase === 'done') return { text: `完成 · 新增 ${st.copied} 个 / ${formatBytes(st.bytes)} · 冲突 ${st.conflicts}`, variant: 'success' }
  if (st.phase === 'stopped') return { text: `已停止 · 已拷贝 ${st.copied} 个`, variant: 'secondary' }
  return { text: `错误 · ${st.errors[0] ?? '未知'}`, variant: 'destructive' }
}

async function act(id: string, op: 'run' | 'pause' | 'resume' | 'stop' | 'delete'): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    let r: { ok: boolean; error?: string }
    if (op === 'delete') r = await window.api.backupDeleteTask(id)
    else if (op === 'run') r = await window.api.backupRun(id)
    else if (op === 'pause') r = await window.api.backupPause(id)
    else if (op === 'resume') r = await window.api.backupResume(id)
    else r = await window.api.backupStop(id)
    if (!r.ok) say(r.error ?? '操作失败')
    await load()
  } finally {
    busy.value = false
  }
}

function startCreate(): void {
  editing.value = true
  editId.value = ''
  name.value = ''
  sources.value = []
  volumeLabel.value = ''
  driveLetter.value = ''
  formErr.value = ''
}

function startEdit(t: BackupTask): void {
  editing.value = true
  editId.value = t.id
  name.value = t.name
  sources.value = [...t.sources]
  volumeLabel.value = t.volumeLabel
  driveLetter.value = t.driveLetter ?? ''
  formErr.value = ''
}

async function addSource(): Promise<void> {
  const dir = await window.api.pickDir()
  if (!dir) return
  if (sources.value.some((s) => s.toLowerCase() === dir.toLowerCase())) return
  sources.value.push(dir)
}

async function saveForm(): Promise<void> {
  formErr.value = ''
  const r = await window.api.backupSaveTask({
    task: { id: editId.value || undefined, name: name.value.trim(), sources: sources.value.slice(), volumeLabel: volumeLabel.value.trim(), driveLetter: driveLetter.value || undefined }
  })
  if (!r.ok) {
    formErr.value = r.error ?? '保存失败'
    return
  }
  editing.value = false
  say(editId.value ? '任务已更新' : '任务已创建')
  await load()
}

function logText(e: BackupLogEntry): string {
  const d = new Date(e.ts)
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const labels: Record<string, string> = { run: '开始', pause: '暂停', resume: '续传', stop: '停止', done: '完成', error: '错误', 'device-lost': '拔盘', 'device-back': '插回' }
  return `${hh} [${labels[e.action] ?? e.action}] ${e.detail}`
}

onMounted(load)
onBeforeUnmount(() => unsub())
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-8 pb-10 pt-7">
    <!-- 页头 -->
    <div class="flex flex-col gap-0.5 pb-1">
      <h2 class="text-[19px] font-semibold tracking-tight text-foreground">备份同步</h2>
      <span class="text-[12.5px] text-muted-foreground">开发文件夹 → 移动硬盘 · 增量只增不改不删 · 拔盘暂停插回续传</span>
    </div>

    <!-- 目标设备状态条 -->
    <Card class="flex items-center gap-3 px-4 py-3">
      <span class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">目标设备</span>
      <Badge v-if="removable.length === 0" variant="warning">未检测到可移动磁盘</Badge>
      <span v-else class="font-mono text-xs text-foreground">
        {{ removable.map((d) => `${d.letter} ${d.label || '未命名'}（剩 ${formatBytes(d.freeBytes)}）`).join(' · ') }}
      </span>
      <span class="ml-auto text-[11px] text-muted-foreground">按卷标识别目标盘；同一任务换 USB 口不影响识别</span>
    </Card>

    <!-- 操作条 -->
    <div class="flex items-center gap-2.5">
      <Button @click="startCreate">新建任务</Button>
      <Button v-if="editing" variant="ghost" @click="editing = false">取消编辑</Button>
      <span v-if="toast" class="text-xs text-primary">{{ toast }}</span>
    </div>

    <!-- 新建 / 编辑表单 -->
    <Card v-if="editing" class="flex flex-col gap-3 p-4">
      <div class="flex items-center gap-3">
        <span class="w-16 flex-none text-xs text-muted-foreground">任务名</span>
        <Input v-model="name" placeholder="如：dev-workspace" maxlength="60" class="flex-1" />
      </div>
      <div class="flex items-start gap-3">
        <span class="w-16 flex-none pt-1.5 text-xs text-muted-foreground">源目录</span>
        <div class="flex flex-1 flex-col gap-1">
          <div v-for="(s, i) in sources" :key="s" class="flex items-center gap-2 text-[11.5px]">
            <span class="flex-1 truncate font-mono text-muted-foreground" :title="s">{{ s }}</span>
            <Button variant="ghost" size="sm" @click="sources.splice(i, 1)">移除</Button>
          </div>
          <Button variant="outline" size="sm" class="self-start" @click="addSource">＋ 添加目录…</Button>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="w-16 flex-none text-xs text-muted-foreground">目标卷标</span>
        <Input v-model="volumeLabel" placeholder="移动硬盘的卷标（如 Backup）" maxlength="32" class="flex-1" />
        <select v-model="driveLetter" class="h-7 flex-none rounded-md border border-input bg-secondary px-2 text-xs text-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25">
          <option value="">备用盘符</option>
          <option v-for="d in drives" :key="d.letter" :value="d.letter">{{ d.letter }}</option>
        </select>
      </div>
      <div v-if="formErr" class="text-xs text-destructive">{{ formErr }}</div>
      <div class="flex items-center gap-2.5">
        <Button :disabled="!name.trim() || sources.length === 0" @click="saveForm">保存</Button>
      </div>
      <Separator />
      <span class="text-[11px] text-muted-foreground">
        备份到「目标盘根目录 / 任务名 / 源目录相对路径」。目标端已有文件一律不覆盖：相同则跳过，不同记冲突。
      </span>
    </Card>

    <!-- 任务列表 -->
    <Card v-if="tasks.length === 0 && !editing" class="border-dashed bg-transparent py-8 text-center text-muted-foreground shadow-none">
      还没有备份任务 —— 点「新建任务」选择源目录与目标盘
    </Card>
    <Card v-else-if="tasks.length" class="px-3 py-1.5">
      <div v-for="t in tasks" :key="t.id" class="flex items-start gap-4 py-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex items-baseline gap-2.5">
            <span class="text-[13px] font-medium text-foreground">{{ t.name }}</span>
            <span class="text-[11px] text-muted-foreground">→ 卷标「{{ t.volumeLabel || t.driveLetter }}」 · {{ t.sources.length }} 个源目录</span>
          </div>
          <div class="truncate font-mono text-[11px] text-muted-foreground" :title="t.sources.join('\n')">{{ t.sources.join(' · ') }}</div>
          <div class="mt-0.5 flex items-center gap-2">
            <Badge :variant="phaseBadge(stateOf(t.id)).variant">{{ phaseBadge(stateOf(t.id)).text }}</Badge>
          </div>
          <div v-if="stateOf(t.id)?.current && stateOf(t.id)?.phase === 'running'" class="truncate font-mono text-[10.5px] text-muted-foreground">
            {{ stateOf(t.id)?.current }}
          </div>
          <span class="text-[11px] text-muted-foreground">
            {{ t.lastRunAt ? `上次运行 ${new Date(t.lastRunAt).toLocaleString()}` : '尚未运行' }}
          </span>
        </div>
        <div class="flex flex-none flex-wrap justify-end gap-1.5">
          <Button
            v-if="!stateOf(t.id) || ['done', 'stopped', 'error'].includes(stateOf(t.id)!.phase)"
            size="sm"
            :disabled="busy"
            @click="act(t.id, 'run')"
          >
            运行
          </Button>
          <Button v-if="stateOf(t.id)?.phase === 'running'" variant="secondary" size="sm" :disabled="busy" @click="act(t.id, 'pause')">暂停</Button>
          <Button v-if="stateOf(t.id)?.phase === 'paused'" size="sm" :disabled="busy" @click="act(t.id, 'resume')">续传</Button>
          <Button v-if="['running', 'paused'].includes(stateOf(t.id)?.phase ?? '')" variant="secondary" size="sm" :disabled="busy" @click="act(t.id, 'stop')">停止</Button>
          <Button variant="ghost" size="sm" :disabled="busy" @click="startEdit(t)">编辑</Button>
          <Button variant="ghost" size="sm" class="text-destructive hover:bg-destructive/10 hover:text-destructive" :disabled="busy" @click="act(t.id, 'delete')">删除</Button>
        </div>
      </div>
    </Card>

    <!-- 任务日志 -->
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
