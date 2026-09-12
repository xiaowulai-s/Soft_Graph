import { enumerateWindows } from '@scanner/winenum'
import { scanInstalled, scanPortable, dedupe, defaultPortableRoots } from '@scanner/software'
import type { ScanSoftwareOptions } from '@scanner/software'

async function main(): Promise<void> {
  const t = { enum: 0, installed: 0, portable: 0, dedupe: 0 }
  let marks: Record<string, number> = {}

  const opts: ScanSoftwareOptions = {
    onProgress: (phase) => {
      const now = Date.now()
      if (marks.phase) console.log('  +', phase, '-', now - marks.phase, 'ms')
      marks.phase = now
    }
  }
  void opts

  let t0 = Date.now()
  const raw = await enumerateWindows()
  t.enum = Date.now() - t0
  console.log('enumerateWindows:', t.enum, 'ms · uninstall', raw.uninstall.length)

  t0 = Date.now()
  const installed = await scanInstalled(raw, {})
  t.installed = Date.now() - t0
  console.log('scanInstalled:', t.installed, 'ms ·', installed.length, '项')

  const installedPaths = new Set(installed.map((i) => normKeyOf(i.installPath)).filter(Boolean))
  const roots = await defaultPortableRoots()
  t0 = Date.now()
  const portable = await scanPortable(roots, installedPaths, 55, new Map(), () => {})
  t.portable = Date.now() - t0
  console.log('scanPortable:', t.portable, 'ms · roots=', roots.join(' | '), '·', portable.length, '项')

  t0 = Date.now()
  const all = dedupe([...installed, ...portable])
  t.dedupe = Date.now() - t0
  console.log('dedupe:', t.dedupe, 'ms ·', all.length, '项')
  console.log('合计:', t.enum + t.installed + t.portable + t.dedupe, 'ms')
  process.exit(0)
}

function normKeyOf(p?: string): string {
  return (p ?? '').toLowerCase().replace(/\//g, '\\')
}

// scanPortable 需要的 normKey 从 shared 引入（避免手写不一致）
import { normKey } from '@shared/util'
void normKey

main().catch((e) => { console.error(e); process.exit(1) })
