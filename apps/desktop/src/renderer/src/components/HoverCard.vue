<script setup lang="ts">
/**
 * 悬停详情浮层
 * 对应技术设计方案 5.4.4 —— 需求中明确要求的核心交互。
 * 七个区块严格按文档表格实现：标题 / 路径 / 属性 / 关系 / 归属 / 安全 / 操作。
 * 「完整路径可一键复制」是需求原文的硬要求。
 */
import { computed } from 'vue'
import type { GraphEdge, GraphNode } from '@shared/types'
import { DEP_TYPE_LABEL, EVIDENCE_LABEL, GROUP_LABEL } from '@shared/types'
import { formatBytes, formatTime, isSharedRuntime } from '@shared/util'

const props = defineProps<{
  node: GraphNode
  edge: GraphEdge | null
  x: number
  y: number
  /** 视口尺寸，用于靠边自动翻转 */
  vw: number
  vh: number
  pinned: boolean
}>()

const emit = defineEmits<{
  (e: 'copy', text: string): void
  (e: 'reveal', path: string): void
  (e: 'focus', id: string): void
  (e: 'close'): void
}>()

const CARD_W = 356
const CARD_H_EST = 232

/** 浮层在鼠标右下方跟随，靠近边缘自动翻转（8.2 悬停态） */
const pos = computed(() => {
  const pad = 14
  let left = props.x + pad
  let top = props.y + pad
  if (left + CARD_W > props.vw - 8) left = props.x - CARD_W - pad
  if (top + CARD_H_EST > props.vh - 8) top = Math.max(8, props.y - CARD_H_EST - pad)
  return { left: `${Math.max(8, left)}px`, top: `${Math.max(8, top)}px` }
})

const file = computed(() => props.node.file)

const kindLabel = computed(() => {
  const n = props.node
  if (n.type === 'group') return '聚合'
  const k = n.file?.kind ?? 'data'
  return (
    { exe: 'EXE', dll: 'DLL', ocx: 'OCX', data: 'DATA', config: 'CONFIG', plugin: 'PLUGIN', resource: 'RES' } as Record<
      string,
      string
    >
  )[k]
})

const relation = computed(() => {
  if (!props.edge) return '—'
  const t = DEP_TYPE_LABEL[props.edge.type] ?? props.edge.type
  return `${t}（${props.edge.evidence.map((e) => EVIDENCE_LABEL[e] ?? e).join(' + ')}）`
})

const confidenceTone = computed(() => {
  const c = props.edge?.confidence ?? 0
  return c >= 0.75 ? 'risk-low' : c >= 0.5 ? 'risk-medium' : 'risk-hint'
})

const ownership = computed(() => {
  const f = file.value
  if (!f) return '—'
  if (f.missing) return '缺失依赖'
  const parts: string[] = []
  if (isSharedRuntime(f.name)) parts.push('共享运行库')
  const rc = f.refCount ?? 0
  parts.push(rc > 1 ? `被 ${rc} 个软件引用` : '专属依赖')
  return parts.join(' · ')
})

const signText = computed(() => {
  const f = file.value
  if (!f) return '—'
  if (f.signStatus === 'signed') return '已签名'
  if (f.signStatus === 'unsigned') return '未签名'
  return '未查询'
})

const parseNote = computed(() => {
  const f = file.value
  if (!f) return ''
  if (f.parseStatus === 'failed') return '未能解析（可能加壳，已降级为目录归属证据）'
  return ''
})
</script>

<template>
  <div class="hover-card" :style="pos" @mouseenter="$event.stopPropagation()">
    <!-- 区块 1：标题 —— 文件名 + 类型徽标 -->
    <div class="hc-head">
      <span class="hc-name sel">{{ node.label }}</span>
      <span class="badge">{{ kindLabel }}</span>
      <span v-if="node.type === 'group'" class="badge">{{ node.collapsedCount }} 项</span>
      <button v-if="pinned" class="ghost hc-x" title="关闭" @click="emit('close')">✕</button>
    </div>

    <template v-if="node.type === 'group'">
      <div class="hc-row">
        <span class="hc-k">分组</span>
        <span class="hc-v">{{ GROUP_LABEL[node.policy!] }}</span>
      </div>
      <div class="hc-row">
        <span class="hc-k">收纳</span>
        <span class="hc-v">{{ node.collapsedCount }} 个文件</span>
      </div>
      <div class="hc-hint">双击可展开该分组</div>
    </template>

    <template v-else-if="file">
      <!-- 区块 2：路径 —— 完整路径（可复制） -->
      <div class="hc-path-block">
        <div class="hc-k">完整路径</div>
        <div class="hc-path mono sel" :class="{ missing: file.missing }">{{ file.fullPath }}</div>
        <button class="ghost hc-copy" @click="emit('copy', file.fullPath)">复制路径</button>
      </div>

      <!-- 区块 3：属性 —— 大小 / 修改时间 / 版本 -->
      <div class="hc-row">
        <span class="hc-k">属性</span>
        <span class="hc-v">
          {{ file.missing ? '—' : formatBytes(file.sizeBytes) }}
          <template v-if="!file.missing"> · {{ formatTime(file.mtime) }}</template>
          <template v-if="file.version"> · {{ file.version }}</template>
          <template v-if="file.arch"> · {{ file.arch }}</template>
        </span>
      </div>

      <!-- 区块 4：关系 —— 关系类型 + 置信度 -->
      <div class="hc-row">
        <span class="hc-k">关系</span>
        <span class="hc-v">
          {{ relation }}
          <span v-if="edge" :class="confidenceTone">· 置信度 {{ edge.confidence.toFixed(2) }}</span>
        </span>
      </div>

      <!-- 区块 5：归属 —— 所属分组 / 是否共享 -->
      <div class="hc-row">
        <span class="hc-k">归属</span>
        <span class="hc-v">{{ ownership }}</span>
      </div>

      <!-- 区块 6：安全 —— 数字签名状态 -->
      <div class="hc-row">
        <span class="hc-k">安全</span>
        <span class="hc-v">{{ signText }}</span>
      </div>

      <div v-if="parseNote" class="hc-warn">{{ parseNote }}</div>
      <div v-if="file.missing" class="hc-warn danger">
        该文件未在标准搜索路径中找到，此软件可能无法正常启动
      </div>

      <!-- 区块 7：操作 —— 快捷按钮 -->
      <div class="hc-actions">
        <button class="ghost" :disabled="file.missing" @click="emit('reveal', file.fullPath)">打开所在目录</button>
        <button class="ghost" @click="emit('copy', file.fullPath)">复制路径</button>
        <button class="ghost" @click="emit('focus', node.id)">在图中聚焦</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hover-card {
  position: fixed;
  z-index: 90;
  width: 356px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 10px 12px 9px;
  pointer-events: auto;
}
.hc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 7px;
}
.hc-name {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hc-x {
  padding: 1px 5px;
  font-size: 11px;
}
.hc-path-block {
  background: var(--bg);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  margin-bottom: 7px;
  position: relative;
}
.hc-path {
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
  color: var(--text);
  margin-top: 2px;
  padding-right: 4px;
}
.hc-path.missing {
  color: var(--node-missing);
}
.hc-copy {
  margin-top: 5px;
  padding: 2px 7px;
  font-size: 11px;
}
.hc-row {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.7;
}
.hc-k {
  color: var(--text-2);
  width: 58px;
  flex: none;
  font-size: 11px;
}
.hc-v {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.hc-hint {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 6px;
}
.hc-warn {
  margin-top: 6px;
  font-size: 11px;
  color: var(--risk-medium);
  background: color-mix(in srgb, var(--risk-medium) 12%, transparent);
  border-radius: var(--radius-sm);
  padding: 5px 7px;
  line-height: 1.5;
}
.hc-warn.danger {
  color: var(--risk-high);
  background: color-mix(in srgb, var(--risk-high) 13%, transparent);
}
.hc-actions {
  display: flex;
  gap: 6px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--border-soft);
}
.hc-actions button {
  flex: 1;
  padding: 4px 6px;
  font-size: 11px;
}
</style>
