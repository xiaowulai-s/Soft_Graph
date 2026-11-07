<script setup lang="ts">
/**
 * v5.2 相似图片独立页：扫描 + 分组卡片（组内保留建议 + 送回收站）。
 */
import { onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'

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
  <div class="pg">
    <div class="pg-head">
      <span class="pg-title">相似图片</span>
      <span class="dim">aHash 感知哈希分组 · 扫描范围 = 图片 / 下载 / 文档目录</span>
    </div>

    <div class="pg-stat">
      <span class="pg-stat-label">状态总览</span>
      <span v-if="groups" class="pg-stat-val mono">
        {{ groups.length }} 组相似 · 涉及 {{ groups.reduce((n, g) => n + g.images.length, 0) }} 张图片
      </span>
      <span v-else class="pg-stat-val dim">扫描中…（解码 + 感知哈希，可能需要一两分钟）</span>
    </div>

    <div class="pg-actions">
      <button class="primary" :disabled="scanning" @click="scan">{{ scanning ? '扫描中…' : '重新扫描' }}</button>
    </div>
    <div v-if="toast" class="pg-toast">{{ toast }}</div>

    <div v-if="groups && !groups.length && !scanning" class="pg-empty">未发现相似图片</div>
    <div v-else-if="groups" class="gwrap">
      <div v-for="(g, gi) in groups" :key="g.hash" class="grp">
        <div class="grp-head">
          <span class="grp-title">第 {{ gi + 1 }} 组 · {{ g.images.length }} 张 · 共 {{ formatBytes(g.images.reduce((n, x) => n + x.sizeBytes, 0)) }}</span>
          <span class="dim" style="font-size: 11px">建议保留一张，其余送回收站</span>
        </div>
        <div v-for="(img, ii) in g.images" :key="img.path" class="irow" :class="{ keep: ii === 0 }">
          <span class="mono" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="img.path">{{ img.path }}</span>
          <span class="mono dim" style="flex: none">{{ formatBytes(img.sizeBytes) }}</span>
          <span v-if="ii === 0" class="badge" style="color: var(--success)">建议保留</span>
          <button v-else class="ghost irow-btn" style="color: var(--danger)" :disabled="busyPath === img.path" @click="trash(img.path)">
            {{ busyPath === img.path ? '处理中…' : '送回收站' }}
          </button>
        </div>
      </div>
    </div>
    <div class="dim pg-foot">删除走系统回收站，可还原。扫描为只读操作。</div>
  </div>
</template>

<style scoped>
@import './page.css';
.gwrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.grp {
  background: var(--panel);
  border: 1px solid var(--border-hair);
  border-radius: 10px;
  padding: 10px 12px;
}
.grp-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-hair);
}
.grp-title {
  font-size: 12px;
  color: var(--text);
  font-weight: 500;
}
.irow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  font-size: 12px;
  border-bottom: 1px solid var(--border-hair);
}
.irow:last-child {
  border-bottom: none;
}
.irow.keep {
  background: var(--accent-soft);
  border-radius: 6px;
  padding-left: 6px;
  padding-right: 6px;
}
.irow-btn {
  flex: none;
}
</style>
