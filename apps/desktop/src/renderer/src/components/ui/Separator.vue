/** shadcn-vue Separator —— 水平/垂直发丝分隔 */
<script setup lang="ts">
import { cn } from '@renderer/lib/utils'
const props = defineProps<{ class?: string; orientation?: 'horizontal' | 'vertical' }>()
</script>

<template>
  <div
    role="separator"
    :class="
      cn(
        'shrink-0 bg-border',
        orientation === 'vertical' ? 'w-px self-stretch' : 'h-px w-full',
        props.class
      )
    "
  />
</template>
