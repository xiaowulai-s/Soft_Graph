<script setup lang="ts">
/**
 * 预览扫描阶段：订阅主进程 onBackupPreviewProgress（400ms），
 * vivid 档加扫描波纹、雷达脉冲与路径淡入；calm 档只保留数字与文字（数字缓动两档都有）。
 */
import { computed } from 'vue'
import { cancelPreview, dmPreviewProgress, dmSyncPreparing } from './dmState'
import { isVivid } from './dmMotion'
import DmNum from './DmNum.vue'

const files = computed(() => dmPreviewProgress.value?.files ?? 0)
const current = computed(() => dmPreviewProgress.value?.current || '')
</script>

<template>
  <div v-if="dmSyncPreparing" class="dm-preview-progress" :class="{ vivid: isVivid }">
    <span class="dm-preview-dot" />
    <strong>正在预览差异</strong>
    <span class="dm-preview-count">已扫描 <DmNum :value="files" /> 个文件</span>
    <span
      :key="current"
      class="dm-mono dm-ellipsis dm-preview-path"
      :title="current"
    >{{ current || '准备中…' }}</span>
    <button class="dm-btn sm" @click="cancelPreview">取消预览</button>
    <span class="dm-preview-wave" aria-hidden="true" />
  </div>
</template>
