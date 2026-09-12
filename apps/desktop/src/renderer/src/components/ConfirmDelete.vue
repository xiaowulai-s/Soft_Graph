<script setup lang="ts">
/**
 * 删除确认流程
 * 对应技术设计方案 8.4 删除确认流程 + 5.5.2 风险分级与确认强度
 *
 *   低风险 → 单次确认弹窗
 *   中风险 → 展示影响清单（前 20 条路径 + 「还有 N 项」）+ 二次确认
 *   高风险 → 必须手动输入「确认删除」四个字
 */
import { computed, ref, watch } from 'vue'
import type { CleanResult, DeletePlan, LockerInfo, RiskLevel } from '@shared/types'
import { RISK_LABEL } from '@shared/types'
import { formatBytes } from '@shared/util'

/** 占用查询与重启后删除（v2.0.0 M2/B2+B3） */
const lockers = ref<Record<string, LockerInfo[]>>({})
const lockerBusy = ref<string>('')
const lockerText = ref('')
const rebootText = ref('')
const rebootOk = ref(false)

async function queryLocker(path: string): Promise<void> {
  lockerBusy.value = path
  lockerText.value = ''
  try {
    const r = await window.api.cleanLockers(path)
    lockers.value = { ...lockers.value, [path]: r.lockers ?? [] }
    if (r.lockers?.length) {
      lockerText.value =
        `占用者：` + r.lockers.map((l) => `${l.name}(PID ${l.pid}${l.appType === 3 ? ', 服务' : ''})`).join('、')
    } else {
      lockerText.value = r.error ? `查询失败：${r.error}` : '未检测到占用进程（可能已被释放或需管理员权限）'
    }
  } catch (e) {
    lockerText.value = `查询失败：${(e as Error).message}`
  } finally {
    lockerBusy.value = ''
  }
}

async function rebootDelete(paths: string[]): Promise<void> {
  rebootText.value = ''
  try {
    const r = await window.api.cleanRebootDelete(paths)
    rebootOk.value = r.ok > 0
    if (r.ok > 0) rebootText.value = `已登记 ${r.ok} 项，重启后自动删除。`
    else if (r.needsElevation) rebootText.value = '需要以管理员身份运行本程序才能登记重启后删除。'
    else rebootText.value = r.errors.join('；') || '登记失败'
  } catch (e) {
    rebootOk.value = false
    rebootText.value = `登记失败：${(e as Error).message}`
  }
}

const props = defineProps<{
  plan: DeletePlan | null
  executing: boolean
  progress: { done: number; total: number; current: string } | null
  result: CleanResult | null
  allowDirectDelete: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm', payload: { useQuarantine: boolean }): void
  (e: 'cancel'): void
  (e: 'close'): void
  (e: 'open-quarantine'): void
  (e: 'reveal', path: string): void
}>()

const CONFIRM_TEXT = '确认删除'
const typed = ref('')
const useQuarantine = ref(true)
const step2 = ref(false)

watch(
  () => props.plan,
  () => {
    typed.value = ''
    step2.value = false
    useQuarantine.value = true
  }
)

const maxRisk = computed<RiskLevel>(() => {
  const b = props.plan?.riskBreakdown
  if (!b) return 'low'
  if (b.high > 0) return 'high'
  if (b.medium > 0) return 'medium'
  if (b.low > 0) return 'low'
  return 'hint'
})

/** 影响清单：中风险展示前 20 条（文档原文要求） */
const impactList = computed(() => (props.plan?.items ?? []).slice(0, 20))
const impactRest = computed(() => Math.max(0, (props.plan?.items.length ?? 0) - 20))

const needTyping = computed(() => maxRisk.value === 'high')
const needStep2 = computed(() => maxRisk.value === 'medium' || maxRisk.value === 'high')

const canProceed = computed(() => {
  if (!props.plan || props.plan.items.length === 0) return false
  if (needTyping.value && typed.value.trim() !== CONFIRM_TEXT) return false
  if (needStep2.value && !step2.value) return false
  return true
})

const riskRows = computed(() => {
  const b = props.plan?.riskBreakdown
  if (!b) return []
  return (['high', 'medium', 'low', 'hint'] as RiskLevel[]).filter((r) => b[r] > 0).map((r) => ({ risk: r, n: b[r] }))
})

function proceed(): void {
  if (needStep2.value && !step2.value) {
    step2.value = true
    return
  }
  if (!canProceed.value) return
  emit('confirm', { useQuarantine: useQuarantine.value })
}
</script>

<template>
  <div v-if="plan || result" class="cd-mask" @click.self="!executing && emit('close')">
    <div class="cd">
      <!-- 结果摘要 -->
      <template v-if="result">
        <div class="cd-head">
          <span class="cd-title">清理完成</span>
        </div>
        <div class="cd-body">
          <div class="cd-result">
            <div class="cd-res-main">
              <div class="cd-res-val">{{ formatBytes(result.freedBytes) }}</div>
              <div class="dim">已释放空间</div>
            </div>
            <div class="cd-res-grid">
              <div><b class="risk-low">{{ result.ok }}</b><span class="dim">成功</span></div>
              <div><b :class="result.failed.length ? 'risk-medium' : ''">{{ result.failed.length }}</b><span class="dim">失败</span></div>
              <div><b :class="result.blocked.length ? 'risk-hint' : ''">{{ result.blocked.length }}</b><span class="dim">已拦截</span></div>
              <div v-if="result.pendingReboot > 0"><b class="risk-medium">{{ result.pendingReboot }}</b><span class="dim">被占用</span></div>
            </div>
          </div>

          <div v-if="result.failed.length" class="cd-sec">
            <div class="cd-sec-t">
              失败项（{{ result.failed.length }}）
              <span class="dim cd-sec-hint">被占用项可查占用进程或登记为重启后删除</span>
            </div>
            <ul class="cd-list">
              <li v-for="f in result.failed.slice(0, 40)" :key="f.path">
                <span class="mono cd-p">{{ f.path }}</span>
                <span class="risk-medium cd-r">{{ f.reason }}</span>
                <span class="cd-acts">
                  <button class="cd-mini" :disabled="lockerBusy === f.path" @click="queryLocker(f.path)">
                    {{ lockerBusy === f.path ? '查询中…' : '查占用' }}
                  </button>
                  <button
                    v-if="lockers[f.path]?.length"
                    class="cd-mini"
                    @click="rebootDelete([f.path])"
                  >
                    重启后删除
                  </button>
                </span>
              </li>
            </ul>
            <div v-if="lockerText" class="cd-note mono">{{ lockerText }}</div>
            <div v-if="rebootText" class="cd-note" :class="rebootOk ? '' : 'risk-medium'">{{ rebootText }}</div>
            <div v-if="result.failed.length > 40" class="dim cd-more">还有 {{ result.failed.length - 40 }} 项…</div>
          </div>

          <div v-if="result.blocked.length" class="cd-sec">
            <div class="cd-sec-t">被安全规则拦截（{{ result.blocked.length }}）</div>
            <ul class="cd-list">
              <li v-for="b in result.blocked.slice(0, 20)" :key="b.path">
                <span class="mono cd-p">{{ b.path }}</span>
                <span class="risk-hint cd-r">{{ b.reason }}</span>
              </li>
            </ul>
            <div v-if="result.blocked.length > 20" class="dim cd-more">还有 {{ result.blocked.length - 20 }} 项…</div>
          </div>

          <div v-if="result.quarantineId" class="cd-note">
            文件已移入隔离区批次 <b class="mono">{{ result.quarantineId }}</b>，保留期内可完整还原。
          </div>
        </div>
        <div class="cd-foot">
          <button v-if="result.quarantineId" class="ghost" @click="emit('open-quarantine')">查看隔离区</button>
          <span class="cd-sp" />
          <button class="primary" @click="emit('close')">完成</button>
        </div>
      </template>

      <!-- 执行中 -->
      <template v-else-if="executing">
        <div class="cd-head"><span class="cd-title">正在清理</span></div>
        <div class="cd-body">
          <div class="cd-bar">
            <i :style="{ width: progress && progress.total ? (progress.done / progress.total) * 100 + '%' : '0%' }" />
          </div>
          <div class="cd-prog">
            <span>{{ progress?.done ?? 0 }} / {{ progress?.total ?? 0 }}</span>
            <span class="dim mono cd-cur">{{ progress?.current ?? '' }}</span>
          </div>
          <div class="cd-note">
            已执行的删除会被记录在案；取消后不会回滚已执行部分。
          </div>
        </div>
        <div class="cd-foot">
          <span class="cd-sp" />
          <button class="danger" @click="emit('cancel')">取消</button>
        </div>
      </template>

      <!-- 确认 -->
      <template v-else-if="plan">
        <div class="cd-head">
          <span class="cd-title">
            {{ step2 ? '再次确认' : '确认删除' }}
            <span v-if="maxRisk === 'high'" class="cd-risk-tag risk-high">高风险</span>
            <span v-else-if="maxRisk === 'medium'" class="cd-risk-tag risk-medium">中风险</span>
          </span>
        </div>

        <div class="cd-body">
          <div class="cd-summary">
            <div>
              <div class="cd-res-val">{{ formatBytes(plan.totalBytes) }}</div>
              <div class="dim">将释放空间</div>
            </div>
            <div>
              <div class="cd-res-val">{{ plan.items.length }}</div>
              <div class="dim">涉及条目</div>
            </div>
          </div>

          <div class="cd-risks">
            <span v-for="r in riskRows" :key="r.risk" class="cd-risk-chip" :class="'risk-' + r.risk">
              {{ RISK_LABEL[r.risk] }}风险 {{ r.n }} 项
            </span>
          </div>

          <div v-if="plan.blocked.length" class="cd-note warn">
            {{ plan.blocked.length }} 项被安全白名单拦截，不会被删除（受保护路径 / 已不存在 / 重复文件保留项）。
          </div>

          <!-- 中高风险：影响清单 -->
          <div v-if="needStep2" class="cd-sec">
            <div class="cd-sec-t">影响清单（前 {{ impactList.length }} 条）</div>
            <ul class="cd-list">
              <li v-for="it in impactList" :key="it.id">
                <span class="mono cd-p" :title="it.fullPath">{{ it.fullPath }}</span>
                <span class="dim cd-r">{{ formatBytes(it.sizeBytes) }}</span>
              </li>
            </ul>
            <div v-if="impactRest > 0" class="dim cd-more">还有 {{ impactRest }} 项…</div>
          </div>

          <!-- 隔离区开关 -->
          <label class="cd-check">
            <input v-model="useQuarantine" type="checkbox" :disabled="!allowDirectDelete && true" />
            <span>
              移入隔离区（保留期内可完整还原）
              <span v-if="!allowDirectDelete" class="dim">— 取消隔离需先在设置中开启「允许跳过隔离区」</span>
            </span>
          </label>

          <!-- 高风险：输入式确认 -->
          <div v-if="needTyping" class="cd-typing">
            <div class="cd-typing-t risk-high">
              ⚠ 本次删除包含高风险项目，请手动输入「{{ CONFIRM_TEXT }}」以继续
            </div>
            <input v-model="typed" type="text" :placeholder="CONFIRM_TEXT" />
          </div>
        </div>

        <div class="cd-foot">
          <span class="cd-sp" />
          <button @click="emit('close')">取消</button>
          <button
            :class="maxRisk === 'high' ? 'danger' : 'primary'"
            :disabled="needStep2 && step2 ? !canProceed : needTyping && !canProceed"
            @click="proceed"
          >
            {{ needStep2 && !step2 ? '查看影响并继续' : '确认删除' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cd-mask {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 14, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  backdrop-filter: blur(2px);
}
.cd {
  width: 560px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.cd-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.cd-title {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cd-risk-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid currentColor;
}
.cd-body {
  padding: 14px 16px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.cd-summary {
  display: flex;
  gap: 28px;
  padding-bottom: 12px;
}
.cd-res-val {
  font-size: 21px;
  font-weight: 700;
  line-height: 1.2;
}
.cd-risks {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding-bottom: 10px;
}
.cd-risk-chip {
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid currentColor;
}
.cd-sec {
  margin-top: 10px;
}
.cd-sec-t {
  font-size: 11.5px;
  color: var(--text-2);
  margin-bottom: 5px;
}
.cd-list {
  list-style: none;
  margin: 0;
  padding: 6px 8px;
  max-height: 190px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  font-size: 10.5px;
}
.cd-list li {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  line-height: 1.5;
}
.cd-p {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.cd-r {
  flex: none;
  font-size: 10px;
}
.cd-more {
  font-size: 10.5px;
  margin-top: 4px;
}
.cd-note {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 7px 9px;
}
.cd-note.warn {
  color: var(--risk-medium);
  background: color-mix(in srgb, var(--risk-medium) 11%, transparent);
}
.cd-check {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 12px;
  font-size: 11.5px;
  line-height: 1.5;
  cursor: pointer;
}
.cd-typing {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--risk-high);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--risk-high) 9%, transparent);
}
.cd-typing-t {
  font-size: 11.5px;
  margin-bottom: 7px;
  line-height: 1.5;
}
.cd-typing input {
  width: 100%;
}
.cd-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 16px;
  border-top: 1px solid var(--border);
  flex: none;
}
.cd-sp {
  flex: 1;
}
.cd-bar {
  height: 6px;
  background: var(--border-soft);
  border-radius: 3px;
  overflow: hidden;
}
.cd-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.cd-prog {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  margin-top: 6px;
}
.cd-cur {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}
.cd-result {
  display: flex;
  align-items: center;
  gap: 26px;
}
.cd-res-grid {
  display: flex;
  gap: 18px;
}
.cd-res-grid div {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 11px;
}
.cd-res-grid b {
  font-size: 16px;
}
.cd-sec-hint {
  font-weight: 400;
  font-size: 11px;
  margin-left: 8px;
}
.cd-acts {
  display: inline-flex;
  gap: 4px;
  flex: 0 0 auto;
}
.cd-mini {
  background: var(--bg-hover);
  color: var(--fg-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  padding: 1px 6px;
  cursor: pointer;
}
.cd-mini:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}
.cd-mini:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
