// 潮汐衰减（T-034）：事实永不过期，事件按半衰期淡出；证据分饱和，不做情绪加权。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retention, shouldForget, evidenceScore, isEventMemory, search, buildIndex, capItems } from '../src/features/memory.js'
import { normalize } from '../src/core/config.js'

const DAY = 86400_000
const close = (a, b) => Math.abs(a - b) < 1e-9

test('配置：decay 默认 30/180；非法值/空值都夹回默认', () => {
  const c = normalize({})
  assert.deepEqual(c.memory.decay, { eventHalfLifeDays: 30, eventForgetDays: 180 })
  const d = normalize({ memory: { decay: { eventHalfLifeDays: 0, eventForgetDays: 99999 } } }).memory.decay
  assert.equal(d.eventHalfLifeDays, 1)
  assert.equal(d.eventForgetDays, 3650)
  const empty = normalize({ memory: { decay: { eventHalfLifeDays: null, eventForgetDays: '' } } }).memory.decay
  assert.deepEqual(empty, { eventHalfLifeDays: 30, eventForgetDays: 180 })
})

test('事实永不过期：900 天前、重要度 0.2 的事实仍然 retention=1，不会被自动忘', () => {
  const now = Date.now()
  const fact = { kind: 'fact', source: 'auto', importance: 0.2, at: now - 900 * DAY }
  assert.equal(isEventMemory(fact), false)
  assert.equal(retention(fact, now), 1)
  assert.equal(shouldForget(fact, now), false)
  // 新数据：kind:'fact' + source:'event'（抖音/B站记住的知识）仍是事实；老数据无 kind 才按 source 认
  assert.equal(isEventMemory({ kind: 'fact', source: 'event' }), false)
  assert.equal(isEventMemory({ source: 'event' }), true)
})

test('事件按 30 天半衰期淡出：0/30/60/180 天 = 1 / 0.5 / 0.25 / 1/64；被想起会续命', () => {
  const now = Date.now()
  const ev = (days) => ({ kind: 'event', source: 'turn', importance: 0.5, at: now - days * DAY })
  assert.equal(retention(ev(0), now), 1)
  assert.ok(close(retention(ev(30), now), 0.5))
  assert.ok(close(retention(ev(60), now), 0.25))
  assert.ok(close(retention(ev(180), now), 1 / 64))
  assert.ok(close(retention({ ...ev(60), lastHit: now - 30 * DAY }, now), 0.5), '最近被想起过，按 30 天算')
})

test('半衰期可配置；配置不影响事实', () => {
  const now = Date.now()
  const ev = { kind: 'event', at: now - 30 * DAY }
  assert.ok(close(retention(ev, now, { eventHalfLifeDays: 60 }), Math.SQRT1_2))
  assert.equal(retention({ kind: 'fact', at: now - 999 * DAY }, now, { eventHalfLifeDays: 1 }), 1)
})

test('事实不自动清理；事件超过 180 天才清，重要事件留着', () => {
  const now = Date.now()
  const ev = (days, importance = 0.4) => ({ kind: 'event', importance, at: now - days * DAY })
  assert.equal(shouldForget(ev(30), now), false)
  assert.equal(shouldForget(ev(179), now), false)
  assert.equal(shouldForget(ev(200), now), true)
  assert.equal(shouldForget({ ...ev(200), lastHit: now - 10 * DAY }, now), false, '最近被想起过，续命')
  assert.equal(shouldForget(ev(200, 0.8), now), false, '重要事件不清')
  assert.equal(shouldForget({ kind: 'fact', source: 'auto', importance: 0.1, at: now - 900 * DAY }, now), false)
  // 被新事实取代的「过时」仍按半年回收
  assert.equal(shouldForget({ kind: 'fact', invalidAt: now - 10 * DAY }, now), false)
  assert.equal(shouldForget({ kind: 'fact', invalidAt: now - 200 * DAY }, now), true)
  // 清理期直接听配置：半衰期 365、清理 30 → 40 天的事件就该清，不能变成 730 天
  assert.equal(shouldForget({ kind: 'event', importance: 0.4, at: now - 40 * DAY }, now, { eventHalfLifeDays: 365, eventForgetDays: 30 }), true)
})

test('证据分 s/(s+2) 饱和：0 / 2 / 6 次想起 = 0 / 0.5 / 0.75', () => {
  assert.equal(evidenceScore({ hits: 0 }), 0)
  assert.equal(evidenceScore({ hits: 2 }), 0.5)
  assert.equal(evidenceScore({ hits: 6 }), 0.75)
  assert.ok(evidenceScore({ hits: 1000 }) < 1)
})

test('检索排序：同样内容、同样重要度，90 天前的旧事件让位给事实', () => {
  const now = Date.now()
  const items = [
    { id: 'event', text: '主人喜欢吃辣', kind: 'event', importance: 0.5, at: now - 90 * DAY, scope: 'owner' },
    { id: 'fact', text: '主人喜欢吃辣', kind: 'fact', importance: 0.5, at: now - 90 * DAY, scope: 'owner' },
  ]
  const hits = search(buildIndex(items), '喜欢吃辣', { now })
  assert.equal(hits[0].it.id, 'fact')
})

test('检索排序：刚发生的事件仍然和事实同档，不被证据分惩罚', () => {
  const now = Date.now()
  const items = [
    { id: 'fact', text: '她说喜欢海边', kind: 'fact', importance: 0.5, at: now - 700 * DAY, scope: 'owner' },
    { id: 'event', text: '她说喜欢海边', kind: 'event', importance: 0.5, at: now - 1 * DAY, scope: 'owner', hits: 0 },
  ]
  const hits = search(buildIndex(items), '喜欢海边', { now })
  const byId = Object.fromEntries(hits.map((h) => [h.it.id, h.score]))
  assert.ok(byId.event / byId.fact > 0.95, `新鲜事件不该比事实低太多：${byId.event} vs ${byId.fact}`)
})

test('检索排序：被反复想起的旧事件，比从没被想起的旧事件靠前', () => {
  const now = Date.now()
  const items = [
    { id: 'cold', text: '我们去海边看海', kind: 'event', importance: 0.5, at: now - 60 * DAY, scope: 'owner', hits: 0 },
    { id: 'warm', text: '我们去海边看海', kind: 'event', importance: 0.5, at: now - 60 * DAY, scope: 'owner', hits: 8 },
  ]
  const hits = search(buildIndex(items), '看海', { now, minScore: 0 })
  assert.equal(hits[0].it.id, 'warm')
})

test('上限保护：先保事实，再给事件名额，低重要度事实不会被静默挤掉', () => {
  const now = Date.now()
  const items = [
    { id: 'fact-low', text: '低重要度事实', kind: 'fact', importance: 0.2, at: now - 10 * DAY },
    { id: 'fact-high', text: '高重要度事实', kind: 'fact', importance: 0.9, at: now - 10 * DAY },
    { id: 'event-high', text: '高重要度事件', kind: 'event', importance: 0.9, at: now - 10 * DAY },
    { id: 'event-low', text: '低重要度事件', kind: 'event', importance: 0.2, at: now - 10 * DAY },
  ]
  const kept = capItems(items, 3).map((m) => m.id).sort()
  assert.deepEqual(kept, ['event-high', 'fact-high', 'fact-low'])
})

test('about-only 命中（正文一个字都不重合）仍然能想起这个人', () => {
  const now = Date.now()
  const items = [{ id: 'a', text: '完全无关的量子力学', kind: 'fact', importance: 0.5, at: now, about: '123', scope: 'owner' }]
  const hits = search(buildIndex(items), '今天吃什么', { now, about: '123' })
  assert.equal(hits[0]?.it.id, 'a')
})
