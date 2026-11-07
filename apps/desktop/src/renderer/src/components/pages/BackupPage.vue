<script setup lang="ts">
/**
 * v5.3 N1 备份同步独立页：开发文件夹 → 移动硬盘增量备份。
 * 语义：只增不改不删（目标端同名文件绝不覆盖，不同则记冲突跳过）。
 * 设备语义：拔盘自动暂停、插回自动续传（主进程 5s 探活）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { BackupDriveInfo, BackupLogEntry, BackupRunState, BackupTask } from '@shared/types'

const tasks = ref<BackupTask[]>([])
const drives = ref<BackupDriveInfo[]>([])
const states = ref<Record<string, BackupRunState>>({})
const log = ref<BackupLogEntry[]>([])
const toast = ref('')
const busy = ref(false)

// ── 新建/编辑表单 ──
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

function phaseText(st: BackupRunState | null): string {
  if (!st) return '未运行'
  if (st.phase === 'running') return `备份中 · ${st.copied} 新增 / ${st.skipped} 跳过 / ${st.conflicts} 冲突`
  if (st.phase === 'paused') return st.reason === 'device-lost' ? '已暂停（目标盘已拔出，插回自动续传）' : '已暂停（手动）'
  if (st.phase === 'done') return `完成 · 新增 ${st.copied} 个 / ${formatBytes(st.bytes)} · 冲突 ${st.conflicts}`
  if (st.phase === 'stopped') return `已停止 · 已拷贝 ${st.copied} 个`
  return `错误 · ${st.errors[0] ?? '未知'}`
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
  const labels: Record<string, string> = {
    run: '开始',
    pause: '暂停',
    resume: '续传',
    stop: '停止',
    done: '完成',
    error: '错误',
    'device-lost': '拔盘',
    'device-back': '插回'
  }
  return `${hh} [${labels[e.action] ?? e.action}] ${e.detail}`
}

onMounted(load)
onBeforeUnmount(() => unsub())
</script>

<template>
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">备份同步</span>
      <span class="dim">开发文件夹 → 移动硬盘 · 增量只增不改不删 · 拔盘暂停插回续传</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">目标设备</span>
      <span class="pg-stat-val mono" :style="{ color: targetPresent || !editing ? 'var(--accent)' : 'var(--danger)' }">
        {{ removable.length === 0 ? '未检测到可移动磁盘' : removable.map((d) => `${d.letter} ${d.label || '未命名'}（剩 ${formatBytes(d.freeBytes)}）`).join(' · ') }}
      </span>
      <span class="dim" style="font-size: 11px">按卷标识别目标盘；同一任务换 USB 口不影响识别</span>
    </div>

    <div class="pg-actions">
      <button class="primary" @click="startCreate">新建任务</button>
      <button v-if="editing" class="ghost" @click="editing = false">取消编辑</button>
      <span class="pg-toast">{{ toast }}</span>
    </div>

    <!-- 新建 / 编辑表单 -->
    <div v-if="editing" class="pg-list" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 10px">
      <div style="display: flex; align-items: center; gap: 10px">
        <span class="dim" style="width: 64px">任务名</span>
        <input v-model="name" class="pg-input" placeholder="如：dev-workspace" maxlength="60" />
      </div>
      <div style="display: flex; align-items: flex-start; gap: 10px">
        <span class="dim" style="width: 64px; padding-top: 6px">源目录</span>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px">
          <div v-for="(s, i) in sources" :key="s" class="bk-src-row">
            <span class="mono" :title="s">{{ s }}</span>
            <button class="ghost" @click="sources.splice(i, 1)">移除</button>
          </div>
          <button class="ghost" style="align-self: flex-start" @click="addSource">＋ 添加目录…</button>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 10px">
        <span class="dim" style="width: 64px">目标卷标</span>
        <input v-model="volumeLabel" class="pg-input" placeholder="移动硬盘的卷标（如 Backup）" maxlength="32" />
        <select v-model="driveLetter" class="pg-input" style="width: 90px">
          <option value="">备用盘符</option>
          <option v-for="d in drives" :key="d.letter" :value="d.letter">{{ d.letter }}</option>
        </select>
      </div>
      <div v-if="formErr" class="pg-err">{{ formErr }}</div>
      <div class="pg-actions">
        <button class="primary" :disabled="!name.trim() || sources.length === 0" @click="saveForm">保存</button>
      </div>
      <span class="dim pg-foot">备份到「目标盘根目录 / 任务名 / 源目录相对路径」。目标端已有文件一律不覆盖：相同则跳过，不同记冲突。</span>
    </div>

    <!-- 任务列表 -->
    <div v-if="tasks.length === 0 && !editing" class="pg-empty">还没有备份任务 —— 点「新建任务」选择源目录与目标盘</div>
    <div v-else class="pg-list" style="padding: 8px 12px">
      <div v-for="t in tasks" :key="t.id" class="bk-task">
        <div class="bk-task-main">
          <div style="display: flex; align-items: baseline; gap: 8px">
            <span style="font-weight: 500">{{ t.name }}</span>
            <span class="dim" style="font-size: 11px">→ 卷标「{{ t.volumeLabel || t.driveLetter }}」 · {{ t.sources.length }} 个源目录</span>
          </div>
          <div class="mono dim bk-srcs" :title="t.sources.join('\n')">{{ t.sources.join('  ·  ') }}</div>
          <div class="bk-state" :class="stateOf(t.id)?.phase" style="font-size: 12px">{{ phaseText(stateOf(t.id)) }}</div>
          <div v-if="stateOf(t.id)?.current && stateOf(t.id)?.phase === 'running'" class="mono dim" style="font-size: 10.5px">{{ stateOf(t.id)?.current }}</div>
          <span class="dim" style="font-size: 11px">
            {{ t.lastRunAt ? `上次运行 ${new Date(t.lastRunAt).toLocaleString()}` : '尚未运行' }}
          </span>
        </div>
        <div class="bk-task-ops">
          <button v-if="!stateOf(t.id) || ['done', 'stopped', 'error'].includes(stateOf(t.id)!.phase)" class="primary" :disabled="busy" @click="act(t.id, 'run')">运行</button>
          <button v-if="stateOf(t.id)?.phase === 'running'" class="ghost" :disabled="busy" @click="act(t.id, 'pause')">暂停</button>
          <button v-if="stateOf(t.id)?.phase === 'paused'" class="primary" :disabled="busy" @click="act(t.id, 'resume')">续传</button>
          <button v-if="['running', 'paused'].includes(stateOf(t.id)?.phase ?? '')" class="ghost" :disabled="busy" @click="act(t.id, 'stop')">停止</button>
          <button class="ghost" :disabled="busy" @click="startEdit(t)">编辑</button>
          <button class="ghost risk" :disabled="busy" @click="act(t.id, 'delete')">删除</button>
        </div>
      </div>
    </div>

    <!-- 任务日志 -->
    <div v-if="log.length" class="pg-list" style="padding: 10px 14px">
      <div class="pg-stat-label" style="margin-bottom: 6px">任务日志（最近 {{ log.length }} 条）</div>
      <div v-for="(e, i) in log.slice(0, 30)" :key="i" class="bk-log mono" :class="{ warn: e.action === 'error' || e.action === 'device-lost' }">{{ logText(e) }}</div>
    </div>
  </div>
</template>

<style scoped>
.bk-task {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 4px;
}
.bk-task + .bk-task {
  border-top: 1px solid var(--border-hair);
}
.bk-task-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.bk-srcs {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bk-state {
  color: var(--text-2);
}
.bk-state.running {
  color: var(--accent);
}
.bk-state.paused {
  color: var(--warning);
}
.bk-state.error {
  color: var(--danger);
}
.bk-task-ops {
  display: flex;
  gap: 6px;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.bk-src-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}
.bk-src-row .mono {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bk-log {
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.8;
  word-break: break-all;
}
.bk-log.warn {
  color: var(--warning);
}
button.risk {
  color: var(--danger);
}
.pg-input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}
.pg-input:focus {
  border-color: var(--accent);
}
select.pg-input {
  flex: none;
}
</style>
