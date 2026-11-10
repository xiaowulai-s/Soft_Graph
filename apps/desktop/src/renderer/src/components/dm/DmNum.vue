<script setup lang="ts">
/**
 * DmNum —— 数字缓动显示。两档都保留（克制档按方案仍保留数字滚动），
 * 仅在自动降级（掉帧 / 后台 / 空闲）时直接显示终值，避免额外开销。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { formatBytes } from '@shared/util'
import { motionAutoCalm } from './dmMotion'

const props = withDefaults(
  defineProps<{ value: number; format?: 'int' | 'bytes'; duration?: number }>(),
  { format: 'int', duration: 560 }
)

const shown = ref(props.value)
let raf = 0

function render(v: number): string {
  return props.format === 'bytes' ? formatBytes(v, 1) : Math.round(v).toLocaleString('zh-CN')
}

function animate(from: number, to: number): void {
  if (raf) window.cancelAnimationFrame(raf)
  if (motionAutoCalm.value || from === to) {
    shown.value = to
    return
  }
  const start = performance.now()
  const tick = (t: number): void => {
    const p = Math.min(1, (t - start) / props.duration)
    const eased = 1 - Math.pow(1 - p, 3)
    shown.value = from + (to - from) * eased
    if (p < 1) raf = window.requestAnimationFrame(tick)
    else shown.value = to
  }
  raf = window.requestAnimationFrame(tick)
}

watch(
  () => props.value,
  (to, from) => animate(from ?? 0, to)
)
onBeforeUnmount(() => {
  if (raf) window.cancelAnimationFrame(raf)
})
</script>

<template>
  <span class="dm-num" :title="String(value)">{{ render(shown) }}</span>
</template>
