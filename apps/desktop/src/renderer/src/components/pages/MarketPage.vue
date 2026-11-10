<script setup lang="ts">
/**
 * v6.1 插件市场（shadcn 重制，对齐设计稿 pg-market）：
 * 源状态条 + 插件卡栅格（版本/权限 Badge）+ 已装管理。
 */
import { computed, onMounted, ref } from 'vue'
import type { FloatPluginManifest, MarketEntry } from '@shared/types'
import { compareVersions } from '@shared/float-market'
import { Badge, Button, Card } from '@renderer/components/ui'

const marketBusy = ref(false)
const marketOk = ref(false)
const marketText = ref('')
const marketList = ref<MarketEntry[]>([])
const installed = ref<FloatPluginManifest[]>([])
const installingId = ref('')

const builtinIds = new Set(['sys.cpumem', 'sys.disk', 'sys.network', 'sys.clock', 'sg.junk', 'sg.overview', 'sg.apps'])

const externalInstalled = computed(() => installed.value.filter((p) => !p.builtin && !builtinIds.has(p.id)))
const updatable = computed(() => marketList.value.filter((e) => statusOf(e).status === 'update-available').length)

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

function statusBadge(e: MarketEntry): { text: string; variant: 'default' | 'secondary' | 'success' | 'warning' } {
  const st = statusOf(e).status
  if (st === 'update-available') return { text: '可更新', variant: 'warning' }
  if (st === 'up-to-date') return { text: '已安装', variant: 'success' }
  if (st === 'unknown-version') return { text: '版本未知', variant: 'secondary' }
  return { text: '未安装', variant: 'secondary' }
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
    if (r.ok) marketText.value = `已安装 ${r.name}${r.permissions?.length ? `，含能力：${r.permissions.join(' / ')}，待授权` : ''}`
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
  <div class="dm-tool-flow">
    <!-- 源状态条 -->
    <Card class="flex flex-wrap items-center gap-3 px-4 py-3">
      <Badge :variant="marketOk ? 'success' : 'warning'">{{ marketOk ? '官方源 ✓ 已连接' : '索引未连接' }}</Badge>
      <span class="text-[11px] text-muted-foreground">{{ marketText || '索引加载中…' }}</span>
      <span class="ml-auto flex items-center gap-2">
        <Badge variant="secondary">已装 {{ externalInstalled.length }} 个</Badge>
        <Badge v-if="updatable" variant="warning">可更新 {{ updatable }} 个</Badge>
        <Button size="sm" :disabled="marketBusy" @click="loadMarket">{{ marketBusy ? '拉取中…' : '刷新索引' }}</Button>
      </span>
    </Card>

    <!-- 插件卡栅格 -->
    <div v-if="marketList.length" class="grid grid-cols-3 gap-3">
      <Card v-for="e in marketList" :key="e.id" hoverable class="flex flex-col gap-1.5 p-4">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] font-semibold text-foreground">{{ e.name }}</span>
          <Badge :variant="statusBadge(e).variant">{{ statusBadge(e).text }}</Badge>
        </div>
        <p class="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{{ e.description }}</p>
        <div class="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" class="font-mono">v{{ e.version }}</Badge>
          <Badge v-for="pm in e.permissions" :key="pm" variant="warning">{{ pm }}</Badge>
          <Badge v-if="!e.permissions.length" variant="success">无权限</Badge>
        </div>
        <div class="mt-auto flex flex-wrap gap-1.5 pt-2">
          <Button v-if="statusOf(e).status === 'not-installed'" size="sm" :disabled="installingId === e.id" @click="install(e, false)">安装</Button>
          <Button v-else-if="statusOf(e).status === 'update-available'" size="sm" :disabled="installingId === e.id" @click="install(e, true)">
            更新<span v-if="statusOf(e).local" class="opacity-60">（本地 v{{ statusOf(e).local }}）</span>
          </Button>
          <span v-else-if="statusOf(e).status === 'up-to-date'" class="self-center text-[11px] text-success">✓ 已是最新</span>
          <span v-else class="self-center text-[11px] text-muted-foreground">版本未知</span>
        </div>
      </Card>
    </div>
    <Card v-else-if="!marketBusy" class="border-dashed bg-transparent py-8 text-center text-muted-foreground shadow-none">
      {{ marketText || '索引为空' }}
    </Card>

    <!-- 已安装管理 -->
    <Card v-if="externalInstalled.length" class="px-4 py-3">
      <div class="pb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">已安装（可卸载）</div>
      <div v-for="p in externalInstalled" :key="p.id" class="flex items-center gap-3 border-t border-border py-2 text-xs first:border-t-0">
        <span class="flex-1 truncate text-foreground">{{ p.name ?? p.id }}</span>
        <span v-if="p.version" class="font-mono text-[10.5px] text-muted-foreground">v{{ p.version }}</span>
        <Badge v-if="p.permissions?.length" variant="warning">{{ p.permissions.join(' / ') }}</Badge>
        <Button variant="ghost" size="sm" class="text-destructive hover:bg-destructive/10 hover:text-destructive" @click="remove(p)">卸载</Button>
      </div>
    </Card>

    <p class="px-1 text-[11px] text-muted-foreground">
      插件经 vm 沙箱提取 manifest、256KB 上限、权限授权后才会运行；自定义索引 URL 在 设置 → 桌面浮窗。
    </p>
  </div>
</template>
