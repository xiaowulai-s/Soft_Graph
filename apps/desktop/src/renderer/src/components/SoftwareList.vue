<script setup lang="ts">
/**
 * 左侧软件列表
 * 对应技术设计方案 8.1 整体布局的左栏：软件列表 + 搜索 + 已装/便携筛选
 */
import { computed, ref } from 'vue'
import type { ScanProgress, SoftwareItem, SoftwareSource } from '@shared/types'
import { formatBytes, initialsOf, nameToHsl } from '@shared/util'

const props = defineProps<{
  items: SoftwareItem[]
  selectedId: string | null
  icons: Record<string, string | null>
  scanning: boolean
  progress: ScanProgress | null
  filter: 'all' | 'installed' | 'portable'
}>()

const emit = defineEmits<{
  (e: 'select', item: SoftwareItem): void
  (e: 'scan'): void
  (e: 'cancel'): void
  (e: 'set-filter', v: 'all' | 'installed' | 'portable'): void
  (e: 'reveal', path: string): void
  (e: 'mark-portable', payload: { path: string; isPortable: boolean }): void
}>()

const term = ref('')
const sortBy = ref<'name' | 'size' | 'date'>('name')

const SOURCE_LABEL: Record<SoftwareSource, string> = {
  registry: '注册表',
  msi: 'MSI',
  store: 'Store',
  portable: '便携',
  service: '服务'
}

const filtered = computed(() => {
  const t = term.value.trim().toLowerCase()
  let list = props.items
  if (props.filter === 'installed') list = list.filter((i) => i.source !== 'portable')
  else if (props.filter === 'portable') list = list.filter((i) => i.source === 'portable')
  if (t) {
    list = list.filter(
      (i) =>
        i.name.toLowerCase().includes(t) ||
        i.publisher.toLowerCase().includes(t) ||
        i.installPath.toLowerCase().includes(t)
    )
  }
  const sorted = [...list]
  if (sortBy.value === 'size') sorted.sort((a, b) => b.sizeBytes - a.sizeBytes)
  else if (sortBy.value === 'date') sorted.sort((a, b) => (b.installDate ?? 0) - (a.installDate ?? 0))
  else sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return sorted
})

const counts = computed(() => ({
  all: props.items.length,
  installed: props.items.filter((i) => i.source !== 'portable').length,
  portable: props.items.filter((i) => i.source === 'portable').length
}))

const menuFor = ref<string | null>(null)
</script>

<template>
  <aside class="sl">
    <header class="sl-head">
      <span class="sl-title">软件列表</span>
      <button v-if="!scanning" class="primary" @click="emit('scan')">{{ items.length ? '刷新' : '扫描' }}</button>
      <button v-else class="danger" @click="emit('cancel')">停止</button>
    </header>

    <div class="sl-search">
      <input v-model="term" type="search" placeholder="搜索软件名 / 发布者 / 路径" />
    </div>

    <div class="sl-tabs">
      <button :class="{ on: filter === 'all' }" @click="emit('set-filter', 'all')">全部 {{ counts.all }}</button>
      <button :class="{ on: filter === 'installed' }" @click="emit('set-filter', 'installed')">
        已装 {{ counts.installed }}
      </button>
      <button :class="{ on: filter === 'portable' }" @click="emit('set-filter', 'portable')">
        便携 {{ counts.portable }}
      </button>
    </div>

    <div class="sl-sort">
      <span class="dim">排序</span>
      <select v-model="sortBy">
        <option value="name">名称</option>
        <option value="size">体积</option>
        <option value="date">安装时间</option>
      </select>
    </div>

    <div v-if="scanning && progress" class="sl-progress">
      <div class="sl-progress-bar"><i :style="{ width: progress.percent + '%' }" /></div>
      <div class="sl-progress-text">
        <span>{{ progress.phase }}</span>
        <span class="dim">{{ progress.found ?? 0 }}</span>
      </div>
      <div class="sl-progress-cur mono dim">{{ progress.current || '…' }}</div>
    </div>

    <div class="sl-list">
      <div v-if="filtered.length === 0 && !scanning" class="sl-empty dim">
        <template v-if="items.length === 0">
          点击「扫描」枚举本机已安装软件与便携软件
        </template>
        <template v-else>没有匹配的软件</template>
      </div>

      <div
        v-for="it in filtered"
        :key="it.id"
        class="sl-item"
        :class="{ on: it.id === selectedId }"
        @click="emit('select', it)"
        @contextmenu.prevent="menuFor = menuFor === it.id ? null : it.id"
      >
        <div class="sl-icon">
          <img v-if="icons[it.iconHash]" :src="icons[it.iconHash]!" alt="" />
          <span v-else class="sl-icon-fb" :style="{ background: nameToHsl(it.name) }">{{ initialsOf(it.name) }}</span>
        </div>
        <div class="sl-body">
          <div class="sl-name" :title="it.name">{{ it.name }}</div>
          <div class="sl-sub">
            <span class="badge">{{ SOURCE_LABEL[it.source] }}</span>
            <span v-if="it.version" class="dim">{{ it.version }}</span>
            <span v-if="it.sizeBytes > 0" class="dim">· {{ formatBytes(it.sizeBytes) }}</span>
          </div>
          <div v-if="it.source === 'portable' && it.portableEvidence" class="sl-evi dim" :title="it.portableEvidence.join('、')">
            便携评分 {{ it.portableScore }} · {{ it.portableEvidence.slice(0, 2).join('、') }}
          </div>
          <div v-if="menuFor === it.id" class="sl-menu" @click.stop>
            <button class="ghost" @click="emit('reveal', it.installPath || it.mainExe); menuFor = null">
              打开安装目录
            </button>
            <button
              class="ghost"
              @click="emit('mark-portable', { path: it.installPath, isPortable: it.source !== 'portable' }); menuFor = null"
            >
              {{ it.source === 'portable' ? '标记为「非便携」' : '标记为「便携软件」' }}
            </button>
            <div class="sl-menu-path mono dim">{{ it.installPath || it.mainExe }}</div>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sl {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel);
  border-right: 1px solid var(--border);
}
.sl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.sl-title {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
}
.sl-search {
  padding: 8px 12px 6px;
  flex: none;
}
.sl-search input {
  width: 100%;
}
.sl-tabs {
  display: flex;
  gap: 4px;
  padding: 0 12px 6px;
  flex: none;
}
.sl-tabs button {
  flex: 1;
  padding: 4px 2px;
  font-size: 11px;
  background: transparent;
}
.sl-tabs button.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.sl-sort {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px 8px;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.sl-sort select {
  flex: 1;
  padding: 3px 5px;
  font-size: 11px;
}
.sl-progress {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.sl-progress-bar {
  height: 4px;
  background: var(--border-soft);
  border-radius: 2px;
  overflow: hidden;
}
.sl-progress-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.25s;
}
.sl-progress-text {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-top: 4px;
}
.sl-progress-cur {
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.sl-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.sl-empty {
  padding: 24px 18px;
  font-size: 11.5px;
  line-height: 1.7;
  text-align: center;
}
.sl-item {
  display: flex;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-soft);
  align-items: flex-start;
}
.sl-item:hover {
  background: var(--hover);
}
.sl-item.on {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  box-shadow: inset 2px 0 0 var(--accent);
}
.sl-icon {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sl-icon img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}
.sl-icon-fb {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sl-body {
  flex: 1;
  min-width: 0;
}
.sl-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-sub {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  margin-top: 2px;
  overflow: hidden;
  white-space: nowrap;
}
.sl-evi {
  font-size: 10px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-menu {
  margin-top: 6px;
  padding: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sl-menu button {
  font-size: 11px;
  padding: 3px 6px;
  text-align: left;
}
.sl-menu-path {
  font-size: 9.5px;
  word-break: break-all;
  line-height: 1.4;
}
</style>
