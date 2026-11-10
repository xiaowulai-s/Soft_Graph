<script setup lang="ts">
/**
 * DmTaskEditor —— 映射组编辑器（唯一实现）。
 * 由 DmGroups 复用；原 DmGroups 内联表单与 BackupPage 的编辑表单均已废弃。
 * 铁律 3：IPC 传参一律展开成纯对象，禁带 Vue reactive Proxy。
 */
import { ref, watch } from 'vue'
import type { BackupDriveInfo, BackupTask } from '@shared/types'
import { dmDrives, dmTasks, pushDmToast, refreshDm, sizeText } from './dmState'

const props = defineProps<{ open: boolean; task: BackupTask | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

interface Draft {
  id: string
  name: string
  mode: 'explicit' | 'mirror'
  from: string
  to: string
  volumeLabel: string
  driveLetter: string
  excludeText: string
}

function blank(): Draft {
  return {
    id: '',
    name: '新映射组',
    mode: 'explicit',
    from: '',
    to: '',
    volumeLabel: '',
    driveLetter: '',
    excludeText: ''
  }
}

function fromTask(task: BackupTask): Draft {
  return {
    id: String(task.id),
    name: String(task.name),
    mode: task.mode === 'mirror' ? 'mirror' : 'explicit',
    from: String(task.mappings?.[0]?.from ?? ''),
    to: String(task.mappings?.[0]?.to ?? ''),
    volumeLabel: String(task.volumeLabel ?? ''),
    driveLetter: String(task.driveLetter ?? ''),
    excludeText: (task.excludeDirs ?? []).join('\n')
  }
}

const draft = ref<Draft>(blank())
const message = ref('')
const messageError = ref(false)
const busy = ref(false)

watch(
  () => [props.open, props.task] as const,
  ([open, task]) => {
    if (!open) return
    draft.value = task ? fromTask(task) : blank()
    message.value = ''
    void refreshDm()
  },
  { immediate: true }
)

function note(text: string, error = false): void {
  message.value = text
  messageError.value = error
  window.setTimeout(() => {
    message.value = ''
  }, 4000)
}

function isAbs(value: string): boolean {
  const v = value.trim()
  return /^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v)
}

async function pickSrc(): Promise<void> {
  const picked = await window.api.pickDir()
  if (picked) draft.value.from = picked
}

async function pickTarget(): Promise<void> {
  const picked = await window.api.pickDir()
  if (!picked) return
  draft.value.to = picked
  await bindDiskForTarget(picked)
}

async function bindDiskForTarget(targetPath: string): Promise<void> {
  await refreshDm()
  const m = targetPath.trim().match(/^([A-Za-z]):/)
  if (!m) {
    note('目标不是本地磁盘绝对路径，请重新选择', true)
    return
  }
  const disk = dmDrives.value.find(
    (d) => d.letter.replace(/:$/, '').toUpperCase() === m[1].toUpperCase()
  )
  if (!disk) {
    note(`未读到 ${m[1]}: 的磁盘信息，请在下方手动点选磁盘`, true)
    return
  }
  chooseDisk(disk)
}

function chooseDisk(disk: BackupDriveInfo): void {
  draft.value.volumeLabel = String(disk.label ?? '')
  draft.value.driveLetter = String(disk.letter ?? '').replace(/:$/, '')
  note(`已绑定 ${disk.letter} 的卷标与盘符`)
}

async function save(): Promise<void> {
  const d = draft.value
  const from = d.from.trim()
  const to = d.to.trim()
  if (!from || !isAbs(from)) return note('请填写源文件夹的绝对路径', true)
  if (d.mode === 'explicit' && (!to || !isAbs(to))) return note('请填写目标文件夹的绝对路径', true)
  if (d.mode === 'explicit' && from.toUpperCase() === to.toUpperCase())
    return note('源目录与目标目录不能相同', true)
  if (!d.volumeLabel.trim() && !d.driveLetter.trim())
    return note('请选择目标移动硬盘（选目标文件夹时会自动绑定）', true)

  const original = dmTasks.value.find((t) => t.id === d.id)
  // 保留原有除首映射外的其它映射（本页只展示首条，不丢数据）
  const rest = original
    ? original.mappings.slice(1).map((m) => ({ from: String(m.from), to: String(m.to ?? '') }))
    : []
  const mappings = [{ from, to: d.mode === 'mirror' ? '' : to }, ...rest]

  busy.value = true
  try {
    const r = await window.api.backupSaveTask({
      task: {
        id: d.id || undefined,
        name: d.name.trim() || '未命名映射组',
        mode: d.mode,
        mappings,
        excludeDirs: d.excludeText
          .split('\n')
          .map((s) => String(s).trim())
          .filter(Boolean),
        volumeLabel: d.volumeLabel.trim(),
        driveLetter: d.driveLetter.trim() || undefined
      }
    })
    if (!r.ok) return note(`保存失败：${r.error ?? '未知错误'}`, true)
    note(d.id ? '映射组已更新' : '映射组已添加')
    pushDmToast('success', d.id ? '映射组已更新' : '映射组已添加', d.name)
    await refreshDm()
    emit('saved')
    emit('close')
  } catch (e) {
    note(`保存异常：${(e as Error).message}`, true)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="open" class="dm-card dm-panel dm-task-editor">
    <div class="dm-panel-head">
      <h2>{{ draft.id ? '编辑映射组' : '新增映射组' }}</h2>
      <span class="dm-hint">源目录与目标目录均使用绝对路径</span>
      <div class="dm-right">
        <button class="dm-btn sm" @click="emit('close')">取消</button>
        <button class="dm-btn primary sm" :disabled="busy" @click="save">保存</button>
      </div>
    </div>
    <div class="dm-form-grid">
      <div class="dm-field">
        <label>名称</label>
        <input v-model="draft.name" class="dm-input" placeholder="例如：项目资料" />
      </div>
      <div class="dm-field">
        <label>同步模式</label>
        <select v-model="draft.mode" class="dm-select">
          <option value="explicit">显式映射（源 → 目标）</option>
          <option value="mirror">盘符镜像（按目标盘符落盘）</option>
        </select>
      </div>
      <div class="dm-field full">
        <label>源文件夹（本机绝对路径）</label>
        <div class="dm-inline">
          <input v-model="draft.from" class="dm-input dm-mono" placeholder="D:\Work\Project" />
          <button class="dm-btn" @click="pickSrc">浏览…</button>
        </div>
      </div>
      <div class="dm-field full">
        <label>目标文件夹（移动硬盘上的绝对路径）</label>
        <div class="dm-inline">
          <input
            v-model="draft.to"
            class="dm-input dm-mono"
            placeholder="G:\Backup\Project"
            :disabled="draft.mode === 'mirror'"
          />
          <button class="dm-btn" :disabled="draft.mode === 'mirror'" @click="pickTarget">浏览…</button>
        </div>
        <div class="dm-hint-text">
          选择后自动绑定该盘卷标与盘符；日后盘符变化时按卷标自动适配，无需改配置。
        </div>
      </div>
      <div class="dm-field full">
        <label>设备识别（卷标 / 盘符）</label>
        <div class="dm-inline">
          <button class="dm-btn sm" @click="refreshDm()">刷新已接入磁盘</button>
          <button
            v-for="disk in dmDrives"
            :key="disk.letter"
            class="dm-btn sm"
            :class="{ ghost: draft.driveLetter && draft.driveLetter === disk.letter.replace(/:$/, '') }"
            @click="chooseDisk(disk)"
          >
            {{ disk.letter }} · {{ disk.label || '无卷标' }} · {{ sizeText(disk.totalBytes) }}
          </button>
        </div>
        <div class="dm-inline">
          <input v-model="draft.volumeLabel" class="dm-input dm-mono" placeholder="卷标" />
          <input
            v-model="draft.driveLetter"
            class="dm-input dm-mono"
            style="max-width: 90px"
            placeholder="盘符"
          />
        </div>
        <div class="dm-hint-text">
          卷标用于识别「这块盘在不在」，不参与路径拼接；卷标不可读时可只用盘符。
        </div>
      </div>
      <div class="dm-field full">
        <label>排除目录（每行一个目录名）</label>
        <textarea
          v-model="draft.excludeText"
          class="dm-textarea dm-mono"
          placeholder="node_modules&#10;.git&#10;temp"
        />
        <div class="dm-hint-text">在默认排除基础上追加；大文件与损坏目录会在执行阶段单独跳过。</div>
      </div>
    </div>
    <div
      v-if="message"
      class="dm-hint-text"
      :style="{ color: messageError ? 'var(--dm-err)' : 'var(--dm-ok)', marginTop: '12px' }"
    >
      {{ message }}
    </div>
  </div>
</template>
