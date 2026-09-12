import { readFileSync } from 'node:fs'
import { psJson } from '@scanner/psbridge'

// 取 winenum.ts 的真实 SCRIPT（~7KB，base64 后 ~7KB 单行 stdin）
const src = readFileSync('tests/../packages/scanner/winenum.ts', 'utf8')
const m = src.match(/const SCRIPT = String\.raw`([\s\S]*?)`\n/) as RegExpMatchArray | null
if (!m) { console.error('SCRIPT 未找到'); process.exit(1) }
const scriptBody: string = m[1]
console.log('SCRIPT 长度:', m[1].length)

async function main(): Promise<void> {
  const t0 = Date.now()
  try {
    const r = await psJson<Record<string, unknown>>(scriptBody, { timeoutMs: 30_000 })
    const keys = Object.entries(r ?? {}).map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : typeof v}`)
    console.log('✓ 会话执行成功', Date.now() - t0, 'ms →', keys.join(' '))
  } catch (e) {
    console.error('✗ 会话执行失败:', (e as Error).name, (e as Error).message)
  }
  process.exit(0)
}
void main()
