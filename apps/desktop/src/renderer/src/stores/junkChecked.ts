/**
 * v3.9 E2：垃圾分类勾选状态共享 —— 图谱侧栏与垃圾清理主视图两个 JunkSidebar
 * 实例读写同一份（Pinia），勾选不再各自独立。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useJunkChecked = defineStore('junkChecked', () => {
  const ids = ref(new Set<string>())
  function replace(next: Set<string>): void {
    ids.value = next
  }
  return { ids, replace }
})
