// 问法路由（T-039）：只测纯函数，不碰存储。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeQuery, routeScore, routeBonus, inferSlot, inferTopic, ROUTE_WEIGHTS } from '../src/features/memory/route.js'
import { search, buildIndex } from '../src/features/memory.js'

const NOW = Date.parse('2026-11-16T18:00:00+08:00')
const people = [{ qq: '10000001', name: '主人' }, { qq: '30000003', name: '朋友A' }]

test('问法：我生日 → owner + birthday 槽位', () => {
  const r = routeQuery('我生日是哪天', { now: NOW, people, ownerQQ: '10000001' })
  assert.equal(r.who, 'owner')
  assert.ok(r.slots.includes('birthday'))
  assert.ok(r.topics.includes('identity'))
})

test('问法：助手的抖音昵称 → bot + 昵称/资料槽位 + 抖音主题', () => {
  const r = routeQuery('助手的抖音昵称是什么', { now: NOW, people, ownerQQ: '10000001' })
  assert.equal(r.who, 'bot')
  assert.ok(r.slots.includes('nickname') || r.slots.includes('profile'))
  assert.ok(r.topics.includes('douyin'))
})

test('问法：叫名字优先认人，不误判成主人', () => {
  const r = routeQuery('朋友A喜欢吃什么', { now: NOW, people, ownerQQ: '10000001' })
  assert.equal(r.who, '朋友A')
  assert.equal(r.qq, '30000003')
  assert.ok(r.slots.includes('pref'))
})

test('问法：昨天 / 周五 能落到具体日期', () => {
  const y = routeQuery('昨天她说什么了', { now: NOW })
  assert.equal(y.dayKeys.length, 1)
  assert.equal(y.dayKeys[0], '2026-11-15')
  const w = routeQuery('周五有什么安排', { now: NOW })
  assert.ok(w.dayKeys.length >= 1)
})

test('空问句不产生结构条件', () => {
  const r = routeQuery('', { now: NOW })
  assert.deepEqual([r.slots.length, r.topics.length, r.tokens.length, r.who, r.dayKeys.length], [0, 0, 0, '', 0])
})

test('单条推断：昵称/资料/主题', () => {
  assert.equal(inferSlot('我的抖音昵称是测试昵称'), 'nickname')
  assert.equal(inferSlot('主人喜欢吃辣'), 'pref')
  assert.equal(inferTopic({ scope: 'self', tags: ['资料', '她自己'], text: '我的抖音昵称是测试昵称' }), 'self')
  assert.equal(inferTopic({ scope: 'douyin', tags: [], text: '在抖音回复了一条评论' }), 'douyin')
})

test('routeScore：主体/槽位/主题/日期分别给信号', () => {
  const route = routeQuery('我今天生日是哪天', { now: NOW, people, ownerQQ: '10000001' })
  const rs = routeScore({ text: '主人 生日是 9 月 5 日', about: '10000001', aboutName: '主人', at: NOW }, route)
  assert.equal(rs.subjectHit, true)
  assert.equal(rs.slotHit, true)
  assert.equal(rs.topicHit, true)
  assert.equal(rs.dateHit, true)
  assert.equal(rs.expired, false)
  assert.equal(routeBonus(rs), ROUTE_WEIGHTS.subject + ROUTE_WEIGHTS.slot + ROUTE_WEIGHTS.topic + ROUTE_WEIGHTS.date)
})

test('槽位 > 主体 > 主题 > 日期；过期扣分', () => {
  assert.ok(ROUTE_WEIGHTS.slot > ROUTE_WEIGHTS.subject)
  assert.ok(ROUTE_WEIGHTS.subject > ROUTE_WEIGHTS.topic)
  assert.ok(ROUTE_WEIGHTS.topic > ROUTE_WEIGHTS.date)
  assert.ok(routeBonus({ expired: true }) < 0)
})

test('问法：主人对她说「你」指她，不是主人', () => {
  const r = routeQuery('你抖音昵称是什么', { now: NOW, people, ownerQQ: '10000001' })
  assert.equal(r.who, 'bot')
  const r2 = routeQuery('你的主人是谁', { now: NOW, people, ownerQQ: '10000001' })
  assert.equal(r2.who, 'owner')
})

test('检索：只说「群事」不会把整个群板捞进来', () => {
  const items = [
    { id: 'hit', text: '旧运行态写的一条群事', kind: 'event', scope: 'group:9', at: NOW },
    { id: 'noise', text: '群九阿司爱下棋', kind: 'event', scope: 'group:9', at: NOW },
  ]
  const route = routeQuery('群事', { now: NOW, people, ownerQQ: '10000001' })
  const hits = search(buildIndex(items), '群事', { now: NOW, route, minScore: 0.35, allow: (it) => it.scope === 'group:9' })
  assert.deepEqual(hits.map((h) => h.it.id), ['hit'])
})

test('检索：问「我生日」时主体命中压过词面相同的朋友A生日', () => {
  const items = [
    { id: 'owner-birth', text: '主人 生日是 9 月 5 日', kind: 'fact', about: '10000001', aboutName: '主人', scope: 'owner', at: NOW },
    { id: 'friend-birth', text: '朋友A 生日是 3 月 2 日', kind: 'fact', about: '30000003', aboutName: '朋友A', scope: 'owner', at: NOW },
  ]
  const route = routeQuery('我生日是哪天', { now: NOW, people, ownerQQ: '10000001' })
  const hits = search(buildIndex(items), '生日 哪天', { now: NOW, route, minScore: 0, limit: 2 })
  assert.equal(hits[0].it.id, 'owner-birth')
})

test('检索：问「助手的抖音昵称」时 self 板的事实排在别人的抖音昵称前', () => {
  const items = [
    { id: 'self-nick', text: '我的抖音昵称是测试昵称', kind: 'fact', scope: 'self', board: 'owner', aboutName: '我', at: NOW },
    { id: 'friend-nick', text: '朋友A的抖音昵称是测试昵称汪', kind: 'fact', scope: 'owner', about: '30000003', aboutName: '朋友A', at: NOW },
  ]
  const route = routeQuery('助手的抖音昵称是什么', { now: NOW, people, ownerQQ: '10000001' })
  const hits = search(buildIndex(items), '抖音 昵称', { now: NOW, route, minScore: 0, limit: 2 })
  assert.equal(hits[0].it.id, 'self-nick')
})

test('检索：问「我生日」时，正文没写“生日”但槽位命中的事实也能被救回', () => {
  const items = [{ id: 'born', text: '9 月 5 日出生', kind: 'fact', about: '10000001', aboutName: '主人', scope: 'owner', at: NOW }]
  const route = routeQuery('我生日是哪天', { now: NOW, people, ownerQQ: '10000001' })
  const hits = search(buildIndex(items), '我生日是哪天', { now: NOW, route, minScore: 0.35 })
  assert.equal(hits[0]?.it.id, 'born')
})

test('检索：泛泛的「我」不把整板事实捞进来，只有槽位/主题/日期能救回', () => {
  const items = [{ id: 'noise', text: '今天天气不错', kind: 'fact', about: '10000001', aboutName: '主人', scope: 'owner', at: NOW }]
  const route = routeQuery('我生日是哪天', { now: NOW, people, ownerQQ: '10000001' })
  const hits = search(buildIndex(items), '我生日是哪天', { now: NOW, route, minScore: 0.35 })
  assert.equal(hits.length, 0)
})

test('检索：route.enabled=false 时不加分，结果仍可用', () => {
  const items = [{ id: 'a', text: '主人的生日是 9 月 5 日', kind: 'fact', about: '10000001', aboutName: '主人', scope: 'owner', at: NOW }]
  const route = routeQuery('我生日是哪天', { now: NOW, people, ownerQQ: '10000001' })
  const withRoute = search(buildIndex(items), '生日', { now: NOW, route, minScore: 0 })
  const without = search(buildIndex(items), '生日', { now: NOW, route: null, minScore: 0 })
  assert.ok(withRoute[0].score > without[0].score)
})
