<script setup lang="ts">
/**
 * DmFlowLayer —— 拓扑连线上的抽象粒子流。
 * 粒子不与真实文件一一对应（方案里的「混合」口径：真实路径另在活动区显示），
 * 每条活跃连线最多 6 个、全局上限 24 个；仅在 vivid 档且有任务运行中时出现。
 * 用 SVG SMIL animateMotion，不占 JS 帧，克制档整层不渲染。
 */
import { computed } from 'vue'

interface FlowLink {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  active: boolean
}

const props = defineProps<{ links: FlowLink[]; running: boolean; vivid: boolean }>()

const perLink = computed(() => {
  const active = props.links.filter((l) => l.active).length || 1
  return Math.max(1, Math.min(6, Math.floor(24 / active)))
})

const particles = computed(() => {
  if (!props.running || !props.vivid) return []
  const out: { key: string; path: string; begin: string; r: number }[] = []
  for (const l of props.links) {
    if (!l.active) continue
    for (let i = 0; i < perLink.value; i++) {
      out.push({
        key: `${l.key}-${i}`,
        path: `M ${l.x1.toFixed(1)} ${l.y1.toFixed(1)} L ${l.x2.toFixed(1)} ${l.y2.toFixed(1)}`,
        begin: `${(i * 0.62).toFixed(2)}s`,
        r: i % 3 === 0 ? 3.2 : 2.2
      })
    }
  }
  return out.slice(0, 24)
})
</script>

<template>
  <g v-if="particles.length" class="dm-flow-layer" aria-hidden="true">
    <circle
      v-for="p in particles"
      :key="p.key"
      :r="p.r"
      class="dm-flow-particle"
      fill="#22d3ee"
    >
      <animateMotion :path="p.path" dur="1.9s" :begin="p.begin" repeatCount="indefinite" />
    </circle>
  </g>
</template>
