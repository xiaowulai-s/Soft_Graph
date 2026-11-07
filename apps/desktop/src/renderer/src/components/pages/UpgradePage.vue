<script setup lang="ts">
/**
 * v5.2 软件升级独立页：状态总览 + 检查更新 + 单项/全部升级（含 UAC 重试）。
 * 合并说明：这是全应用唯一的升级管理入口。
 */
import { onMounted, ref } from 'vue'
import type { WingetUpgrade } from '@shared/types'

const ups = ref<WingetUpgrade[] | null>(null)
const busy = ref(false)
const upgradingId = ref('')
const allBusy = ref(false)
const allProgress = ref(0)
const errText = ref('')

async function load(): Promise<void> {
  busy.value = true
  errText.value = ''
  try {
    ups.value = await window.api.wingetList()
  } catch (e) {
    errText.value = (e as Error).message
    ups.value = []
  } finally {
    busy.value = false
  }
}

async function upgradeOne(u: WingetUpgrade, elevated = false): Promise<void> {
  upgradingId.value = u.id
  try {
    const r = elevated ? await window.api.wingetUpgradeElevated(u.id) : await window.api.wingetUpgrade(u.id)
    if (r.ok) {
      ups.value = (ups.value ?? []).filter((x) => x.id !== u.id)
    } else if (!elevated && r.needsElevation) {
      await upgradeOne(u, true)
    }
  } catch {
    /* 单项失败不中断 */
  } finally {
    upgradingId.value = ''
  }
}

async function upgradeAll(): Promise<void> {
  allBusy.value = true
  allProgress.value = 0
  const list = [...(ups.value ?? [])]
  let okCount = 0
  for (const u of list) {
    try {
      const r = await window.api.wingetUpgrade(u.id)
      if (r.ok) okCount++
      ups.value = (ups.value ?? []).filter((x) => x.id !== u.id)
    } catch {
      /* 继续 */
    }
    allProgress.value++
  }
  allBusy.value = false
}

onMounted(load)
</script>

<template>
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">软件升级</span>
      <span class="dim">winget 源 · 唯一升级管理入口</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">状态总览</span>
      <span v-if="ups" class="pg-stat-val mono">
        {{ ups.length }} 个可升级 · {{ ups.filter((u) => u.needsElevation).length }} 个需管理员
      </span>
      <span v-else class="pg-stat-val dim">检查中…</span>
      <span v-if="allBusy" class="dim" style="font-size: 11px">批量升级中 {{ allProgress }}/{{ ups?.length ?? 0 }}…</span>
    </div>

    <div v-if="errText" class="pg-err">检查失败：{{ errText }}</div>
    <div class="pg-actions">
      <button class="primary" :disabled="busy || allBusy" @click="load">{{ busy ? '检查中…' : '检查更新' }}</button>
      <button v-if="ups && ups.length" :disabled="allBusy" @click="upgradeAll">全部升级</button>
    </div>

    <div v-if="ups && !ups.length && !busy" class="pg-empty">所有软件均为最新（或 winget 未安装）</div>
    <div v-else-if="ups" class="pg-list">
      <div v-for="u in ups" :key="u.id" class="urow">
        <div style="flex: 1; min-width: 0">
          <div class="urow-name">
            {{ u.name }}
            <span v-if="u.needsElevation" class="badge" title="上次失败需要管理员权限">UAC</span>
          </div>
          <div class="urow-ver mono">{{ u.version }} → {{ u.available }}</div>
        </div>
        <button class="ghost ubtn" :disabled="upgradingId === u.id || allBusy" @click="upgradeOne(u)">
          {{ upgradingId === u.id ? '升级中…' : '升级' }}
        </button>
      </div>
    </div>
    <div class="dim pg-foot">需管理员的升级会自动弹 UAC 重试；失败原因写入日志（scope app-update / winget）。</div>
  </div>
</template>

<style scoped>
@import './page.css';
.urow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-hair);
}
.urow-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}
.urow-ver {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.ubtn {
  flex: none;
}
</style>
