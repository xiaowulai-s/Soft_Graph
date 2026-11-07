import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { expandEnvVars } from '../../packages/shared/util'

describe('v4.1.1 expandEnvVars', () => {
  const env = { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' }

  it('展开已定义的 %VAR%', () => {
    assert.equal(expandEnvVars('C:\\Users\\%USERNAME%\\Downloads', env), 'C:\\Users\\alice\\Downloads')
    assert.equal(expandEnvVars('%USERPROFILE%\\doc', env), 'C:\\Users\\alice\\doc')
  })

  it('未定义的占位符保持原样（不吞字符）', () => {
    assert.equal(expandEnvVars('%NOPE%\\x', env), '%NOPE%\\x')
  })

  it('无占位符透传 + 大小写敏感匹配（Windows env 惯例）', () => {
    assert.equal(expandEnvVars('C:\\plain\\path', env), 'C:\\plain\\path')
    assert.equal(expandEnvVars('%username%', env), '%username%')
  })
})
