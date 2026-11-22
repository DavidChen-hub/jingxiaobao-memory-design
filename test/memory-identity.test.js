// T-037 全局身份卡：纯函数，不碰存储。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIdentityCard, isIdentityFact } from '../src/features/memory/identity.js'
import { cleanScope, scopeVisible } from '../src/features/memory.js'

const NOW = Date.parse('2026-11-16T19:30:00+08:00')

test('身份卡：至少知道「你是大肥鱼；主人是主人」', () => {
  const c = buildIdentityCard({ items: [] })
  assert.match(c.text, /你是大肥鱼；主人是主人/)
  assert.ok(c.chars > 0)
})

test('身份卡：自己的昵称/名字事实能进来', () => {
  const c = buildIdentityCard({ items: [
    { text: '我的抖音昵称是测试昵称', scope: 'self', tags: ['资料', '她自己'], at: NOW },
    { text: '我叫测试昵称，字饱', scope: 'identity', at: NOW },
  ] })
  assert.match(c.text, /测试昵称/)
  assert.equal(c.included.length, 2)
})

test('身份卡：敏感事实（生日/学校/住址/账号/密码）不进来', () => {
  for (const text of ['主人生日是 9 月 5 日', '主人住在某小区', '主人学校是某某大学', '主人微信是 abc123', '验证码 123456', '主人账号 12345678']) {
    assert.equal(isIdentityFact({ text, scope: 'identity', at: NOW }), false, text)
  }
  const c = buildIdentityCard({ items: [
    { text: '主人生日是 9 月 5 日', scope: 'identity', at: NOW },
    { text: '我的抖音昵称是测试昵称', scope: 'self', at: NOW },
  ] })
  assert.doesNotMatch(c.text, /生日/)
  assert.match(c.text, /测试昵称/)
})

test('身份卡：去重、截断到上限', () => {
  const c = buildIdentityCard({ items: [
    { text: '我的抖音昵称是测试昵称', scope: 'self', at: NOW },
    { text: '我的抖音昵称是测试昵称', scope: 'self', at: NOW },
    { text: '我是大肥鱼，住在屏幕里', scope: 'identity', at: NOW },
  ], maxChars: 80 })
  assert.equal(c.included.filter((x) => x.includes('测试昵称')).length, 1)
  assert.ok(c.chars <= 80)
  assert.ok(c.text.endsWith('…') || c.chars <= 80)
})

test('身份事实：显式 identity / 身份标签 / self 资料；普通私事不算', () => {
  assert.equal(isIdentityFact({ text: '朋友A是朋友', scope: 'owner', tags: ['关系'] }), true)
  assert.equal(isIdentityFact({ text: '主人喜欢钓鱼', scope: 'owner' }), false)
  assert.equal(isIdentityFact({ text: '我的抖音昵称是测试昵称', scope: 'self' }), true)
  assert.equal(isIdentityFact({ text: '我的抖音昵称是测试昵称', scope: 'self', invalidAt: NOW }), false)
  assert.equal(isIdentityFact({ text: '和主人说：我的是这个', scope: 'self', kind: 'event', source: 'turn' }), false, '经历不算身份')
})

test('identity 板块：面板可写，所有场合可见，隔离区仍不可见', () => {
  assert.equal(cleanScope('identity'), 'identity')
  assert.equal(scopeVisible({ scope: 'identity' }, 'group:9'), true)
  assert.equal(scopeVisible({ scope: 'identity' }, 'douyin'), true)
  assert.equal(scopeVisible({ scope: 'identity' }, 'quarantine'), false)
})
