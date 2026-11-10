<script setup lang="ts">
/**
 * DmScheduleBox —— 备份定时调度区（唯一实现，分钟制）。
 * 原设置页「同步参数」里的备份间隔迁入此处；底层仍是 AppSettings.backupSchedule.intervalHours，
 * 允许小数（0.5 = 30 分钟），主进程 backupTick 用 intervalHours * 3600_000 判到期，天然支持。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { dmSettings, pushDmToast, refreshDm } from './dmState'

const PRESETS: { label: string; minutes: number }[] = [
  { label: '15 分钟', minutes: 15 },
  { label: '30 分钟', minutes: 30 },
  { label: '1 小时', minutes: 60 },
  { label: '6 小时', minutes: 360 },
  { label: '每天', minutes: 1440 }
]

const enabled = ref(false)
const minutes = ref(30)
const busy = ref(false)
const message = ref('')

function syncFromSettings(): void {
  const sch = dmSettings.value?.backupSchedule
  enabled.value = !!sch?.enabled
  const raw = Number(sch?.intervalHours ?? 0.5)
  minutes.value = raw > 0 ? Math.round(raw * 60) : 30
}
syncFromSettings()
watch(dmSettings, syncFromSettings)
// 挂载时主动读一次真实配置，避免依赖 10 秒轮询导致外部写入后显示滞后
onMounted(() => {
  void window.api
    .getSettings()
    .then((s) => {
      dmSettings.value = s
    })
    .catch(() => {})
})

const currentText = computed(() => {
  if (!enabled.value) return '当前：未启用自动备份'
  return `当前：每 ${minutes.value >= 60 && minutes.value % 60 === 0 ? `${minutes.value / 60} 小时` : `${minutes.value} 分钟`} 自动同步一次`
})

function pick(min: number): void {
  minutes.value = min
}

async function save(): Promise<void> {
  if (busy.value) return
  const m = Math.max(15, Math.round(Number(minutes.value) || 30))
  busy.value = true
  try {
    const next = await window.api.setSettings({
      backupSchedule: { enabled: enabled.value, intervalHours: m / 60 }
    })
    dmSettings.value = next
    minutes.value = m
    await refreshDm()
    message.value = enabled.value
      ? `已启用：每 ${m} 分钟自动同步一次`
      : '已关闭自动备份'
    pushDmToast('success', '调度已保存', message.value)
    window.setTimeout(() => {
      message.value = ''
    }, 4000)
  } catch (e) {
    message.value = `保存失败：${(e as Error).message}`
    pushDmToast('error', '调度保存失败', (e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dm-card dm-panel dm-schedule-box">
    <div class="dm-panel-head">
      <h2>定时自动备份</h2>
      <span class="dm-hint">目标盘在线且无手动任务活动时自动执行（只增改不删）</span>
    </div>
    <div class="dm-field" style="max-width: 320px">
      <label>自动备份</label>
      <label class="dm-switch" style="margin-top: 6px">
        <input v-model="enabled" type="checkbox" />
        <span class="dm-switch-track" />
        <span>{{ currentText }}</span>
      </label>
    </div>
    <div class="dm-field" style="margin-top: 14px">
      <label>间隔（分钟，最小 15）</label>
      <div class="dm-inline" style="flex-wrap: wrap">
        <input v-model.number="minutes" class="dm-input" type="number" min="15" step="15" style="max-width: 110px" />
        <button
          v-for="p in PRESETS"
          :key="p.minutes"
          class="dm-btn sm"
          :class="{ ghost: minutes === p.minutes }"
          @click="pick(p.minutes)"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="dm-hint-text" style="margin-top: 8px">
        调度器每 15 分钟检查一次是否到期；应用启动 90 秒后会做首次检查。
        每轮为全量扫描（约数分钟），间隔越短磁盘占用越高。
      </div>
    </div>
    <div class="dm-inline" style="margin-top: 16px">
      <button class="dm-btn primary" :disabled="busy" @click="save">保存调度</button>
      <span class="dm-hint-text" :style="{ color: message.includes('失败') ? 'var(--dm-err)' : 'var(--dm-ok)' }">
        {{ message }}
      </span>
    </div>
  </div>
</template>
