<script setup lang="ts">
/**
 * v3.1 维护中心 —— 定时清理 / 软件升级 / 隔离区管理 / 社区规则 的独立界面。
 * 功能代码自 SettingsDrawer 迁入（v3.1），设置抽屉只保留「应用更新 / 规则更新源」等全局设置。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { AppSettings } from '@shared/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const tab = ref<'schedule' | 'upgrades' | 'quarantine' | 'community'>('schedule')
const settings = ref<AppSettings>({
  portableRoots: [], portableThreshold: 55, excludePaths: [],
  quarantineKeepDaysLow: 7, quarantineKeepDaysHigh: 14, theme: 'dark',
  maxDepth: 2, enabledJunkCategories: [], advancedMode: false,
  allowDirectDelete: false, rulesUpdateUrl: '',
  junkSchedule: { enabled: false, intervalHours: 168 },
  float: { enabled: false, instances: [], theme: 'auto', opacity: 90 } as never
})

onMounted(async () => {
  try {
    settings.value = await window.api.getSettings()
  } catch {
    /* 保留默认值 */
  }
})

async function patch(p: Partial<AppSettings>): Promise<void> {
  settings.value = await window.api.setSettings(p)
}

// ── 定时静默清理 ──
const scheduleBusy = ref(false)
const scheduleText = ref('')
async function runScheduleNow(): Promise<void> {
  scheduleBusy.value = true
  try {
    const r = await window.api.junkScheduleRun()
    scheduleText.value = r.cleaned > 0 ? `已清理 ${r.cleaned} 项，释放 ${formatBytes(r.freedBytes)}` : '没有需要清理的项目'
  } catch (e) {
    scheduleText.value = `执行失败：${(e as Error).message}`
  } finally {
    scheduleBusy.value = false
  }
}

// ── 隔离区管理 ──
const shredBusy = ref(false)
const shredConfirm = ref(false)
const shredText = ref('')
const shredOk = ref(false)
async function doShredAll(): Promise<void> {
  shredBusy.value = true
  try {
    const list = await window.api.quarantineList()
    const r = await window.api.quarantineShred(list.map((x) => x.id))
    shredOk.value = r.failed.length === 0
    shredText.value = `粉碎完成：${r.ok} 项 / 释放 ${formatBytes(r.freed)}${r.failed.length ? `，失败 ${r.failed.length} 项` : ''}`
    shredConfirm.value = false
  } catch (e) {
    shredOk.value = false
    shredText.value = `粉碎失败：${(e as Error).message}`
  } finally {
    shredBusy.value = false
  }
}

// ── 软件升级管家（winget） ──
const upgrades = ref<{ id: string; name: string; version: string; available: string }[]>([])
const wingetBusy = ref(false)
const wingetUpgrading = ref(false)
const wingetText = ref('')
const wingetOk = ref(false)
const upgradeProgress = ref(0)
async function loadUpgrades(): Promise<void> {
  wingetBusy.value = true
  wingetText.value = ''
  try {
    upgrades.value = await window.api.wingetList()
    wingetOk.value = true
    wingetText.value = upgrades.value.length ? `发现 ${upgrades.value.length} 个可升级软件` : '所有软件均为最新（或 winget 未安装）'
  } catch (e) {
    wingetOk.value = false
    wingetText.value = `检查失败：${(e as Error).message}`
  } finally {
    wingetBusy.value = false
  }
}

async function upgradeOne(id: string): Promise<void> {
  wingetUpgrading.value = true
  wingetText.value = `正在升级 ${id} …`
  try {
    const r = await window.api.wingetUpgrade(id)
    wingetOk.value = r.ok
    wingetText.value = r.ok ? `${id} 升级完成` : `${id} 升级失败：${r.output ?? ''}`
    await loadUpgrades()
  } finally {
    wingetUpgrading.value = false
  }
}

async function upgradeAll(): Promise<void> {
  wingetUpgrading.value = true
  upgradeProgress.value = 0
  let okCount = 0
  for (const u of upgrades.value) {
    try {
      const r = await window.api.wingetUpgrade(u.id)
      if (r.ok) okCount++
    } catch {
      /* 单个失败不中断 */
    }
    upgradeProgress.value++
  }
  wingetOk.value = okCount === upgrades.value.length
  wingetText.value = `升级完成：成功 ${okCount} / ${upgrades.value.length}（部分软件可能需要重启生效）`
  wingetUpgrading.value = false
  upgrades.value = []
}

// ── Winapp2 社区规则导入 ──
const winapp2Busy = ref(false)
const winapp2Text = ref('')
const winapp2Ok = ref(false)
async function importWinapp2(): Promise<void> {
  winapp2Busy.value = true
  try {
    const r = await window.api.rulesImportWinapp2()
    winapp2Ok.value = true
    winapp2Text.value = r.imported
      ? `导入 ${r.imported} 条社区规则（跳过重复 ${r.skipped} 条），重新扫描即可看到`
      : '没有新规则可导入（可能已导入过或文件为空）'
  } catch (e) {
    winapp2Ok.value = false
    winapp2Text.value = `导入失败：${(e as Error).message}`
  } finally {
    winapp2Busy.value = false
  }
}

onBeforeUnmount(() => {
  /* 预留 */
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mc-mask" @click.self="emit('close')">
      <div class="mc-panel">
        <header class="mc-head">
          <h3>维护中心</h3>
          <button class="ghost" title="关闭" @click="emit('close')">✕</button>
        </header>

        <nav class="mc-tabs">
          <button :class="tab === 'schedule' ? 'active' : ''" @click="tab = 'schedule'">定时清理</button>
          <button :class="tab === 'upgrades' ? 'active' : ''" @click="tab = 'upgrades'">软件升级</button>
          <button :class="tab === 'quarantine' ? 'active' : ''" @click="tab = 'quarantine'">隔离区管理</button>
          <button :class="tab === 'community' ? 'active' : ''" @click="tab = 'community'">社区规则</button>
        </nav>

        <!-- 定时清理 -->
        <section v-if="tab === 'schedule'" class="mc-sec">
          <div class="mc-row">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input
                type="checkbox"
                :checked="settings.junkSchedule?.enabled"
                @change="patch({ junkSchedule: { enabled: ($event.target as HTMLInputElement).checked, intervalHours: settings.junkSchedule?.intervalHours ?? 168 } })"
              />
              启用定时静默清理（自动隔离清理，可在隔离区还原）
            </label>
          </div>
          <div class="mc-row">
            <span>执行周期</span>
            <select
              :value="settings.junkSchedule?.intervalHours ?? 168"
              :disabled="!settings.junkSchedule?.enabled"
              @change="patch({ junkSchedule: { enabled: settings.junkSchedule?.enabled ?? false, intervalHours: Number(($event.target as HTMLSelectElement).value) } })"
            >
              <option :value="24">每天</option>
              <option :value="72">每 3 天</option>
              <option :value="168">每周</option>
              <option :value="336">每两周</option>
            </select>
            <button class="ghost" :disabled="scheduleBusy" @click="runScheduleNow">
              {{ scheduleBusy ? '执行中…' : '立即执行一次' }}
            </button>
          </div>
          <div v-if="scheduleText" class="mc-hint">{{ scheduleText }}</div>
          <div class="mc-hint dim">清理范围 = 「一键清理」相同的安全白名单项（GC 低风险默认勾选类）。应用运行期间每 15 分钟检查一次是否到期。</div>
        </section>

        <!-- 软件升级 -->
        <section v-if="tab === 'upgrades'" class="mc-sec">
          <div class="mc-row">
            <button class="ghost" :disabled="wingetBusy" @click="loadUpgrades">{{ wingetBusy ? '检查中…' : '检查可升级软件' }}</button>
            <button v-if="upgrades.length" class="ghost" :disabled="wingetUpgrading" @click="upgradeAll">
              {{ wingetUpgrading ? `升级中（${upgradeProgress}/${upgrades.length}）…` : `全部升级（${upgrades.length}）` }}
            </button>
          </div>
          <div v-if="wingetText" class="mc-hint" :class="wingetOk ? '' : 'warn'">{{ wingetText }}</div>
          <ul v-if="upgrades.length" class="mc-list">
            <li v-for="u in upgrades" :key="u.id">
              <span class="name">{{ u.name }}</span>
              <span class="ver mono">{{ u.version }} → {{ u.available }}</span>
              <button class="ghost" :disabled="wingetUpgrading" @click="upgradeOne(u.id)">升级</button>
            </li>
          </ul>
          <div class="mc-hint dim">调用系统 winget 静默升级（--silent）；未安装 winget 或无网络时给出提示。</div>
        </section>

        <!-- 隔离区管理 -->
        <section v-if="tab === 'quarantine'" class="mc-sec">
          <div class="mc-row">
            <button class="ghost" :disabled="shredBusy || shredConfirm" @click="shredConfirm = true">彻底粉碎隔离区</button>
            <button v-if="shredConfirm" class="danger" @click="doShredAll">确认粉碎（不可恢复）</button>
            <button v-if="shredConfirm" class="ghost" @click="shredConfirm = false">取消</button>
          </div>
          <div v-if="shredText" class="mc-hint" :class="shredOk ? '' : 'warn'">{{ shredText }}</div>
          <div class="mc-hint dim">
            对隔离区全部内容先单遍随机覆写再删除（不可恢复）。还原请在垃圾扫描页的隔离区列表操作；
            原文件删除后的隔离副本通常已无敏感价值，确认粉碎前请三思。
          </div>
        </section>

        <!-- 社区规则 -->
        <section v-if="tab === 'community'" class="mc-sec">
          <div class="mc-row">
            <button class="ghost" :disabled="winapp2Busy" @click="importWinapp2">{{ winapp2Busy ? '导入中…' : '导入 Winapp2.ini' }}</button>
          </div>
          <div v-if="winapp2Text" class="mc-hint" :class="winapp2Ok ? '' : 'warn'">{{ winapp2Text }}</div>
          <div class="mc-hint dim">
            Winapp2 是社区维护的清理规则合集（数千条）。导入后每节生成一条独立规则
            （GC-101 起），全部「默认不勾选」，按节出现在垃圾扫描分类里，请逐项审阅后再勾选。
            支持重复导入（自动跳过已导入的节）。
          </div>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mc-mask {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center;
}
.mc-panel {
  width: min(720px, 92vw); max-height: 82vh; overflow: auto;
  background: var(--panel, #1e1e1e); color: var(--text, #ddd);
  border: 1px solid var(--border, #3a3a3a); border-radius: 12px;
  padding: 18px 22px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}
.mc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.mc-head h3 { margin: 0; font-size: 16px; }
.mc-tabs { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.mc-tabs button {
  background: transparent; border: 1px solid var(--border, #3a3a3a); color: inherit;
  border-radius: 8px; padding: 5px 14px; cursor: pointer; font-size: 13px;
}
.mc-tabs button.active { border-color: var(--accent, #0891b2); color: var(--accent, #22d3ee); }
.mc-sec { display: flex; flex-direction: column; gap: 10px; }
.mc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mc-row span { font-size: 13px; }
.mc-row select, .mc-row button, .mc-list button {
  background: transparent; border: 1px solid var(--border, #3a3a3a); color: inherit;
  border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 13px;
}
.mc-row select:disabled { opacity: 0.5; cursor: not-allowed; }
.mc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.mc-list li { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.mc-list .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-hint { font-size: 12px; line-height: 1.6; opacity: 0.85; }
.mc-hint.warn { color: #f59e0b; }
.mc-hint.dim { opacity: 0.6; }
.mono { font-family: Consolas, monospace; }
button.danger { border-color: #b91c1c; color: #f87171; }
button.ghost:hover, .mc-row button:hover { border-color: var(--accent, #0891b2); }
</style>
