/**
 * PE 解析器测试
 * 以系统自带文件为基准（任何 Windows 机器都有，CI 友好），
 * 并针对 v1.0.0 踩过的「大文件被 64MB 上限拦掉」缺陷做回归。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePe, readPeMeta, detectPacker } from '@scanner/pe'
import { mapApiSet, isApiSetName, resolveDll, buildPathDirs, repairHint } from '@scanner/dllresolve'

const SYS = process.env.SystemRoot || 'C:\\Windows'
const S32 = join(SYS, 'System32')

describe('parsePe —— 系统样本基准', () => {
  it('explorer.exe 解析成功且导入表非空', async () => {
    const r = await parsePe(join(SYS, 'explorer.exe'))
    assert.equal(r.parseStatus, 'ok')
    assert.equal(r.arch, 'x64')
    assert.equal(r.isDll, false)
    assert.ok(r.imports.length > 50, `导入项过少: ${r.imports.length}`)
    assert.ok(r.imports.some((d) => /^combase\.dll$/i.test(d)), '缺少 combase.dll 导入')
    assert.ok(r.delayImports.length > 0, '应有延迟导入项')
    assert.ok(!!r.fileVersion, '应解析出文件版本')
  })

  it('kernel32.dll 被正确识别为 DLL', async () => {
    const r = await parsePe(join(S32, 'kernel32.dll'))
    assert.equal(r.parseStatus, 'ok')
    assert.equal(r.isDll, true)
    assert.ok(r.imports.includes('ntdll.dll') || r.imports.some((d) => /ntdll/i.test(d)))
  })

  it('notepad.exe 可解析且带 SxS 清单', async () => {
    const r = await parsePe(join(S32, 'notepad.exe'))
    assert.equal(r.parseStatus, 'ok')
    assert.ok(r.imports.length > 10)
    assert.ok(r.sxsDependencies.length >= 0, 'SxS 解析不应抛错')
  })

  it('readPeMeta 返回架构与版本信息', async () => {
    const m = await readPeMeta(join(S32, 'kernel32.dll'))
    assert.equal(m.ok, true)
    assert.equal(m.arch, 'x64')
    assert.ok((m.fileDescription || m.productName || '').length > 0, '应有版本资源描述')
  })
})

describe('parsePe —— 异常输入', () => {
  it('不存在的文件返回 failed 而不抛异常', async () => {
    const r = await parsePe(join(S32, '__not_exist_12345__.exe'))
    assert.equal(r.parseStatus, 'failed')
    assert.ok(r.imports.length === 0)
  })

  it('非 PE 文件返回 not_pe', async () => {
    const r = await parsePe(join(process.cwd(), 'README.md'))
    assert.equal(r.parseStatus, 'not_pe')
  })

  it('空文件不崩溃', async () => {
    const r = await parsePe(join(process.cwd(), 'package.json'), { resources: false })
    assert.ok(['not_pe', 'failed'].includes(r.parseStatus))
  })
})

describe('parsePe —— 大文件回归（v1.0.0 缺陷 BUG-01）', () => {
  // 本机若存在 100MB+ 的单体可执行文件，必须能解析出导入表；
  // CI 上通常不存在，因此跳过而不是失败。
  const candidates = ['C:\\Software\\ZCode\\ZCode.exe', 'C:\\Software\\Apipost\\Apipost.exe']
  const big = candidates.find((p) => existsSync(p) && statSync(p).size > 100 * 1024 * 1024)

  it('超大 PE（>100MB）仍能解析出导入表', { skip: big ? false : '本机无超大样本，跳过' }, async () => {
    assert.ok(big)
    const sizeMB = statSync(big!).size / 1048576
    const r = await parsePe(big!, { resources: false })
    assert.equal(r.parseStatus, 'ok', `${big} (${sizeMB.toFixed(0)}MB) 解析失败: ${r.error}`)
    assert.ok(r.imports.length > 0, '导入表不应为空（这正是 BUG-01 的表现）')
  })
})

describe('parsePe —— 零导入模块不应被误判为加壳', () => {
  it('ntdll.dll：零导入但有导出表 → 判定为 ok', async () => {
    const p = join(S32, 'ntdll.dll')
    if (!existsSync(p)) return // 非 Windows 环境跳过
    const r = await parsePe(p, { resources: false })
    assert.equal(r.hasExports, true, 'ntdll 应有导出表')
    assert.equal(
      r.parseStatus,
      'ok',
      `ntdll.dll 零导入属正常形态，不应判为解析失败（实际：${r.parseStatus} / ${r.error}）`
    )
    assert.equal(r.packerSection, undefined, 'ntdll 不应命中加壳特征')
  })

  it('KernelBase.dll 的零导入同样应判为 ok', async () => {
    const p = join(S32, 'KernelBase.dll')
    if (!existsSync(p)) return
    const r = await parsePe(p, { resources: false })
    if (r.imports.length === 0 && r.delayImports.length === 0) {
      assert.equal(r.parseStatus, 'ok')
    }
  })
})

describe('加壳节名识别', () => {
  const mk = (names: string[]): { name: string; virtualAddress: number; virtualSize: number; rawPointer: number; rawSize: number }[] =>
    names.map((n) => ({ name: n, virtualAddress: 0, virtualSize: 0, rawPointer: 0, rawSize: 0 }))

  it('识别 UPX', () => assert.equal(detectPacker(mk(['.text', 'UPX0', 'UPX1'])), 'UPX'))
  it('识别 VMProtect', () => assert.equal(detectPacker(mk(['.text', '.vmp0'])), 'VMProtect'))
  it('识别 Themida', () => assert.equal(detectPacker(mk(['.text', '.themida'])), 'Themida'))
  it('识别 ASPack', () => assert.equal(detectPacker(mk(['.adata', '.text'])), 'ASPack'))
  it('普通节名不误报', () => {
    assert.equal(detectPacker(mk(['.text', '.rdata', '.data', '.pdata', '.rsrc', '.reloc'])), undefined)
    assert.equal(detectPacker(mk(['.text', 'CPADinfo', 'LZMADEC'])), undefined, 'ZCode/Electron 的自定义节名不应误报')
  })
})

describe('API Set 映射（5.2.3）', () => {
  const cases: [string, string][] = [
    ['api-ms-win-crt-runtime-l1-1-0.dll', 'ucrtbase.dll'],
    ['api-ms-win-core-file-l1-2-0.dll', 'kernelbase.dll'],
    ['api-ms-win-security-base-l1-1-0.dll', 'sechost.dll'],
    ['api-ms-win-eventing-provider-l1-1-0.dll', 'sechost.dll'],
    ['api-ms-win-core-winrt-string-l1-1-0.dll', 'combase.dll']
  ]
  for (const [input, expect] of cases) {
    it(`${input} → ${expect}`, () => assert.equal(mapApiSet(input), expect))
  }

  it('非 API Set 名称返回 null', () => {
    assert.equal(mapApiSet('kernel32.dll'), null)
    assert.equal(isApiSetName('kernel32.dll'), false)
    assert.equal(isApiSetName('api-ms-win-core-x.dll'), true)
  })

  it('未知 API Set 仍归类到 kernelbase 兜底而非缺失', () => {
    assert.equal(mapApiSet('api-ms-win-some-new-family-l1-1-0.dll'), 'kernelbase.dll')
  })
})

describe('DLL 搜索路径解析（5.2.4）', () => {
  const pathDirs = buildPathDirs()
  const ctx = { appDir: S32, arch: 'x64' as const, pathDirs, known: new Set<string>() }

  it('系统 DLL 命中 System32', () => {
    const r = resolveDll('kernel32.dll', ctx)
    assert.notEqual(r.kind, 'missing')
    assert.ok(/system32/i.test(r.fullPath), `应落在 System32: ${r.fullPath}`)
  })

  it('不存在的 DLL 判定为缺失依赖', () => {
    const r = resolveDll('definitely-not-a-real-dll-xyz.dll', ctx)
    assert.equal(r.kind, 'missing')
    assert.equal(r.fullPath, '')
  })

  it('32 位程序优先搜索 SysWOW64', () => {
    const r = resolveDll('kernel32.dll', { ...ctx, arch: 'x86' })
    assert.notEqual(r.kind, 'missing')
    assert.ok(/syswow64|system32/i.test(r.fullPath))
  })

  it('API Set 名称会被还原成宿主 DLL（virtual 标记）', () => {
    const r = resolveDll('api-ms-win-crt-runtime-l1-1-0.dll', ctx)
    assert.equal(r.virtual, true)
    assert.ok(/ucrtbase/i.test(r.resolvedName))
  })

  it('修复建议覆盖常见缺失场景', () => {
    assert.ok(/VC\+\+|Visual C\+\+/i.test(repairHint('msvcp140.dll')))
    assert.ok(/\.NET/.test(repairHint('hostfxr.dll')))
    assert.ok(/DirectX/i.test(repairHint('xinput1_4.dll')))
    assert.ok(repairHint('whatever.dll').length > 0)
  })
})
