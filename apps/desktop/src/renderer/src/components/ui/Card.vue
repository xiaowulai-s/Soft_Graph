/** shadcn-vue Card 家族：白底发丝边 + 轻阴影 + 悬停微升（hoverable 变体） */
<script setup lang="ts">
import { cn } from '@renderer/lib/utils'
const props = defineProps<{ class?: string; hoverable?: boolean }>()
</script>

<template>
  <div
    :class="
      cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        hoverable && 'transition-all duration-150 hover:-translate-y-px hover:shadow-md',
        props.class
      )
    "
  >
    <slot />
  </div>
</template>
