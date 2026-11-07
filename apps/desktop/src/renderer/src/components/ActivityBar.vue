<script setup lang="ts">
/**
 * v5.0 左侧活动栏：54px 图标导航，注册表驱动（nav.ts 五区）。
 * 设置项固定在底部，其余自上而下。
 */
import { NAV_MODULES, navIconSvg } from '@shared/nav'

const model = defineModel<string>({ required: true })

const MAIN = NAV_MODULES.filter((m) => m.id !== 'settings')
const SETTINGS = NAV_MODULES.find((m) => m.id === 'settings')
const ICONS = Object.fromEntries(NAV_MODULES.map((m) => [m.id, navIconSvg(m.icon)]))
</script>

<template>
  <nav class="ab">
    <div class="ab-brand">◈</div>
    <button
      v-for="m in MAIN"
      :key="m.id"
      class="ab-btn"
      :class="{ active: model === m.id }"
      :title="`${m.title} — ${m.desc}`"
      @click="model = m.id"
    >
      <span class="ab-ico" v-html="ICONS[m.id]"></span>
      <span class="ab-tip">{{ m.title }}</span>
    </button>
    <span style="flex: 1"></span>
    <button
      v-if="SETTINGS"
      class="ab-btn"
      :class="{ active: model === SETTINGS.id }"
      :title="`${SETTINGS.title} — ${SETTINGS.desc}`"
      @click="model = SETTINGS.id"
    >
      <span class="ab-ico" v-html="ICONS[SETTINGS.id]"></span>
      <span class="ab-tip">{{ SETTINGS.title }}</span>
    </button>
  </nav>
</template>

<style scoped>
.ab {
  width: 54px;
  flex: none;
  height: 100%;
  background: var(--panel);
  border-right: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 6px;
}
.ab-brand {
  font-size: 17px;
  color: var(--accent);
  margin-bottom: 10px;
  user-select: none;
}
.ab-btn {
  width: 40px;
  height: 38px;
  border: none;
  background: transparent;
  border-radius: 9px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.ab-btn:hover:not(:disabled) {
  background: var(--hover);
  border: none;
}
.ab-btn.active {
  background: var(--accent);
}
.ab-btn.active .ab-ico {
  color: #fff;
}
.ab-ico {
  line-height: 1;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ab-ico :deep(svg) {
  display: block;
}
.ab-tip {
  position: absolute;
  left: 48px;
  top: 50%;
  transform: translateY(-50%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
  z-index: 90;
  box-shadow: var(--shadow);
}
.ab-btn:hover .ab-tip {
  opacity: 1;
}
</style>
