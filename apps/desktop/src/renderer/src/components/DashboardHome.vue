<script setup lang="ts">
/**
 * v6.1 仪表盘（shadcn-vue 重制）：指标卡 + 磁盘概览 + 快捷动作 + 常用软件 + 系统动态。
 * 数据策略：本地快数据直取，重扫描数据由 App 注入；winget/CIM 懒加载。
 */
import { onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { StartupEntry } from '@shared/startup'
import { Badge, Button, Card } from '@renderer/components/ui'

const props = defineProps<{ junkTotal: number; softwareCount: number; junkItems: number }>()
const emit = defineEmits<{
  navigate: [view: string]
  'rescan-software': []
  'rescan-junk': []
}>()

const quarCount = ref(0)
const startupCount = ref<number | null>(null)
const startupUnsigned = ref(0)
const schedInfo = ref<{ lastRunAt: number; lastCleaned: number; lastFreedBytes: number } | null>(null)
const recent = ref<{ name: string; path: string; at: number }[]>([])
const upgradeCount = ref<number | null>(null)
const drives = ref<{ letter: string; label: string; totalBytes: number; freeBytes: number }[]>([])

onMounted(async () => {
  void window.api.quarantineCount().then((n) => (quarCount.value = n)).catch(() => {})
  try {
    const list: StartupEntry[] = await window.api.startupList()
    startupCount.value = list.length
    startupUnsigned.value = list.filter((x) => !x.fileExists || x.signStatus === 'unsigned').length
  } catch {
    startupCount.value = null
  }
  try {
    schedInfo.value = await window.api.junkScheduleInfo()
  } catch {
    /* ignore */
  }
  try {
    recent.value = await window.api.dashRecent()
  } catch {
    /* ignore */
  }
  void window.api
    .wingetList()
    .then((ups) => (upgradeCount.value = ups.length))
    .catch(() => (upgradeCount.value = null))
  void window.api
    .backupDrives()
    .then((ds) => (drives.value = ds.filter((d) => d.totalBytes > 0)))
    .catch(() => {})
})

async function launchRecent(path: string): Promise<void> {
  await window.api.appLaunch({ path })
  recent.value = await window.api.dashRecent().catch(() => recent.value)
}

function fmtWhen(ts: number): string {
  if (!ts) return '尚未运行'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function diskPercent(d: { totalBytes: number; freeBytes: number }): number {
  if (!d.totalBytes) return 0
  return Math.round(((d.totalBytes - d.freeBytes) / d.totalBytes) * 100)
}
function diskTone(d: { totalBytes: number; freeBytes: number }): string {
  const p = diskPercent(d)
  if (p > 92) return 'bg-destructive'
  if (p > 80) return 'bg-warning'
  return 'bg-primary'
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-8 pb-10 pt-7">
    <!-- 页头 -->
    <div class="flex items-baseline gap-3 pb-1">
      <h2 class="text-[19px] font-semibold tracking-tight text-foreground">概览</h2>
      <span class="text-[12.5px] text-muted-foreground">已收录 {{ softwareCount }} 个软件 · 数据随时可扫描刷新</span>
    </div>

    <!-- 指标卡 -->
    <div class="grid grid-cols-4 gap-3">
      <Card hoverable class="cursor-pointer gap-0.5 p-4 text-left" title="进入清理视图" @click="emit('navigate', 'junk')">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">磁盘可释放</div>
        <div class="mt-1 font-mono text-xl font-semibold text-primary">{{ formatBytes(junkTotal) }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">{{ junkItems > 0 ? `${junkItems} 项待审阅` : '扫描后显示' }}</div>
      </Card>
      <Card hoverable class="cursor-pointer gap-0.5 p-4 text-left" title="进入软件图谱" @click="emit('navigate', 'graph')">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">已收录软件</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ softwareCount }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">图谱与依赖分析</div>
      </Card>
      <Card hoverable class="cursor-pointer gap-0.5 p-4 text-left" title="进入自启动管理" @click="emit('navigate', 'startup')">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">自启动项</div>
        <div class="mt-1 flex items-baseline gap-2">
          <span class="font-mono text-xl font-semibold text-foreground">{{ startupCount ?? '…' }}</span>
          <Badge v-if="startupUnsigned" variant="warning">{{ startupUnsigned }} 项需关注</Badge>
        </div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">Run / 启动文件夹</div>
      </Card>
      <Card hoverable class="cursor-pointer gap-0.5 p-4 text-left" title="打开隔离区" @click="emit('navigate', 'junk')">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">隔离区保留</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ quarCount }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">删除可还原</div>
      </Card>
    </div>

    <!-- 双栏：磁盘概览 + 快捷动作 -->
    <div class="grid grid-cols-2 gap-3">
      <Card class="px-4 py-3">
        <div class="pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">磁盘概览</div>
        <div v-if="drives.length === 0" class="py-2 text-[11px] text-muted-foreground">读取中…</div>
        <div
          v-for="d in drives"
          :key="d.letter"
          class="flex items-center gap-3 py-2 text-xs"
          :title="`${d.letter} ${d.label || ''} · 总 ${formatBytes(d.totalBytes)} · 剩 ${formatBytes(d.freeBytes)}`"
        >
          <span class="w-7 flex-none font-mono text-[11.5px] text-muted-foreground">{{ d.letter }}</span>
          <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <i class="block h-full rounded-full transition-[width] duration-500" :class="diskTone(d)" :style="{ width: diskPercent(d) + '%' }" />
          </div>
          <span class="w-[92px] flex-none text-right font-mono text-[11px] text-muted-foreground">剩 {{ formatBytes(d.freeBytes, 1) }}</span>
        </div>
        <Button variant="ghost" size="sm" class="mt-1 px-0 text-primary hover:bg-transparent hover:text-primary" @click="emit('navigate', 'treemap')">
          空间树图查看详情 →
        </Button>
      </Card>

      <Card class="px-4 py-3">
        <div class="pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">快捷动作</div>
        <div class="flex flex-wrap gap-2 py-1.5">
          <Button size="lg" @click="emit('rescan-junk')">垃圾扫描</Button>
          <Button variant="secondary" size="lg" @click="emit('rescan-software')">重新扫描软件</Button>
          <Button variant="secondary" size="lg" @click="emit('navigate', 'treemap')">▦ 空间树图</Button>
          <Button variant="secondary" size="lg" @click="emit('navigate', 'backup')">备份同步</Button>
        </div>
        <div class="px-0.5 pb-1 pt-1.5 text-[11px] text-muted-foreground">
          上次定时清理：{{ fmtWhen(schedInfo?.lastRunAt ?? 0) }}{{ schedInfo?.lastCleaned ? ` · 清理 ${schedInfo.lastCleaned} 项 / ${formatBytes(schedInfo.lastFreedBytes)}` : '' }}
        </div>
      </Card>
    </div>

    <!-- 常用软件 -->
    <Card v-if="recent.length" class="px-4 py-3">
      <div class="pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">常用软件</div>
      <div class="flex flex-wrap gap-2 py-1">
        <Button
          v-for="r in recent.slice(0, 6)"
          :key="r.path"
          variant="outline"
          :title="r.path"
          class="rounded-lg"
          @click="launchRecent(r.path)"
        >
          ▶ {{ r.name }}
        </Button>
      </div>
    </Card>

    <!-- 系统动态 -->
    <Card class="px-4 py-2">
      <div class="py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">系统动态</div>
      <div v-if="upgradeCount !== null" class="flex items-center gap-2.5 border-t border-border py-2 text-xs text-muted-foreground">
        <span class="size-[7px] flex-none rounded-full" :class="upgradeCount > 5 ? 'bg-warning' : 'bg-primary'" />
        <span>
          可升级软件 {{ upgradeCount }} 个
          <Button variant="ghost" size="sm" class="ml-2 text-primary" @click="emit('navigate', 'upgrade')">去升级 →</Button>
        </span>
      </div>
      <div class="flex items-center gap-2.5 border-t border-border py-2 text-xs text-muted-foreground">
        <span class="size-[7px] flex-none rounded-full bg-primary" />
        <span>备份同步任务与插件市场更新也会在这里提示</span>
      </div>
    </Card>
  </div>
</template>
