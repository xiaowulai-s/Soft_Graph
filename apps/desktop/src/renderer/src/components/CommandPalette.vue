<script setup lang="ts">
/**
 * v5.0 Ctrl+K 命令面板：全功能模糊搜索直达（视图 + 工具 + 高频动作）。
 * 键盘：↑↓ 选择 / Enter 执行 / Esc 关闭。
 */
import { computed, ref, watch, nextTick } from 'vue'
import { NAV_MODULES } from '../nav'

export interface PaletteRun {
  view: string
  tool?: string
  action?: 'treemap' | 'rescan-software' | 'rescan-junk'
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; run: [cmd: PaletteRun] }>()

interface Entry {
  label: string
  hint: string
  group: string
  cmd: PaletteRun
}

const ENTRIES: Entry[] = [
  ...NAV_MODULES.map((m) => ({ label: m.title, hint: m.desc, group: '视图', cmd: { view: m.id } as PaletteRun })),
  { label: '重新扫描软件', hint: '重建软件库与图谱', group: '动作', cmd: { view: 'graph', action: 'rescan-software' } },
  { label: '垃圾扫描', hint: '19 类规则全量扫描', group: '动作', cmd: { view: 'junk', action: 'rescan-junk' } }
]

const q = ref('')
const sel = ref(0)
const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return ENTRIES
  return ENTRIES.filter((e) => (e.label + e.hint + e.group).toLowerCase().includes(k))
})

watch(
  () => props.open,
  (v) => {
    if (v) {
      q.value = ''
      sel.value = 0
      window.addEventListener('keydown', onKey, true)
    } else {
      window.removeEventListener('keydown', onKey, true)
    }
  }
)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    sel.value = Math.min(sel.value + 1, filtered.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    sel.value = Math.max(sel.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runAt(sel.value)
  }
}

async function runAt(i: number): Promise<void> {
  const e = filtered.value[i]
  if (!e) return
  emit('run', e.cmd)
  emit('close')
  await nextTick()
}

function onInput(): void {
  sel.value = 0
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cp-mask" @click.self="emit('close')">
      <div class="cp">
        <input v-model="q" class="cp-input" type="text" placeholder="输入功能、工具或动作…" autofocus @input="onInput" />
        <div class="cp-list">
          <div v-if="!filtered.length" class="cp-empty">没有匹配项</div>
          <button
            v-for="(e, i) in filtered"
            :key="e.label"
            class="cp-item"
            :class="{ on: i === sel }"
            @click="runAt(i)"
            @mousemove="sel = i"
          >
            <span class="cp-group">{{ e.group }}</span>
            <span class="cp-label">{{ e.label }}</span>
            <span class="cp-hint">{{ e.hint }}</span>
          </button>
        </div>
        <div class="cp-foot">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cp-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(10, 22, 34, 0.35);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
}
.cp {
  width: min(640px, 92vw);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.cp-input {
  width: 100%;
  border: none !important;
  border-bottom: 1px solid var(--border-hair) !important;
  border-radius: 0 !important;
  padding: 13px 16px !important;
  font-size: 14px !important;
  background: var(--panel) !important;
  box-shadow: none !important;
}
.cp-list {
  max-height: 46vh;
  overflow: auto;
  padding: 6px;
}
.cp-empty {
  padding: 26px;
  text-align: center;
  color: var(--text-3);
}
.cp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 8px;
  padding: 9px 10px;
}
.cp-item.on {
  background: var(--accent-soft);
}
.cp-group {
  flex: none;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border-hair);
  border-radius: 4px;
  padding: 2px 5px;
}
.cp-label {
  font-size: 13px;
  color: var(--text);
  flex: none;
}
.cp-hint {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-foot {
  padding: 7px 14px;
  font-size: 11px;
  color: var(--text-3);
  border-top: 1px solid var(--border-hair);
}
</style>
