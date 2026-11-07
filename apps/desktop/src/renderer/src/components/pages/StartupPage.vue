<script setup lang="ts">
/**
 * v5.2 自启动管理独立页：状态总览 + 启停列表（两段式）。
 */
import { onMounted, ref } from 'vue'
import type { StartupEntry, StartupSource } from '@shared/startup'

const entries = ref<StartupEntry[] | null>(null)
const loadErr = ref('')
const busyId = ref('')
const toast = ref('')

async function load(): Promise<void> {
  loadErr.value = ''
  try {
    entries.value = await window.api.startupList()
  } catch (e) {
    loadErr.value = (e as Error).message
    entries.value = []
  }
}

async function toggle(e: StartupEntry): Promise<void> {
  busyId.value = e.id
  try {
    const r = await window.api.startupToggle({ source: e.source, name: e.name, enable: !e.enabled })
    toast.value = r.ok ? `${e.name} 已${e.enabled ? '禁用' : '启用'}` : `失败：${r.error ?? '未知原因'}`
    if (r.ok) await load()
  } catch (err) {
    toast.value = `失败：${(err as Error).message}`
  } finally {
    busyId.value = ''
    setTimeout(() => (toast.value = ''), 3000)
  }
}

const SOURCE_LABEL: Record<StartupSource, string> = {
  'HKCU:Run': '当前用户 Run',
  'HKCU:RunOnce': '当前用户 RunOnce',
  'HKLM:Run': '系统 Run',
  'HKLM:RunOnce': '系统 RunOnce',
  'StartupFolder:User': '启动文件夹（用户）',
  'StartupFolder:AllUsers': '启动文件夹（所有用户）'
}

onMounted(load)
</script>

<template>
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">自启动管理</span>
      <span class="dim">注册表 Run / 启动文件夹 · 可逆启停</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">状态总览</span>
      <span v-if="entries" class="pg-stat-val mono">
        {{ entries.length }} 项 · {{ entries.filter((x) => x.signStatus === 'unsigned').length }} 未签名 ·
        {{ entries.filter((x) => !x.fileExists).length }} 目标缺失
      </span>
      <span v-else class="pg-stat-val dim">枚举中…</span>
    </div>

    <div v-if="loadErr" class="pg-err">枚举失败：{{ loadErr }}</div>
    <div v-else-if="!entries" class="dim pg-wait">枚举中…（注册表 + 启动文件夹 + 签名检测）</div>
    <div v-else-if="!entries.length" class="dim pg-wait">没有发现自启动项</div>
    <div v-else class="pg-list">
      <div v-for="e in entries" :key="e.id" class="row" :class="{ off: !e.enabled }">
        <span
          class="dot"
          :style="{ background: !e.fileExists ? 'var(--danger)' : e.signStatus === 'signed' ? 'var(--success)' : e.signStatus === 'unsigned' ? 'var(--text-3)' : 'var(--warning)' }"
          :title="!e.fileExists ? '目标文件缺失' : e.signStatus === 'signed' ? `已签名：${e.signer}` : e.signStatus === 'unsigned' ? '未签名' : '签名未知'"
        ></span>
        <div style="flex: 1; min-width: 0">
          <div class="row-name">
            {{ e.name }}
            <span class="badge">{{ SOURCE_LABEL[e.source] }}</span>
            <span v-if="e.needsElevation" class="badge" title="改动需管理员权限">UAC</span>
            <span v-if="!e.fileExists" class="badge" style="color: var(--danger)">目标缺失</span>
          </div>
          <div class="row-cmd mono" :title="e.command">{{ e.command || e.exePath }}</div>
        </div>
        <label class="row-switch" :title="e.enabled ? '禁用（可逆）' : '启用'">
          <input type="checkbox" :checked="e.enabled" :disabled="busyId === e.id" @change="toggle(e)" />
          <span>{{ e.enabled ? '启用中' : '已禁用' }}</span>
        </label>
      </div>
    </div>

    <div class="pg-actions">
      <button class="primary" @click="load">重新枚举</button>
    </div>
    <div v-if="toast" class="pg-toast">{{ toast }}</div>
    <div class="dim pg-foot">禁用 = 移入 AutorunsDisabled（与 Sysinternals Autoruns 兼容），随时可逆；系统级项弹 UAC。</div>
  </div>
</template>

<style scoped>
@import './page.css';
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-hair);
}
.row.off {
  opacity: 0.55;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.row-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}
.row-cmd {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}
.row-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  flex: none;
}
</style>
