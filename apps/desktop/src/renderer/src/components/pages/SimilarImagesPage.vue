<script setup lang="ts">
/**
 * v6.1 相似图片（shadcn 重制，对齐设计稿 pg-images）：
 * 统计卡 + 重复组卡（缩略色块 + 路径清单 + 保留建议 + 送回收站）。
 * aHash 感知哈希分组；删除走系统回收站可还原；扫描只读。
 */
import { computed, onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import { Badge, Button, Card } from '@renderer/components/ui'

interface ImgItem {
  path: string
  sizeBytes: number
}
interface Group {
  hash: string
  images: ImgItem[]
}

const groups = ref<Group[] | null>(null)
const scanning = ref(false)
const toast = ref('')
const busyPath = ref('')

const totalImages = computed(() => groups.value?.reduce((n, g) => n + g.images.length, 0) ?? 0)
const reclaimable = computed(() =>
  groups.value?.reduce((n, g) => {
    const sorted = [...g.images].sort((a, b) => b.sizeBytes - a.sizeBytes)
    return n + sorted.slice(1).reduce((m, x) => m + x.sizeBytes, 0)
  }, 0) ?? 0
)

function hue(hash: string, i: number): string {
  let h = 0
  for (const c of hash + i) h = (h * 31 + c.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 45% 72%), hsl(${(h + 40) % 360} 45% 55%))`
}

async function scan(): Promise<void> {
  scanning.value = true
  try {
    groups.value = await window.api.imagesSimilar()
  } catch (e) {
    toast.value = `扫描失败：${(e as Error).message}`
    groups.value = []
  } finally {
    scanning.value = false
    setTimeout(() => (toast.value = ''), 4000)
  }
}

async function trash(p: string): Promise<void> {
  busyPath.value = p
  try {
    const r = await window.api.imageTrash(p)
    toast.value = r.ok ? '已送回收站（可还原）' : '送回收站失败'
    if (r.ok) await scan()
  } finally {
    busyPath.value = ''
    setTimeout(() => (toast.value = ''), 4000)
  }
}

onMounted(() => {
  void scan()
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-8 pb-10 pt-7">
    <div class="flex flex-col gap-0.5 pb-1">
      <h2 class="text-[19px] font-semibold tracking-tight text-foreground">相似图片</h2>
      <span class="text-[12.5px] text-muted-foreground">aHash 感知哈希分组 · 扫描范围 = 图片 / 下载 / 文档目录 · 删除走系统回收站可还原</span>
    </div>

    <!-- 统计卡 -->
    <div class="grid grid-cols-4 gap-3">
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">扫描图片</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ scanning ? '…' : totalImages }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">涉及相似组内的图片</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">重复组</div>
        <div class="mt-1 font-mono text-xl font-semibold text-primary">{{ groups ? groups.length : '…' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">汉明距离 ≤ 5</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">可释放</div>
        <div class="mt-1 font-mono text-xl font-semibold text-foreground">{{ groups ? formatBytes(reclaimable) : '…' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">每组保留最大 1 张</div>
      </Card>
      <Card hoverable class="gap-0.5 p-4">
        <div class="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">扫描状态</div>
        <div class="mt-1 text-xl font-semibold" :class="scanning ? 'text-muted-foreground' : 'text-success'">{{ scanning ? '进行中' : '完成' }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">解码 + 感知哈希</div>
      </Card>
    </div>

    <!-- 操作条 -->
    <div class="flex items-center gap-2.5">
      <Button :disabled="scanning" @click="scan">{{ scanning ? '扫描中…（可能需要一两分钟）' : '重新扫描' }}</Button>
      <span v-if="toast" class="text-xs text-primary">{{ toast }}</span>
    </div>

    <!-- 重复组卡 -->
    <Card v-if="groups && !groups.length && !scanning" class="border-dashed bg-transparent py-8 text-center text-muted-foreground shadow-none">
      未发现相似图片
    </Card>
    <div v-else-if="groups" class="flex flex-col gap-3">
      <Card v-for="(g, gi) in groups" :key="g.hash" class="p-4">
        <div class="flex items-start gap-4">
          <div class="flex flex-none gap-1.5">
            <div v-for="(img, ii) in g.images.slice(0, 4)" :key="ii" class="h-[38px] w-[52px] rounded-md border border-border" :style="{ background: hue(g.hash, ii) }" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="mb-1.5 flex flex-wrap items-center gap-2">
              <span class="text-[13px] font-semibold text-foreground">第 {{ gi + 1 }} 组 · {{ g.images.length }} 张</span>
              <Badge variant="success">建议保留第 1 张（最大 {{ formatBytes(Math.max(...g.images.map((x) => x.sizeBytes))) }}）</Badge>
              <span class="font-mono text-[11px] text-muted-foreground">共 {{ formatBytes(g.images.reduce((n, x) => n + x.sizeBytes, 0)) }}</span>
            </div>
            <div class="flex flex-col">
              <div
                v-for="(img, ii) in g.images"
                :key="img.path"
                class="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-[11.5px]"
                :class="ii === 0 && 'bg-accent-soft'"
              >
                <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground" :title="img.path">{{ img.path }}</span>
                <span class="flex-none font-mono text-muted-foreground">{{ formatBytes(img.sizeBytes) }}</span>
                <Badge v-if="ii === 0" variant="success">建议保留</Badge>
                <Button
                  v-else
                  variant="ghost"
                  size="sm"
                  class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  :disabled="busyPath === img.path"
                  @click="trash(img.path)"
                >
                  {{ busyPath === img.path ? '处理中…' : '送回收站' }}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>

    <p class="px-1 text-[11px] text-muted-foreground">删除走系统回收站，可还原。扫描为只读操作。</p>
  </div>
</template>
