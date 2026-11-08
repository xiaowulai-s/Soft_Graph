<script setup lang="ts">
/**
 * v6.1 自启动管理（shadcn 重制，对齐设计稿 pg-startup）：
 * 统计卡 + 签名状态条目表 + 风险提示。禁用 = 移入 AutorunsDisabled
 * （与 Sysinternals Autoruns 兼容），可逆；系统级项弹 UAC。
 */
import { computed, onMounted, ref } from 'vue'
import type { StartupEntry, StartupSource } from '@shared/startup'
import { Badge, Button, Card, Separator } from '@renderer/components/ui'

const entries = ref<StartupEntry[] | null>(null)
const loadErr = ref('')
const busyId = ref('')
const toast = ref('')
const toastOk = ref(false)

const unsignedCount = computed(() => entries.value?.filter((x) => x.signStatus === 'unsigned').length ?? 0)
const missingCount = computed(() => entries.value?.filter((x) => !x.fileExists).length ?? 0)
const disabledCount = computed(() => entries.value?.filter((x) => !x.enabled).length ?? 0)
const riskItems = computed(() => entries.value?.filter((x) => !x.fileExists || x.signStatus === 'unsigned') ?? [])

function signBadge(e: StartupEntry): { text: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' } {
  if (!e.fileExists) return { text: '目标缺失', variant: 'destructive' }
  if (e.signStatus === 'signed') return { text: `签名有效${e.signer ? ' · ' + e.signer : ''}`, variant: 'success' }
  if (e.signStatus === 'unsigned') return { text: '未签名', variant: 'warning' }
  return { text: '签名未知', variant: 'secondary' }
}

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
    toastOk.value = r.ok
    toast.value = r.ok ? `${e.name} 已${e.enabled ? '禁用' : '启用'}` : `失败：${r.error ?? '未知原因'}`
    if (r.ok) await load()
  } catch (err) {
    toastOk.value = false
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
  <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-8 pb-10 pt-7">
    <div class="flex flex-col gap-0.5 pb-1">
      <h2 class="text-[19px] font-semibold tracking-tight text-foreground">自启动管理</h2>
      <span class="text-[12.5px] text-muted-foreground">注册表 Run / 启动文件夹 · 签名校验 · 可逆启停</span>
    </div>

    <!-- 统计卡 -->
    <div class="grid grid-cols-4 gap-3">
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">自启动项</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ entries ? entries.length : '…' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">Run 键 + 启动文件夹</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">需关注</div>
        <div class="mt-1 font-mono text-xl font-semibold" :class="unsignedCount + missingCount > 0 ? 'text-warning' : 'text-foreground'">
          {{ entries ? unsignedCount + missingCount : '…' }}
        </div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">未签名 / 目标缺失</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">已禁用</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ entries ? disabledCount : '…' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">随时可恢复</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">开机影响</div>
        <div class="mt-1 text-xl font-semibold" :class="(entries?.length ?? 0) > 15 ? 'text-warning' : 'text-success'">
          {{ !entries ? '…' : (entries?.length ?? 0) > 15 ? '偏高' : '正常' }}
        </div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">建议 ≤ 15 项</div>
      </Card>
    </div>

    <!-- 操作条 -->
    <div class="flex items-center gap-2.5">
      <Button @click="load">重新枚举</Button>
      <span v-if="toast" class="text-xs" :class="toastOk ? 'text-primary' : 'text-destructive'">{{ toast }}</span>
      <span v-if="loadErr" class="text-xs text-destructive">枚举失败：{{ loadErr }}</span>
    </div>

    <div class="grid grid-cols-[1fr_300px] items-start gap-3">
      <!-- 条目表 -->
      <Card v-if="entries && entries.length" class="max-h-[480px] overflow-auto px-3 py-1">
        <div v-for="e in entries" :key="e.id" class="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0" :class="!e.enabled && 'opacity-50'">
          <span
            class="size-2 flex-none rounded-full"
            :class="!e.fileExists ? 'bg-destructive' : e.signStatus === 'signed' ? 'bg-success' : e.signStatus === 'unsigned' ? 'bg-muted-foreground/60' : 'bg-warning'"
            :title="!e.fileExists ? '目标文件缺失' : e.signStatus === 'signed' ? `已签名：${e.signer}` : e.signStatus === 'unsigned' ? '未签名' : '签名未知'"
          />
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-medium text-foreground">{{ e.name }}</span>
              <Badge variant="secondary">{{ SOURCE_LABEL[e.source] }}</Badge>
              <Badge v-if="e.needsElevation" variant="warning" title="改动需管理员权限">UAC</Badge>
            </div>
            <div class="truncate font-mono text-[10.5px] text-muted-foreground" :title="e.command || e.exePath">{{ e.command || e.exePath }}</div>
          </div>
          <Badge :variant="signBadge(e).variant">{{ signBadge(e).text }}</Badge>
          <label class="flex flex-none cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground" :title="e.enabled ? '禁用（可逆）' : '启用'">
            <input type="checkbox" class="h-3.5 w-3.5 accent-[var(--accent)]" :checked="e.enabled" :disabled="busyId === e.id" @change="toggle(e)" />
            <span>{{ e.enabled ? '启用中' : '已禁用' }}</span>
          </label>
        </div>
      </Card>
      <Card v-else-if="entries && !entries.length && !loadErr" class="border-dashed bg-transparent py-8 text-center text-muted-foreground shadow-none">
        没有发现自启动项
      </Card>

      <!-- 风险提示 -->
      <Card class="px-4 py-3">
        <div class="pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">风险提示</div>
        <template v-if="riskItems.length">
          <div v-for="r in riskItems" :key="r.id" class="border-t border-border py-2 text-[11.5px] leading-relaxed text-muted-foreground first:border-t-0">
            <span :class="!r.fileExists ? 'text-destructive' : 'text-warning'">· {{ r.name }}</span>
            {{ !r.fileExists ? '指向已删除文件，属残留死项' : '未签名，建议禁用后观察系统行为' }}
          </div>
        </template>
        <div v-else class="py-2 text-[11.5px] text-muted-foreground">当前全部条目签名正常且文件存在。</div>
        <Separator class="my-2" />
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          禁用 = 移入 AutorunsDisabled（与 Sysinternals Autoruns 兼容），随时可逆；系统级项弹 UAC。
        </p>
      </Card>
    </div>
  </div>
</template>
