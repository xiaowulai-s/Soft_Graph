<script setup lang="ts">
/**
 * v5.2 装机清单独立页：软件总表 + CSV / winget 脚本导出。
 */
import { onMounted, ref } from 'vue'
import type { SoftwareItem } from '@shared/types'
import { formatBytes } from '@shared/util'

const items = ref<SoftwareItem[]>([])
const loading = ref(true)
const toast = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    items.value = await window.api.listSoftware()
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

async function exportAs(fmt: 'csv' | 'ps1'): Promise<void> {
  const r = await window.api.exportManifest({ format: fmt })
  toast.value = r.ok ? `已导出：${r.path}` : `导出失败：${r.error ?? '已取消'}`
  setTimeout(() => (toast.value = ''), 4000)
}

onMounted(load)
</script>

<template>
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">装机清单</span>
      <span class="dim">换机 / 重装场景：导出软件表或 winget 批量安装脚本</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">状态总览</span>
      <span class="pg-stat-val mono">
        {{ items.length }} 个软件 · 便携 {{ items.filter((x) => x.source === 'portable').length }} 个 · 总占用
        {{ formatBytes(items.reduce((n, x) => n + x.sizeBytes, 0)) }}
      </span>
    </div>

    <div class="pg-actions">
      <button class="primary" @click="exportAs('csv')">⬇ 导出 CSV</button>
      <button @click="exportAs('ps1')">⬇ 导出 winget 脚本 (.ps1)</button>
      <button class="ghost" :disabled="loading" @click="load">刷新</button>
    </div>
    <div v-if="toast" class="pg-toast">{{ toast }}</div>

    <div v-if="loading" class="pg-wait">加载软件库…</div>
    <div v-else class="pg-list">
      <div class="lhead">
        <span style="flex: 2">软件</span>
        <span style="flex: 1">版本</span>
        <span style="flex: 1">发布者</span>
        <span style="width: 70px">大小</span>
        <span style="width: 60px">类型</span>
      </div>
      <div v-for="i in items" :key="i.id" class="lrow">
        <span style="flex: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="i.name">{{ i.name }}</span>
        <span class="mono" style="flex: 1; color: var(--text-3)">{{ i.version || '—' }}</span>
        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3)">{{ i.publisher || '—' }}</span>
        <span class="mono" style="width: 70px; color: var(--text-3)">{{ formatBytes(i.sizeBytes) }}</span>
        <span style="width: 60px">
          <span class="badge">{{ i.source === 'portable' ? '便携' : '安装' }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import './page.css';
.lhead,
.lrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  font-size: 12px;
}
.lhead {
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--panel);
}
.lrow {
  border-bottom: 1px solid var(--border-hair);
  color: var(--text);
}
</style>
