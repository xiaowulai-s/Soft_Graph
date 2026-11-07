<script setup lang="ts">
/**
 * v5.2 注册表残留独立页：状态总览 + 死条目扫描与删除。
 * 安全约束：只允许删除卸载表内的键；HKCU 直删、HKLM 弹 UAC。
 */
import { onMounted, ref } from 'vue'
import type { RegistryLeftover } from '@shared/types'

const items = ref<RegistryLeftover[] | null>(null)
const busyKey = ref('')
const errText = ref('')
const toast = ref('')

async function load(): Promise<void> {
  errText.value = ''
  try {
    items.value = await window.api.registryLeftovers()
  } catch (e) {
    errText.value = (e as Error).message
    items.value = []
  }
}

async function remove(i: RegistryLeftover): Promise<void> {
  busyKey.value = i.keyPath
  try {
    const r = await window.api.registryDelete(i.hive, i.keyPath)
    toast.value = r.ok ? `已删除 ${i.displayName}` : `删除失败：${r.output?.slice(-80) ?? '未知原因'}`
    if (r.ok) await load()
  } catch (e) {
    toast.value = `删除失败：${(e as Error).message}`
  } finally {
    busyKey.value = ''
    setTimeout(() => (toast.value = ''), 3000)
  }
}

onMounted(load)
</script>

<template>
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">注册表残留</span>
      <span class="dim">卸载表死条目（卸载程序与安装目录均已消失）</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">状态总览</span>
      <span v-if="items" class="pg-stat-val mono">
        {{ items.length }} 个死条目 · HKCU {{ items.filter((x) => x.hive === 'HKCU').length }} / HKLM
        {{ items.filter((x) => x.hive === 'HKLM').length }}
      </span>
      <span v-else class="pg-stat-val dim">扫描中…</span>
    </div>

    <div v-if="errText" class="pg-err">扫描失败：{{ errText }}</div>
    <div v-else-if="items && !items.length" class="pg-empty">没有发现死条目 —— 卸载表很干净</div>
    <div v-else-if="items" class="pg-list">
      <div v-for="i in items" :key="i.keyPath" class="rrow">
        <div style="flex: 1; min-width: 0">
          <div class="rrow-name">
            {{ i.displayName }}
            <span class="badge">{{ i.hive }}</span>
          </div>
          <div class="rrow-path mono" :title="i.keyPath">{{ i.keyPath }}</div>
        </div>
        <button class="ghost rbtn" style="color: var(--danger)" :disabled="busyKey === i.keyPath" @click="remove(i)">
          {{ busyKey === i.keyPath ? '删除中…' : '删除' }}
        </button>
      </div>
    </div>

    <div class="pg-actions">
      <button class="primary" :disabled="!!items && busyKey !== ''" @click="load">重新扫描</button>
    </div>
    <div v-if="toast" class="pg-toast">{{ toast }}</div>
    <div class="dim pg-foot">只允许删除卸载表内的键（硬约束）；HKCU 直接删除，HKLM 弹 UAC。注册表没有回收站，删除前请确认。</div>
  </div>
</template>

<style scoped>
@import './page.css';
.rrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-hair);
}
.rrow-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}
.rrow-path {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}
.rbtn {
  flex: none;
}
</style>
