<script setup lang="ts">
/**
 * v5.2 侧栏：图标 + 文本常显（150px），按域分组，可折叠成 54px 纯图标。
 * 条目由 nav.ts 注册表驱动，全部统一 SVG 线性图标 + 统一文本规格。
 */
import { ref } from 'vue'
import { NAV_GROUPS, NAV_MODULES, navIconSvg } from '@shared/nav'

const model = defineModel<string>({ required: true })

const collapsed = ref(false)
const ICONS = Object.fromEntries(NAV_MODULES.map((m) => [m.id, navIconSvg(m.icon)]))
</script>

<template>
  <nav class="sb" :class="{ mini: collapsed }">
    <div class="sb-brand">
      <span class="sb-logo">◈</span>
      <span v-if="!collapsed" class="sb-name">SoftGraph</span>
    </div>

    <template v-for="g in NAV_GROUPS" :key="g.key">
      <div v-if="!collapsed" class="sb-group">{{ g.title }}</div>
      <div v-else class="sb-group-line"></div>
      <button
        v-for="m in NAV_MODULES.filter((x) => x.group === g.key)"
        :key="m.id"
        class="sb-btn"
        :class="{ active: model === m.id }"
        :title="collapsed ? `${m.title} — ${m.desc}` : m.desc"
        @click="model = m.id"
      >
        <span class="sb-ico" v-html="ICONS[m.id]"></span>
        <span v-if="!collapsed" class="sb-txt">{{ m.title }}</span>
      </button>
    </template>

    <span style="flex: 1"></span>
    <button class="sb-btn sb-fold" :title="collapsed ? '展开侧栏' : '折叠侧栏'" @click="collapsed = !collapsed">
      <span class="sb-ico fold-ico" :class="{ flip: collapsed }">‹</span>
      <span v-if="!collapsed" class="sb-txt">折叠</span>
    </button>
  </nav>
</template>

<style scoped>
.sb {
  width: 150px;
  flex: none;
  height: 100%;
  background: var(--panel);
  border-right: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  padding: 10px 8px;
  gap: 2px;
  overflow-y: auto;
  overflow-x: hidden;
  transition: width 0.15s ease;
}
.sb.mini {
  width: 54px;
  align-items: center;
  padding: 10px 6px;
}
.sb-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px 10px;
}
.sb-logo {
  font-size: 17px;
  color: var(--accent);
  line-height: 1;
}
.sb-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.sb.mini .sb-brand {
  justify-content: center;
  padding: 2px 0 10px;
}
.sb-group {
  font-size: 10px;
  color: var(--text-3);
  letter-spacing: 2px;
  padding: 10px 8px 4px;
  user-select: none;
}
.sb-group-line {
  width: 26px;
  height: 1px;
  background: var(--border-soft);
  margin: 8px 0 4px;
}
.sb-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--text-2);
}
.sb-btn:hover:not(:disabled) {
  background: var(--hover);
  border: none;
}
.sb-btn.active {
  background: var(--accent);
}
.sb-btn.active .sb-ico,
.sb-btn.active .sb-txt {
  color: #fff;
}
.sb-ico {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}
.sb-ico :deep(svg) {
  display: block;
}
.sb-txt {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-fold {
  margin-top: 4px;
}
.fold-ico {
  font-size: 14px;
  transition: transform 0.15s;
}
.fold-ico.flip {
  transform: rotate(180deg);
}
</style>
