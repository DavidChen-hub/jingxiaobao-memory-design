import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARD_HEADER, buildFactCard } from '../src/features/memory/card.js'

const now = Date.parse('2026-11-08T12:00:00+08:00')

test('事实卡：单值槽留最完整值，实体槽不复述', () => {
  const card = buildFactCard([
    { id: 'short', text: '住在北京', slot: 'residence', topicId: 'user', at: now - 2000 },
    { id: 'full', text: '住在北京市朝阳区', slot: 'residence', topicId: 'user', at: now - 1000 },
    { id: 'gear', text: 'M9 GT9RS', slot: 'gear', topicId: 'user', at: now - 500 },
    { id: 'pref', text: 'M9 GT9RS', slot: 'pref', topicId: 'user', at: now - 500 },
  ], { maxChars: 500, topics: [{ id: 'user', name: '主人' }], now })

  assert.match(card.text, /^【长期记忆（事实卡）】/)
  assert.ok(card.included.some((f) => f.id === 'full'))
  assert.ok(!card.included.some((f) => f.id === 'short'))
  assert.equal((card.text.match(/M9 GT9RS/g) || []).length, 1)
})

test('事实卡：过期事实进入旧事，且总字数不超上限', () => {
  const card = buildFactCard([
    { id: 'live', text: '喜欢黑咖啡', slot: 'pref', topicId: 'user', at: now },
    { id: 'old', text: '以前住在旧城', slot: 'residence', topicId: 'user', at: now - 86400_000, validUntil: now - 1000 },
    { id: 'long', text: '这是一条很长很长的事实'.repeat(20), slot: 'note', topicId: 'user', at: now },
  ], { maxChars: 220, topics: [{ id: 'user', name: '主人' }], now })

  assert.ok(card.chars <= 220)
  assert.ok(card.text.length <= 220)
  assert.match(card.text, /旧事：/)
  assert.match(card.text, /以前住在旧城/)
  assert.equal(card.chars, card.text.length)
  assert.ok(card.text.startsWith(CARD_HEADER))
})

test('事实卡：没内容时不注入空壳', () => {
  const card = buildFactCard([], { maxChars: 1500, now })
  assert.equal(card.text, '')
  assert.equal(card.chars, 0)
})

test('事实卡：事件不进卡（事件走带日期的「最近经历」）', () => {
  const card = buildFactCard([
    { id: 'f', text: '主人喜欢白米饭', slot: 'pref', topicId: 'u', at: now },
    { id: 'e', text: '他问我能看到画面了吗，我说没看到', slot: 'note', topicId: 'u', at: now, kind: 'event' },
  ], { maxChars: 800, topics: [{ id: 'u', name: '主人' }], now })

  assert.ok(card.included.some((x) => x.id === 'f'))
  assert.ok(!card.included.some((x) => x.id === 'e'))
  assert.doesNotMatch(card.text, /能看到画面/)
})

test('事实卡：同一 uid 的不同称呼合并成一组，第三方单独成组', () => {
  const facts = [
    { id: 'a', text: '住在北京', slot: 'residence', about: 'u1', aboutName: '', at: now },
    { id: 'b', text: '喜欢黑咖啡', slot: 'pref', about: 'u1', aboutName: '小鱼', at: now },
    { id: 'c', text: '朋友A爱吃白米饭', slot: 'pref', about: 'u1', aboutName: '朋友A', at: now },
  ]
  const card = buildFactCard(facts, { maxChars: 800, now, personNames: { u1: '小鱼' } })

  assert.equal((card.text.match(/【小鱼】/g) || []).length, 1)
  assert.ok(!card.text.includes('【u1】'), '不该再出现 uid 组头')
  assert.equal((card.text.match(/【朋友A】/g) || []).length, 1)
  assert.deepEqual(card.included.map((f) => f.id).sort(), ['a', 'b', 'c'])
})

test('事实卡：预算按行填，不会因为前一组太大就把后面全丢', () => {
  const facts = []
  for (let i = 0; i < 14; i++) {
    facts.push({ id: 'f' + i, text: '第' + i + '条事实，内容写得稍微长一点点好占预算', slot: 'pref', topicId: 't' + i, at: now })
  }
  const card = buildFactCard(facts, { maxChars: 400, now })

  assert.ok(card.chars <= 400)
  assert.ok(card.chars >= 280, '预算应该被填得比较满，实际 ' + card.chars)
  assert.ok(card.included.length >= 4)
})

test('事实卡：只有名字的事实能反查到 QQ，和写了 QQ 的事实合成一组（2026-11-12 阿青拆两组）', () => {
  const facts = [
    { id: 'a', text: '阿青自己写了五子棋', slot: 'note', about: '20002', aboutName: '阿青', at: now },
    { id: 'b', text: '阿青把「在吗」表情定为自己想说话时的专用图', slot: 'note', about: '', aboutName: '阿青', at: now },
  ]
  const card = buildFactCard(facts, { maxChars: 800, now, personNames: { 20002: '阿青' } })

  assert.equal((card.text.match(/【阿青】/g) || []).length, 1, '同一个人只能出现一组：\n' + card.text)
  assert.deepEqual(card.included.map((f) => f.id).sort(), ['a', 'b'])
})

test('事实卡：同名不同 QQ（阿青 2 个号 + 1 条无号）合并成一组', () => {
  const facts = [
    { id: 'a', text: '阿青今晚下棋输了六盘', slot: 'note', about: '3782551785', aboutName: '阿青', at: now },
    { id: 'b', text: '阿青承认那盘不是放水，是数漏了活四', slot: 'note', about: '20002', aboutName: '阿青', at: now },
    { id: 'c', text: '朋友B说阿青下象棋好菜', slot: 'note', about: '', aboutName: '阿青', at: now },
  ]
  const card = buildFactCard(facts, { maxChars: 800, now, personNames: {} })

  assert.equal((card.text.match(/【阿青】/g) || []).length, 1, '同名不同号也只出现一组：\n' + card.text)
  assert.deepEqual(card.included.map((f) => f.id).sort(), ['a', 'b', 'c'])
})
