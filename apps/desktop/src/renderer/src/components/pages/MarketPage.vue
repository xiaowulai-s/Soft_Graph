<script setup lang="ts">
/**
 * v5.2 插件市场独立页：官方索引 + 安装 / 更新 / 已装管理。
 * 合并说明：市场唯一入口（自设置浮窗 tab 迁出）。
 */
import { onMounted, ref } from 'vue'
import type { FloatPluginManifest, MarketEntry } from '@shared/types'
import { compareVersions, marketStatus } from '@shared/float-market'

const marketBusy = ref(false)
const marketOk = ref(false)
const marketText = ref('')
const marketList = ref<MarketEntry[]>([])
const installed = ref<FloatPluginManifest[]>([])
const installingId = ref('')

async function reloadInstalled(): Promise<void> {
  try {
    installed.value = await window.api.floatPlugins()
  } catch {
    installed.value = []
  }
}

async function loadMarket(): Promise<void> {
  marketBusy.value = true
  marketText.value = ''
  try {
    let indexUrl: string | undefined
    try {
      const s = await window.api.getSettings()
      indexUrl = s.float?.pluginIndexUrl || undefined
    } catch {
      /* 默认官方源 */
    }
    const r = await window.api.floatMarket(indexUrl)
    if (!r.ok || !r.plugins) {
      marketOk.value = false
      marketText.value = r.error ?? '索引拉取失败'
      return
    }
    marketOk.value = true
    marketList.value = r.plugins
    marketText.value = `索引共 ${r.plugins.length} 个插件`
  } catch (e) {
    marketOk.value = false
    marketText.value = `拉取失败：${(e as Error).message}`
  } finally {
    marketBusy.value = false
  }
}

function statusOf(e: MarketEntry): { status: string; local?: string } {
  const local = installed.value.find((p) => p.id === e.id)
  if (!local) return { status: 'not-installed' }
  const lv = local.version ?? ''
  if (!lv) return { status: 'unknown-version', local: lv }
  const cmp = compareVersions(e.version, lv)
  return cmp > 0 ? { status: 'update-available', local: lv } : { status: 'up-to-date', local: lv }
}

async function install(e: MarketEntry, isUpdate: boolean): Promise<void> {
  installingId.value = e.id
  try {
    if (isUpdate) {
      const rm = await window.api.floatPluginRemove(e.id)
      if (!rm.ok) {
        marketText.value = `更新失败（卸载旧版）：${rm.error}`
        return
      }
    }
    const r = await window.api.floatPluginInstall({ url: e.url })
    if (r.ok) marketText.value = `已安装 ${r.name}（${isUpdate ? '市场更新' : '市场'}）${r.permissions?.length ? `，含能力：${r.permissions.join(' / ')}，待授权` : ''}`
    else marketText.value = `安装失败：${r.error}`
    await reloadInstalled()
  } finally {
    installingId.value = ''
    setTimeout(() => (marketText.value = ''), 5000)
  }
}

async function remove(p: FloatPluginManifest): Promise<void> {
  const r = await window.api.floatPluginRemove(p.id)
  marketText.value = r.ok ? `已卸载 ${p.name ?? p.id}` : `卸载失败：${r.error}`
  await reloadInstalled()
}

onMounted(async () => {
  await reloadInstalled()
  await loadMarket()
})
</script>

<template>
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">插件市场</span>
      <span class="dim">浮窗插件 · 官方索引（Gitee 直连 + GitHub 回退）</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">状态总览</span>
      <span class="pg-stat-val mono">已装 {{ installed.length }} 个 · 索引 {{ marketList.length }} 个</span>
    </div>

    <div class="pg-actions">
      <button class="primary" :disabled="marketBusy" @click="loadMarket">{{ marketBusy ? '拉取中…' : '刷新市场' }}</button>
    </div>
    <div v-if="marketText" class="pg-toast" :class="{ 'pg-err': !marketOk }">{{ marketText }}</div>

    <div v-if="marketList.length" class="pg-list">
      <div v-for="e in marketList" :key="e.id" class="mrow">
        <div style="flex: 1; min-width: 0">
          <div class="mrow-name">
            {{ e.name }}
            <span class="mono dim" style="font-size: 10px">v{{ e.version }}</span>
            <span v-if="e.permissions.length" class="badge">需授权：{{ e.permissions.join(' / ') }}</span>
          </div>
          <div class="dim" style="font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ e.description }}</div>
        </div>
        <template v-if="statusOf(e).status === 'not-installed'">
          <button class="ghost mbtn" :disabled="installingId === e.id" @click="install(e, false)">安装</button>
        </template>
        <template v-else-if="statusOf(e).status === 'update-available'">
          <span class="dim mono" style="font-size: 10px">本地 v{{ statusOf(e).local }}</span>
          <button class="ghost mbtn" :disabled="installingId === e.id" @click="install(e, true)">更新</button>
        </template>
        <template v-else-if="statusOf(e).status === 'up-to-date'">
          <span style="font-size: 11px; color: var(--success)">✓ 已安装</span>
        </template>
        <template v-else>
          <span class="dim" style="font-size: 11px">版本未知</span>
        </template>
      </div>
    </div>

    <div v-if="installed.length" class="pg-list">
      <div class="pg-stat-label" style="padding: 6px 8px 0">已安装（可卸载）</div>
      <div v-for="p in installed" :key="p.id" class="mrow">
        <div style="flex: 1">
          <span style="font-size: 12px; color: var(--text)">{{ p.name ?? p.id }}</span>
          <span v-if="p.version" class="mono dim" style="font-size: 10px; margin-left: 6px">v{{ p.version }}</span>
        </div>
        <button class="ghost mbtn" style="color: var(--danger)" @click="remove(p)">卸载</button>
      </div>
    </div>
    <div class="dim pg-foot">
      插件经 vm 沙箱提取 manifest、256KB 上限、权限授权后才会运行；自定义索引 URL 在 设置 → 浮窗。
    </div>
  </div>
</template>

<style scoped>
@import './page.css';
.mrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-hair);
}
.mrow-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}
.mbtn {
  flex: none;
}
</style>
