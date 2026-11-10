<script setup lang="ts">
/**
 * v6.1 软件升级（shadcn 重制，对齐设计稿 pg-upgrade）：
 * 统计卡 + 升级列表（版本迁移 + UAC Badge）+ 批量操作。
 * 需管理员的升级自动弹 UAC 重试；失败写入日志（scope winget）。
 */
import { computed, onMounted, ref } from 'vue'
import type { WingetUpgrade } from '@shared/types'
import { Badge, Button, Card } from '@renderer/components/ui'

const ups = ref<WingetUpgrade[] | null>(null)
const busy = ref(false)
const upgradingId = ref('')
const allBusy = ref(false)
const allProgress = ref(0)
const errText = ref('')

const elevCount = computed(() => ups.value?.filter((u) => u.needsElevation).length ?? 0)

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
  for (const u of list) {
    try {
      const r = await window.api.wingetUpgrade(u.id)
      if (r.ok) ups.value = (ups.value ?? []).filter((x) => x.id !== u.id)
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
  <div class="dm-tool-flow">
    <!-- 统计卡 -->
    <div class="grid grid-cols-4 gap-3">
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">待升级</div>
        <div class="mt-1 font-mono text-xl font-semibold" :class="(ups?.length ?? 0) > 0 ? 'text-primary' : 'text-foreground'">
          {{ ups ? ups.length : '…' }}
        </div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">winget upgrade 源</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">需提权</div>
        <div class="mt-1 font-mono text-xl font-semibold" :class="elevCount > 0 ? 'text-warning' : 'text-foreground'">{{ ups ? elevCount : '…' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">0x8a15 自动检测</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">批量进度</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">
          {{ allBusy ? `${allProgress}/${ups?.length ?? 0}` : '—' }}
        </div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">{{ allBusy ? '批量升级中…' : '空闲' }}</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">检查状态</div>
        <div class="mt-1 text-xl font-semibold" :class="busy ? 'text-muted-foreground' : 'text-success'">{{ busy ? '检查中…' : '就绪' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">{{ errText ? '上次检查失败' : 'winget 已接入' }}</div>
      </Card>
    </div>

    <!-- 操作条 -->
    <div class="flex items-center gap-2.5">
      <Button :disabled="busy || allBusy" @click="load">{{ busy ? '检查中…' : '检查更新' }}</Button>
      <Button v-if="ups && ups.length" variant="secondary" :disabled="allBusy" @click="upgradeAll">全部静默升级</Button>
      <span v-if="errText" class="text-xs text-destructive">检查失败：{{ errText }}</span>
    </div>

    <!-- 升级列表 -->
    <Card v-if="ups && !ups.length && !busy" class="border-dashed bg-transparent py-8 text-center text-muted-foreground shadow-none">
      所有软件均为最新（或 winget 未安装）
    </Card>
    <Card v-else-if="ups && ups.length" class="px-3 py-1.5">
      <div v-for="u in ups" :key="u.id" class="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-medium text-foreground">{{ u.name }}</span>
            <Badge v-if="u.needsElevation" variant="warning" title="上次静默失败，需要管理员权限">UAC</Badge>
          </div>
          <div class="font-mono text-[11px] text-muted-foreground">{{ u.version }} <span class="opacity-60">→</span> {{ u.available }}</div>
        </div>
        <Button
          size="sm"
          :variant="u.needsElevation ? 'secondary' : 'default'"
          :disabled="upgradingId === u.id || allBusy"
          :title="u.needsElevation ? '以管理员权限升级（弹 UAC）' : '静默升级'"
          @click="upgradeOne(u)"
        >
          {{ upgradingId === u.id ? '升级中…' : u.needsElevation ? '提权升级' : '升级' }}
        </Button>
      </div>
    </Card>

    <p class="px-1 text-[11px] text-muted-foreground">需管理员的升级会自动弹 UAC 重试；失败原因写入日志（scope app-update / winget）。</p>
  </div>
</template>
