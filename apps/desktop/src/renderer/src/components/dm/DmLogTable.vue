<script setup lang="ts">
/**
 * DmLogTable —— 原「日志与队列」页并入映射组后的日志区（唯一实现）。
 * 失败队列由 BackupRunState.errors 聚合；日志表在同一张卡内切换「运行记录 / 实时事件」两个视图，
 * 不再单占一个一级页面，也不新增页内 Tab 分页。
 */
import { computed, ref } from 'vue'
import {
  dmEvents,
  dmPendingItems,
  dmRunRows,
  dmTasks,
  fmtClock,
  fmtTime,
  pushDmToast,
  refreshDm,
  sizeText,
  taskName
} from './dmState'
import type { DmLevel } from './dmState'

const view = ref<'events' | 'runs'>('events')
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
function levelCls(l: string): string {
  return LEVEL_META[l as DmLevel]?.cls ?? 'mute'
}
function levelText(l: string): string {
  return LEVEL_META[l as DmLevel]?.text ?? '信息'
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
  pushDmToast(
    r.ok ? 'info' : 'error',
    '重试本组',
    r.ok ? `${taskName(id)} 已重新下发` : r.error ?? '下发失败'
  )
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
        <h2>运行记录与事件</h2>
        <span class="dm-hint">最近 {{ dmEvents.length }} 条事件 · {{ dmRunRows.length }} 条运行记录</span>
        <div class="dm-right">
          <button class="dm-btn sm" :class="{ ghost: view === 'events' }" @click="view = 'events'">实时事件</button>
          <button class="dm-btn sm" :class="{ ghost: view === 'runs' }" @click="view = 'runs'">运行记录</button>
          <select v-if="view === 'events'" v-model="level" class="dm-select" style="width: 120px">
            <option value="all">全部级别</option>
            <option value="info">信息</option>
            <option value="success">成功</option>
            <option value="warn">警告</option>
            <option value="error">错误</option>
          </select>
          <input
            v-if="view === 'events'"
            v-model="keyword"
            class="dm-input"
            style="width: 200px"
            placeholder="搜索路径或内容"
          />
        </div>
      </div>

      <!-- 运行记录：原仪表盘「最近同步记录」块 -->
      <template v-if="view === 'runs'">
        <div v-if="!dmRunRows.length" class="dm-empty">尚无同步记录</div>
        <table v-else>
          <thead>
            <tr>
              <th>时间</th><th>映射组</th><th>触发方式</th><th>新增</th><th>更新</th>
              <th>删除</th><th>跳过</th><th>失败</th><th>传输量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in dmRunRows" :key="run.id">
              <td class="dm-mono">{{ fmtTime(run.startedAt) }}</td>
              <td>{{ taskName(run.groupId) }}</td>
              <td><span class="dm-badge mute">{{ run.trigger }}</span></td>
              <td>{{ run.added }}</td>
              <td>{{ run.updated === null ? '—' : run.updated }}</td>
              <td>{{ run.deleted === null ? '—' : run.deleted }}</td>
              <td>{{ run.skipped }}</td>
              <td :style="{ color: run.failed ? 'var(--dm-err)' : 'inherit' }">{{ run.failed }}</td>
              <td class="dm-mono">{{ sizeText(run.bytes) }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- 实时事件：原「日志与队列」页事件日志 + 原仪表盘实时事件列表 -->
      <template v-else>
        <div v-if="!filtered.length" class="dm-empty">没有匹配的日志</div>
        <div v-else class="dm-log-scroll">
          <table>
            <thead>
              <tr><th>时间</th><th>级别</th><th>映射组</th><th>类型</th><th>相对路径</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="entry in filtered" :key="entry.id">
                <td class="dm-mono">{{ fmtClock(entry.ts) }}</td>
                <td><span class="dm-badge" :class="levelCls(entry.level)">{{ levelText(entry.level) }}</span></td>
                <td>{{ groupLabel(entry.groupId) }}</td>
                <td class="dm-mono">{{ entry.kind }}</td>
                <td class="dm-mono dm-ellipsis" :title="entry.path">{{ entry.path || '—' }}</td>
                <td>{{ entry.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div class="dm-hint-text" style="margin-top: 10px">
        共 {{ dmTasks.length }} 个映射组 · 日志来源：备份运行日志 + 清理审计记录
      </div>
    </div>
  </div>
</template>
