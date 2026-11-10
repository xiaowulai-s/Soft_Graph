<script setup lang="ts">
/** DmToastStack —— DiskMirror 右上角 toast 栈复刻 */
import { dmToasts } from './dmState'
</script>

<template>
  <div class="dm-toast-stack">
    <div v-for="toast in dmToasts" :key="toast.id" class="dm-toast" :class="toast.level">
      <div class="dm-toast-title">{{ toast.title }}</div>
      <div class="dm-toast-msg">{{ toast.message }}</div>
    </div>
  </div>
</template>
