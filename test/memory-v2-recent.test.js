import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECENT_HEADER, formatRecentSlice } from '../src/features/memory/recent.js'

const now = Date.parse('2026-11-08T12:00:00+08:00')

test('最近原话：只取净对话，保留用户原话和她真正发出的话', () => {
  const r = formatRecentSlice({
    chatId: 'private:1',
    now,
    records: [
      { t: now - 3000, chatId: 'private:1', who: '主人', text: '第一句原话' },
      { t: now - 2000, chatId: 'private:1', who: 'bot', text: '她真正说的 [sticker]' },
      { t: now - 1500, chatId: 'private:1', who: 'event', text: '不该出现的经历事件' },
      { t: now - 1000, chatId: 'private:2', who: '别人', text: '别处的聊天' },
    ],
  })
  assert.ok(r.text.startsWith(RECENT_HEADER))
  assert.match(r.text, /用户：第一句原话/)
  assert.match(r.text, /助手：她真正说的/)
  assert.doesNotMatch(r.text, /sticker|不该出现|别处的聊天/)
  assert.equal(r.turns, 1)
})

test('最近原话：预算从最新往前用，超了就停', () => {
  const r = formatRecentSlice({
    maxChars: 220,
    perTurn: 500,
    now,
    records: [
      { t: now - 2000, chatId: 'private:1', who: '主人', text: '早先的话'.repeat(20) },
      { t: now - 1900, chatId: 'private:1', who: 'bot', text: '早先的回复'.repeat(20) },
      { t: now - 1000, chatId: 'private:1', who: '主人', text: '最新的话' },
      { t: now - 900, chatId: 'private:1', who: 'bot', text: '最新的回复' },
    ],
  })
  assert.ok(r.chars <= 220)
  assert.ok(r.text.length <= 220)
  assert.match(r.text, /最新的话/)
  assert.doesNotMatch(r.text, /早先的话/)
})

test('最近原话：24 小时无记录时回退最后 6 轮', () => {
  const records = []
  for (let i = 0; i < 8; i += 1) {
    records.push({ t: now - (72 - i) * 3600_000, chatId: 'private:1', who: '主人', text: `旧话${i}` })
    records.push({ t: now - (72 - i) * 3600_000 + 1000, chatId: 'private:1', who: 'bot', text: `旧回${i}` })
  }
  const r = formatRecentSlice({ records, now, maxChars: 2400 })
  assert.equal(r.fallback, true)
  assert.equal(r.turns, 6)
  assert.doesNotMatch(r.text, /旧话0|旧话1/)
  assert.match(r.text, /旧话7/)
})
