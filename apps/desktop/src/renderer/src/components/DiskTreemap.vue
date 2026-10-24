<script setup lang="ts">
/**
 * v4.1 S2：磁盘空间树图（squarified treemap，支持下钻与文件回收）。
 * 内嵌于垃圾清理主视图（覆盖层）。
 */
import { computed, ref } from 'vue'
import { formatBytes } from '@shared/util'
import { squarify, type TreemapItem, type TreemapRect } from '@shared/squarify'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const W = 900
const H = 560

const rootPath = ref('')
const pathInput = ref('')
const loading = ref(false)
const errText = ref('')
const stack = ref<{ name: string; path: string; items: TreemapItem[] }[]>([])
const selRect = ref<TreemapRect | null>(null)
const toast = ref('')

const current = computed(() => stack.value[stack.value.length - 1] ?? null)
const rects = computed(() => {
  if (!current.value) return []
  return squarify(current.value.items, W, H)
})
const crumbs = computed(() => stack.value.map((s) => ({ name: s.name, path: s.path })))

const QUICK = ['C:\\Users\\%USERNAME%\\Downloads', 'C:\\Users\\%USERNAME%\\Documents']

function expandUser(p: string): string {
  return p.replace(/%USERNAME%/i, window.navigator.userAgent.includes('') ? '' : '').replace(/^~/, '')
}

async function scan(dir: string): Promise<void> {
  loading.value = true
  errText.value = ''
  selRect.value = null
  try {
    const r = await window.api.diskTreemap({ root: dir, depth: 2 })
    if (!r.ok || !r.node) {
      errText.value = r.error ?? '扫描失败'
      return
    }
    const node = r.node as { name: string; path: string; children?: TreemapItem[] }
    const items = (node.children ?? []).map((c) => ({
      name: c.name,
      sizeBytes: Number(c.sizeBytes),
      path: c.path,
      isDir: Boolean(c.isDir)
    }))
    if (stack.value.length === 0) {
      stack.value = [{ name: node.name || node.path, path: node.path, items }]
    } else {
      stack.value.push({ name: node.name || node.path, path: node.path, items })
    }
    pathInput.value = node.path
    rootPath.value = node.path
  } catch (e) {
    errText.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function open(): void {
  const dir = pathInput.value.trim() || rootPath.value
  if (!dir) return
  stack.value = []
  void scan(dir)
}

function clickRect(r: TreemapRect): void {
  if (r.item.isDir) {
    selRect.value = null
    void scan(r.item.path)
  } else {
    selRect.value = r
  }
}

function popTo(i: number): void {
  stack.value = stack.value.slice(0, i + 1)
}

async function trashSel(): Promise<void> {
  const p = selRect.value?.item.path
  if (!p) return
  const r = await window.api.imageTrash(p) // shell.trashItem 通用回收站通道
  toast.value = r.ok ? '已送回收站' : '送回收站失败'
  if (r.ok) {
    selRect.value = null
    // 刷新当前层
    const cur = current.value?.path
    if (cur) {
      stack.value = stack.value.slice(0, -1)
      await scan(cur)
    }
  }
}

async function revealSel(): Promise<void> {
  const p = selRect.value?.item.path
  if (p) await window.api.reveal({ path: p })
}

const colorFor = (r: TreemapRect): string => {
  const hue = 187 - Math.min(r.item.sizeBytes / (current.value?.items[0]?.sizeBytes || 1), 1) * 40
  return `hsl(${hue} 70% ${r.item.isDir ? 30 : 38}%)`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dt-mask" @click.self="emit('close')">
      <div class="dt-panel">
        <header class="dt-head">
          <h3>空间树图</h3>
          <input
            v-model="pathInput"
            class="dt-path mono"
            type="text"
            placeholder="输入目录，如 C:\\Users\\you\\Downloads"
            @keydown.enter="open"
          />
          <button class="ghost" :disabled="loading || !pathInput.trim()" @click="open">
            {{ loading ? '扫描中…' : '分析' }}
          </button>
          <button class="ghost" @click="emit('close')">✕</button>
        </header>
        <div class="dt-crumbs">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i > 0">›</span>
            <button class="ghost crumb" @click="popTo(i)">{{ c.name }}</button>
          </template>
        </div>
        <div v-if="errText" class="dt-err">{{ errText }}</div>
        <div v-else-if="!current && !loading" class="dt-empty">
          <p>输入要分析的目录（含 %USERNAME% 占位符自动展开）。</p>
          <p class="dim">目录块点击下钻 · 文件块点击查看操作 · 大小按面积呈现（Squarified Treemap）</p>
        </div>
        <div v-else class="dt-stage" :style="{ width: W + 'px', height: H + 'px' }">
          <div
            v-for="(r, i) in rects"
            :key="r.item.path + i"
            class="dt-cell"
            :class="{ dir: r.item.isDir, sel: selRect?.item.path === r.item.path }"
            :style="{
              left: r.x + 'px', top: r.y + 'px', width: Math.max(r.w - 2, 1) + 'px', height: Math.max(r.h - 2, 1) + 'px',
              background: colorFor(r)
            }"
            :title="`${r.item.name} · ${formatBytes(r.item.sizeBytes)}${r.item.isDir ? '（点击下钻）' : '（点击查看操作）'}`"
            @click="clickRect(r)"
          >
            <span v-if="r.w > 56 && r.h > 24" class="dt-name">{{ r.item.name }}</span>
            <span v-if="r.w > 56 && r.h > 44" class="dt-size">{{ formatBytes(r.item.sizeBytes) }}</span>
          </div>
        </div>
        <footer v-if="selRect" class="dt-ops">
          <span class="mono">{{ selRect.item.path }}</span>
          <span style="flex:1"></span>
          <span style="font-size:12px">{{ formatBytes(selRect.item.sizeBytes) }}</span>
          <button class="ghost" @click="revealSel">打开位置</button>
          <button class="ghost" style="color:var(--danger)" @click="trashSel">送回收站</button>
        </footer>
        <div v-if="toast" class="dt-toast">{{ toast }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dt-mask { position: fixed; inset: 0; z-index: 95; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; }
.dt-panel {
  width: min(960px, 96vw); background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 14px; display: flex; flex-direction: column; gap: 8px;
}
.dt-head { display: flex; gap: 8px; align-items: center; }
.dt-head h3 { margin: 0; font-size: 14px; }
.dt-path { flex: 1; background: transparent; border: 1px solid var(--border); border-radius: 8px; color: inherit; padding: 5px 10px; font-size: 12px; }
.dt-crumbs { display: flex; gap: 6px; align-items: center; font-size: 12px; min-height: 24px; flex-wrap: wrap; }
.dt-err, .dt-empty { padding: 30px; text-align: center; color: var(--text-2); }
.dt-stage { position: relative; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; max-width: 100%; }
.dt-cell {
  position: absolute; overflow: hidden; cursor: pointer; display: flex; flex-direction: column;
  padding: 4px; color: #e2e8f0; border: 1px solid rgba(0, 0, 0, 0.25); box-sizing: border-box;
}
.dt-cell:hover { outline: 2px solid var(--accent-2, #22d3ee); }
.dt-cell.dir .dt-name { font-weight: 500; }
.dt-cell.sel { outline: 2px solid #fff; }
.dt-name { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-size { font-size: 10px; opacity: 0.75; }
.dt-ops { display: flex; gap: 8px; align-items: center; font-size: 12px; min-height: 30px; }
.dt-toast { font-size: 12px; color: var(--accent-2, #22d3ee); }
button.ghost { background: transparent; border: 1px solid var(--border); border-radius: 8px; color: inherit; padding: 4px 10px; cursor: pointer; font-size: 12px; }
</style>
