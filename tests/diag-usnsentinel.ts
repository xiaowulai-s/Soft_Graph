/** 检测卷哨兵可命中性：静止期间连续采样的 nextUsn 是否保持不变 */
import { queryJournal } from '@junk/usn'

async function main(): Promise<void> {
  for (const v of ['C:', 'D:']) {
    const samples: string[] = []
    for (let i = 0; i < 3; i++) {
      const info = await queryJournal(v)
      samples.push(info?.nextUsn ?? '(无)')
      if (i < 2) await new Promise((r) => setTimeout(r, 4000))
    }
    const stable = new Set(samples).size === 1
    console.log(
      `${v} 采样 ${samples.join(' → ')} · ${stable ? '✅ 静止期未变（哨兵可命中）' : '❌ 持续变化（哨兵难以命中）'}`
    )
  }
  process.exit(0)
}
void main()
