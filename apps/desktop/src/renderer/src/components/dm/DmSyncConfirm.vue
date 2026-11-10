<script setup lang="ts">
/**
 * DmSyncConfirm —— 审阅式同步确认框（最小改法）。
 * 「立即同步」不再直接跑全量扫描：先 backupPreview 列三区差异 → 展示 → 用户确认
 * 后才 backupExecute（requireFreshPreview:true）。只增改不删。
 */
import { computed } from 'vue'
import {
  cancelSync,
  confirmSync,
  dmSyncExecuting,
  dmSyncPlans,
  sizeText
} from './dmState'
import type { DmSyncPlan } from './dmState'
import DmNum from './DmNum.vue'
import { isVivid } from './dmMotion'

const plans = computed(() => dmSyncPlans.value)
const changedCount = computed(
  () => plans.value.filter((p) => p.result && p.result.add + p.result.update > 0).length
)
const totalBytes = computed(() =>
  plans.value.reduce((sum, p) => sum + (p.result?.bytesToAdd ?? 0), 0)
)

function samples(p: DmSyncPlan): string[] {
  if (!p.result) return []
  return [...p.result.sampleAdds, ...p.result.sampleUpdates]
    .map((s) => s.path)
    .slice(0, 5)
}
</script>

<template>
  <div v-if="plans.length" class="dm-sync-mask" @click.self="cancelSync">
    <div class="dm-sync-dialog" :class="{ vivid: isVivid }" role="dialog" aria-label="同步差异确认">
      <div class="dm-sync-head">
        <h2>同步差异确认</h2>
        <span>先列出差异，确认后才执行；只新增 / 覆盖更新，不删除目标多出的文件。</span>
      </div>

      <div class="dm-sync-body">
        <div v-for="p in plans" :key="p.taskId" class="dm-sync-task">
          <div class="dm-sync-task-head">
            <span class="dm-group-name">{{ p.name }}</span>
            <span v-if="p.error" class="dm-badge mute">预览未完成</span>
            <span
              v-else-if="p.result && p.result.add + p.result.update + p.result.deleteExtra === 0"
              class="dm-badge ok"
            >已一致</span>
            <span v-else class="dm-badge warn">有差异</span>
            <span v-if="p.result" class="dm-hint-text">{{ sizeText(p.result.bytesToAdd) }} 待写入</span>
          </div>

          <div v-if="p.error" class="dm-hint-text">{{ p.error }}</div>
          <template v-else-if="p.result">
            <div class="dm-sync-stats">
              <div><label>新增</label><b><DmNum :value="p.result.add" /></b></div>
              <div><label>更新</label><b><DmNum :value="p.result.update" /></b></div>
              <div><label>目标多出</label><b><DmNum :value="p.result.deleteExtra" /></b></div>
              <div><label>已一致</label><b><DmNum :value="p.result.same" /></b></div>
            </div>
            <div v-if="samples(p).length" class="dm-sync-samples">
              <div v-for="(s, i) in samples(p)" :key="i" class="dm-sync-sample-row dm-mono dm-ellipsis" :title="s">
                {{ s }}
              </div>
              <div v-if="p.result.add + p.result.update > samples(p).length" class="dm-hint-text">
                … 其余 {{ p.result.add + p.result.update - samples(p).length }} 项未展开
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="dm-sync-foot">
        <span class="dm-hint-text">共 <DmNum :value="changedCount" /> 组需写入 · 预计写入 <DmNum :value="totalBytes" format="bytes" /></span>
        <div class="dm-inline">
          <button class="dm-btn" :disabled="dmSyncExecuting" @click="cancelSync">取消</button>
          <button
            class="dm-btn primary dm-confirm-pulse"
            :disabled="!changedCount || dmSyncExecuting"
            @click="confirmSync"
          >
            {{ dmSyncExecuting ? '启动中…' : `确认同步 ${changedCount} 组` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
