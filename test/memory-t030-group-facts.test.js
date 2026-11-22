import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let normalize
let cfg
let mem
let ownerFactId = ''

const groupId = '123456'
const groupChatId = `group:${groupId}`
const groupChat = { kind: 'group', groupId, chatId: groupChatId, nickname: '' }
const dataRoot = mkdtempSync(join(tmpdir(), 'memory-design-t030-group-'))
const logs = new Map()
const prompts = []
const hub = {
  chatLogDays: () => [...logs.keys()].sort(),
  chatLogOf: (day) => logs.get(day) || [],
  deleteChatLog: (day) => logs.delete(day),
  lastTextOf: () => '',
  prevTextOf: () => '',
  speakersOf: () => [],
}
const log = { info() {}, warn() {}, debug() {} }
const dsh = { get: () => null }
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const shadowRows = () => {
  const file = join(dataRoot, 'memory-shadow.jsonl')
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
}
const shadowFor = (sessionId) => shadowRows().filter((r) => r.sessionId === sessionId).at(-1)

before(async () => {
  process.env.MEMORY_DATA_DIR = dataRoot
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({
    ownerQQ: '1',
    ownerName: '主人',
    model: { provider: 'p', model: 'm' },
    memory: { enabled: true, v2: { enabled: true, shadow: true, cardMaxChars: 1500, recentMaxChars: 2400 } },
  })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })

  dsh.llm = {
    async *stream({ system, messages }) {
      const text = messages?.[0]?.content?.[0]?.text || ''
      let out = '[]'
      if (system.includes('整理长期记忆')) {
        prompts.push({ system, text })
        if (text.includes('我固定在周五晚上开桌游房')) {
          out = JSON.stringify([
            { op: 'add', kind: 'fact', text: '阿青固定在周五晚开桌游房', about: '阿青', quote: '我固定在周五晚上开桌游房', importance: 0.7 },
            { op: 'add', kind: 'event', text: '阿青今晚赢了桌游', about: '阿青', quote: '今晚桌游我又赢了', importance: 0.4 },
          ])
        }
      } else if (system.includes('{"insights"')) {
        out = '{"insights":[],"style":[]}'
      }
      yield { type: 'text-delta', text: out }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  }

  const fixtures = [
    ['北岸常玩狼人杀', '北岸', ['喜好']],
    ['阿青每周组织桌游局', '阿青', ['喜好']],
    ['司至年长期做独立游戏', '司至年', ['工作']],
    ['阿木是群里的棋类高手', '阿木', ['技能']],
    ['晚风常分享摄影作品', '晚风', ['喜好']],
    ['小满负责群活动报名', '小满', ['工作']],
    ['朋友B长期收集黑胶唱片', '朋友B', ['喜好']],
    ['明南常带新人打副本', '明南', ['技能']],
    ['青禾在群里连载短篇故事', '青禾', ['工作']],
    ['白川固定周末跑步', '白川', ['计划']],
    ['阿灯喜欢研究机械键盘', '阿灯', ['喜好']],
    ['南枝常组织观影活动', '南枝', ['喜好']],
    ['群规是晚上十一点后禁刷屏', '', ['规矩']],
    ['周三晚上固定开黑', '', ['计划']],
    ['群梗是输棋者负责发猫图', '', ['规矩']],
    ['新人入群要先看置顶规则', '', ['规矩']],
    ['月末会办一次群内歌会', '', ['计划']],
    ['争论版本时以群投票为准', '', ['规矩']],
  ]
  for (const [text, aboutName, tags] of fixtures) {
    const r = mem.add({ text, aboutName, tags, importance: 0.8, source: 'panel', chatId: groupChatId, scope: groupChatId, kind: 'fact' })
    assert.ok(r.id || r.updated, `夹具未写入：${text}`)
  }
  const owner = mem.add({ text: '主人的私人猫叫秘密鱼', about: '1', aboutName: '主人', importance: 0.9, source: 'panel', chatId: 'private:1', scope: 'owner' })
  ownerFactId = owner.id || owner.updated
})

test('群聊抽取：专用提示词产出 fact，并直接写入 group:123456 板', async () => {
  const now = Date.now()
  logs.set(day(new Date(now)), [
    { t: now - 3000, chatId: groupChatId, who: '阿青', uid: '2001', text: '我固定在周五晚上开桌游房' },
    { t: now - 2000, chatId: groupChatId, who: '阿木', uid: '2002', text: '嗯，你已经连着开了一个月了' },
    { t: now - 1000, chatId: groupChatId, who: '阿青', uid: '2003', text: '今晚桌游我又赢了' },
  ])

  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.ok(r.events >= 1)

  const items = mem.list('')
  const fact = items.find((m) => m.text === '阿青固定在周五晚开桌游房')
  assert.ok(fact, '群聊没有产出预期 fact')
  assert.equal(fact.kind, 'fact')
  assert.equal(fact.scope, groupChatId)
  assert.equal(fact.source, 'auto')
  const event = items.find((m) => m.text === '阿青今晚赢了桌游')
  assert.ok(event && event.kind === 'event' && event.scope === groupChatId)
  assert.ok(!mem.candidates({ includeResolved: true }).some((c) => c.text.includes('开桌游房')), '群 fact 不应卡在候选池')

  const prompt = prompts.at(-1)
  assert.match(prompt.system, /三个月后还成立/)
  assert.match(prompt.system, /谁常玩什么/)
  assert.match(prompt.system, /主人私事/)
  assert.match(prompt.system, /别人的私聊内容/)
  assert.match(prompt.system, /联系方式/)
  assert.match(prompt.system, /不超过 40 字/)
  assert.match(prompt.text, /阿青\(2001\)/)
})

test('群卡夹具：group:123456 的事实卡不少于 300 字', () => {
  mem.volatileFor(groupChat, 't030-card-size')
  const row = shadowFor('t030-card-size')
  assert.ok(row, '没有写群卡影子日志')
  assert.ok(row.cardChars >= 300, `群卡只有 ${row.cardChars} 字：${row.cardText}`)
  assert.ok(row.cardFactIds.length >= 15, `群卡事实不足：${row.cardFactIds.length}`)
  assert.match(row.cardText, /北岸常玩狼人杀/)
})

test('群卡隔离：owner 板事实不进入 group:123456 的卡', () => {
  mem.volatileFor(groupChat, 't030-card-owner-isolation')
  const row = shadowFor('t030-card-owner-isolation')
  assert.ok(row, '没有写群卡影子日志')
  assert.ok(ownerFactId)
  assert.equal(mem.list('').find((m) => m.id === ownerFactId)?.scope, 'owner')
  assert.ok(!row.cardFactIds.includes(ownerFactId), 'owner 事实 id 出现在群卡 included 里')
  assert.doesNotMatch(row.cardText, /秘密鱼/)
})