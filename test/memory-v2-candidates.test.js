import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let normalize
const logs = new Map()
const hubState = { text: '', prev: '', speakers: [] }
const hub = {
  chatLogDays: () => [...logs.keys()].sort(),
  chatLogOf: (day) => logs.get(day) || [],
  deleteChatLog: (day) => logs.delete(day),
  lastTextOf: () => hubState.text,
  prevTextOf: () => hubState.prev,
  speakersOf: () => hubState.speakers,
}
const log = { info() {}, warn() {}, debug() {} }
const dsh = { get: () => null }
let cfg
let mem
const dataRoot = mkdtempSync(join(tmpdir(), 'memory-design-mem-v2-'))
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

before(async () => {
  process.env.MEMORY_DATA_DIR = dataRoot
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({ ownerQQ: '1', ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { v2: { enabled: true, shadow: false } } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
})

test('配置：v2 默认关闭且影子开启', () => {
  assert.deepEqual(normalize({}).memory.v2, { enabled: false, shadow: true, cardMaxChars: 1500, recentMaxChars: 2400 })
})

test('候选池：不可检索/不进卡；同 key 三次后 pass，陈旧单次 block，其余 mark', () => {
  const now = Date.now()
  for (let i = 0; i < 3; i += 1) {
    assert.equal(mem.addCandidate({ text: '鲸鱼的名字叫泡泡', key: 'pet.whale.name', confidence: 0.3, at: now + i }).ok, true)
  }
  assert.equal(mem.candidates().length, 1)
  assert.equal(mem.list('鲸鱼').length, 0, '候选不能进入 BM25 索引')
  assert.equal(mem.candidateStats().pending, 1)

  let r = mem.judgeCandidates({ now: now + 10 })
  assert.equal(r.passed, 1)
  assert.equal(mem.candidates().length, 0)
  assert.equal(mem.list('鲸鱼').length, 1)
  assert.equal(mem.candidateStats().passed, 1)

  mem.addCandidate({ text: '很旧的单次候选', key: 'stale.once', at: now - 15 * 86400_000 })
  mem.addCandidate({ text: '新来的候选', key: 'fresh.once', at: now })
  r = mem.judgeCandidates({ now })
  assert.equal(r.blocked, 1)
  assert.equal(r.marked, 1)
  assert.equal(mem.candidateStats().pending, 1)
  assert.equal(mem.candidates()[0].decision, 'mark')
})

test('v2 注入：首轮卡+最近原话，次轮只带最近原话和 1–3 条命中', () => {
  const now = Date.now()
  mem.add({ text: '主人喜欢黑咖啡', aboutName: '主人', about: '1', chatId: 'private:1', importance: 0.8, source: 'panel' })
  hubState.text = '咖啡'
  logs.set(day(new Date(now)), [
    { t: now - 2000, chatId: 'private:1', who: '主人', uid: '1', text: '今天还是喝咖啡' },
    { t: now - 1000, chatId: 'private:1', who: 'bot', text: '行，记住了 [poke]' },
  ])
  const chat = { kind: 'private', userId: '1', chatId: 'private:1', nickname: '主人' }
  const first = mem.volatileFor(chat, 'session-v2-1')
  const second = mem.volatileFor(chat, 'session-v2-1')
  assert.match(first, /【长期记忆（事实卡）】/)
  assert.match(first, /【最近一天的原话】/)
  assert.match(second, /【最近一天的原话】/)
  assert.doesNotMatch(second, /【长期记忆（事实卡）】/)
})

test('影子模式：只写 memory-shadow.jsonl，不把卡和原话注入 prompt', () => {
  cfg.memory.v2.shadow = true
  const now = Date.now()
  hubState.text = '咖啡'
  logs.set(day(new Date(now)), [
    { t: now - 1000, chatId: 'private:1', who: '主人', uid: '1', text: '影子测试用户话' },
    { t: now - 900, chatId: 'private:1', who: 'bot', text: '影子测试回复' },
  ])
  const chat = { kind: 'private', userId: '1', chatId: 'private:1', nickname: '主人' }
  const text = mem.volatileFor(chat, 'session-shadow-1')
  assert.doesNotMatch(text, /【长期记忆（事实卡）】/)
  assert.doesNotMatch(text, /【最近一天的原话】/)
  const rows = readFileSync(join(dataRoot, 'memory-shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(rows.length >= 1)
  assert.ok(rows.at(-1).cardChars > 0)
  assert.ok(rows.at(-1).recentChars > 0)
  assert.ok('overlapRate' in rows.at(-1))
})

test('关掉影子后仍写 memory-shadow.jsonl（判据 3 观察窗口），注入的是新文本', () => {
  cfg.memory.v2.shadow = false
  const now = Date.now()
  hubState.text = '咖啡'
  logs.set(day(new Date(now)), [
    { t: now - 1000, chatId: 'private:1', who: '主人', uid: '1', text: '观察期用户话' },
    { t: now - 900, chatId: 'private:1', who: 'bot', text: '观察期回复' },
  ])
  const chat = { kind: 'private', userId: '1', chatId: 'private:1', nickname: '主人' }
  const file = join(dataRoot, 'memory-shadow.jsonl')
  const before = readFileSync(file, 'utf8').trim().split('\n').length
  const text = mem.volatileFor(chat, 'session-live-1')
  assert.match(text, /【长期记忆（事实卡）】/, '关影子后注入的应该是新文本')
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(rows.length > before, 'shadow=false 也要照样写一行')
  assert.equal(rows.at(-1).sessionId, 'session-live-1')
})

test('模型抽取在 v2 中先落候选，确认三次后才进入事实库', async () => {
  dsh.llm = {
    async *stream({ system, messages }) {
      const text = messages?.[0]?.content?.[0]?.text || ''
      let out = '[]'
      if (system.includes('整理长期记忆') && text.includes('月光')) {
        out = JSON.stringify([{ op: 'add', key: 'pref.moonlight', text: '阿青喜欢月光', about: '阿青', about_qq: '20000002', quote: '我最近喜欢月光', importance: 0.4, confidence: 0.3 }])
      } else if (system.includes('{"insights"')) {
        out = '{"insights":[],"style":[]}'
      }
      yield { type: 'text-delta', text: out }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  }
  const now = Date.now()
  logs.set(day(new Date(now)), [
    { t: now - 3000, chatId: 'private:2', who: '阿青', uid: '20000002', text: '我最近喜欢月光' },
    { t: now - 2500, chatId: 'private:2', who: '阿青', uid: '20000002', text: '晚上会去阳台看' },
    { t: now - 2000, chatId: 'private:2', who: '阿青', uid: '20000002', text: '月光很好看' },
  ])
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(mem.list('月光').length, 0, '模型抽取没有直接进入事实库')
  assert.ok(mem.candidates({ includeResolved: true }).some((c) => c.key.endsWith('|pref.moonlight') && c.status === 'candidate'))

  mem.addCandidate({ text: '阿青喜欢月光', key: 'pref.moonlight', chatId: 'private:2' })
  mem.addCandidate({ text: '阿青喜欢月光', key: 'pref.moonlight', chatId: 'private:2' })
  mem.judgeCandidates({ now: now + 10 })
  assert.equal(mem.list('月光').length, 1)
})

test('记忆总览：卡、事件、候选、统计都能给面板用', () => {
  const o = mem.overview()
  assert.equal(typeof o.card.chars, 'number')
  assert.ok(o.card.chars <= 1500)
  assert.ok(Array.isArray(o.card.groups))
  assert.equal(typeof o.events.count, 'number')
  assert.ok(Array.isArray(o.recent))
  assert.ok(o.stats.total >= o.stats.facts)
  assert.equal(typeof o.stats.candidates, 'number')
  assert.ok(o.recent.every((m) => m.id && m.at && (m.kind === 'fact' || m.kind === 'event')))
})
