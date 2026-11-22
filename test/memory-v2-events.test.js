import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_HEADER, formatEventSlice } from '../src/features/memory/events.js'

const now = Date.parse('2026-11-09T14:00:00+08:00')
const ev = (id, at, text, kind = 'event') => ({ id, at, text, kind })

test('事件段：只取 24 小时内、按时间倒序、每条带日期', () => {
  const s = formatEventSlice([
    ev('a', now - 2 * 3600e3, '在抖音回了主人一条评论'),
    ev('b', now - 30 * 3600e3, '昨天的旧事'),
    { id: 'c', at: now - 3600e3, text: '这是事实不是事件', kind: 'fact' },
    ev('d', now - 26 * 3600e3, '前天的'),
  ], { now })

  assert.ok(s.text.startsWith(EVENT_HEADER))
  assert.match(s.text, /回了主人一条评论/)
  assert.doesNotMatch(s.text, /旧事|前天的|这是事实/)
  assert.equal(s.count, 1)
  assert.match(s.text.split('\n')[1], /^- \[\d{2}-\d{2} \d{2}:\d{2}\] /)
})

test('事件段：条数与字数封顶', () => {
  const items = []
  for (let i = 0; i < 12; i++) items.push(ev('e' + i, now - i * 60e3, `第${i}件事` + '内容'.repeat(40)))
  const s = formatEventSlice(items, { now, maxItems: 6, maxChars: 600 })
  assert.ok(s.count <= 6, `条数 ${s.count}`)
  assert.ok(s.chars <= 600, `字数 ${s.chars}`)
  assert.ok(s.chars >= 100, '不该只剩空壳')
})

test('事件段：没有事件时不注入空壳', () => {
  const s = formatEventSlice([], { now })
  assert.equal(s.text, '')
  assert.equal(s.chars, 0)
  assert.equal(s.count, 0)
})

test('事件段：作废的条目不算', () => {
  const s = formatEventSlice([{ ...ev('x', now - 60e3, '作废的事'), invalidAt: now }], { now })
  assert.equal(s.text, '')
})

test('事件段：老数据没有 kind，但 source=event 也算事件', () => {
  const s = formatEventSlice([{ id: 'o', at: now - 60e3, text: '在抖音看了个视频', source: 'event' }], { now })
  assert.equal(s.count, 1)
  assert.match(s.text, /看了个视频/)
})
