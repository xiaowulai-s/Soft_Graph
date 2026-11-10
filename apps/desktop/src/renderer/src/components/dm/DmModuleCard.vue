<script setup lang="ts">
/** DmModuleCard —— 总仪表盘的模块概览卡（全站统一卡片格式，无分节标题）。 */
interface Metric {
  label: string
  value: string | number
}
defineProps<{
  title: string
  status: string
  tone?: 'ok' | 'warn' | 'mute'
  target: string
  metrics: Metric[]
  scanLabel?: string
}>()
const emit = defineEmits<{ navigate: [view: string]; scan: [] }>()
</script>

<template>
  <div class="dm-card dm-module-card">
    <div class="dm-module-head">
      <strong>{{ title }}</strong>
      <span class="dm-badge" :class="tone ?? 'mute'">{{ status }}</span>
    </div>
    <div class="dm-module-metrics">
      <div v-for="m in metrics" :key="m.label">
        <label>{{ m.label }}</label>
        <b>{{ m.value }}</b>
      </div>
    </div>
    <div class="dm-module-foot">
      <button v-if="scanLabel" class="dm-btn sm" @click="emit('scan')">{{ scanLabel }}</button>
      <button class="dm-btn sm primary" @click="emit('navigate', target)">打开</button>
    </div>
  </div>
</template>
