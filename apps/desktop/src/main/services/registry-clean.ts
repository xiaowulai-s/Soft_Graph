/**
 * v3.3 P2-2 注册表残留检测（借鉴 BCU）：
 * 枚举卸载表条目，找出「卸载程序已不存在 + 安装目录缺失/为空」的死条目。
 * HKCU 条目可直接删除；HKLM 条目需管理员（提供提权删除）。
 */
import { spawn } from 'node:child_process'

export interface RegistryLeftover {
  hive: 'HKCU' | 'HKLM'
  keyPath: string
  displayName: string
  uninstallString: string
  reason: string
}

const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]


/** 枚举全部卸载条目（reg query 全量 + 逐条取值） */
export async function enumerateUninstallEntries(): Promise<
  { hive: RegistryLeftover['hive']; keyPath: string; displayName: string; uninstallString: string; installLocation: string }[]
> {
  const entries: { hive: RegistryLeftover['hive']; keyPath: string; displayName: string; uninstallString: string; installLocation: string }[] = []
  for (const root of UNINSTALL_ROOTS) {
    const hive = root.startsWith('HKCU') ? 'HKCU' : 'HKLM'
    const subkeys = await listSubkeys(root)
    for (const sk of subkeys) {
      const keyPath = `${root}\\${sk}`
      const vals = await regQueryValues(keyPath)
      const displayName = vals.DisplayName ?? ''
      const uninstallString = vals.UninstallString ?? ''
      const installLocation = vals.InstallLocation ?? ''
      if (!displayName || !uninstallString) continue
      entries.push({ hive, keyPath, displayName, uninstallString, installLocation })
    }
  }
  return entries
}

function regQuery(args: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('reg', args.split(' '), { windowsHide: true })
    let raw = Buffer.alloc(0)
    child.stdout.on('data', (d: Buffer) => (raw = Buffer.concat([raw, d])))
    child.stderr.on('data', () => {})
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(new TextDecoder('gbk').decode(raw)))
  })
}

async function listSubkeys(root: string): Promise<string[]> {
  const text = await regQuery(`"${root}"`)
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith(root)) out.push(t.slice(root.length + 1).trim())
  }
  return out
}

async function regQueryValues(keyPath: string): Promise<Record<string, string>> {
  const text = await regQuery(`"${keyPath}"`)
  const vals: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{4}(\S+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (m) vals[m[1]] = m[2].trim()
  }
  return vals
}

function pathExists(p: string): Promise<boolean> {
  return import('node:fs/promises')
    .then((fs) => fs.access(p.replace(/^"|"$/g, '')))
    .then(() => true)
    .catch(() => false)
}

/** 判定死条目：卸载程序文件不存在，且安装目录缺失/为空 */
export async function findDeadEntries(): Promise<RegistryLeftover[]> {
  const entries = await enumerateUninstallEntries()
  const out: RegistryLeftover[] = []
  for (const e of entries) {
    const exePath = (e.uninstallString.match(/^"?([^"]+?\.exe)"?/i) ?? [])[1]
    if (!exePath) continue
    const exeMissing = !(await pathExists(exePath))
    if (!exeMissing) continue
    const loc = e.installLocation.replace(/^"|"$/g, '').trim()
    const locMissing = !loc || !(await pathExists(loc.endsWith('\\') ? loc : loc + '\\'))
    if (!locMissing) continue
    out.push({
      hive: e.hive,
      keyPath: e.keyPath,
      displayName: e.displayName,
      uninstallString: e.uninstallString,
      reason: '卸载程序已不存在，且安装目录缺失'
    })
  }
  return out
}

/** 删除注册表键：HKCU 直接删；HKLM 需提权（UAC） */
export async function deleteRegistryKey(hive: RegistryLeftover['hive'], keyPath: string): Promise<{ ok: boolean; output?: string }> {
  if (!/^HK(CU|LM)\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\/.test(keyPath)) {
    return { ok: false, output: '只允许删除卸载表内的键（安全约束）' }
  }
  return new Promise((resolve) => {
    if (hive === 'HKCU') {
      const child = spawn('reg', ['delete', keyPath, '/f'], { windowsHide: true })
      let raw = Buffer.alloc(0)
      child.stdout.on('data', (d: Buffer) => (raw = Buffer.concat([raw, d])))
      child.stderr.on('data', (d: Buffer) => (raw = Buffer.concat([raw, d])))
      child.on('error', (e) => resolve({ ok: false, output: e.message }))
      child.on('close', (code) => resolve({ ok: code === 0, output: new TextDecoder('gbk').decode(raw).slice(-500) }))
    } else {
      const child = spawn(
        'powershell',
        ['-NoProfile', '-Command', `Start-Process reg.exe -ArgumentList 'delete','${keyPath.replace(/'/g, "''")}','/f' -Verb RunAs -Wait; exit $LASTEXITCODE`],
        { windowsHide: true }
      )
      child.on('error', (e) => resolve({ ok: false, output: e.message }))
      child.on('close', (code) => resolve({ ok: code === 0 }))
    }
  })
}
