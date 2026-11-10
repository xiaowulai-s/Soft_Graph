<script setup lang="ts">
/**
 * DmDashboard —— 软件总仪表盘（v6.2.3）。
 * 顶部一条紧凑全局状态栏（软件 / 垃圾 / 磁盘 / 备份），下方 12 张模块概览卡；
 * 「当前同步活动」与「同步拓扑」已迁到「备份同步」页，仪表盘不再是备份视角。
 * 轻数据启动拉取 + 60s 轮询；winget / 相似图片 / 树图为按需扫描，不拖慢启动。
 */
import { computed } from 'vue'
import DmModuleCard from './DmModuleCard.vue'
import {
  dmDrives,
  dmOverview,
  fmtTime,
  refreshOverview,
  scanOverview,
  sizeText
} from './dmState'

const emit = defineEmits<{ navigate: [view: string] }>()

const localDrive = computed(() => dmDrives.value.find((d) => d.driveType === 3) ?? dmDrives.value[0])
const diskUsage = computed(() => {
  const d = localDrive.value
  if (!d || !d.totalBytes) return '—'
  return `${Math.round(((d.totalBytes - d.freeBytes) / d.totalBytes) * 100)}%`
})

interface CardDef {
  key: string
  title: string
  status: string
  tone?: 'ok' | 'warn' | 'mute'
  target: string
  metrics: { label: string; value: string | number }[]
  scanLabel?: string
  scan?: 'winget' | 'images' | 'treemap'
}

const cards = computed<CardDef[]>(() => {
  const o = dmOverview.value
  const b = (n: number): string => sizeText(n)
  const when = (ts: number): string => (ts ? fmtTime(ts) : '尚无记录')
  return [
    {
      key: 'graph', title: '软件图谱', target: 'graph',
      status: o.software ? `${o.software} 款已收录` : '尚未扫描', tone: o.software ? 'ok' : 'mute',
      metrics: [
        { label: '收录软件', value: o.software },
        { label: '便携软件', value: o.portable },
        { label: '最近访问', value: o.recent }
      ]
    },
    {
      key: 'junk', title: '垃圾清理', target: 'junk',
      status: o.junkItems ? `${o.junkItems} 项待审阅` : '暂无待清理', tone: o.junkItems ? 'warn' : 'ok',
      metrics: [
        { label: '待审阅', value: o.junkItems },
        { label: '可回收', value: b(o.junkBytes) },
        { label: '清理规则', value: o.junkRules }
      ]
    },
    {
      key: 'startup', title: '自启动管理', target: 'startup',
      status: `${o.startupTotal} 项`, tone: 'mute',
      metrics: [
        { label: '启动项总数', value: o.startupTotal },
        { label: '已启用', value: o.startupEnabled },
        { label: '已禁用', value: Math.max(0, o.startupTotal - o.startupEnabled) }
      ]
    },
    {
      key: 'upgrade', title: '软件升级', target: 'upgrade',
      status: o.winget === null ? '未扫描' : o.winget ? `${o.winget} 款可升级` : '全部最新',
      tone: o.winget === null ? 'mute' : o.winget ? 'warn' : 'ok',
      metrics: [
        { label: '可升级', value: o.winget === null ? '—' : o.winget },
        { label: '数据源', value: 'winget' },
        { label: '检查方式', value: '按需' }
      ],
      scanLabel: o.winget === null ? '立即检查' : '重新检查', scan: 'winget'
    },
    {
      key: 'registry', title: '注册表残留', target: 'registry',
      status: o.registryBackups ? '备份可用' : '待检查',
      tone: o.registryBackups ? 'ok' : 'mute',
      metrics: [
        { label: '注册表备份', value: o.registryBackups },
        { label: '已收录软件', value: o.software },
        { label: '检查方式', value: '页内执行' }
      ]
    },
    {
      key: 'manifest', title: '装机清单', target: 'manifest',
      status: `${o.software} 款可导出`, tone: 'mute',
      metrics: [
        { label: '清单条目', value: o.software },
        { label: '导出格式', value: 'CSV / PS1' },
        { label: '最近访问', value: o.recent }
      ]
    },
    {
      key: 'treemap', title: '空间树图', target: 'treemap',
      status: o.treemapScanned ? '已扫描' : '未扫描', tone: o.treemapScanned ? 'ok' : 'mute',
      metrics: [
        { label: '已识别磁盘', value: dmDrives.value.length },
        { label: '系统盘占用', value: diskUsage.value },
        { label: '扫描方式', value: '按需' }
      ],
      scanLabel: '扫描目录', scan: 'treemap'
    },
    {
      key: 'images', title: '相似图片', target: 'images',
      status: o.similarGroups === null ? '未扫描' : `${o.similarGroups} 组重复`,
      tone: o.similarGroups === null ? 'mute' : o.similarGroups ? 'warn' : 'ok',
      metrics: [
        { label: '重复组', value: o.similarGroups === null ? '—' : o.similarGroups },
        { label: '可释放', value: b(o.similarBytes) },
        { label: '算法', value: 'aHash' }
      ],
      scanLabel: '开始查重', scan: 'images'
    },
    {
      key: 'schedule', title: '定时调度', target: 'schedule',
      status: o.backupEnabled ? `备份每 ${o.backupMinutes} 分钟` : '备份调度关闭',
      tone: o.backupEnabled ? 'ok' : 'mute',
      metrics: [
        { label: '备份间隔', value: `${o.backupMinutes} 分钟` },
        { label: '清理调度', value: o.junkScheduleOn ? `${o.junkHours} 小时` : '关闭' },
        { label: '上次清理', value: when(o.junkLastAt) }
      ]
    },
    {
      key: 'backup', title: '备份同步', target: 'dm-groups',
      status: o.backupErrors ? `${o.backupErrors} 项失败` : o.backupTasks ? '运行中' : '无任务',
      tone: o.backupErrors ? 'warn' : 'ok',
      metrics: [
        { label: '任务数', value: o.backupTasks },
        { label: '最近同步', value: when(o.backupLastAt ?? 0) },
        { label: '失败项', value: o.backupErrors }
      ]
    },
    {
      key: 'market', title: '插件市场', target: 'market',
      status: o.floatOn ? '浮窗已开启' : '浮窗关闭', tone: o.floatOn ? 'ok' : 'mute',
      metrics: [
        { label: '已装插件', value: o.plugins },
        { label: '浮窗状态', value: o.floatOn ? '开启' : '关闭' },
        { label: '插件目录', value: 'plugins/' }
      ]
    },
    {
      key: 'system', title: '系统状态', target: 'dm-settings',
      status: `v${o.version}`, tone: 'mute',
      metrics: [
        { label: '界面主题', value: o.theme === 'dark' ? '深色' : '浅色' },
        { label: '审计记录', value: o.audits },
        { label: '隔离区条目', value: o.quarantine }
      ]
    }
  ]
})

function onScan(kind: 'winget' | 'images' | 'treemap'): void {
  void scanOverview(kind)
}
function onRefresh(): void {
  void refreshOverview()
}
</script>

<template>
  <div class="dm-dashboard">
    <div class="dm-global-status">
      <div><span>收录软件</span><b>{{ dmOverview.software }}</b></div>
      <div><span>可回收垃圾</span><b>{{ sizeText(dmOverview.junkBytes) }}</b></div>
      <div><span>磁盘占用</span><b>{{ diskUsage }}</b></div>
      <div><span>备份任务</span><b>{{ dmOverview.backupTasks }}</b></div>
      <button class="dm-btn sm" title="刷新概览" @click="onRefresh">刷新</button>
    </div>

    <div class="dm-module-grid">
      <DmModuleCard
        v-for="c in cards"
        :key="c.key"
        :title="c.title"
        :status="c.status"
        :tone="c.tone"
        :target="c.target"
        :metrics="c.metrics"
        :scan-label="c.scanLabel"
        @navigate="emit('navigate', $event)"
        @scan="c.scan && onScan(c.scan)"
      />
    </div>
  </div>
</template>
