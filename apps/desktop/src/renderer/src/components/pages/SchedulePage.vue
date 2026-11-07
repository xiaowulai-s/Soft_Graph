<script setup lang="ts">
/**
 * v5.2 定时调度独立页：开关 / 周期 / 空闲窗口 / 上次执行状态（两段式）。
 */
import { onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { AppSettings } from '@shared/types'

const enabled = ref(false)
const intervalHours = ref(168)
const idleOnly = ref(true)
const last = ref<{ lastRunAt: number; lastCleaned: number; lastFreedBytes: number } | null>(null)
const running = ref(false)
const runText = ref('')

function fmtWhen(ts: number): string {
  if (!ts) return '尚未运行'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function load(): Promise<void> {
  try {
    const s: AppSettings = await window.api.getSettings()
    enabled.value = s.junkSchedule?.enabled ?? false
    intervalHours.value = s.junkSchedule?.intervalHours ?? 168
    idleOnly.value = s.junkSchedule?.idleOnly !== false
  } catch {
    /* 保留默认 */
  }
  try {
    last.value = await window.api.junkScheduleInfo()
  } catch {
    last.value = null
  }
}

async function patch(): Promise<void> {
  await window.api.setSettings({
    junkSchedule: { enabled: enabled.value, intervalHours: intervalHours.value, idleOnly: idleOnly.value }
  } as never)
  await load()
}

async function runNow(): Promise<void> {
  running.value = true
  runText.value = ''
  try {
    const r = await window.api.junkScheduleRun()
    runText.value = r.cleaned > 0 ? `已清理 ${r.cleaned} 项，释放 ${formatBytes(r.freedBytes)}` : '没有需要清理的项目'
    await load()
  } catch (e) {
    runText.value = `执行失败：${(e as Error).message}`
  } finally {
    running.value = false
    setTimeout(() => (runText.value = ''), 5000)
  }
}

onMounted(load)
</script>

<template>
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">定时调度</span>
      <span class="dim">静默清理计划 —— 到期且空闲时自动隔离清理，可还原</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">状态总览</span>
      <span class="pg-stat-val mono" :style="{ color: enabled ? 'var(--accent)' : 'var(--text-3)' }">
        {{ enabled ? '已启用' : '未启用' }} · 每 {{ intervalHours }} 小时
      </span>
      <span class="dim" style="font-size: 11px">
        上次执行：{{ fmtWhen(last?.lastRunAt ?? 0) }}{{ last?.lastCleaned ? ` · 清理 ${last.lastCleaned} 项 / ${formatBytes(last.lastFreedBytes)}` : '' }}
      </span>
    </div>

    <div class="pg-list" style="padding: 12px 16px; gap: 12px; display: flex; flex-direction: column">
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer">
        <input v-model="enabled" type="checkbox" @change="patch" />
        <span style="font-size: 13px; color: var(--text)">启用定时静默清理（自动隔离，可在隔离区还原）</span>
      </label>
      <div style="display: flex; align-items: center; gap: 10px">
        <span style="font-size: 12px; color: var(--text-2); flex: none">执行周期</span>
        <select v-model.number="intervalHours" :disabled="!enabled" style="width: 160px" @change="patch">
          <option :value="24">每天</option>
          <option :value="72">每 3 天</option>
          <option :value="168">每周</option>
          <option :value="336">每两周</option>
          <option :value="720">每月</option>
        </select>
      </div>
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer">
        <input v-model="idleOnly" type="checkbox" :disabled="!enabled" @change="patch" />
        <span style="font-size: 12px; color: var(--text-2)">仅空闲时执行（系统无输入 ≥15 分钟，不满足自动顺延）</span>
      </label>
    </div>

    <div class="pg-actions">
      <button class="primary" :disabled="running" @click="runNow">{{ running ? '执行中…' : '立即执行一次' }}</button>
    </div>
    <div v-if="runText" class="pg-toast">{{ runText }}</div>
  </div>
</template>

<style scoped>
@import './page.css';
</style>
