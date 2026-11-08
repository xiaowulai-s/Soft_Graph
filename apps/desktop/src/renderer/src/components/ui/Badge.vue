/** shadcn-vue Badge —— default / secondary / outline / success / warning / destructive */
<script setup lang="ts">
import { cn } from '@renderer/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium w-fit whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-muted-foreground',
        success: 'border-transparent bg-success/12 text-success',
        warning: 'border-transparent bg-warning/12 text-warning',
        destructive: 'border-transparent bg-destructive/12 text-destructive'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

type Variants = VariantProps<typeof badgeVariants>
const props = defineProps<{ variant?: Variants['variant']; class?: string }>()
</script>

<template>
  <span :class="cn(badgeVariants({ variant }), props.class)">
    <slot />
  </span>
</template>
