<script setup lang="ts">
/**
 * v6.1 定时调度（shadcn 重制，对齐设计稿 pg-schedule）：
 * 三状态卡 + 配置面板 + 执行信息。设计稿中的「执行历史列表」
 * 无历史数据 API 支撑，落地为「上次执行详情 + 立即执行」。
 */
import { onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { AppSettings } from '@shared/types'
import { Badge, Button, Card, Separator } from '@renderer/components/ui'

const enabled = ref(false)
const intervalHours = ref(168)
const idleOnly = ref(true)
const last = ref<{ lastRunAt: number; lastCleaned: number; lastFreedBytes: number } | null>(null)
const running = ref(false)
const runText = ref('')

function fmtWhen(ts: number): string {
  if (!ts) return '尚未运行'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function nextEstimate(ts: number, hours: number): string {
  if (!ts) return '启用后按周期推算'
  return fmtWhen(ts + hours * 3600_000)
}

async function load(): Promise<void> {
  try {
    const s: AppSettings = await window.api.getSettings()
    enabled.value = s.junkSchedule?.enabled ?? false
    intervalHours.value = s.junkSchedule?.intervalHours ?? 168
    idleOnly.value = s.junkSchedule?.idleOnly !== false
  } catch {
    /* 保留默认 */
  }
  try {
    last.value = await window.api.junkScheduleInfo()
  } catch {
    last.value = null
  }
}

async function patch(): Promise<void> {
  await window.api.setSettings({
    junkSchedule: { enabled: enabled.value, intervalHours: intervalHours.value, idleOnly: idleOnly.value }
  } as never)
  await load()
}

async function runNow(): Promise<void> {
  running.value = true
  runText.value = ''
  try {
    const r = await window.api.junkScheduleRun()
    runText.value = r.cleaned > 0 ? `已清理 ${r.cleaned} 项，释放 ${formatBytes(r.freedBytes)}` : '没有需要清理的项目'
    await load()
  } catch (e) {
    runText.value = `执行失败：${(e as Error).message}`
  } finally {
    running.value = false
    setTimeout(() => (runText.value = ''), 5000)
  }
}

onMounted(load)
</script>

<template>
  <div class="dm-tool-flow">
    <!-- 状态卡 ×3 -->
    <div class="grid grid-cols-3 gap-3">
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">调度状态</div>
        <div class="mt-1 flex items-baseline gap-2">
          <span class="text-xl font-semibold" :class="enabled ? 'text-primary' : 'text-muted-foreground'">{{ enabled ? '已启用' : '未启用' }}</span>
          <Badge :variant="enabled ? 'success' : 'secondary'">{{ enabled ? '运行中' : '已停用' }}</Badge>
        </div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">每 {{ intervalHours }} 小时 · {{ idleOnly ? '仅空闲时执行' : '到期即执行' }}</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">上次执行</div>
        <div class="mt-1 font-mono text-sm font-semibold text-foreground">{{ fmtWhen(last?.lastRunAt ?? 0) }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">
          {{ last?.lastCleaned ? `清理 ${last.lastCleaned} 项 / ${formatBytes(last.lastFreedBytes)}` : '尚无记录' }}
        </div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">下次预计</div>
        <div class="mt-1 font-mono text-sm font-semibold text-foreground">{{ enabled ? nextEstimate(last?.lastRunAt ?? 0, intervalHours) : '—' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">{{ idleOnly ? '系统空闲 ≥ 10 分钟时' : '到期即执行' }}</div>
      </Card>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <!-- 配置 -->
      <Card class="px-4 py-3">
        <div class="pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">配置</div>
        <div class="flex items-center justify-between py-2.5 text-xs">
          <span class="text-muted-foreground">启用定时静默清理</span>
          <input v-model="enabled" type="checkbox" class="h-3.5 w-3.5 accent-[var(--accent)]" @change="patch" />
        </div>
        <Separator />
        <div class="flex items-center justify-between py-2.5 text-xs">
          <span class="text-muted-foreground">执行周期</span>
          <select v-model.number="intervalHours" class="h-6 rounded-md border border-input bg-secondary px-2 text-xs" @change="patch">
            <option :value="24">每 24 小时（每天）</option>
            <option :value="72">每 72 小时（3 天）</option>
            <option :value="168">每 168 小时（每周）</option>
            <option :value="336">每 336 小时（两周）</option>
          </select>
        </div>
        <Separator />
        <div class="flex items-center justify-between py-2.5 text-xs">
          <span class="text-muted-foreground">仅系统空闲时执行</span>
          <input v-model="idleOnly" type="checkbox" class="h-3.5 w-3.5 accent-[var(--accent)]" @change="patch" />
        </div>
      </Card>

      <!-- 执行 -->
      <Card class="px-4 py-3">
        <div class="pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">手动执行</div>
        <div class="flex flex-wrap items-center gap-2 py-2">
          <Button size="lg" :disabled="running" @click="runNow">{{ running ? '执行中…' : '立即执行一次' }}</Button>
          <span v-if="runText" class="text-xs text-primary">{{ runText }}</span>
        </div>
        <Separator class="my-1" />
        <p class="px-0.5 pb-1 pt-2 text-[11px] leading-relaxed text-muted-foreground">
          调度清理与手动清理同链路：扫描 → 隔离（可还原）→ 7 天后可彻底清除。
          空闲检测避免打断前台工作；跳过时顺延到下个空闲窗口。
        </p>
      </Card>
    </div>
  </div>
</template>
