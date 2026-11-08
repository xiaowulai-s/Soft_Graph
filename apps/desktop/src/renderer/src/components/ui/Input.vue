/** shadcn-vue Input —— defineModel 标准实现（v-model 单双向、attrs、class 均正确） */
<script setup lang="ts">
import { cn } from '@renderer/lib/utils'
import { useAttrs } from 'vue'

const props = defineProps<{ class?: string }>()
const model = defineModel<string | number>()
const attrs = useAttrs()

defineOptions({ inheritAttrs: false })
</script>

<template>
  <input
    v-model="model"
    :class="
      cn(
        'flex h-7 w-full rounded-md border border-input bg-secondary px-3 py-1 text-xs text-foreground transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:border-primary disabled:opacity-45',
        props.class
      )
    "
    v-bind="attrs"
  >
</template>
