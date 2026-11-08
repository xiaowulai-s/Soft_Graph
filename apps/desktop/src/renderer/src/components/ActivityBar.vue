<script setup lang="ts">
/**
 * v6.1 侧栏（Tailwind + shadcn 视觉）：图标 + 文本常显（190px），按域分组，可折叠 54px。
 * 条目由 nav.ts 注册表驱动，统一 SVG 线性图标。
 */
import { ref } from 'vue'
import { NAV_GROUPS, NAV_MODULES, navIconSvg } from '@shared/nav'
import { cn } from '@renderer/lib/utils'

const model = defineModel<string>({ required: true })

const collapsed = ref(false)
const ICONS = Object.fromEntries(NAV_MODULES.map((m) => [m.id, navIconSvg(m.icon)]))
</script>

<template>
  <nav
    :class="
      cn(
        'flex flex-col gap-px overflow-y-auto overflow-x-hidden border-r border-border bg-side transition-[width] duration-150',
        collapsed ? 'w-[54px] items-center px-1.5 py-3.5' : 'w-[190px] px-3 py-3.5'
      )
    "
  >
    <div :class="cn('flex items-center gap-2', collapsed ? 'justify-center pb-3.5' : 'px-2 pb-3.5')">
      <span
        class="flex size-6 flex-none items-center justify-center rounded-[7px] bg-gradient-to-br from-teal-400 to-primary text-[12px] text-white shadow-sm dark:text-[#04241e]"
      >
        ◆
      </span>
      <span v-if="!collapsed" class="text-[13px] font-semibold tracking-tight text-foreground">SoftGraph</span>
    </div>

    <template v-for="g in NAV_GROUPS" :key="g.key">
      <div
        v-if="!collapsed"
        class="select-none px-2.5 pb-1 pt-3.5 text-[10.5px] font-medium uppercase tracking-[1.4px] text-muted-foreground/80"
      >
        {{ g.title }}
      </div>
      <div v-else class="mx-auto my-2 h-px w-6 bg-border-soft" />

      <button
        v-for="m in NAV_MODULES.filter((x) => x.group === g.key)"
        :key="m.id"
        :title="collapsed ? `${m.title} — ${m.desc}` : m.desc"
        :class="
          cn(
            'flex h-[30px] w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-2.5 text-left text-[12.5px] transition-colors duration-100',
            collapsed && 'justify-center px-0',
            model === m.id
              ? 'bg-accent-soft font-medium text-primary'
              : 'text-muted-foreground hover:bg-hover hover:text-foreground'
          )
        "
        @click="model = m.id"
      >
        <span class="flex flex-none items-center justify-center [&>svg]:block" :class="model === m.id ? 'text-primary' : 'text-muted-foreground/80'" v-html="ICONS[m.id]" />
        <span v-if="!collapsed" class="truncate">{{ m.title }}</span>
      </button>
    </template>

    <span class="flex-1" />
    <button
      :title="collapsed ? '展开侧栏' : '折叠侧栏'"
      :class="
        cn(
          'flex h-[30px] w-full items-center gap-2.5 rounded-lg border-none bg-transparent text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
          collapsed ? 'justify-center px-0' : 'px-2.5'
        )
      "
      @click="collapsed = !collapsed"
    >
      <span class="text-[14px] leading-none transition-transform" :class="collapsed && 'rotate-180'">‹</span>
      <span v-if="!collapsed" class="text-[12.5px]">折叠</span>
    </button>
  </nav>
</template>
