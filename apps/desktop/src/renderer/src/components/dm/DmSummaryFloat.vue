<script setup lang="ts">
/**
 * DmSummaryFloat —— 同步完成汇总浮层（右下角，与右上 toast 栈错开）。
 * 仅在窗口可见时由 dmState 触发；4.5 秒后自动淡出，也可手动关闭。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { dismissSummary, dmSummary, isVivid } from './dmMotion'
import DmNum from './DmNum.vue'

const visible = ref(false)
let timer: number | undefined

watch(dmSummary, (s) => {
  if (!s) {
    visible.value = false
    return
  }
  visible.value = true
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    visible.value = false
    dismissSummary()
  }, 4500)
})

const duration = computed(() => {
  const s = dmSummary.value
  if (!s?.startedAt) return '—'
  const sec = Math.max(0, Math.round(((s.finishedAt ?? Date.now()) - s.startedAt) / 1000))
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
})

onBeforeUnmount(() => {
  if (timer) window.clearTimeout(timer)
})
</script>

<template>
  <Transition name="dm-summary">
    <div
      v-if="visible && dmSummary"
      class="dm-summary-float"
      :class="{ vivid: isVivid, 'has-failed': dmSummary.failed > 0 }"
      role="status"
    >
      <div class="dm-summary-head">
        <span class="dm-summary-check">✓</span>
        <strong>同步完成</strong>
        <span class="dm-hint-text dm-ellipsis">{{ dmSummary.name }}</span>
        <button class="dm-summary-close" title="关闭" @click="dismissSummary">×</button>
      </div>
      <div class="dm-summary-grid">
        <div><label>拷贝</label><b><DmNum :value="dmSummary.copied" /></b></div>
        <div><label>写入</label><b><DmNum :value="dmSummary.bytes" format="bytes" /></b></div>
        <div><label>耗时</label><b>{{ duration }}</b></div>
        <div>
          <label>失败</label>
          <b :style="{ color: dmSummary.failed ? 'var(--dm-err)' : 'inherit' }">{{ dmSummary.failed }}</b>
        </div>
      </div>
      <div class="dm-summary-bar"><span /></div>
    </div>
  </Transition>
</template>
