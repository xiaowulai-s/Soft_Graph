<script setup lang="ts">
/**
 * v3.1 维护中心 —— 定时清理 / 软件升级 / 隔离区管理 / 社区规则 的独立界面。
 * 功能代码自 SettingsDrawer 迁入（v3.1），设置抽屉只保留「应用更新 / 规则更新源」等全局设置。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { formatBytes } from '@shared/util'
import type { AppSettings, AppUpdateState } from '@shared/types'

const props = defineProps<{ open?: boolean; page?: boolean }>()
const emit = defineEmits<{ close: [] }>()

// v3.6 合并同类 → 4 组胶囊：清理调度 / 软件资产 / 规则供给 / 扫描与更新
const tab = ref<'cleanup' | 'software' | 'rules' | 'system'>('cleanup')
const settings = ref<AppSettings>({
  portableRoots: [], portableThreshold: 55, excludePaths: [],
  quarantineKeepDaysLow: 7, quarantineKeepDaysHigh: 14, theme: 'dark',
  maxDepth: 2, enabledJunkCategories: [], advancedMode: false,
  allowDirectDelete: false, rulesUpdateUrl: '',
  junkSchedule: { enabled: false, intervalHours: 168 },
  extraScanDirs: [],
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
const schedInfo = ref<{ lastRunAt: number; lastCleaned: number; lastFreedBytes: number } | null>(null)
async function loadSchedInfo(): Promise<void> {
  try {
    schedInfo.value = await window.api.junkScheduleInfo()
  } catch {
    /* ignore */
  }
}
onMounted(() => void loadSchedInfo())
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
const quarItems = ref<{ id: string; originalPath: string; sizeBytes: number }[]>([])
const quarSel = ref(new Set<string>())
const quarLoading = ref(false)

async function loadQuarantine(): Promise<void> {
  quarLoading.value = true
  try {
    quarItems.value = await window.api.quarantineList()
    quarSel.value = new Set()
  } finally {
    quarLoading.value = false
  }
}

function toggleQuarSel(id: string): void {
  const next = new Set(quarSel.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  quarSel.value = next
}

async function doShredSelected(): Promise<void> {
  shredBusy.value = true
  try {
    const ids = [...quarSel.value]
    const r = await window.api.quarantineShred(ids)
    shredOk.value = r.failed.length === 0
    shredText.value = `粉碎完成：${r.ok} 项 / 释放 ${formatBytes(r.freed)}${r.failed.length ? `，失败 ${r.failed.length} 项` : ''}`
    shredConfirm.value = false
    await loadQuarantine()
  } catch (e) {
    shredOk.value = false
    shredText.value = `粉碎失败：${(e as Error).message}`
  } finally {
    shredBusy.value = false
  }
}

// ── 软件升级管家（winget） ──
const upgrades = ref<{ id: string; name: string; version: string; available: string; needsElevation?: boolean }[]>([])
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
    wingetText.value = r.ok
      ? `${id} 升级完成`
      : `${id} 升级失败${r.needsElevation ? '（需要管理员权限，可点「提权重试」）' : ''}：${r.output ?? ''}`
    await loadUpgrades()
  } finally {
    wingetUpgrading.value = false
  }
}

async function upgradeOneElevated(id: string): Promise<void> {
  wingetUpgrading.value = true
  wingetText.value = `正在以管理员权限升级 ${id} …（请在 UAC 弹窗确认）`
  try {
    const r = await window.api.wingetUpgradeElevated(id)
    wingetOk.value = r.ok
    wingetText.value = r.ok ? `${id} 提权升级完成` : `${id} 提权升级失败：${r.output ?? ''}`
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

// ── 相似图片盘点（v3.3 P2-1） ──
const imgBusy = ref(false)
const imgText = ref('')
const imgOk = ref(false)
const similarGroups = ref<{ hash: string; images: { path: string; sizeBytes: number }[] }[]>([])
async function scanSimilarImages(): Promise<void> {
  imgBusy.value = true
  imgText.value = ''
  try {
    similarGroups.value = await window.api.imagesSimilar()
    imgOk.value = true
    imgText.value = similarGroups.value.length
      ? `发现 ${similarGroups.value.length} 组相似图片`
      : '未发现相似图片'
  } catch (e) {
    imgOk.value = false
    imgText.value = `扫描失败：${(e as Error).message}`
  } finally {
    imgBusy.value = false
  }
}

async function trashImage(path: string, gi: number): Promise<void> {
  try {
    const r = await window.api.imageTrash(path)
    if (r.ok) {
      similarGroups.value[gi].images = similarGroups.value[gi].images.filter((x) => x.path !== path)
      if (similarGroups.value[gi].images.length < 2) similarGroups.value.splice(gi, 1)
    } else {
      imgText.value = `送回收站失败`
    }
  } catch (e) {
    imgText.value = `送回收站失败：${(e as Error).message}`
  }
}

// ── 应用自更新（自设置抽屉迁入） ──
const appUpdate = ref<AppUpdateState | null>(null)
let appUpdateUnsub: (() => void) | null = null
onMounted(() => {
  appUpdateUnsub = window.api.onAppUpdateState((st) => {
    appUpdate.value = st
  })
})
onBeforeUnmount(() => {
  appUpdateUnsub?.()
  appUpdateUnsub = null
})

async function checkAppUpdate(): Promise<void> {
  appUpdate.value = { phase: 'checking' }
  try {
    const r = await window.api.appUpdateCheck()
    if (r.available) appUpdate.value = { phase: 'available', version: r.version ?? '' }
    else appUpdate.value = { phase: 'not-available', version: r.version ?? '' }
  } catch (e) {
    appUpdate.value = { phase: 'error', message: (e as Error).message }
  }
}

async function downloadAppUpdate(): Promise<void> {
  await window.api.appUpdateDownload()
}

function installAppUpdate(): void {
  window.api.appUpdateInstall()
}

const skipText = ref('')
async function skipAppUpdate(version: string): Promise<void> {
  await window.api.appUpdateSkip(version)
  skipText.value = `已跳过 v${version}，之后的版本仍会正常提示`
}

// ── 签名规则在线更新（自设置抽屉迁入） ──
const rulesBusy = ref(false)
const rulesText = ref('')
const rulesOk = ref(false)
async function checkRulesUpdate(): Promise<void> {
  rulesBusy.value = true
  rulesText.value = ''
  try {
    const r = await window.api.rulesUpdate()
    rulesOk.value = r.ok
    rulesText.value = r.ok
      ? `规则库已更新到 v${r.version}（${r.ruleCount ?? '?'} 类）。重新扫描即生效。`
      : `未更新：${r.reason ?? '未知原因'}`
  } catch (e) {
    rulesOk.value = false
    rulesText.value = `检查失败：${(e as Error).message}`
  }
}

// ── 注册表残留（v3.3 P2-2） ──
const regBusy = ref(false)
const regText = ref('')
const regOk = ref(false)
const leftovers = ref<{ hive: string; keyPath: string; displayName: string; reason: string }[]>([])
async function scanRegistry(): Promise<void> {
  regBusy.value = true
  regText.value = ''
  try {
    leftovers.value = await window.api.registryLeftovers()
    regOk.value = true
    regText.value = leftovers.value.length
      ? `发现 ${leftovers.value.length} 个残留卸载项`
      : '未发现残留卸载项'
  } catch (e) {
    regOk.value = false
    regText.value = `扫描失败：${(e as Error).message}`
  } finally {
    regBusy.value = false
  }
}

async function deleteLeftover(l: { hive: string; keyPath: string; displayName: string }): Promise<void> {
  regBusy.value = true
  try {
    const r = await window.api.registryDelete(l.hive, l.keyPath)
    if (r.ok) {
      leftovers.value = leftovers.value.filter((x) => x.keyPath !== l.keyPath)
      regText.value = `已删除「${l.displayName}」的残留条目`
    } else {
      regText.value = `删除失败：${r.output ?? ''}`
    }
  } catch (e) {
    regText.value = `删除失败：${(e as Error).message}`
  } finally {
    regBusy.value = false
  }
}

onBeforeUnmount(() => {
  /* 预留 */
})
</script>

<template>
  <Teleport to="body" :disabled="page">
    <div v-if="page || open" :class="page ? 'mc-page' : 'mc-mask'" @click.self="!page && emit('close')">
      <div class="mc-panel" :class="{ full: page }">
        <header class="mc-head">
          <h3>维护中心</h3>
          <button v-if="!page" class="ghost" title="关闭" @click="emit('close')">✕</button>
        </header>

        <nav class="mc-tabs">
          <button :class="tab === 'cleanup' ? 'active' : ''" @click="tab = 'cleanup'">清理调度</button>
          <button :class="tab === 'software' ? 'active' : ''" @click="tab = 'software'">软件资产</button>
          <button :class="tab === 'rules' ? 'active' : ''" @click="tab = 'rules'">规则供给</button>
          <button :class="tab === 'system' ? 'active' : ''" @click="tab = 'system'">扫描与更新</button>
        </nav>

        <!-- 定时清理 -->
        <section v-if="tab === 'cleanup'" class="mc-sec">
          <h4 class="mc-sub">定时静默清理</h4>
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
          <div v-if="schedInfo" class="mc-hint">上次自动清理：{{ new Date(schedInfo.lastRunAt).toLocaleString() }} · 清理 {{ schedInfo.lastCleaned }} 项 · 释放 {{ formatBytes(schedInfo.lastFreedBytes) }}</div>
          <div class="mc-hint dim">清理范围 = 「一键清理」相同的安全白名单项（GC 低风险默认勾选类）。应用运行期间每 15 分钟检查一次是否到期。</div>

          <h4 style="margin:8px 0 0;font-size:13px">重复 / 超大文件额外扫描目录（GC-11 / GC-12）</h4>
          <div class="mc-hint dim">每行一个绝对路径；默认只扫用户库，加了目录后重新扫描即生效。</div>
          <textarea
            class="mono"
            rows="3"
            style="width:100%;background:transparent;border:1px solid var(--border,#3a3a3a);border-radius:8px;color:inherit;padding:6px;font-size:12px"
            :value="settings.extraScanDirs?.join('\n') ?? ''"
            @change="patch({ extraScanDirs: ($event.target as HTMLTextAreaElement).value.split(/\n/).map((x) => x.trim()).filter(Boolean) })"
          />
        </section>

        <!-- 软件升级 -->
        <section v-if="tab === 'software'" class="mc-sec">
          <h4 class="mc-sub">软件升级（winget）</h4>
          <div class="mc-row">
            <button class="ghost" :disabled="wingetBusy" @click="loadUpgrades">{{ wingetBusy ? '检查中…' : '检查可升级软件' }}</button>
            <button v-if="upgrades.length" class="ghost" :disabled="wingetUpgrading" @click="upgradeAll">
              {{ wingetUpgrading ? `升级中（${upgradeProgress}/${upgrades.length}）…` : `全部升级（${upgrades.length}）` }}
            </button>
          </div>
          <div v-if="wingetText" class="mc-hint" :class="wingetOk ? '' : 'warn'">{{ wingetText }}</div>
          <ul v-if="upgrades.length" class="mc-list">
            <li v-for="u in upgrades" :key="u.id">
              <span class="name">{{ u.name }}<span v-if="u.needsElevation" class="mc-hint warn">（需管理员）</span></span>
              <span class="ver mono">{{ u.version }} → {{ u.available }}</span>
              <button v-if="u.needsElevation" class="ghost" :disabled="wingetUpgrading" @click="upgradeOneElevated(u.id)">提权重试</button>
              <button class="ghost" :disabled="wingetUpgrading" @click="upgradeOne(u.id)">升级</button>
            </li>
          </ul>
          <div class="mc-hint dim">调用系统 winget 静默升级（--silent）；未安装 winget 或无网络时给出提示。</div>
        </section>

        <!-- 隔离区管理 -->
        <section v-if="tab === 'cleanup'" class="mc-sec" style="margin-top:14px">
          <h4 class="mc-sub">隔离区管理</h4>
          <div class="mc-row">
            <button class="ghost" :disabled="quarLoading" @click="loadQuarantine">{{ quarLoading ? '加载中…' : '刷新隔离区列表' }}</button>
            <button class="ghost" :disabled="!quarItems.length || shredBusy || shredConfirm" @click="shredConfirm = true">粉碎选中（{{ quarSel.size }}）</button>
            <button v-if="shredConfirm" class="danger" @click="doShredSelected">确认粉碎（不可恢复）</button>
            <button v-if="shredConfirm" class="ghost" @click="shredConfirm = false">取消</button>
          </div>
          <div v-if="shredText" class="mc-hint" :class="shredOk ? '' : 'warn'">{{ shredText }}</div>
          <ul v-if="quarItems.length" class="mc-list">
            <li v-for="q in quarItems" :key="q.id">
              <input type="checkbox" :checked="quarSel.has(q.id)" @change="toggleQuarSel(q.id)" />
              <span class="name" :title="q.originalPath">{{ q.originalPath }}</span>
              <span class="ver mono">{{ formatBytes(q.sizeBytes) }}</span>
            </li>
          </ul>
          <div v-else class="mc-hint dim">隔离区为空。</div>
          <div class="mc-hint dim">
            粉碎 = 单遍随机覆写后删除（不可恢复）；还原请在垃圾扫描页的隔离区入口操作。
          </div>
        </section>

        <!-- 社区规则 -->
        <section v-if="tab === 'rules'" class="mc-sec">
          <h4 class="mc-sub">社区清理规则（Winapp2.ini）</h4>
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

        <section v-if="tab === 'rules'" class="mc-sec" style="margin-top:14px">
          <h4 class="mc-sub">签名规则在线更新</h4>
          <div class="mc-row">
            <label>更新源（留空 = 自动使用官方源 + 镜像回退）</label>
            <input
              class="mono"
              type="url"
              style="flex:1;background:transparent;border:1px solid var(--border);border-radius:8px;color:inherit;padding:5px 10px;font-size:12px"
              :value="settings.rulesUpdateUrl"
              @change="patch({ rulesUpdateUrl: ($event.target as HTMLInputElement).value.trim() })"
            />
            <button class="ghost" :disabled="rulesBusy" @click="checkRulesUpdate">
              {{ rulesBusy ? '检查中…' : '检查规则更新' }}
            </button>
          </div>
          <div v-if="rulesText" class="mc-hint" :class="rulesOk ? '' : 'warn'">{{ rulesText }}</div>
          <div class="mc-hint dim">
            更新包必须通过 Ed25519 签名（公钥内置）、SHA-256 校验、版本单调与安全结构检查，
            任何一步失败都不会改动本机规则。
          </div>
        </section>

        <!-- 相似图片 -->
        <section v-if="tab === 'system'" class="mc-sec">
          <h4 class="mc-sub">相似图片盘点</h4>
          <div class="mc-row">
            <button class="ghost" :disabled="imgBusy" @click="scanSimilarImages">{{ imgBusy ? '扫描中…（图片较多时需一两分钟）' : '扫描相似图片' }}</button>
          </div>
          <div v-if="imgText" class="mc-hint" :class="imgOk ? '' : 'warn'">{{ imgText }}</div>
          <div v-for="(g, gi) in similarGroups" :key="gi" class="mc-hint" style="border:1px solid var(--border,#3a3a3a);border-radius:8px;padding:8px">
            <div class="dim" style="margin-bottom:4px">相似组 {{ gi + 1 }}（{{ g.images.length }} 张，建议保留一张，其余送回收站）</div>
            <div v-for="img in g.images" :key="img.path" style="display:flex;align-items:center;gap:8px;padding:2px 0">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="img.path">{{ img.path }}</span>
              <span class="mono dim">{{ formatBytes(img.sizeBytes) }}</span>
              <button class="ghost" :disabled="imgBusy" @click="trashImage(img.path, gi)">送回收站</button>
            </div>
          </div>
          <div class="mc-hint dim">感知哈希（aHash）+ 汉明距离分组；扫描范围为图片/下载/文档目录；删除走系统回收站，可还原。</div>
        </section>

        <section v-if="tab === 'system'" class="mc-sec" style="margin-top:14px">
          <h4 class="mc-sub">应用自更新</h4>
          <div class="mc-row">
            <button class="ghost" :disabled="appUpdate?.phase === 'checking' || appUpdate?.phase === 'downloading'" @click="checkAppUpdate">
              {{ appUpdate?.phase === 'checking' ? '检查中…' : '检查应用更新' }}
            </button>
            <button v-if="appUpdate?.phase === 'available'" class="ghost" @click="downloadAppUpdate">
              下载 v{{ appUpdate.version }}
            </button>
            <button v-if="appUpdate?.phase === 'downloaded'" class="ghost" @click="installAppUpdate">
              重启并安装 v{{ appUpdate.version }}
            </button>
          </div>
          <div v-if="appUpdate?.phase === 'downloading'" class="mc-hint">
            下载中 {{ appUpdate.percent }}%（{{ (appUpdate.bytesPerSecond / 1048576).toFixed(1) }} MB/s）
          </div>
          <div v-else-if="appUpdate?.phase === 'not-available'" class="mc-hint">已是最新版本（v{{ appUpdate.version }}）</div>
          <div v-else-if="appUpdate?.phase === 'downloaded'" class="mc-hint">下载完成，点「重启并安装」完成更新</div>
          <div v-else-if="appUpdate?.phase === 'error'" class="mc-hint warn">更新失败：{{ appUpdate.message }}</div>
          <div v-else-if="appUpdate?.phase === 'available'" class="mc-hint">
            发现新版本 v{{ appUpdate.version }}，点「下载」获取
            <div v-if="appUpdate.releaseNotes" class="mc-hint dim" style="max-height:100px;overflow:auto;margin-top:4px">{{ appUpdate.releaseNotes.slice(0, 400) }}</div>
            <button class="ghost" style="margin-top:4px" @click="skipAppUpdate(appUpdate.version)">跳过此版本</button>
            <div v-if="skipText" class="mc-hint">{{ skipText }}</div>
          </div>
          <div class="mc-hint dim">启动后自动检查（每 24h 一次），下载需手动确认；失败会写入日志（scope app-update）。</div>
        </section>

        <!-- 注册表清理 -->
        <section v-if="tab === 'software'" class="mc-sec" style="margin-top:14px">
          <h4 class="mc-sub">注册表残留清理</h4>
          <div class="mc-row">
            <button class="ghost" :disabled="regBusy" @click="scanRegistry">{{ regBusy ? '扫描中…（逐键查询，约需一两分钟）' : '扫描残留卸载项' }}</button>
          </div>
          <div v-if="regText" class="mc-hint" :class="regOk ? '' : 'warn'">{{ regText }}</div>
          <ul v-if="leftovers.length" class="mc-list">
            <li v-for="l in leftovers" :key="l.keyPath">
              <span class="name" :title="l.keyPath">{{ l.displayName }}<span class="mc-hint dim">（{{ l.hive }}）</span></span>
              <button class="ghost" :disabled="regBusy" @click="deleteLeftover(l)">删除死条目</button>
            </li>
          </ul>
          <div class="mc-hint dim">
            仅列出「卸载程序已不存在且安装目录缺失」的死条目。HKCU 条目直接删除；
            HKLM 条目删除会弹 UAC 确认。删除前请确认对应软件确实已卸载。
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
.mc-page {
  width: 100%; height: 100%; overflow: auto;
  display: flex; justify-content: center;
  background: transparent;
}
.mc-panel {
  width: min(720px, 92vw); max-height: 82vh; overflow: auto;
  background: var(--panel, #1e1e1e); color: var(--text, #ddd);
  border: 1px solid var(--border, #3a3a3a); border-radius: 12px;
  padding: 18px 22px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}
.mc-panel.full {
  width: 100%; max-width: 1200px; max-height: none; height: fit-content; min-height: 100%;
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
.mc-sub { margin: 0; font-size: 13px; font-weight: 500; color: var(--accent-2, #22d3ee); }
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
