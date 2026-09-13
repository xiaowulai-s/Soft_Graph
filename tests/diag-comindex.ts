/** 测量 COM 反查索引（E6）的构建成本与规模（会话池下的现状） */
import { loadComIndex } from '@scanner/deps'

async function main(): Promise<void> {
  const t0 = Date.now()
  const idx = await loadComIndex()
  const ms = Date.now() - t0
  console.log('索引构建:', (ms / 1000).toFixed(2), 's · DLL 条目', idx.size)
  let clsids = 0
  let sample = 0
  for (const [k, v] of idx) {
    clsids += v.length
    if (sample < 3) {
      console.log('  样例:', k, '→', v.slice(0, 2).join(','))
      sample++
    }
  }
  console.log('CLSID 映射总数:', clsids)

  // 二次调用（走内存缓存）
  const t1 = Date.now()
  await loadComIndex()
  console.log('二次调用（缓存）:', Date.now() - t1, 'ms')
  process.exit(0)
}
void main()
