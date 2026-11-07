<script setup lang="ts">
/**
 * v5.0 仪表盘首页：指标卡 + 快捷动作 + 系统动态。
 * 数据策略：本地快数据直取（隔离区计数/定时清理记录/自启动枚举），重扫描数据由 App 注入。
 */
import { onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { StartupEntry } from '@shared/startup'

const props = defineProps<{ junkTotal: number; softwareCount: number; junkItems: number }>()
const emit = defineEmits<{
  navigate: [view: string]
  'rescan-software': []
  'rescan-junk': []
}>()

const quarCount = ref(0)
const startupCount = ref<number | null>(null)
const startupUnsigned = ref(0)
const schedInfo = ref<{ lastRunAt: number; lastCleaned: number; lastFreedBytes: number } | null>(null)
const recent = ref<{ name: string; path: string; at: number }[]>([])
const upgradeCount = ref<number | null>(null)

onMounted(async () => {
  void window.api.quarantineCount().then((n) => (quarCount.value = n)).catch(() => {})
  try {
    const list: StartupEntry[] = await window.api.startupList()
    startupCount.value = list.length
    startupUnsigned.value = list.filter((x) => !x.fileExists || x.signStatus === 'unsigned').length
  } catch {
    startupCount.value = null
  }
  try {
    schedInfo.value = await window.api.junkScheduleInfo()
  } catch {
    /* ignore */
  }
  try {
    recent.value = await window.api.dashRecent()
  } catch {
    /* ignore */
  }
  // v5.1 N4：升级数懒加载（winget 查询较慢，后台补数）
  void window.api
    .wingetList()
    .then((ups) => (upgradeCount.value = ups.length))
    .catch(() => (upgradeCount.value = null))
})

async function launchRecent(path: string): Promise<void> {
  await window.api.appLaunch({ path })
  recent.value = await window.api.dashRecent().catch(() => recent.value)
}

function fmtWhen(ts: number): string {
  if (!ts) return '尚未运行'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="dh">
    <div class="dh-hello">
      <span class="dh-title">概览</span>
      <span class="dim">已收录 {{ softwareCount }} 个软件 · 数据随时可扫描刷新</span>
    </div>

    <div class="dh-cards">
      <button class="dh-card" title="进入清理视图" @click="emit('navigate', 'junk')">
        <span class="dh-label">磁盘可释放</span>
        <span class="dh-val mono" style="color: var(--accent)">{{ formatBytes(junkTotal) }}</span>
        <span class="dh-sub">{{ junkItems > 0 ? `${junkItems} 项待审阅` : '扫描后显示' }}</span>
      </button>
      <button class="dh-card" title="进入软件图谱" @click="emit('navigate', 'graph')">
        <span class="dh-label">已收录软件</span>
        <span class="dh-val mono">{{ softwareCount }}</span>
        <span class="dh-sub">图谱与依赖分析</span>
      </button>
      <button class="dh-card" title="进入自启动管理" @click="emit('navigate', 'startup')">
        <span class="dh-label">自启动项</span>
        <span class="dh-val mono">{{ startupCount ?? '…' }}</span>
        <span class="dh-sub" :style="startupUnsigned ? 'color:var(--warning)' : ''">
          {{ startupUnsigned ? `${startupUnsigned} 项需关注` : '加载中或全部正常' }}
        </span>
      </button>
      <button class="dh-card" title="打开隔离区" @click="emit('navigate', 'junk')">
        <span class="dh-label">隔离区保留</span>
        <span class="dh-val mono">{{ quarCount }}</span>
        <span class="dh-sub">可还原</span>
      </button>
    </div>

    <div class="dh-actions">
      <button class="primary dh-act" @click="emit('rescan-junk')">垃圾扫描</button>
      <button class="dh-act" @click="emit('rescan-software')">重新扫描软件</button>
      <button class="dh-act" @click="emit('navigate', 'treemap')">▦ 空间树图</button>
      <button class="dh-act" @click="emit('navigate', 'market')">插件市场</button>
    </div>

    <div v-if="recent.length" class="dh-recent">
      <div class="dh-feed-title">常用软件</div>
      <div class="dh-chips">
        <button v-for="r in recent.slice(0, 6)" :key="r.path" class="dh-chip" :title="r.path" @click="launchRecent(r.path)">
          ▶ {{ r.name }}
        </button>
      </div>
    </div>

    <div class="dh-feed">
      <div class="dh-feed-title">系统动态</div>
      <div v-if="upgradeCount !== null" class="dh-row">
        <span class="dh-dot" :style="{ background: upgradeCount > 5 ? 'var(--warning)' : 'var(--accent)' }"></span>
        <span>
          可升级软件 {{ upgradeCount }} 个
          <button class="ghost" style="margin-left: 8px; padding: 2px 8px" @click="emit('navigate', 'upgrade')">去升级 →</button>
        </span>
      </div>
      <div class="dh-row">
        <span class="dh-dot" style="background: var(--accent)"></span>
        <span>上次定时清理：{{ fmtWhen(schedInfo?.lastRunAt ?? 0) }}{{ schedInfo?.lastCleaned ? ` · 清理 ${schedInfo.lastCleaned} 项 / ${formatBytes(schedInfo.lastFreedBytes)}` : '' }}</span>
      </div>
      <div class="dh-row">
        <span class="dh-dot" style="background: var(--text-3)"></span>
        <span>应用更新与升级发现会在这里与系统通知同步出现</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dh {
  max-width: 980px;
  margin: 0 auto;
  padding: 26px 30px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.dh-hello {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.dh-title {
  font-size: 16px;
  font-weight: 500;
}
.dh-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.dh-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.dh-card:hover {
  border-color: var(--accent);
}
.dh-label {
  font-size: 12px;
  color: var(--text-3);
}
.dh-val {
  font-size: 19px;
  font-weight: 500;
}
.dh-sub {
  font-size: 11px;
  color: var(--text-3);
}
.dh-actions {
  display: flex;
  gap: 10px;
}
.dh-act {
  padding: 8px 16px;
  border-radius: 8px;
}
.dh-feed {
  background: var(--panel);
  border: 1px solid var(--border-hair);
  border-radius: 10px;
  padding: 6px 16px 12px;
}
.dh-feed-title {
  font-size: 12px;
  color: var(--text-3);
  padding: 8px 0 4px;
}
.dh-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 0;
  font-size: 12px;
  color: var(--text-2);
  border-top: 1px solid var(--border-hair);
}
.dh-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.dh-recent {
  background: var(--panel);
  border: 1px solid var(--border-hair);
  border-radius: 10px;
  padding: 6px 16px 12px;
}
.dh-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0 6px;
}
.dh-chip {
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 5px 13px;
  font-size: 12px;
  background: var(--surface-2);
  color: var(--text);
}
.dh-chip:hover:not(:disabled) {
  border-color: var(--accent);
}
</style>
