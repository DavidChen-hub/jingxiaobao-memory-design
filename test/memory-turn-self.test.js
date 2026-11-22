import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let formatEventSliceMixed
let scopeVisible
const hub = {
  chatLogDays: () => [],
  chatLogOf: () => [],
  deleteChatLog() {},
  lastTextOf: () => '',
  prevTextOf: () => '',
  speakersOf: () => [],
}
const log = { info() {}, warn() {}, debug() {} }
const dsh = { get: () => null }
let cfg
let mem

before(async () => {
  process.env.MEMORY_DATA_DIR = mkdtempSync(join(tmpdir(), 'memory-design-turn-'))
  ;({ createMemoryStore, scopeVisible } = await import('../src/features/memory.js'))
  ;({ formatEventSliceMixed } = await import('../src/features/memory/events.js'))
  const { normalize } = await import('../src/core/config.js')
  cfg = normalize({ ownerQQ: '1', ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { enabled: true, v2: { enabled: true, shadow: false } } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
})

const rows = (chatId) => mem.list('').filter((m) => m.source === 'turn' && (!chatId || m.chatId === chatId))

test('经历流：私聊/群各记一条，全是 scope=self 的事件，带场合前缀', () => {
  assert.equal(mem.noteSaid({ chatId: 'private:1', reply: '这版有过程，前头那段才是味道', userText: '你看这版' }).ok, true)
  assert.equal(mem.noteSaid({ chatId: 'group:9', reply: '我也躺着听了', userText: '你听' }).ok, true)
  const list = mem.list('').filter((m) => m.source === 'turn')
  assert.equal(list.length, 2)
  assert.ok(list.every((m) => m.scope === 'self' && m.kind === 'event' && m.importance <= 0.5))
  assert.ok(list.some((m) => m.text.startsWith('和主人说：')))
  assert.ok(list.some((m) => m.text.startsWith('在群里说：')))
  // system 会话（抖音等）不写：那边有自己的经历写入
  assert.equal(mem.noteSaid({ chatId: 'system:douyin', reply: '看了个视频' }).ok, false)
})

test('经历流：同一个群里 24h 内同一句话只记一条', () => {
  const a = mem.noteSaid({ chatId: 'group:11', reply: '这句一模一样的话我再说一遍试试看', userText: '你说' })
  const b = mem.noteSaid({ chatId: 'group:11', reply: '这句一模一样的话我再说一遍试试看', userText: '换一句问问' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.skipped, 'dup')
  assert.equal(rows('group:11').length, 1)
})

test('经历流：工具步骤的垫话不写，只记最终回复', () => {
  const a = mem.noteSaid({ chatId: 'group:14', reply: '让我看看', userText: '你知道吗', phase: 'mid' })
  const b = mem.noteSaid({ chatId: 'group:14', reply: '这版有过程，前头那段才是味道', userText: '你知道吗', phase: 'final' })
  assert.equal(a.ok, false)
  assert.equal(a.skipped, 'mid')
  assert.equal(b.ok, true)
  const list = rows('group:14')
  assert.equal(list.length, 1)
  assert.ok(list[0].text.includes('这版有过程'))
})

test('经历流隐私：她的话按发生地收窄——私聊说的进不了群/抖音，群里说的主人私聊能回想', () => {
  const a = mem.noteSaid({ chatId: 'private:1', reply: '今天想吃两大碗大白饭', userText: '你吃什么' })
  const b = mem.noteSaid({ chatId: 'group:15', reply: '我也躺着听了', userText: '你听' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  const pi = mem.list('').find((m) => m.source === 'turn' && m.text.includes('今天想吃两大碗大白饭'))
  const gi = mem.list('').find((m) => m.source === 'turn' && m.text.includes('我也躺着听了'))
  assert.equal(pi.board, 'owner')
  assert.equal(gi.board, 'group:15')
  // 私聊里的话不进群、不进抖音
  assert.equal(scopeVisible(pi, 'group:15'), false)
  assert.equal(scopeVisible(pi, 'douyin'), false)
  // 群里说的话，主人私聊能回想（跨场合），本群也在
  assert.equal(scopeVisible(gi, 'owner'), true)
  assert.equal(scopeVisible(gi, 'group:15'), true)
  assert.equal(scopeVisible(gi, 'group:99'), false)
})

test('经历流：每个场合每小时最多 4 条（防淹库）', () => {
  let ok = 0
  let rate = 0
  for (let i = 0; i < 6; i++) {
    const r = mem.noteSaid({ chatId: 'group:12', reply: `第 ${i} 句不一样的话，用来试限额` })
    if (r.ok) ok++
    if (r.skipped === 'rate') rate++
  }
  assert.equal(ok, 4)
  assert.equal(rate, 2)
  assert.equal(rows('group:12').length, 4)
})

test('经历流隐私边界：敏感信息 / 成段引用 / 复述对方原话都不写', () => {
  assert.equal(mem.noteSaid({ chatId: 'group:13', reply: '他 QQ 是 12345678，你加他' }).skipped, 'sensitive')
  assert.equal(mem.noteSaid({ chatId: 'group:13', reply: '电话 138 0013 8000，打给他' }).skipped, 'sensitive')
  assert.equal(mem.noteSaid({ chatId: 'group:13', reply: '她原话是「想从本鱼这偷图，门都没有」' }).skipped, 'quote')
  assert.equal(mem.noteSaid({ chatId: 'group:13', reply: '我今天特别想吃两大碗大白饭', userText: '我今天特别想吃两大碗大白饭可以吗' }).skipped, 'retell')
  assert.equal(rows('group:13').length, 0)
  // 拿不准就不写：只有她自己的短句才落；表情标签不写进 self
  assert.equal(mem.noteSaid({ chatId: 'group:16', reply: '好呀<sticker:开心>', userText: '发个表情' }).ok, true)
  assert.equal(rows('group:16')[0].text, '在群里说：好呀')
  assert.equal(mem.noteSaid({ chatId: 'group:13', reply: '厚礼蟹' }).ok, true)
})

test('经历注入：本场合 4 条 + 其他场合 2 条，别的场合不会被热闹的群挤掉', () => {
  const now = Date.now()
  const items = []
  for (let i = 0; i < 8; i++) items.push({ id: `g${i}`, text: `群里第 ${i} 句`, kind: 'event', source: 'turn', scope: 'self', chatId: 'group:9', at: now - i * 60_000 })
  for (let i = 0; i < 3; i++) items.push({ id: `p${i}`, text: `私聊第 ${i} 句`, kind: 'event', source: 'turn', scope: 'self', chatId: 'private:1', at: now - (100 + i) * 60_000 })
  const r = formatEventSliceMixed(items, { chatId: 'group:9', maxItems: 4, otherMaxItems: 2, maxChars: 600, now })
  assert.equal(r.count, 6)
  assert.ok(r.text.includes('群里第 0 句'))
  assert.ok(r.text.includes('私聊第 0 句'))
  assert.ok(!r.text.includes('群里第 4 句'))
  // 抖音轻量版：预算 400 字，总条数不超 6
  const light = formatEventSliceMixed(items, { chatId: 'system:douyin', maxItems: 4, otherMaxItems: 2, maxChars: 400, now })
  assert.ok(light.count <= 6)
  assert.ok(light.chars <= 400)
})

test('P1-5 小档案按「板块+QQ」存：群里的那份不会带出私聊的事', () => {
  mem.setProfile('1', '主人私聊里的印象', '', 'owner')
  mem.setProfile('2', '群 77 里的朋友A', '', 'group:77')
  const list = mem.profiles().filter((p) => p.qq === '2')
  assert.equal(list.length, 1)
  assert.equal(list[0].scope, 'group:77')
  hub.speakersOf = (sid) => (sid === 's-group' ? ['2'] : [])
  const priv = mem.contextFor({ kind: 'private', userId: '1', chatId: 'private:1' }, 's-priv')
  assert.ok(priv.includes('主人私聊里的印象'))
  assert.ok(!priv.includes('群 77 里的朋友A'))
  const grp = mem.contextFor({ kind: 'group', groupId: '77', chatId: 'group:77' }, 's-group')
  assert.ok(grp.includes('群 77 里的朋友A'))
  assert.ok(!grp.includes('主人私聊里的印象'))
})

test('P1-4 B 站公开活动单独一个桶：抖音看不到 B 站看了什么', () => {
  const item = { scope: 'public:bili', kind: 'event', source: 'turn' }
  assert.equal(scopeVisible(item, 'douyin'), false)
  assert.equal(scopeVisible(item, 'group:9'), false)
  assert.equal(scopeVisible(item, 'public:bili'), true)
})

test('经历注入：没有 chatId 的老事件（抖音）按板块算「本场合」，不会只剩 2 条', () => {
  const now = Date.now()
  const dy = []
  for (let i = 0; i < 6; i++) dy.push({ id: `d${i}`, text: `抖音第 ${i} 条`, kind: 'event', scope: 'douyin', chatId: '', at: now - i * 60_000 })
  const r = formatEventSliceMixed(dy, { chatId: 'system:douyin', board: 'douyin', maxItems: 4, otherMaxItems: 2, maxChars: 600, now })
  assert.equal(r.count, 4)
  assert.ok(r.text.includes('抖音第 0 条'))
})

test('P1 群聊插话评分只数本群：私聊里说过的话不抬高群插话相关度', () => {
  const r = mem.noteSaid({ chatId: 'private:1', reply: '独一无二的关键词甲龙虾', userText: '吃饭' })
  assert.equal(r.ok, true)
  assert.ok(mem.topicScore('龙虾', 'owner') > 0)
  assert.equal(mem.topicScore('龙虾', 'group:9'), 0)
  assert.equal(mem.topicScore('龙虾', ''), 0, '没有板块就不给分')
})

test('P1 群注入里不会出现私聊的 self 经历', () => {
  mem.noteSaid({ chatId: 'private:1', reply: '私聊专属暗号乙松鼠', userText: '暗号' })
  const txt = mem.volatileFor({ kind: 'group', groupId: '9', chatId: 'group:9' }, 's-group-9')
  assert.ok(!txt.includes('私聊专属暗号乙松鼠'))
})

test('P1 旧纯 QQ 档案保存后保留名字、只留一份', async () => {
  const fs = await import('node:fs')
  const p = join(process.env.MEMORY_DATA_DIR, 'memories.json')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  j.profiles = j.profiles || {}
  j.profiles['9'] = { text: '旧档案', name: '小明', at: Date.now() - 1000 }
  fs.writeFileSync(p, JSON.stringify(j))
  mem.setProfile('9', '新档案', '', 'owner')
  const list = mem.profiles().filter((x) => x.qq === '9')
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '小明')
  assert.equal(list[0].scope, 'owner')
})

test('P2 无 scope 的 B 站旧记录也迁到 public:bili', async () => {
  const fs = await import('node:fs')
  const p = join(process.env.MEMORY_DATA_DIR, 'memories.json')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  j.items.push({ id: 'bili1', text: '在B站看了《某视频》', tags: ['B站'], importance: 0.4, source: 'event', kind: 'event', at: Date.now(), hits: 0 })
  fs.writeFileSync(p, JSON.stringify(j))
  const it = mem.list('').find((x) => x.id === 'bili1')
  assert.equal(it.scope, 'public:bili')
})

test('P1 topicScore 的 BM25 统计只算本板块：加私聊记录不改变群分', () => {
  assert.equal(mem.noteSaid({ chatId: 'group:20', reply: '陀螺仪转起来了', userText: '看看' }).ok, true)
  const a = mem.topicScore('陀螺仪', 'group:20')
  assert.ok(a > 0)
  assert.equal(mem.noteSaid({ chatId: 'private:1', reply: '陀螺仪坏了', userText: '坏了' }).ok, true)
  assert.ok(Math.abs(mem.topicScore('陀螺仪', 'group:20') - a) < 1e-6, '加入私聊记录后群分不应变化（只差时间衰减）')
})

test('P2 新旧档案键并存：canonical 优先，且不丢旧键的名字', async () => {
  const fs = await import('node:fs')
  const p = join(process.env.MEMORY_DATA_DIR, 'memories.json')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  j.profiles = j.profiles || {}
  j.profiles['11'] = { text: '旧键正文', name: '小北', at: Date.now() }
  j.profiles['owner|11'] = { text: '新键正文', name: '', at: Date.now() - 5000, scope: 'owner' }
  fs.writeFileSync(p, JSON.stringify(j))
  const list = mem.profiles().filter((x) => x.qq === '11')
  assert.equal(list.length, 1)
  assert.equal(list[0].scope, 'owner')
  assert.equal(list[0].text, '新键正文', 'canonical 键优先，不被更新的旧键盖掉')
})

test('跨场合：私聊注入里要给「她在群里说的话」留位置，不被抖音活动挤掉', () => {
  const now = Date.now()
  const items = []
  for (let i = 0; i < 3; i++) items.push({ id: `p${i}`, text: `私聊第 ${i} 句`, kind: 'event', source: 'turn', scope: 'self', chatId: 'private:1', board: 'owner', at: now - i * 60_000 })
  items.push({ id: 'g1', text: '在群里说：今晚吃火锅', kind: 'event', source: 'turn', scope: 'self', chatId: 'group:9', board: 'group:9', at: now - 5 * 3600_000 })
  for (let i = 0; i < 3; i++) items.push({ id: `d${i}`, text: `抖音第 ${i} 条`, kind: 'event', source: 'event', scope: 'douyin', chatId: '', at: now - (60 + i) * 60_000 })
  const r = formatEventSliceMixed(items, { chatId: 'private:1', board: 'owner', maxItems: 4, otherMaxItems: 2, maxChars: 600, now })
  assert.ok(r.text.includes('今晚吃火锅'), '群里说的话必须出现在私聊注入里')
})
