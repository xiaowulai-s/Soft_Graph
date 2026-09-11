/**
 * 依赖归属置信度打分测试（设计文档 7.1）
 * 公式：confidence = clamp( max(E_weight) + 0.05*(hitCount-1) - 0.15*min(1, log10(refCount)/2) )
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scoreConfidence, baselineRefCount } from '@scanner/deps'
import { EVIDENCE_WEIGHT, type EvidenceCode } from '@shared/types'

describe('scoreConfidence —— 单证据基线', () => {
  it('E2 单证据且专属（refCount=1）应等于权重本身', () => {
    const c = scoreConfidence(['E2'], 1)
    assert.equal(Number(c.toFixed(4)), EVIDENCE_WEIGHT.E2)
  })

  it('E1 单证据偏低（0.60）', () => {
    assert.equal(Number(scoreConfidence(['E1'], 1).toFixed(2)), 0.6)
  })

  it('E8 为满分上限', () => {
    assert.equal(scoreConfidence(['E8'], 1), 1)
  })

  it('空证据返回 0', () => {
    assert.equal(scoreConfidence([], 1), 0)
  })
})

describe('scoreConfidence —— 多证据印证加成', () => {
  it('E1+E2（安装目录 + 导入表）应显著高于单 E2', () => {
    const single = scoreConfidence(['E2'], 1)
    const dual = scoreConfidence(['E1', 'E2'], 1)
    assert.ok(dual > single, '双证据必须加成')
    assert.equal(Number((dual - single).toFixed(4)), 0.05)
  })

  it('三条证据加成 0.10', () => {
    const c = scoreConfidence(['E1', 'E2', 'E5'] as EvidenceCode[], 1)
    assert.equal(Number(c.toFixed(4)), Number((EVIDENCE_WEIGHT.E2 + 0.1).toFixed(4)))
  })

  it('加成后不超过 1', () => {
    const c = scoreConfidence(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'], 1)
    assert.ok(c <= 1)
  })

  it('取最强证据为基准，而非平均', () => {
    const weak = scoreConfidence(['E7'], 1)
    const mixed = scoreConfidence(['E7', 'E2'], 1)
    assert.ok(mixed > weak)
    assert.ok(mixed >= EVIDENCE_WEIGHT.E2, '应以最强证据 E2 为基')
  })
})

describe('scoreConfidence —— 共享惩罚', () => {
  it('refCount 越大置信度越低', () => {
    const a = scoreConfidence(['E2'], 1)
    const b = scoreConfidence(['E2'], 10)
    const c = scoreConfidence(['E2'], 120)
    assert.ok(a > b && b > c, `单调性被破坏: ${a} ${b} ${c}`)
  })

  it('refCount=120（系统 DLL 典型值）应把 E2 压到 0.75 附近', () => {
    const c = scoreConfidence(['E2'], 120)
    assert.equal(Number(c.toFixed(2)), 0.75)
  })

  it('惩罚上限为 0.15，不会压到 0 以下', () => {
    const c = scoreConfidence(['E1'], 1e9)
    assert.equal(Number(c.toFixed(2)), Number((EVIDENCE_WEIGHT.E1 - 0.15).toFixed(2)))
    assert.ok(c >= 0)
  })

  it('refCount=0 与 refCount=1 等效（log10 保护）', () => {
    assert.equal(scoreConfidence(['E2'], 0), scoreConfidence(['E2'], 1))
  })
})

describe('scoreConfidence —— 文档中给出的设计意图场景', () => {
  it('「PE 导入命中 + 位于安装目录」应接近高分（≥0.93）', () => {
    const c = scoreConfidence(['E1', 'E2'], 1)
    assert.ok(c >= 0.93, `双证据专属依赖得分偏低: ${c}`)
  })

  it('kernel32 类被数百软件共享的文件必须被显著压低', () => {
    const c = scoreConfidence(['E2'], 400)
    assert.ok(c < 0.8, `共享惩罚不足: ${c}`)
  })
})

describe('baselineRefCount —— 冷启动基线', () => {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'

  it('System32 下的文件给高基线（避免误判为专属依赖）', () => {
    assert.ok(baselineRefCount(`${sysRoot}\\System32\\kernel32.dll`, 'kernel32.dll') >= 100)
  })

  it('WinSxS 次之', () => {
    const v = baselineRefCount(`${sysRoot}\\WinSxS\\x\\y.dll`, 'y.dll')
    assert.ok(v >= 40 && v < baselineRefCount(`${sysRoot}\\System32\\a.dll`, 'a.dll'))
  })

  it('共享运行库即便在别处也给中高基线', () => {
    assert.ok(baselineRefCount('D:\\App\\vcruntime140.dll', 'vcruntime140.dll') >= 40)
  })

  it('普通应用目录文件为 1（专属）', () => {
    assert.equal(baselineRefCount('D:\\MyApp\\a.dll', 'a.dll'), 1)
  })
})
