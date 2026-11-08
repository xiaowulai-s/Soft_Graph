/**
 * shadcn-vue Button —— cva 变体（default / secondary / ghost / outline / destructive / link）
 * 尺寸：sm / default / lg / icon。视觉基于主题令牌（--accent 等），浅深主题自适应。
 */
<script setup lang="ts">
import { cn } from '@renderer/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'
import { computed, useAttrs } from 'vue'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-xs font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:translate-y-0 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110 hover:-translate-y-px hover:shadow-md',
        secondary: 'bg-secondary text-secondary-foreground border border-border hover:bg-accent',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:brightness-110',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-7 px-3',
        sm: 'h-6 rounded-[5px] px-2.5 text-[11px]',
        lg: 'h-9 px-5 text-[13px]',
        icon: 'h-7 w-7'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

type Variants = VariantProps<typeof buttonVariants>

const props = defineProps<{ variant?: Variants['variant']; size?: Variants['size']; class?: string; disabled?: boolean }>()
const attrs = useAttrs()
const delegated = computed(() => {
  const { class: _, disabled: __, ...rest } = attrs as Record<string, unknown>
  return rest
})
</script>

<template>
  <button :class="cn(buttonVariants({ variant, size }), props.class)" :disabled="disabled" v-bind="delegated">
    <slot />
  </button>
</template>
