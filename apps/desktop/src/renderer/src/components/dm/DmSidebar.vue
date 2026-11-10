<script setup lang="ts">
/**
 * DmSidebar —— DiskMirror 侧栏（224px 深青渐变）复刻。
 * v6.2.3：13 个入口平铺成一个列表，不再分「主 Tab / 工具」两组；
 * 按功能域排序，设置固定最末。
 */
import { computed } from 'vue'
import {
  DM_NAV,
  dmPendingItems,
  dmReadyCount,
  dmTasks,
  dmVersion
} from './dmState'

const props = defineProps<{ view: string }>()
const emit = defineEmits<{ navigate: [view: string] }>()

const pendingCount = computed(() => dmPendingItems.value.length)
</script>

<template>
  <aside class="dm-sidebar">
    <div class="dm-brand">
      <div class="dm-brand-mark">SG</div>
      <div>
        <div class="dm-brand-name">SoftGraph</div>
        <div class="dm-brand-sub">软件图谱与磁盘清理</div>
      </div>
    </div>

    <div class="dm-nav-scroll">
      <nav class="dm-nav dm-nav-flat">
        <button
          v-for="item in DM_NAV"
          :key="item.key"
          class="dm-nav-item"
          :class="{ active: props.view === item.key }"
          :title="item.hint"
          @click="emit('navigate', item.key)"
        >
          <span class="dm-nav-dot" />
          <span>{{ item.label }}</span>
          <span v-if="item.key === 'dm-groups' && pendingCount" class="dm-nav-count">{{ pendingCount }}</span>
        </button>
      </nav>
    </div>

    <div class="dm-sidebar-foot">
      <div class="dm-foot-pill"><span class="dm-live-dot" /> 后台守护运行中</div>
      <div class="dm-foot-line">
        版本 {{ dmVersion }}<br />
        就绪 {{ dmReadyCount }} / {{ dmTasks.length }} 组<br />
        配置与清单存于本机
      </div>
    </div>
  </aside>
</template>
