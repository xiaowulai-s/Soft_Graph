<script setup lang="ts">
/**
 * DmGroups —— 「备份同步」页（统一卡片流：不设分区标题、不切 Tab）。
 * ①任务区：编辑器（默认折叠）+ 组卡片 + 已接入磁盘
 * ②活动区：同步进度精简条 + 各组状态 + 定时自动备份调度
 * ③日志区：失败队列 + 「运行记录 / 实时事件」两视图
 * 原「日志与队列」页与「完整备份页」的重复实现已收敛到 components/dm/ 公共组件。
 */
import { ref } from 'vue'
import type { BackupRunState, BackupTask } from '@shared/types'
import DmTaskEditor from './DmTaskEditor.vue'
import DmTaskCard from './DmTaskCard.vue'
import DmDriveTable from './DmDriveTable.vue'
import DmLogTable from './DmLogTable.vue'
import DmScheduleBox from './DmScheduleBox.vue'
import DmTopology from './DmTopology.vue'
import {
  dmActiveStates,
  dmPreviewTotals,
  dmTasks,
  elapsedText,
  fmtTime,
  groupStatus,
  prepareSync,
  pushDmToast,
  refreshDm,
  taskName,
  taskTarget
} from './dmState'
import DmNum from './DmNum.vue'
import { isVivid, motionAutoCalm, motionMode, setMotionMode } from './dmMotion'

defineEmits<{ navigate: [view: string] }>()

const editorOpen = ref(false)
const editingTask = ref<BackupTask | null>(null)
const message = ref('')

function openNew(): void {
  editingTask.value = null
  editorOpen.value = true
  message.value = ''
}
function openEdit(task: BackupTask): void {
  editingTask.value = task
  editorOpen.value = true
  message.value = ''
}

async function remove(task: BackupTask): Promise<void> {
  const r = await window.api.backupDeleteTask(String(task.id))
  const text = r.ok ? '映射组已删除' : `删除失败：${r.error ?? '未知错误'}`
  message.value = text
  pushDmToast(r.ok ? 'success' : 'error', '删除映射组', text)
  await refreshDm()
  window.setTimeout(() => {
    message.value = ''
  }, 4000)
}

async function act(op: 'run' | 'pause' | 'resume' | 'preview', task: BackupTask): Promise<void> {
  const id = String(task.id)
  if (op === 'run') {
    await prepareSync([id])
    await refreshDm()
    return
  }
  if (op === 'preview') {
    await prepareSync([id], { checkOnly: true })
    await refreshDm()
    return
  }
  let r: { ok: boolean; error?: string } = { ok: false }
  if (op === 'pause') r = await window.api.backupPause(id)
  else if (op === 'resume') r = await window.api.backupResume(id)
  const text = r.ok ? '操作已下发' : `操作失败：${r.error ?? '未知错误'}`
  message.value = text
  pushDmToast(r.ok ? 'info' : 'error', '映射组操作', text)
  await refreshDm()
  window.setTimeout(() => {
    message.value = ''
  }, 4000)
}

async function openTarget(path: string): Promise<void> {
  if (path && !path.includes('未解析')) await window.api.reveal({ path })
}

function percent(st: BackupRunState): number {
  const total = dmPreviewTotals.value[st.taskId] ?? 0
  if (!total) return 0
  return Math.min(100, Math.round(((st.copied + st.skipped) / total) * 100))
}
function hasTotal(st: BackupRunState): boolean {
  return (dmPreviewTotals.value[st.taskId] ?? 0) > 0
}
</script>

<template>
  <div class="dm-groups-page">
    <!-- ① 任务区 -->
    <section class="dm-zone">
      <div class="dm-card dm-panel">
        <div class="dm-panel-head">
          <h2>映射组（{{ dmTasks.length }}）</h2>
          <span class="dm-hint">源 → 目标均为绝对路径</span>
          <div class="dm-right">
            <button class="dm-btn sm" @click="refreshDm()">刷新磁盘</button>
            <button class="dm-btn primary sm" @click="openNew">新增映射组</button>
          </div>
        </div>

        <DmTaskEditor
          :open="editorOpen"
          :task="editingTask"
          @close="editorOpen = false"
          @saved="editorOpen = false"
        />

        <div v-if="!dmTasks.length" class="dm-empty">
          <span class="dm-empty-strong">还没有配置任何同步关系</span>
          点击「新增映射组」，分别选择本机源文件夹和移动硬盘上的目标文件夹即可开始。
        </div>
        <DmTaskCard
          v-for="task in dmTasks"
          :key="task.id"
          :task="task"
          @edit="openEdit"
          @act="act"
          @remove="remove"
          @open-target="openTarget"
        />
        <div v-if="message" class="dm-hint-text" style="margin-top: 12px">{{ message }}</div>
      </div>
      <DmDriveTable />
    </section>

    <!-- ② 活动区 -->
    <section class="dm-zone">
      <div class="dm-card dm-panel">
        <div class="dm-panel-head">
          <h2>当前同步活动</h2>
          <span class="dm-hint">{{ dmActiveStates.length }} 组进行中 · 实时刷新</span>
          <div class="dm-right dm-motion-switch">
            <span class="dm-hint-text">动效</span>
            <button class="dm-btn sm" :class="{ ghost: motionMode === 'vivid' }" @click="setMotionMode('vivid')">生动</button>
            <button class="dm-btn sm" :class="{ ghost: motionMode === 'calm' }" @click="setMotionMode('calm')">克制</button>
            <span v-if="motionAutoCalm" class="dm-hint-text">已自动降档</span>
          </div>
        </div>
        <div v-if="!dmActiveStates.length" class="dm-hint-text">当前没有进行中的同步任务</div>
        <div v-for="st in dmActiveStates" :key="st.taskId" class="dm-activity dm-activity-compact">
          <div class="dm-activity-head">
            <span class="dm-group-name">{{ taskName(st.taskId) }}</span>
            <span class="dm-badge" :class="st.phase === 'running' ? 'ok' : 'warn'">
              {{ hasTotal(st) ? '传输中' : '扫描中' }}
            </span>
            <span class="dm-activity-pct">{{ hasTotal(st) ? `${percent(st)}%` : '—' }}</span>
          </div>
          <div class="dm-progress-track" :class="{ indeterminate: !hasTotal(st), vivid: isVivid }">
            <div class="dm-progress-fill" :style="{ width: `${percent(st)}%` }" />
          </div>
          <div class="dm-hint-text" style="margin-top: 8px">
            <DmNum :value="st.copied" /> / {{ dmPreviewTotals[st.taskId] ?? '—' }} 个 · <DmNum :value="st.bytes" format="bytes" /> ·
            已用 {{ elapsedText(st.startedAt) }} ·
            <span :key="st.current" class="dm-mono dm-current-file" :title="st.current">{{ st.current || '准备中…' }}</span>
          </div>
          <div class="dm-hint-text dm-mono" :title="taskTarget(dmTasks.find((t) => t.id === st.taskId) ?? ({} as never))">
            {{ taskTarget(dmTasks.find((t) => t.id === st.taskId) ?? ({} as never)) }}
          </div>
        </div>

        <!-- 各组状态精简条：原仪表盘「各组状态」块 -->
        <div class="dm-divider" />
        <div class="dm-status-strip">
          <div v-for="task in dmTasks" :key="task.id" class="dm-status-item">
            <span class="dm-group-name">{{ task.name }}</span>
            <span class="dm-badge" :class="groupStatus(task.id).cls">
              <span class="dm-badge-dot" />{{ groupStatus(task.id).text }}
            </span>
            <span class="dm-hint-text dm-mono">{{ taskTarget(task) }}</span>
            <span class="dm-hint-text">最近 {{ fmtTime(task.lastRunAt) }}</span>
          </div>
          <div v-if="!dmTasks.length" class="dm-hint-text">暂无映射组</div>
        </div>
      </div>
      <div class="dm-card dm-panel">
        <div class="dm-panel-head">
          <h2>同步拓扑</h2>
          <span class="dm-hint">源文件夹 ↔ 移动硬盘（按序列号）</span>
        </div>
        <DmTopology v-if="dmTasks.length" />
        <div v-else class="dm-empty">添加映射组后显示拓扑</div>
      </div>
      <DmScheduleBox />
    </section>

    <!-- ③ 日志区 -->
    <section class="dm-zone">
      <DmLogTable />
    </section>
  </div>
</template>
