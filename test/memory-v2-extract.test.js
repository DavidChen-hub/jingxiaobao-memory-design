import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentLines, quoteInTranscript } from '../src/features/memory.js'

const t0 = Date.parse('2026-11-09T12:00:00+08:00')
const line = (t, text, who = '主人') => ({ t, who, text, chatId: 'private:1' })

test('情境段：间隔超过 90 分钟就断开', () => {
  const lines = [
    line(t0, 'a'), line(t0 + 5 * 60e3, 'b'),
    line(t0 + 5 * 60e3 + 91 * 60e3, 'c'),
  ]
  const segs = segmentLines(lines)
  assert.equal(segs.length, 2)
  assert.deepEqual(segs[0].map((l) => l.text), ['a', 'b'])
  assert.deepEqual(segs[1].map((l) => l.text), ['c'])
})

test('情境段：单段最多 40 轮', () => {
  const lines = Array.from({ length: 85 }, (_, i) => line(t0 + i * 60e3, 'x' + i))
  const segs = segmentLines(lines)
  assert.equal(segs.length, 3)
  assert.equal(segs[0].length, 40)
  assert.equal(segs[1].length, 40)
  assert.equal(segs[2].length, 5)
})

test('情境段：没有时间戳的流水算一段', () => {
  const segs = segmentLines([{ text: 'a' }, { text: 'b' }])
  assert.equal(segs.length, 1)
})

test('引文校验：逐字能找到才算过，空白差异忽略', () => {
  const hay = '主人：我不吃香菜\n我：那以后不放'
  assert.equal(quoteInTranscript('我不吃香菜', hay), true)
  assert.equal(quoteInTranscript('我不 吃 香菜', hay), true)
  assert.equal(quoteInTranscript('他爱吃香菜', hay), false)
  assert.equal(quoteInTranscript('', hay), false)
})
