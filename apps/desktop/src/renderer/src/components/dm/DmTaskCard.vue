<script setup lang="ts">
/** DmTaskCard —— 映射组卡片（唯一实现），动作由父页统一调用 prepareSync / IPC。 */
import type { BackupTask } from '@shared/types'
import { dmRunStates, fmtTime, groupStatus, taskSource, taskTarget } from './dmState'
import { isVivid } from './dmMotion'

defineProps<{ task: BackupTask }>()
const emit = defineEmits<{
  edit: [task: BackupTask]
  act: [op: 'run' | 'pause' | 'resume' | 'preview', task: BackupTask]
  remove: [task: BackupTask]
  'open-target': [path: string]
}>()
</script>

<template>
  <div class="dm-card dm-group-card" :class="{ 'is-running': dmRunStates[task.id]?.phase === 'running', vivid: isVivid }">
    <div class="dm-group-top">
      <span class="dm-group-name">{{ task.name }}</span>
      <span class="dm-badge" :class="groupStatus(task.id).cls">
        <span class="dm-badge-dot" />{{ groupStatus(task.id).text }}
      </span>
      <div class="dm-group-actions">
        <button class="dm-btn sm" @click="emit('edit', task)">编辑</button>
        <button class="dm-btn sm" title="暂停该组" @click="emit('act', 'pause', task)">停用</button>
        <button class="dm-btn sm danger" @click="emit('remove', task)">删除</button>
      </div>
    </div>
    <div class="dm-group-meta">
      源 <span class="dm-mono">{{ taskSource(task) }}</span><br />
      目标 <span class="dm-mono">{{ taskTarget(task) }}</span><br />
      设备 <span class="dm-mono">{{ task.volumeLabel || '—' }} · {{ task.driveLetter || '自动' }}</span><br />
      排除 {{ task.excludeDirs?.length ?? 0 }} 条规则 ·
      {{ dmRunStates[task.id]?.phase || '尚未同步' }} ·
      {{ fmtTime(task.lastRunAt) }}
      <template v-if="dmRunStates[task.id]?.reason"><br /><span style="color: var(--dm-warn)">{{ dmRunStates[task.id]?.reason }}</span></template>
    </div>
    <div class="dm-row-actions" style="margin-top: 12px">
      <button class="dm-btn sm ghost" @click="emit('act', 'run', task)">立即同步</button>
      <button class="dm-btn sm" @click="emit('act', 'pause', task)">暂停</button>
      <button class="dm-btn sm" @click="emit('act', 'resume', task)">恢复</button>
      <button class="dm-btn sm" @click="emit('act', 'preview', task)">预览差异</button>
      <button class="dm-btn sm" @click="emit('act', 'run', task)">重试失败项</button>
      <button class="dm-btn sm" @click="emit('open-target', taskTarget(task))">打开目标位置</button>
    </div>
  </div>
</template>
