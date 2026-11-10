<script setup lang="ts">
/**
 * DmLogs —— DiskMirror「日志与队列」页像素级复刻。
 * 失败队列由 BackupRunState.errors 聚合（SoftGraph 无 pending 实体）；
 * 事件日志 = 备份日志 + 清理审计日志聚合，级别与关键字筛选保留原交互。
 */
import { computed, ref } from 'vue'
import {
  dmEvents,
  dmPendingItems,
  dmTasks,
  fmtTime,
  pushDmToast,
  refreshDm,
  taskName
} from './dmState'
import type { DmLevel } from './dmState'

const keyword = ref('')
const level = ref<'all' | DmLevel>('all')
const busy = ref(false)

const LEVEL_META: Record<DmLevel, { text: string; cls: string }> = {
  info: { text: '信息', cls: 'mute' },
  success: { text: '成功', cls: 'ok' },
  warn: { text: '警告', cls: 'warn' },
  error: { text: '错误', cls: 'err' }
}

const filtered = computed(() =>
  dmEvents.value.filter((entry) => {
    if (level.value !== 'all' && entry.level !== level.value) return false
    if (!keyword.value.trim()) return true
    const needle = keyword.value.trim().toLowerCase()
    return `${entry.path} ${entry.message} ${entry.kind}`.toLowerCase().includes(needle)
  })
)

function groupLabel(id: string): string {
  return id === '清理审计' ? id : taskName(id)
}

async function retryAll(): Promise<void> {
  if (busy.value) return
  const ids = [...new Set(dmPendingItems.value.map((p) => p.groupId))]
  if (!ids.length) return
  busy.value = true
  let ok = 0
  try {
    for (const id of ids) {
      try {
        const r = await window.api.backupRun(id, { deleteExtras: false, requireFreshPreview: false })
        if (r.ok) ok++
      } catch {
        /* 单组失败不阻断其它组 */
      }
    }
    pushDmToast(ok ? 'info' : 'warn', '立即重试全部', `已重新下发 ${ok} / ${ids.length} 组`)
    await refreshDm()
  } finally {
    busy.value = false
  }
}

async function retryOne(id: string): Promise<void> {
  const r = await window.api.backupRun(id, { deleteExtras: false, requireFreshPreview: false })
  pushDmToast(r.ok ? 'info' : 'error', '重试本组', r.ok ? `${taskName(id)} 已重新下发` : r.error ?? '下发失败')
  await refreshDm()
}
</script>

<template>
  <div class="dm-stack">
    <div class="dm-card dm-panel">
      <div class="dm-panel-head">
        <h2>失败队列（{{ dmPendingItems.length }}）</h2>
        <span class="dm-hint">一般失败自动退避重试，严重失败会暂停该组</span>
        <div class="dm-right">
          <button class="dm-btn sm primary" :disabled="!dmPendingItems.length || busy" @click="retryAll">
            立即重试全部
          </button>
        </div>
      </div>
      <div v-if="!dmPendingItems.length" class="dm-empty">队列为空，没有待重试的文件</div>
      <table v-else>
        <thead>
          <tr><th>映射组</th><th>相对路径</th><th>操作</th><th>重试次数</th><th>原因</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="item in dmPendingItems" :key="item.id">
            <td>{{ taskName(item.groupId) }}</td>
            <td class="dm-mono dm-ellipsis" :title="item.relPath">{{ item.relPath }}</td>
            <td><span class="dm-badge mute">{{ item.op }}</span></td>
            <td>{{ item.attempts }}</td>
            <td class="dm-ellipsis" :title="item.reason">{{ item.reason }}</td>
            <td><button class="dm-btn sm" @click="retryOne(item.groupId)">重试本组</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="dm-card dm-panel">
      <div class="dm-panel-head">
        <h2>事件日志（最近 {{ dmEvents.length }} 条）</h2>
        <div class="dm-right">
          <select v-model="level" class="dm-select" style="width: 120px">
            <option value="all">全部级别</option>
            <option value="info">信息</option>
            <option value="success">成功</option>
            <option value="warn">警告</option>
            <option value="error">错误</option>
          </select>
          <input v-model="keyword" class="dm-input" style="width: 200px" placeholder="搜索路径或内容" />
        </div>
      </div>
      <div v-if="!filtered.length" class="dm-empty">没有匹配的日志</div>
      <div v-else class="dm-log-scroll">
        <table>
          <thead>
            <tr><th>时间</th><th>级别</th><th>映射组</th><th>类型</th><th>相对路径</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="entry in filtered" :key="entry.id">
              <td class="dm-mono">{{ fmtTime(entry.ts) }}</td>
              <td>
                <span class="dm-badge" :class="LEVEL_META[entry.level].cls">{{ LEVEL_META[entry.level].text }}</span>
              </td>
              <td>{{ groupLabel(entry.groupId) }}</td>
              <td class="dm-mono">{{ entry.kind }}</td>
              <td class="dm-mono dm-ellipsis" :title="entry.path">{{ entry.path || '—' }}</td>
              <td>{{ entry.message }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="dm-hint-text" style="margin-top: 10px">
        共 {{ dmTasks.length }} 个映射组 · 日志来源：备份运行日志 + 清理审计记录
      </div>
    </div>
  </div>
</template>
