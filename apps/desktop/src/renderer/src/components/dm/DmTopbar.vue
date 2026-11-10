<script setup lang="ts">
/**
 * DmTopbar —— DiskMirror 68px 顶栏复刻。
 * 主 Tab：标题/副标题 + 状态徽标；「深度校验」「立即同步」只在仪表盘显示。
 * 工具页：同一个顶栏，标题换成功能名与描述。
 */
import { computed, ref } from 'vue'
import { NAV_MODULES } from '@renderer/nav'
import {
  DM_TABS,
  dmActiveStates,
  dmBusyCount,
  dmProgressSummary,
  dmTasks,
  isDmTab,
  prepareSync,
  pushDmToast,
} from './dmState'
import DmNum from './DmNum.vue'
import { isVivid } from './dmMotion'

const props = defineProps<{ view: string }>()
const emit = defineEmits<{ navigate: [view: string] }>()

const mainTab = computed(() => DM_TABS.find((t) => t.key === props.view))
const tool = computed(() => NAV_MODULES.find((m) => m.id === props.view))
const title = computed(() => mainTab.value?.label ?? tool.value?.title ?? '仪表盘')
const sub = computed(() => mainTab.value?.hint ?? tool.value?.desc ?? '')

const busy = ref(false)

async function deepCheck(): Promise<void> {
  if (busy.value) return
  const tasks = dmTasks.value
  if (!tasks.length) {
    pushDmToast('warn', '深度校验', '还没有任何映射组，请先到「映射组」新增')
    emit('navigate', 'dm-groups')
    return
  }
  busy.value = true
  try {
    await prepareSync(tasks.map((t) => t.id), { checkOnly: true })
  } finally {
    busy.value = false
  }
}

async function syncNow(): Promise<void> {
  if (busy.value) return
  const tasks = dmTasks.value
  if (!tasks.length) {
    pushDmToast('warn', '未开始同步', '还没有任何映射组，请先到「映射组」新增')
    emit('navigate', 'dm-groups')
    return
  }
  busy.value = true
  try {
    await prepareSync(tasks.map((t) => t.id))
  } finally {
    busy.value = false
  }
}

</script>

<template>
  <header class="dm-topbar" :class="{ vivid: isVivid }">
    <div>
      <h1>{{ title }}</h1>
      <div class="dm-sub">{{ sub }}<template v-if="isDmTab(props.view)"> · 同步中 <DmNum :value="dmBusyCount" /> 组</template></div>
    </div>
    <div class="dm-topbar-actions">
      <template v-if="isDmTab(props.view)">
        <span class="dm-badge dm-live-badge" :class="[dmBusyCount ? 'warn' : 'ok', { 'is-live': dmActiveStates.length }]">
          <span class="dm-badge-dot" />{{ dmActiveStates.length ? '正在同步' : '运行中' }}
        </span>
        <span v-if="dmProgressSummary" class="dm-badge">
          <span class="dm-badge-dot" />{{ dmProgressSummary }}
        </span>
        <template v-if="props.view === 'dm-dashboard'">
          <button class="dm-btn" :disabled="busy" @click="deepCheck">深度校验</button>
          <button class="dm-btn primary" :disabled="busy" @click="syncNow">立即同步</button>
        </template>
      </template>
    </div>
  </header>
</template>
