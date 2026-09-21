#!/usr/bin/env node
/**
 * 代码签名预检与产物验收（E1 前置 · v3.0.0）
 * ============================================================
 * E1 的阻塞点是「没有正式证书」，但 docs/07 承诺的「证书到位后 15 分钟切换」
 * 今天做不到：切换要手改 `electron-builder.yml`、手敲 signtool、肉眼看签名状态，
 * 而其中最危险的一步是**静默失败** —— `signAndEditExecutable: false` 留在配置里时，
 * 就算 CSC_LINK 配好了，electron-builder 也不会签名，产物照样发布出去。
 *
 * 本脚本把「切换前该检查什么」和「发布前该验收什么」变成一条命令：
 *
 *   npm run sign:check                # 预检 + 有产物就逐个验收
 *   npm run sign:check -- --precheck  # 只预检（还没构建时用）
 *   npm run sign:check -- --verify    # 只验收 release/<version>/ 下的产物
 *
 * 退出码：0 = 当前配置与产物状态自洽；1 = 有必须处理的问题（不要发布）。
 * 全程不打印任何密钥内容（`CSC_KEY_PASSWORD` 只报是否存在与长度）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import https from 'node:https'
import http from 'node:http'

const root = process.cwd()
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const RELEASE_DIR = join(root, 'release', version)
const BUILDER_YML = join(root, 'electron-builder.yml')
const TS_URL = flag('--ts-url') || 'http://timestamp.digicert.com'

const out = []
const problems = []
const warnings = []
const ok = (m) => out.push(['OK  ', m])
const warn = (m) => {
  warnings.push(m)
  out.push(['WARN', m])
}
const bad = (m) => {
  problems.push(m)
  out.push(['FAIL', m])
}
const info = (m) => out.push(['    ', m])

// ───────────────── PowerShell（最小环境块，见 BUG-22） ─────────────────

const ENV_WHITELIST = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PATH',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PSModulePath', 'SESSIONNAME'
]
function minimalEnv() {
  const e = {}
  for (const k of ENV_WHITELIST) {
    const v = process.env[k]
    if (v && v.length <= 32 * 1024) e[k] = v
  }
  return e
}

function ps(script, env) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...minimalEnv(), ...(env || {}) }
  })
  if (r.status !== 0 && !r.stdout) return { ok: false, error: (r.stderr || r.error?.message || '').trim().slice(0, 300) }
  return { ok: true, stdout: (r.stdout || '').trim() }
}

// ───────────────── 预检：证书侧 ─────────────────

function precheckCert() {
  const link = process.env.CSC_LINK
  const pwd = process.env.CSC_KEY_PASSWORD
  const name = process.env.CSC_NAME

  if (!link && !name) {
    warn('未设置 CSC_LINK / CSC_NAME —— 当前构建**不会签名**，只能按未签名包发布')
    return { certAvailable: false }
  }
  ok(`CSC_LINK ${link ? `已设置（${link.length} 字符）` : ''}${name ? `CSC_NAME=${name}` : ''}`)
  if (!pwd && link && !/^-----BEGIN/.test(link)) warn('未设置 CSC_KEY_PASSWORD —— PFX 有口令时签名会失败')
  else if (pwd) ok(`CSC_KEY_PASSWORD 已设置（长度 ${pwd.length}，内容不打印）`)

  // 文件形式的 PFX：检查存在性与有效期/主体（Get-PfxCertificate 不导私钥，安全）
  let file = null
  if (link) {
    if (/^[a-zA-Z]:[\\/]/.test(link) || link.startsWith('.')) file = link
    else {
      try {
        const decoded = Buffer.from(link, 'base64').subarray(0, 4)
        if (decoded.length === 4) info('CSC_LINK 是 base64（CI 常用形式），不做文件存在性检查')
      } catch {
        /* 非 base64，忽略 */
      }
    }
  }
  if (file) {
    if (!existsSync(file)) {
      bad(`CSC_LINK 指向的文件不存在：${file}`)
      return { certAvailable: true }
    }
    ok(`证书文件存在：${file}（${(statSync(file).size / 1024).toFixed(0)} KB）`)
    const r = ps(
      `try { $p = Get-PfxCertificate -FilePath $env:SG_PFX -ErrorAction Stop; ` +
        `"$($p.Subject)|$($p.Thumbprint)|$($p.NotBefore.ToString('yyyy-MM-dd'))|$($p.NotAfter.ToString('yyyy-MM-dd'))|$($p.DnsNameList)" } ` +
        `catch { "ERR $($_.Exception.Message)" }`,
      { SG_PFX: file }
    )
    if (!r.ok) return { certAvailable: true, pfxFile: file }
    const line = r.stdout.split('\n').pop() || ''
    if (line.startsWith('ERR')) {
      warn(`Get-PfxCertificate 读取失败（可能需要口令）：${line.slice(4, 160)}`)
    } else {
      const [subject, thumb, notBefore, notAfter, san] = line.split('|')
      ok(`证书主体：${subject}`)
      info(`指纹 ${thumb} ｜ 有效期 ${notBefore} → ${notAfter} ｜ 使用者 ${san}`)
      const end = new Date(notAfter)
      if (!Number.isNaN(end.getTime())) {
        if (end < new Date()) bad('证书已过期 —— 签名产物会立刻不可信')
        else if (end - new Date() < 30 * 86400_000) warn(`证书将在 ${Math.round((end - new Date()) / 86400_000)} 天后到期，签名必须带时间戳`)
      }
      return { certAvailable: true, pfxFile: file, subject, thumbprint: thumb, notAfter }
    }
  }
  return { certAvailable: true }
}

// ───────────────── 预检：electron-builder 配置侧 ─────────────────

function precheckBuilder(cert) {
  if (!existsSync(BUILDER_YML)) {
    bad('electron-builder.yml 不存在')
    return {}
  }
  const yml = readFileSync(BUILDER_YML, 'utf8')
  const grab = (key) => {
    const m = yml.match(new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'm'))
    return m ? m[1] : undefined
  }
  const signAndEdit = grab('signAndEditExecutable')
  const force = grab('forceCodeSigning')
  info(`electron-builder.yml：signAndEditExecutable=${signAndEdit ?? '(未设置，默认 true)'} forceCodeSigning=${force ?? '(未设置)'}`)

  if (cert.certAvailable) {
    if (signAndEdit === 'false') {
      bad('证书已就位，但 `signAndEditExecutable: false` 仍在 —— electron-builder 会**静默跳过签名**，产物照样能构建出来。正式发布请删除该行或改为 true')
    } else {
      ok('证书与构建配置一致：electron-builder 会在构建期签名')
    }
    if (force !== 'true') warn('建议同时设 `forceCodeSigning: true`：签名失败即构建失败，而不是产出未签名包')
  } else if (signAndEdit !== 'false') {
    bad('无证书却开着签名开关：electron-builder 会「找不到证书就报错」或静默跳过，行为不直观。要么补 CSC_LINK，要么显式写 signAndEditExecutable: false')
  } else {
    info('当前为「未签名发布」形态：Release 说明必须注明未签名（docs/07 的检查清单第 5 条）')
  }
  return { signAndEdit, forceCodeSigning: force }
}

// ───────────────── 预检：时间戳与工具链 ─────────────────

function headCheck(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.request(url, { method: 'HEAD', timeout: 8000 }, (res) => {
      res.resume()
      resolve({ ok: res.statusCode < 500, status: res.statusCode })
    })
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'timeout' })
    })
    req.end()
  })
}

function findSigntool() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['signtool'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0]
  const kits = ['C:\\Program Files (x86)\\Windows Kits\\10\\bin', 'C:\\Program Files\\Windows Kits\\10\\bin']
  for (const k of kits) {
    if (!existsSync(k)) continue
    const versions = readdirSync(k).filter((v) => /^\d/.test(v)).sort().reverse()
    for (const v of versions) {
      for (const arch of ['x64', '']) {
        const p = join(k, v, arch, 'signtool.exe')
        if (existsSync(p)) return p
      }
    }
    const direct = join(k, 'x64', 'signtool.exe')
    if (existsSync(direct)) return direct
  }
  return null
}

// ───────────────── 产物验收 ─────────────────

function artifacts(deep) {
  if (!existsSync(RELEASE_DIR)) return null
  const files = []
  const walk = (dir, insideUnpacked) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (deep || !insideUnpacked) walk(p, insideUnpacked || f === 'win-unpacked' || /unpacked/i.test(f))
        continue
      }
      if (!/\.exe$/i.test(f)) continue
      // win-unpacked 内的 SoftGraph.exe 与卸载器只有 --deep 时才看（NSIS 会一并签）
      if (!deep && insideUnpacked) continue
      files.push(p)
    }
  }
  walk(RELEASE_DIR, false)
  return files
}

function verifyArtifacts(files) {
  return files.map((f) => {
    const r = ps(
      `$s = Get-AuthenticodeSignature -FilePath $env:SG_FILE; ` +
        `[pscustomobject]@{ Status=[string]$s.Status; Msg=[string]$s.StatusMessage; ` +
        `Subject=[string]$s.SignerCertificate.Subject; Thumb=[string]$s.SignerCertificate.Thumbprint; ` +
        `NotAfter=[string]$s.SignerCertificate.NotAfter; ` +
        `Ts=[string]$s.TimeStamperCertificate.Subject; TstNotAfter=[string]$s.TimeStamperCertificate.NotAfter } | ` +
        `ConvertTo-Json -Compress`,
      { SG_FILE: f }
    )
    if (!r.ok) return { file: f, status: 'UNKNOWN', message: r.error || 'PowerShell 调用失败' }
    let j = {}
    try {
      j = JSON.parse(r.stdout.split('\n').pop())
    } catch {
      return { file: f, status: 'UNKNOWN', message: '签名信息解析失败' }
    }
    return {
      file: f,
      status: j.Status,
      message: j.Msg,
      subject: j.Subject,
      thumbprint: j.Thumb,
      certNotAfter: j.NotAfter,
      timestamp: j.Ts && j.Ts !== '' ? j.Ts : null,
      timestampNotAfter: j.TstNotAfter || null
    }
  })
}

// ───────────────── 主流程 ─────────────────

async function main() {
  const onlyPrecheck = has('--precheck')
  const onlyVerify = has('--verify')

  const cert = precheckCert()
  const builder = precheckBuilder(cert)

  const ts = await headCheck(TS_URL)
  if (ts.ok) ok(`时间戳服务可达：${TS_URL}（HTTP ${ts.status}）`)
  else warn(`时间戳服务不可达：${TS_URL}（${ts.error || ts.status}）—— 离线时签名会失败或无时间戳`)

  const signtool = findSigntool()
  if (signtool) ok(`signtool 可用：${signtool}`)
  else info('未找到 signtool（Windows SDK）—— 用内置 Get-AuthenticodeSignature 校验，够用；`signtool verify /pa` 可作为二次复核')

  let report = []
  if (!onlyPrecheck) {
    const extra = argv.reduce((acc, a, i) => (a === '--file' && argv[i + 1] ? acc.concat(argv[i + 1]) : acc), [])
    const files = extra.length > 0 ? extra : artifacts(has('--deep'))
    if (files === null) {
      info(`未找到 ${basename(RELEASE_DIR)} 产物目录（${join('release', version)}）—— 先 npm run pack:win 再验收`)
    } else if (files.length === 0) {
      warn('产物目录存在但没有 .exe —— 构建可能未产出安装包')
    } else {
      report = verifyArtifacts(files)
      for (const a of report) {
        const rel = basename(a.file)
        if (a.status === 'Valid') {
          ok(`${rel}：签名有效 —— ${a.subject}${a.timestamp ? ` ｜ 带时间戳（${a.timestamp}）` : ''}`)
          if (!a.timestamp) bad(`${rel}：签名**没有时间戳** —— 证书过期后该产物即不可信，必须重签（docs/07）`)
        } else if (a.status === 'NotSigned') {
          if (cert.certAvailable) bad(`${rel}：未签名，但证书环境变量已就位 —— 检查 signAndEditExecutable / forceCodeSigning`)
          else warn(`${rel}：未签名（无证书，属预期）—— Release 必须注明`)
        } else {
          bad(`${rel}：签名状态 ${a.status} —— ${a.message || ''}`)
        }
      }
      const signed = report.filter((a) => a.status === 'Valid').length
      info(`产物签名汇总：${signed}/${report.length} 有效`)
    }
  }

  // 结论
  console.log('\n代码签名检查（E1）')
  console.log('─'.repeat(72))
  for (const [tag2, m] of out) console.log(`${tag2} ${m}`)
  console.log('─'.repeat(72))

  const unsigned = report.filter((a) => a.status === 'NotSigned').length
  const invalid = report.filter((a) => a.status && a.status !== 'Valid' && a.status !== 'NotSigned').length
  let verdict
  if (problems.length > 0) verdict = '不可发布'
  else if (cert.certAvailable && report.length > 0) verdict = '可发布（签名已生效）'
  else if (!cert.certAvailable && report.length > 0) verdict = '可发布（未签名，需在 Release 注明）'
  else verdict = '预检通过（未验收产物）'

  console.log(`结论：${verdict}${problems.length ? ` ｜ 必须处理 ${problems.length} 项` : ''}${warnings.length ? ` ｜ 提示 ${warnings.length} 项` : ''}`)
  for (const p of problems) console.log('  ✘ ' + p)
  for (const w of warnings) console.log('  · ' + w)

  const jsonFile = flag('--json') || join(root, '.tmp', 'sign-check.json')
  mkdirSync(join(jsonFile, '..'), { recursive: true })
  writeFileSync(
    jsonFile,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        version,
        cert: { ...cert, linkLength: (process.env.CSC_LINK || '').length, hasPassword: !!process.env.CSC_KEY_PASSWORD },
        builder,
        timestampService: { url: TS_URL, ...ts },
        signtool,
        artifacts: report,
        problems,
        warnings,
        verdict
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`\n报告：${jsonFile}`)

  // Release 说明可直接粘贴的一行
  if (report.length > 0) {
    const line = cert.certAvailable
      ? `**代码签名**：已签名（${report.find((a) => a.status === 'Valid')?.subject ?? '见报告'}${
          report.some((a) => a.timestamp) ? '，含 RFC3161 时间戳' : '，无时间戳'
        }）`
      : '**代码签名**：本版本未签名（证书待接入）。安装包完整性请核对同目录的 SHA256SUMS.txt'
    console.log('\nRelease 说明片段：\n' + line)
  }

  process.exit(problems.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('签名检查脚本失败：', e)
  process.exit(1)
})
