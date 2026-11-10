<script setup lang="ts">
/**
 * v5.0 工具箱：行式列表页（状态摘要 + 计数徽标），行直达详情。
 * 自启动管理 = 内置面板（v4.0 服务首次获得 UI）；其余工具复用 MaintenanceCenter 对应组（:key 重挂载）。
 * 插件市场在浮窗设置内 —— 交由 App 打开浮窗抽屉。
 */
import { onMounted, ref, watch } from 'vue'
import type { StartupEntry, StartupSource } from '@shared/startup'
import MaintenanceCenter from './MaintenanceCenter.vue'

const props = defineProps<{ /** App 侧跳转指令（`tool#序号`，序号防同值不触发） */ jumpTool?: string }>()
const emit = defineEmits<{ 'open-market': []; 'open-manifest': [] }>()

const tool = ref<string | null>(null)

const ROWS: { id: string; name: string; desc: string; mcTab?: string }[] = [
  { id: 'startup', name: '自启动管理', desc: '注册表 Run / 启动文件夹，可逆启停' },
  { id: 'software', name: '软件升级管家', desc: 'winget 可升级列表 · 提权重试', mcTab: 'software' },
  { id: 'registry', name: '注册表残留', desc: '卸载表死条目检测与删除', mcTab: 'software' },
  { id: 'manifest', name: '装机清单', desc: '导出 CSV / winget 批量安装脚本（跳转图谱视图）' },
  { id: 'cleanup', name: '定时清理调度', desc: '周期 · 空闲窗口 · 上次执行', mcTab: 'cleanup' },
  { id: 'market', name: '插件市场', desc: '官方索引 · 一键安装浮窗插件' }
]

// ── 自启动面板（v4.0 S1 的 UI 补全） ──
const entries = ref<StartupEntry[] | null>(null)
const loadErr = ref('')
const busyId = ref('')
const toast = ref('')

async function loadStartup(): Promise<void> {
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
    if (r.ok) {
      toast.value = `${e.name} 已${e.enabled ? '禁用' : '启用'}`
      await loadStartup()
    } else {
      toast.value = `失败：${r.error ?? '未知原因'}`
    }
  } catch (err) {
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

onMounted(() => {
  if (tool.value === 'startup') void loadStartup()
})

watch(
  () => props.jumpTool,
  (v) => {
    if (v) open(v.split('#')[0])
  }
)

function open(t: string): void {
  if (t === 'manifest') {
    tool.value = null
    emit('open-manifest')
    return
  }
  tool.value = t
  if (t === 'startup') void loadStartup()
  if (t === 'market') {
    tool.value = null
    emit('open-market')
  }
}
function back(): void {
  tool.value = null
}
</script>

<template>
  <div class="tbx">
    <template v-if="!tool">
      <div class="tbx-head">
        <span class="tbx-title">工具箱</span>
        <span class="dim">{{ ROWS.length }} 个工具 · Ctrl+K 可直达</span>
      </div>
      <div class="tbx-list">
        <button v-for="r in ROWS" :key="r.id" class="tbx-row" @click="open(r.id)">
          <span class="tbx-name">{{ r.name }}</span>
          <span class="tbx-desc">{{ r.desc }}</span>
          <span class="tbx-arrow">▸</span>
        </button>
      </div>
    </template>

    <template v-else>
      <div class="tbx-head">
        <button class="ghost" @click="back">‹ 返回工具箱</button>
        <span class="tbx-title" style="margin-left: 8px">{{ ROWS.find((r) => r.id === tool)?.name }}</span>
      </div>

      <!-- 自启动管理（内置面板） -->
      <div v-if="tool === 'startup'" class="tbx-body">
        <div v-if="loadErr" class="tbx-err">枚举失败：{{ loadErr }}</div>
        <div v-else-if="!entries" class="dim" style="padding: 30px; text-align: center">枚举中…（注册表 + 启动文件夹 + 签名检测）</div>
        <div v-else-if="!entries.length" class="dim" style="padding: 30px; text-align: center">没有发现自启动项</div>
        <div v-else class="tbx-su">
          <div v-for="e in entries" :key="e.id" class="tbx-su-row" :class="{ off: !e.enabled }">
            <span
              class="tbx-dot"
              :style="{ background: !e.fileExists ? 'var(--danger)' : e.signStatus === 'signed' ? 'var(--success)' : e.signStatus === 'unsigned' ? 'var(--text-3)' : 'var(--warning)' }"
              :title="!e.fileExists ? '目标文件缺失' : e.signStatus === 'signed' ? `已签名：${e.signer}` : e.signStatus === 'unsigned' ? '未签名' : '签名未知'"
            ></span>
            <div style="flex: 1; min-width: 0">
              <div class="tbx-su-name">
                {{ e.name }}
                <span class="badge">{{ SOURCE_LABEL[e.source] }}</span>
                <span v-if="e.needsElevation" class="badge" title="改动需管理员权限">UAC</span>
                <span v-if="!e.fileExists" class="badge" style="color: var(--danger)">目标缺失</span>
              </div>
              <div class="tbx-su-cmd mono" :title="e.command">{{ e.command || e.exePath }}</div>
            </div>
            <label class="tbx-switch" :title="e.enabled ? '禁用（可逆）' : '启用'">
              <input type="checkbox" :checked="e.enabled" :disabled="busyId === e.id" @change="toggle(e)" />
              <span>{{ e.enabled ? '启用中' : '已禁用' }}</span>
            </label>
          </div>
          <div v-if="toast" class="tbx-toast">{{ toast }}</div>
          <div class="dim" style="font-size: 11px; padding: 10px 4px">
            禁用 = 移入 AutorunsDisabled（与 Sysinternals Autoruns 兼容），随时可逆；系统级项会弹 UAC。
          </div>
        </div>
      </div>

      <!-- 其余工具：复用维护中心对应组 -->
      <div v-else class="tbx-body">
        <MaintenanceCenter :key="tool" :page="true" :initial-tab="ROWS.find((r) => r.id === tool)?.mcTab ?? 'cleanup'" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.tbx {
  height: 100%;
  overflow: auto;
  padding: 22px 28px;
}
.tbx-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.tbx-title {
  font-size: 16px;
  font-weight: 500;
}
.tbx-list {
  max-width: 860px;
  display: flex;
  flex-direction: column;
}
.tbx-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-hair);
  border-radius: 0;
  padding: 14px 8px;
}
.tbx-row:hover:not(:disabled) {
  background: var(--hover);
  border-color: var(--border-hair);
}
.tbx-name {
  font-size: 13px;
  color: var(--text);
  flex: none;
  width: 130px;
}
.tbx-desc {
  flex: 1;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tbx-arrow {
  color: var(--text-3);
}
.tbx-body {
  max-width: 980px;
}
.tbx-err {
  color: var(--danger);
  padding: 20px 0;
}
.tbx-su {
  display: flex;
  flex-direction: column;
}
.tbx-su-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-hair);
}
.tbx-su-row.off {
  opacity: 0.55;
}
.tbx-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.tbx-su-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}
.tbx-su-cmd {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}
.tbx-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  flex: none;
}
.tbx-toast {
  padding: 8px 4px;
  font-size: 12px;
  color: var(--accent);
}
</style>
