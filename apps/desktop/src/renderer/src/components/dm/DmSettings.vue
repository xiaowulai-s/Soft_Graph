<script setup lang="ts">
/**
 * DmSettings —— 设置页（合并后不再有「常用参数 / 完整设置」双 Tab）。
 * 左栏是一套连续的设置内容：上方常用参数（不含备份调度），下方直接内嵌全量设置抽屉；
 * 备份定时调度已迁到「映射组」页的 DmScheduleBox，本页保存时不再回写 backupSchedule，
 * 避免把那边设定的间隔覆盖掉。右栏三张卡（运行机制 / 数据位置 / 关于）保持不变。
 */
import { ref, watch } from 'vue'
import type { AppSettings } from '@shared/types'
import SettingsDrawer from '../SettingsDrawer.vue'
import { dmSettings, dmVersion, pushDmToast, refreshDm } from './dmState'

const emit = defineEmits<{
  navigate: [view: string]
  theme: [v: 'dark' | 'light']
}>()

interface Form {
  theme: 'dark' | 'light'
  junkEnabled: boolean
  junkHours: number
  keepLow: number
  keepHigh: number
  advancedMode: boolean
  allowDirectDelete: boolean
  hotkeyLauncher: boolean
  rulesUpdateUrl: string
}

function fromSettings(s: AppSettings | null): Form {
  return {
    theme: s?.theme ?? 'light',
    junkEnabled: s?.junkSchedule?.enabled ?? false,
    junkHours: s?.junkSchedule?.intervalHours ?? 24,
    keepLow: s?.quarantineKeepDaysLow ?? 7,
    keepHigh: s?.quarantineKeepDaysHigh ?? 30,
    advancedMode: s?.advancedMode ?? false,
    allowDirectDelete: s?.allowDirectDelete ?? false,
    hotkeyLauncher: s?.hotkeyLauncher ?? false,
    rulesUpdateUrl: s?.rulesUpdateUrl ?? ''
  }
}

const form = ref<Form>(fromSettings(dmSettings.value))
const drawerTab = ref<'settings' | 'float' | 'quarantine' | 'registry' | 'rules' | 'about'>('settings')
const message = ref('')
const busy = ref(false)
const floatOn = ref(false)

watch(dmSettings, (s) => {
  form.value = fromSettings(s)
})

async function loadFloat(): Promise<void> {
  try {
    const s = await window.api.floatGetSettings()
    floatOn.value = !!s?.enabled
  } catch {
    floatOn.value = false
  }
}
void loadFloat()

async function toggleFloat(): Promise<void> {
  const next = !floatOn.value
  await window.api.floatToggle(next)
  floatOn.value = next
  pushDmToast('info', '桌面浮窗', next ? '已开启' : '已关闭')
}

async function save(): Promise<void> {
  busy.value = true
  try {
    const f = form.value
    // 注意：不写 backupSchedule，它由「映射组」页的调度区单独管理
    const patch: Partial<AppSettings> = {
      theme: f.theme,
      junkSchedule: {
        enabled: !!f.junkEnabled,
        intervalHours: Math.max(1, Number(f.junkHours) || 24),
        idleOnly: false
      },
      quarantineKeepDaysLow: Math.max(1, Number(f.keepLow) || 7),
      quarantineKeepDaysHigh: Math.max(1, Number(f.keepHigh) || 30),
      advancedMode: !!f.advancedMode,
      allowDirectDelete: !!f.allowDirectDelete,
      hotkeyLauncher: !!f.hotkeyLauncher,
      rulesUpdateUrl: String(f.rulesUpdateUrl).trim()
    }
    const next = await window.api.setSettings(patch)
    dmSettings.value = next
    document.documentElement.dataset.theme = next.theme
    emit('theme', next.theme)
    message.value = '设置已保存并立即生效'
    pushDmToast('success', '设置已保存', '参数已即时生效，无需重启')
    await refreshDm()
  } catch (e) {
    message.value = `保存失败：${(e as Error).message}`
  } finally {
    busy.value = false
    window.setTimeout(() => {
      message.value = ''
    }, 4000)
  }
}

/** 「关于」卡：真正执行一次更新检查，结果用 toast 反馈（下载/安装仍在全量设置里） */
const updateChecking = ref(false)
async function checkUpdate(): Promise<void> {
  if (updateChecking.value) return
  updateChecking.value = true
  try {
    const r = await window.api.appUpdateCheck()
    if (r.available) {
      pushDmToast('info', '发现新版本', `SoftGraph ${r.version ?? '新版本'} 可用，下载与安装请在「设置 → 关于」中完成`)
    } else {
      pushDmToast('success', '已是最新版本', `当前 v${dmVersion.value}，无需更新`)
    }
  } catch (e) {
    pushDmToast('error', '检查更新失败', (e as Error).message)
  } finally {
    updateChecking.value = false
  }
}

async function exportDiag(): Promise<void> {
  try {
    const r = await window.api.diagExport()
    pushDmToast('info', '导出诊断包', r ? `已导出：${String(r)}` : '导出已取消')
  } catch (e) {
    pushDmToast('error', '导出诊断包失败', (e as Error).message)
  }
}
</script>

<template>
  <div class="dm-split">
    <div class="dm-card dm-panel">
      <div class="dm-panel-head">
        <h2>设置</h2>
        <span class="dm-hint">修改后即时生效，无需重启</span>
      </div>

      <div class="dm-form-grid">
        <div class="dm-field">
          <label>界面主题</label>
          <select v-model="form.theme" class="dm-select">
            <option value="light">浅色（DiskMirror 基准）</option>
            <option value="dark">深色伴生</option>
          </select>
        </div>
        <div class="dm-field">
          <label>规则库在线更新源（HTTPS）</label>
          <input v-model="form.rulesUpdateUrl" class="dm-input dm-mono" placeholder="留空 = 禁用在线更新" />
        </div>
        <div class="dm-field">
          <label>定时静默清理间隔（小时）</label>
          <input v-model.number="form.junkHours" class="dm-input" type="number" min="1" />
        </div>
        <div class="dm-field">
          <label>隔离区保留天数（低风险）</label>
          <input v-model.number="form.keepLow" class="dm-input" type="number" min="1" />
        </div>
        <div class="dm-field">
          <label>隔离区保留天数（高风险）</label>
          <input v-model.number="form.keepHigh" class="dm-input" type="number" min="1" />
        </div>
        <div class="dm-field">
          <label>定时静默清理</label>
          <label class="dm-switch" style="margin-top: 6px">
            <input v-model="form.junkEnabled" type="checkbox" />
            <span class="dm-switch-track" />
            <span>到期自动扫描并隔离</span>
          </label>
        </div>
      </div>

      <div class="dm-divider" />
      <div class="dm-stack" style="gap: 12px">
        <label class="dm-switch">
          <input v-model="form.hotkeyLauncher" type="checkbox" />
          <span class="dm-switch-track" />
          <span>启用全局热键（Alt+G 聚焦主窗搜索）</span>
        </label>
        <label class="dm-switch">
          <input :checked="floatOn" type="checkbox" @change="toggleFloat" />
          <span class="dm-switch-track" />
          <span>桌面浮窗常驻显示</span>
        </label>
        <label class="dm-switch">
          <input v-model="form.advancedMode" type="checkbox" />
          <span class="dm-switch-track" />
          <span>高级模式（允许勾选高风险清理项）</span>
        </label>
        <label class="dm-switch">
          <input v-model="form.allowDirectDelete" type="checkbox" />
          <span class="dm-switch-track" />
          <span>允许 Shift 跳过隔离区直接删除</span>
        </label>
        <div class="dm-hint-text">
          自动触发（文件变化、周期校验、插盘补齐）默认静默完成；所有事件仍完整记录在「映射组」页。
          备份定时调度也在该页设置。
        </div>
        <div class="dm-inline">
          <button class="dm-btn sm" @click="emit('navigate', 'startup')">管理开机自启动</button>
          <button class="dm-btn sm" @click="emit('navigate', 'schedule')">定时调度详情</button>
        </div>
      </div>

      <div style="margin-top: 20px; display: flex; align-items: center; gap: 14px">
        <button class="dm-btn primary" :disabled="busy" @click="save">保存设置</button>
        <span class="dm-hint-text" :style="{ color: message.includes('失败') ? 'var(--dm-err)' : 'var(--dm-ok)' }">
          {{ message }}
        </span>
      </div>

      <div class="dm-divider" />
      <div class="dm-hint-text" style="margin-bottom: 12px">
        下方为 SoftGraph 全量设置（主题 / 浮窗 / 隔离区 / 规则库 / 关于），与常用参数同页显示，无需切换。
      </div>
      <div style="height: 560px; overflow: auto">
        <SettingsDrawer
          :page="true"
          :open="true"
          :tab="drawerTab"
          @set-tab="drawerTab = $event"
          @toast="pushDmToast('info', '设置', $event)"
          @theme="emit('theme', $event)"
        />
      </div>
    </div>

    <div class="dm-stack">
      <div class="dm-card dm-panel">
        <div class="dm-panel-head"><h2>运行机制</h2></div>
        <div class="dm-stat-line"><span>方向</span><span>单向：源 → 移动硬盘</span></div>
        <div class="dm-stat-line"><span>一致性</span><span>审阅式预览 + 三区差异报告</span></div>
        <div class="dm-stat-line"><span>删除</span><span>目标多出文件需审阅确认</span></div>
        <div class="dm-stat-line"><span>设备识别</span><span>卷标 / 盘符</span></div>
        <div class="dm-stat-line"><span>写入方式</span><span>临时文件 + 原子替换</span></div>
        <div class="dm-stat-line"><span>校验算法</span><span>size + mtime</span></div>
        <div class="dm-stat-line"><span>数据库</span><span>SQLite（sql.js，本机）</span></div>
      </div>
      <div class="dm-card dm-panel">
        <div class="dm-panel-head"><h2>数据位置</h2></div>
        <div class="dm-hint-text">
          配置、清单与日志都保存在本机用户目录的 SoftGraph 文件夹下，不写入移动硬盘。
          这样硬盘未接入时程序仍能记录待同步变化和告警。<br /><br />
          用户数据目录：<span class="dm-mono">%LOCALAPPDATA%\SoftGraph\</span>
        </div>
      </div>
      <div class="dm-card dm-panel">
        <div class="dm-panel-head"><h2>关于</h2></div>
        <div class="dm-hint-text">
          SoftGraph v{{ dmVersion }} · Electron 33 + Vue 3 + TypeScript + Vite + Tailwind v4 + d3-force + SQLite<br />
          界面复刻自 DiskMirror 1.3.1；工具模块经侧栏「工具」分组进入。
        </div>
        <div class="dm-divider" />
        <div class="dm-about-actions">
          <div class="dm-about-action">
            <button class="dm-btn primary" :disabled="updateChecking" @click="checkUpdate">
              {{ updateChecking ? '检查中…' : '检查更新' }}
            </button>
            <div class="dm-hint-text">检查 GitHub / Gitee 是否有新版本；下载与安装请在「设置 → 关于」中完成。</div>
          </div>
          <div class="dm-about-action">
            <button class="dm-btn danger" @click="exportDiag">导出诊断包</button>
            <div class="dm-hint-text">排查备份失败、设备识别异常或界面问题时，导出脱敏诊断包（写入前已做路径脱敏）。</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
