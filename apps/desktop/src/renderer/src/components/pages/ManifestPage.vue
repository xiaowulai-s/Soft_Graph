<script setup lang="ts">
/**
 * v6.1 装机清单（shadcn 重制，对齐设计稿 pg-manifest）：
 * 汇总卡 + 导出双通道卡 + 清单表格预览。
 */
import { computed, onMounted, ref } from 'vue'
import type { SoftwareItem } from '@shared/types'
import { formatBytes } from '@shared/util'
import { Badge, Button, Card } from '@renderer/components/ui'

const items = ref<SoftwareItem[]>([])
const loading = ref(true)
const toast = ref('')

const portableCount = computed(() => items.value.filter((x) => x.source === 'portable').length)
const storeCount = computed(() => items.value.filter((x) => x.source === 'store').length)
const totalSize = computed(() => items.value.reduce((n, x) => n + x.sizeBytes, 0))

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
  <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-8 pb-10 pt-7">
    <div class="flex flex-col gap-0.5 pb-1">
      <h2 class="text-[19px] font-semibold tracking-tight text-foreground">装机清单</h2>
      <span class="text-[12.5px] text-muted-foreground">换机 / 重装场景：导出软件表或 winget 批量安装脚本</span>
    </div>

    <!-- 汇总卡 -->
    <div class="grid grid-cols-4 gap-3">
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">已收录软件</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ items.length }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">全部清单</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">便携软件</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ portableCount }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">免安装识别</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">商店应用</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ storeCount }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">MSIX / Store</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">总占用</div>
        <div class="mt-1 font-mono text-xl font-semibold text-primary">{{ formatBytes(totalSize) }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">按登记大小累计</div>
      </Card>
    </div>

    <!-- 导出双通道 -->
    <div class="grid grid-cols-2 gap-3">
      <Card hoverable class="flex items-center gap-4 p-4">
        <div class="flex-1">
          <div class="text-[13px] font-semibold text-foreground">CSV 表格</div>
          <div class="mt-0.5 text-[11px] text-muted-foreground">名称 / 版本 / 发布者 / 路径，Excel 直开</div>
        </div>
        <Button @click="exportAs('csv')">导出 CSV</Button>
      </Card>
      <Card hoverable class="flex items-center gap-4 p-4">
        <div class="flex-1">
          <div class="text-[13px] font-semibold text-foreground">PS1 安装脚本</div>
          <div class="mt-0.5 text-[11px] text-muted-foreground">winget 批量静默安装，管理员运行</div>
        </div>
        <Button variant="secondary" @click="exportAs('ps1')">导出 PS1</Button>
      </Card>
    </div>

    <div class="flex items-center gap-2.5">
      <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
      <span v-if="toast" class="text-xs text-primary">{{ toast }}</span>
    </div>

    <!-- 清单预览 -->
    <Card v-if="loading" class="py-8 text-center text-muted-foreground shadow-none">加载软件库…</Card>
    <Card v-else class="max-h-[440px] overflow-auto px-3 py-1">
      <div class="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-panel px-2 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span class="flex-[2]">软件</span>
        <span class="flex-1">版本</span>
        <span class="flex-1">发布者</span>
        <span class="w-16 text-right">大小</span>
        <span class="w-12 text-center">类型</span>
      </div>
      <div v-for="i in items" :key="i.id" class="flex items-center gap-3 border-b border-border py-2 text-xs last:border-b-0">
        <span class="flex-[2] truncate text-foreground" :title="i.name">{{ i.name }}</span>
        <span class="flex-1 font-mono text-muted-foreground">{{ i.version || '—' }}</span>
        <span class="flex-1 truncate text-muted-foreground" :title="i.publisher">{{ i.publisher || '—' }}</span>
        <span class="w-16 text-right font-mono text-muted-foreground">{{ formatBytes(i.sizeBytes) }}</span>
        <span class="w-12 text-center"><Badge :variant="i.source === 'portable' ? 'default' : 'secondary'">{{ i.source === 'portable' ? '便携' : '安装' }}</Badge></span>
      </div>
    </Card>
  </div>
</template>
