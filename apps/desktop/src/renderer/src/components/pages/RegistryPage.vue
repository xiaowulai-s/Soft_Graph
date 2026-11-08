<script setup lang="ts">
/**
 * v6.1 注册表残留（shadcn 重制，对齐设计稿 pg-registry）：
 * 统计卡 + 死条目表 + 安全提示。安全约束：只删卸载表内的键；
 * HKCU 直删、HKLM 弹 UAC。注册表无回收站，删除前确认。
 */
import { computed, onMounted, ref } from 'vue'
import type { RegistryLeftover } from '@shared/types'
import { Badge, Button, Card } from '@renderer/components/ui'

const items = ref<RegistryLeftover[] | null>(null)
const busyKey = ref('')
const errText = ref('')
const toast = ref('')
const toastOk = ref(false)

const hkcuCount = computed(() => items.value?.filter((x) => x.hive === 'HKCU').length ?? 0)
const hklmCount = computed(() => items.value?.filter((x) => x.hive === 'HKLM').length ?? 0)

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
    toastOk.value = r.ok
    toast.value = r.ok ? `已删除 ${i.displayName}` : `删除失败：${r.output?.slice(-80) ?? '未知原因'}`
    if (r.ok) await load()
  } catch (e) {
    toastOk.value = false
    toast.value = `删除失败：${(e as Error).message}`
  } finally {
    busyKey.value = ''
    setTimeout(() => (toast.value = ''), 3000)
  }
}

onMounted(load)
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-8 pb-10 pt-7">
    <div class="flex flex-col gap-0.5 pb-1">
      <h2 class="text-[19px] font-semibold tracking-tight text-foreground">注册表残留</h2>
      <span class="text-[12.5px] text-muted-foreground">卸载表死条目（卸载程序与安装目录均已消失）· 只读扫描 · 删除即生效</span>
    </div>

    <!-- 统计卡 -->
    <div class="grid grid-cols-3 gap-3">
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">死条目</div>
        <div class="mt-1 font-mono text-xl font-semibold" :class="(items?.length ?? 0) > 0 ? 'text-destructive' : 'text-foreground'">
          {{ items ? items.length : '…' }}
        </div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">卸载器 + 目录均已消失</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">HKCU（当前用户）</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ items ? hkcuCount : '…' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">删除无需提权</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">HKLM（本机）</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ items ? hklmCount : '…' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">删除弹 UAC 确认</div>
      </Card>
    </div>

    <!-- 操作条 -->
    <div class="flex items-center gap-2.5">
      <Button :disabled="!!items && busyKey !== ''" @click="load">重新扫描</Button>
      <span v-if="toast" class="text-xs" :class="toastOk ? 'text-primary' : 'text-destructive'">{{ toast }}</span>
      <span v-if="errText" class="text-xs text-destructive">扫描失败：{{ errText }}</span>
    </div>

    <!-- 死条目列表 -->
    <Card v-if="items && !items.length && !errText" class="border-dashed bg-transparent py-8 text-center text-muted-foreground shadow-none">
      没有发现死条目 —— 卸载表很干净
    </Card>
    <Card v-else-if="items && items.length" class="px-3 py-1.5">
      <div v-for="i in items" :key="i.keyPath" class="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-medium text-foreground">{{ i.displayName }}</span>
            <Badge :variant="i.hive === 'HKLM' ? 'warning' : 'secondary'">{{ i.hive }}</Badge>
          </div>
          <div class="truncate font-mono text-[10.5px] text-muted-foreground" :title="i.keyPath">{{ i.keyPath }}</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          class="text-destructive hover:bg-destructive/10 hover:text-destructive"
          :disabled="busyKey === i.keyPath"
          @click="remove(i)"
        >
          {{ busyKey === i.keyPath ? '删除中…' : '删除' }}
        </Button>
      </div>
    </Card>

    <p class="px-1 text-[11px] text-muted-foreground">
      只允许删除卸载表内的键（硬约束）；HKCU 直接删除，HKLM 弹 UAC。注册表没有回收站，删除前请确认。
    </p>
  </div>
</template>
