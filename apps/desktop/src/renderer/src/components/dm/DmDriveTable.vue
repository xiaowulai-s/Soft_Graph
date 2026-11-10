<script setup lang="ts">
/** DmDriveTable —— 已接入磁盘表（唯一实现），数据来自 backup:drives。 */
import { dmDrives, sizeText } from './dmState'
</script>

<template>
  <div class="dm-card dm-panel">
    <div class="dm-panel-head">
      <h2>已接入磁盘</h2>
      <span class="dm-hint">由系统磁盘枚举读取</span>
    </div>
    <div v-if="!dmDrives.length" class="dm-empty">未检测到磁盘或未完成首次扫描</div>
    <table v-else>
      <thead>
        <tr><th>盘符</th><th>卷标</th><th>容量</th><th>可用</th><th>类型</th></tr>
      </thead>
      <tbody>
        <tr v-for="disk in dmDrives" :key="disk.letter">
          <td class="dm-mono">{{ disk.letter }}</td>
          <td>{{ disk.label || '—' }}</td>
          <td class="dm-mono">{{ sizeText(disk.totalBytes) }}</td>
          <td class="dm-mono">{{ sizeText(disk.freeBytes) }}</td>
          <td>{{ disk.driveType === 2 ? '可移动磁盘' : '本地磁盘' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
