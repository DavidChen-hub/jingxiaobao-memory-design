import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let normalize
const logs = new Map()
const hub = {
  chatLogDays: () => [...logs.keys()].sort(),
  chatLogOf: (day) => logs.get(day) || [],
  deleteChatLog: (day) => logs.delete(day),
  lastTextOf: () => '',
  prevTextOf: () => '',
  speakersOf: () => [],
  sent: [],
  async sendText(chatId, text) { this.sent.push({ chatId, text }); return { message_id: 'x' } },
}
const log = { info() {}, warn() {}, debug() {} }
const dsh = { get: () => null }
let cfg
let mem
const dataRoot = mkdtempSync(join(tmpdir(), 'memory-design-mem-review-'))

before(async () => {
  process.env.MEMORY_DATA_DIR = dataRoot
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({ ownerQQ: '1', ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { v2: { enabled: true, shadow: false } } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
})

test('待确认队列：今天的候选进今日，早先的进积压；all=1 才带积压明细', () => {
  const now = Date.now()
  mem.addCandidate({ text: '今天的候选甲', key: 'review.today.a', confidence: 0.4, at: now })
  mem.addCandidate({ text: '上周的候选乙', key: 'review.old.b', at: now - 6 * 86400_000 })
  const q = mem.reviewQueue({ now })
  assert.equal(q.today.length, 1)
  assert.equal(q.today[0].text, '今天的候选甲')
  assert.equal(q.backlogCount, 1)
  assert.equal(q.backlog.length, 0, '默认不传积压明细，免得刷面板太重')
  assert.equal(q.pending, 2)
  const all = mem.reviewQueue({ all: true, now })
  assert.equal(all.backlog.length, 1)
  assert.equal(all.backlog[0].text, '上周的候选乙')
})

test('确认是事实：写进记忆 + 候选标 passed，队列里消失', () => {
  const now = Date.now()
  const q = mem.reviewQueue({ now })
  const c = q.today[0]
  const r = mem.decideReview(c.id, 'fact')
  assert.equal(r.ok, true, r.message)
  assert.equal(r.today.length, 0, '处理完今日队列就空了')
  assert.equal(mem.list('今天的候选甲').length, 1)
  assert.equal(mem.candidateStats().passed, 1)
  assert.equal(mem.candidates().some((x) => x.id === c.id), false)
})

test('改成经过：入库为 event，不进事实卡', () => {
  const now = Date.now()
  const add = mem.addCandidate({ text: '刚才那场雨下得很大', key: 'review.event.a', confidence: 0.4, at: now })
  assert.equal(add.ok, true)
  const q = mem.reviewQueue({ now })
  const c = q.today.find((x) => x.id === add.id)
  assert.ok(c, '新候选应该在今日队列')
  const r = mem.decideReview(c.id, 'event')
  assert.equal(r.ok, true, r.message)
  const items = mem.list('那场雨')
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'event')
})

test('删：候选标 blocked，不写进记忆', () => {
  const now = Date.now()
  const add = mem.addCandidate({ text: '一条没用的流水丁', key: 'review.drop.a', confidence: 0.4, at: now })
  const r = mem.decideReview(add.id, 'drop')
  assert.equal(r.ok, true, r.message)
  assert.equal(mem.list('流水丁').length, 0)
  assert.equal(mem.candidateStats().blocked >= 1, true)
})

test('幂等：同一条裁决两次，第二次被拒', () => {
  const now = Date.now()
  const add = mem.addCandidate({ text: '只能确认一次的戊', key: 'review.once.a', confidence: 0.4, at: now })
  assert.equal(mem.decideReview(add.id, 'fact').ok, true)
  const again = mem.decideReview(add.id, 'fact')
  assert.equal(again.ok, false)
  assert.match(again.message, /已经处理过/)
})

test('批量裁决：逐条成功，重复的算没动', () => {
  const now = Date.now()
  const ids = []
  for (let i = 0; i < 3; i += 1) ids.push(mem.addCandidate({ text: `批量候选${i}号`, key: `review.bulk.${i}`, confidence: 0.4, at: now }).id)
  const r = mem.decideReviewMany(ids, 'fact')
  assert.equal(r.ok, true)
  assert.equal(r.done, 3)
  assert.equal(r.failed.length, 0)
  const again = mem.decideReviewMany(ids, 'fact')
  assert.equal(again.done, 0)
  assert.equal(again.failed.length, 3)
})

test('旧数据空板块候选：队列标 noScope，确认时按 chatId 补出板块并回报', () => {
  const file = join(dataRoot, 'memories.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.memoryCandidates = Array.isArray(raw.memoryCandidates) ? raw.memoryCandidates : []
  raw.memoryCandidates.push({
    id: 'dead0001', key: 'x|noscope', text: '旧群里的一条候选甲', about: '', aboutName: '',
    tags: [], importance: 0.5, confidence: 0.4, source: 'auto', chatId: 'group:123456', kind: 'fact',
    scope: '', status: 'candidate', decision: 'new', mentions: 1,
    firstAt: Date.now(), lastAt: Date.now(), lastJudgedAt: 0,
  })
  writeFileSync(file, JSON.stringify(raw))
  const mem2 = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const c = mem2.reviewQueue({}).today.find((x) => x.id === 'dead0001')
  assert.ok(c, '旧候选应该在今日队列')
  assert.equal(c.noScope, true)
  const r = mem2.decideReview(c.id, 'fact')
  assert.equal(r.ok, true, r.message)
  assert.equal(r.scope, 'group:123456', '补出来的板块要回报给面板，不能悄悄换地方')
})

test('配置：reviewRemindAt 默认 22:40，空/off 关闭', () => {
  assert.equal(normalize({}).memory.reviewRemindAt, '22:40')
  assert.equal(normalize({ memory: { reviewRemindAt: '' } }).memory.reviewRemindAt, '')
  assert.equal(normalize({ memory: { reviewRemindAt: 'off' } }).memory.reviewRemindAt, '')
  assert.equal(normalize({ memory: { reviewRemindAt: '7:05' } }).memory.reviewRemindAt, '07:05')
})

