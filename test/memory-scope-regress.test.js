// 记忆板块隔离的回归测试（T-026 / Codex review2 P1-4、P1-6、P1-7、P1-8）。
// 四类：recall_memory 跨板块、relatedTo/known 跨板块改写、人物档案注入范围、未知 board。
// 不碰真实数据：每次跑在临时目录里。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let deriveMemoryScope
let scopeVisible
let boardFromChatId
let subjectMatchesScope
let cleanScope
let panelAddScope
let resolveMemoryScope
let normalize

const logs = new Map()
let speakers = []
const hub = {
  chatLogDays: () => [...logs.keys()].sort(),
  chatLogOf: (day) => logs.get(day) || [],
  deleteChatLog: (day) => logs.delete(day),
  lastTextOf: () => '',
  prevTextOf: () => '',
  speakersOf: () => speakers,
}
const log = { info() {}, warn() {}, debug() {} }

let reply = () => '[]'
let profileOut = '主人是主人，最近戒辣了，爱钓鱼'
let asked = []
const dsh = {
  get: () => null,
  llm: {
    async *stream({ system, messages }) {
      const text = messages[0].content[0].text
      asked.push({ system, text })
      let out = '[]'
      if (system.includes('人物小档案')) out = profileOut
      else if (system.includes('整理长期记忆')) out = reply(text)
      yield { type: 'text-delta', text: out }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  },
}

const day = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let cfg
let mem

before(async () => {
  process.env.MEMORY_DATA_DIR = mkdtempSync(join(tmpdir(), 'memory-design-scope-regress-'))
  ;({ createMemoryStore, deriveMemoryScope, scopeVisible, boardFromChatId, subjectMatchesScope, cleanScope, panelAddScope, resolveMemoryScope } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({ ownerQQ: '1', ownerName: '主人', botQQ: '2', model: { provider: 'p', model: 'm' } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
})

test('recall：只能翻到当前板块（quarantine 永不出现，未知 board 一条不给）', () => {
  mem.add({ text: '主人不吃香菜', about: '1', aboutName: '主人', importance: 0.8, source: 'tool', chatId: 'private:1' })
  mem.add({ text: '群九阿司爱下棋', scope: 'group:9', importance: 0.8, source: 'tool' })
  mem.add({ text: '在抖音回复了陌生人', scope: 'douyin', importance: 0.8, source: 'event' })
  mem.add({ text: '朋友A怕黑', scope: 'friend:朋友A', importance: 0.8, source: 'tool' })
  mem.add({ text: '我在空间写过日记', scope: 'self', importance: 0.8, source: 'diary' })
  mem.add({ text: '阿强喜欢钓鱼', scope: 'quarantine', importance: 0.9, source: 'import' })

  const texts = (q, board) => mem.recall(q, { board }).map((h) => h.it.text)

  // 群：本群 + 抖音公开活动（T-027 P0-mini）；主人/朋友/隔离区仍翻不到
  assert.deepEqual(texts('下棋', 'group:9'), ['群九阿司爱下棋'])
  assert.deepEqual(texts('香菜', 'group:9'), [])
  assert.deepEqual(texts('怕黑', 'group:9'), [])
  assert.deepEqual(texts('陌生人', 'group:9'), ['在抖音回复了陌生人'])
  assert.deepEqual(texts('钓鱼', 'group:9'), [])

  // 抖音：只有抖音/自己；主人私事和朋友的事都不给（A 决策）
  assert.deepEqual(texts('陌生人', 'douyin'), ['在抖音回复了陌生人'])
  assert.deepEqual(texts('香菜', 'douyin'), [])
  assert.deepEqual(texts('怕黑', 'douyin'), [])

  // 主人私聊：看得到自己人（owner + 朋友 + 抖音活动），看不到别的群
  assert.deepEqual(texts('香菜', 'owner'), ['主人不吃香菜'])
  assert.deepEqual(texts('怕黑', 'owner'), ['朋友A怕黑'])
  assert.deepEqual(texts('下棋', 'owner'), [])

  // 朋友自己的私聊：只有自己的
  assert.deepEqual(texts('怕黑', 'friend:朋友A'), ['朋友A怕黑'])
  assert.deepEqual(texts('香菜', 'friend:朋友A'), [])

  // 未知 board：fail-closed
  assert.deepEqual(texts('香菜', ''), [])
  assert.deepEqual(texts('下棋', ''), [])
  assert.deepEqual(texts('香菜', undefined), [])
})

test('整理时的「已经记得的事」：只列本板块，update/outdated 改不了别的板块', async () => {
  const ownerFact = mem.add({ text: '主人喜欢黑咖啡', about: '1', aboutName: '主人', importance: 0.8, source: 'tool', chatId: 'private:1' })
  const friendFact = mem.add({ text: '朋友A怕狗', scope: 'friend:朋友A', importance: 0.8, source: 'tool' })
  const groupFact = mem.add({ text: '群九阿光爱围棋', scope: 'group:9', importance: 0.8, source: 'tool' })

  logs.set(day(), [
    { chatId: 'private:1', who: '主人', text: '今天喝的黑咖啡真不错' },
    { chatId: 'private:1', who: '主人', text: '对了，朋友A最近怕狗，你记得吧' },
    { chatId: 'private:1', who: '主人', text: '以后改喝美式吧' },
  ])
  asked = []
  reply = () => JSON.stringify([
    { op: 'update', id: ownerFact.id, text: '主人改喝美式了', about: '主人', importance: 0.8 },
    { op: 'update', id: friendFact.id, text: '朋友A不怕狗了', about: '朋友A' },
    { op: 'outdated', id: groupFact.id, text: '群九阿光不爱围棋了', about: '阿光' },
  ])
  await mem.consolidate({ includeToday: true })

  const prompt = asked.filter((a) => a.system.includes('整理长期记忆')).at(-1)
  assert.ok(prompt, '确实跑了记忆整理')
  assert.ok(prompt.text.includes('#' + ownerFact.id), '本板块的旧事实带编号交给模型')
  assert.ok(prompt.text.includes('#' + friendFact.id), '主人私聊里朋友的事可以改（friend:* 本来对主人可见）')
  assert.ok(!prompt.text.includes('#' + groupFact.id), '别的群的旧事实不列进来')

  const all = mem.list('')
  assert.equal(all.find((m) => m.id === ownerFact.id).text, '主人改喝美式了', '本板块的 update 生效')
  assert.equal(all.find((m) => m.id === friendFact.id).text, '朋友A不怕狗了', '朋友板块的 update 生效')
  assert.equal(all.find((m) => m.id === friendFact.id).scope, 'friend:朋友A', '改写不动 scope，不会漂到主人板块')
  assert.equal(all.find((m) => m.id === groupFact.id).text, '群九阿光爱围棋', '别的群的 update 被拒')
  assert.ok(!all.find((m) => m.id === groupFact.id).invalidAt, '别的群不会被标过时')
  assert.ok(!all.some((m) => m.text === '群九阿光不爱围棋了'), '被拒的改写不会变成新事实塞进本板块')
})

test('改写主体校验：朋友板块的 id 只能改那个人的事（QQ 对、名字错也不行）', async () => {
  mem.setProfile('3', '小明是她朋友', '小明')
  const xh = mem.add({ text: '朋友A爱看海', scope: 'friend:朋友A', importance: 0.8, source: 'tool' })
  const xm = mem.add({ text: '小明怕水', about: '3', aboutName: '小明', scope: 'friend:3', importance: 0.8, source: 'tool' })
  const addLines = (who) => {
    const d = day()
    logs.set(d, [...(logs.get(d) || []),
      { chatId: 'private:1', who: '主人', text: who + '最近怎么样' },
      { chatId: 'private:1', who: '主人', text: who + '的事你还记得吧' },
      { chatId: 'private:1', who: '主人', text: '你记一下' },
    ])
  }

  // 1) 朋友A的 id 配小明的名字 → 拒
  addLines('朋友A')
  reply = () => JSON.stringify([{ op: 'update', id: xh.id, text: '小明不怕狗了', about: '小明' }])
  await mem.consolidate({ includeToday: true })
  assert.equal(mem.list('看海').find((m) => m.id === xh.id).text, '朋友A爱看海', '主体对不上（小明）不生效')

  // 2) 小明的 id + 正确 QQ，但名字写成朋友A → 拒（Codex review5 抓的洞）
  addLines('小明')
  reply = () => JSON.stringify([{ op: 'update', id: xm.id, text: '小明不怕水了', about: '朋友A', about_qq: '3' }])
  await mem.consolidate({ includeToday: true })
  assert.equal(mem.list('怕水').find((m) => m.id === xm.id).text, '小明怕水', 'QQ 对、名字错也不行')

  // 3) 朋友A主体对上 → 生效
  addLines('朋友A')
  reply = () => JSON.stringify([{ op: 'update', id: xh.id, text: '朋友A爱看山了', about: '朋友A' }])
  await mem.consolidate({ includeToday: true })
  assert.equal(mem.list('看山').find((m) => m.id === xh.id).text, '朋友A爱看山了', '主体对上才生效')
})

test('面板板块白名单 + 主体校验纯函数', () => {
  assert.equal(cleanScope(''), '')
  assert.equal(cleanScope('owner'), 'owner')
  assert.equal(cleanScope('quarantine'), 'quarantine')
  assert.equal(cleanScope('group:123456'), 'group:123456')
  assert.equal(cleanScope('friend:朋友A'), 'friend:朋友A')
  assert.equal(cleanScope('friend:'), null, '空朋友名不行')
  assert.equal(cleanScope('global; DROP'), null, '白名单之外一律拒绝')
  assert.equal(subjectMatchesScope({ scope: 'owner', about: '9' }), true, '非朋友板块不校验主体')
  assert.equal(subjectMatchesScope({ scope: 'friend:3', about: '3' }), true)
  assert.equal(subjectMatchesScope({ scope: 'friend:3', aboutName: '小明', profiles: { 3: { name: '小明' } } }), true)
  assert.equal(subjectMatchesScope({ scope: 'friend:3', aboutName: '朋友A', profiles: { 3: { name: '小明' } } }), false)
  assert.equal(subjectMatchesScope({ scope: 'friend:3', about: '3', aboutName: '朋友A', profiles: { 3: { name: '小明' } } }), false, 'QQ 对、名字错也不行')
  assert.equal(subjectMatchesScope({ scope: 'friend:3', about: '3', aboutName: '小明', profiles: { 3: { name: '小明' } } }), true)
  assert.equal(subjectMatchesScope({ scope: 'friend:朋友A', aboutName: '朋友A' }), true)

  assert.deepEqual(panelAddScope({ aboutName: '主人', ownerName: '主人' }), { scope: '', note: '' }, '关于主人不隔离')
  assert.equal(resolveMemoryScope({ aboutName: '主人', ownerQQ: '1', ownerName: '主人' }), 'owner', '只给「主人」这个名字也要归主人板块')
  const panelOwner = mem.add({ text: '主人爱吃鱼干', aboutName: '主人', source: 'panel' })
  assert.equal(mem.list('鱼干').find((m) => m.id === panelOwner.id).scope, 'owner', '面板加「关于主人」真的落 owner，不是 friend:主人')
  assert.equal(panelAddScope({ aboutName: '小明', profiles: { 3: { name: '小明' } } }).scope, '', '档案里有这个名字，按名字归一')
  assert.equal(panelAddScope({ aboutName: '新人' }).scope, 'quarantine', '没对上 QQ 的先隔离，等主人选板块')
  assert.equal(panelAddScope({ scope: 'owner', aboutName: '新人' }).scope, 'owner', '显式选了板块就照办')
})

test('朋友键统一：主人在私聊里提到朋友，名字和 QQ 都落到 friend:<QQ>', () => {
  mem.setProfile('5', '小红是她自己的朋友', '小红')
  const a = mem.add({ text: '小红喜欢猫', about: '5', aboutName: '小红', source: 'tool', chatId: 'private:1' })
  assert.equal(mem.list('喜欢猫').find((m) => m.id === a.id).scope, 'friend:5', '给了 QQ 就用 QQ 当键，不再落到 owner')
  const b = mem.add({ text: '小红怕冷', aboutName: '小红', source: 'tool', chatId: 'private:1' })
  assert.equal(mem.list('怕冷').find((m) => m.id === b.id).scope, 'friend:5', '只给名字、档案里唯一对应时也用 QQ 当键')
  const friendHits = mem.recall('怕冷', { board: 'friend:5' }).map((h) => h.it.text)
  assert.ok(friendHits.includes('小红怕冷'), '朋友自己的私聊看得到')
  assert.ok(friendHits.every((t) => t === '小红怕冷' || t === '小红喜欢猫'), '图谱只关联同一个小红的事，不串别人')
  const ownerHits = mem.recall('怕冷', { board: 'owner' }).map((h) => h.it.text)
  assert.ok(ownerHits.includes('小红怕冷'), '主人私聊也看得到')
  assert.ok(ownerHits.every((t) => t === '小红怕冷' || t === '小红喜欢猫'), '主人私聊也只关联小红的事')
})

test('人物档案：只在主人私聊注入，群和朋友私聊都不注入', async () => {
  mem.add({ text: '主人爱钓鱼', about: '1', aboutName: '主人', source: 'tool', chatId: 'private:1' })
  mem.add({ text: '主人是程序员', about: '1', aboutName: '主人', source: 'tool', chatId: 'private:1' })
  mem.add({ text: '主人养了一只狗', about: '1', aboutName: '主人', source: 'tool', chatId: 'private:1' })
  assert.equal(await mem.buildProfile('1'), true)
  assert.equal(mem.profiles()[0].qq, '1')

  const p = mem.contextFor({ kind: 'private', userId: '1', chatId: 'private:1' }, 's-owner')
  assert.match(p, /你对对方的印象/)
  speakers = ['1']
  const g = mem.contextFor({ kind: 'group', groupId: '9', chatId: 'group:9' }, 's-group')
  assert.doesNotMatch(g, /你对.*印象/, '群里不注入档案（群成员的事聚合在别的板块）')
  const f = mem.contextFor({ kind: 'private', userId: '2', chatId: 'private:2' }, 's-friend')
  assert.doesNotMatch(f, /你对.*印象/, '朋友私聊也不注入（档案是主人私聊的东西）')
  speakers = []

  // 非主人档案也不注入：只排除主人 QQ 的旧修法会漏掉这条
  mem.add({ text: '小红爱猫', about: '2', aboutName: '小红', source: 'tool', chatId: 'private:2' })
  mem.add({ text: '小红住城里', about: '2', aboutName: '小红', source: 'tool', chatId: 'private:2' })
  mem.add({ text: '小红上班忙', about: '2', aboutName: '小红', source: 'tool', chatId: 'private:2' })
  profileOut = '小红是朋友，爱猫'
  assert.equal(await mem.buildProfile('2'), true)
  speakers = ['2']
  const g2 = mem.contextFor({ kind: 'group', groupId: '9', chatId: 'group:9' }, 's-group2')
  assert.doesNotMatch(g2, /小红是朋友/, '群里不注入任何人的档案')
  const f2 = mem.contextFor({ kind: 'private', userId: '2', chatId: 'private:2' }, 's-friend2')
  assert.doesNotMatch(f2, /小红是朋友/, '朋友私聊也不注入档案')
  speakers = []
})

test('未知 board：缺 scope / 空 board / 未知会话全部 fail-closed；import 一律 quarantine', () => {
  assert.equal(scopeVisible({ scope: 'owner' }, ''), false)
  assert.equal(scopeVisible({ scope: 'owner' }, undefined), false)
  assert.equal(scopeVisible({}, 'owner'), false, '缺 scope 不可见')
  assert.equal(scopeVisible({ scope: 'quarantine' }, 'owner'), false)
  assert.equal(boardFromChatId('system:douyin', '1'), '')
  assert.equal(boardFromChatId('weird:1', '1'), '')

  assert.equal(deriveMemoryScope({ source: 'import', chatId: 'private:1', text: '旧档案' }), 'quarantine', 'import 不能被私聊绕过')
  assert.equal(deriveMemoryScope({ source: 'import', chatId: 'group:9', text: '旧档案' }), 'quarantine')
  assert.equal(deriveMemoryScope({ source: 'import', tags: ['空间'], text: '旧档案' }), 'quarantine', 'import 不能被 tags=空间 绕过')

  const text = mem.volatileFor({ kind: 'weird', chatId: 'weird:1' }, 's-unknown') + '\n' + mem.contextFor({ kind: 'weird', chatId: 'weird:1' }, 's-unknown')
  assert.doesNotMatch(text, /香菜|怕黑|下棋|陌生人/, '未知会话不给任何板块的记忆')

  // import 不能靠显式 scope 绕过（Codex P1-3）
  const imp = mem.add({ text: '旧档案里的秘密', source: 'import', scope: 'global' })
  assert.equal(mem.list('秘密').find((m) => m.id === imp.id).scope, 'quarantine', 'import 给显式 scope 也进隔离区')
})

test('图谱召回：补关联条、不跨板块、quarantine/invalid 不回来、maxNeighbors=0 关闭', () => {
  const chatId = 'group:9'
  const a = mem.add({ text: '图谱验证甲：暗号是蓝鲸', kind: 'event', scope: chatId, chatId, about: '9' })
  const b = mem.add({ text: '图谱验证乙：收到', kind: 'event', scope: chatId, chatId, about: '9' })
  const owner = mem.add({ text: '图谱验证丙：主人那边的事', kind: 'event', scope: 'owner', chatId: 'private:1', about: '9' })
  const q = mem.add({ text: '图谱验证丁：待确认', kind: 'event', scope: 'quarantine', chatId, about: '9' })
  const inv = mem.add({ text: '图谱验证戊：作废', kind: 'event', scope: chatId, chatId, about: '9' })
  mem.invalidate(inv.id)
  const hits = mem.recall('暗号', { board: chatId })
  assert.ok(hits.some((h) => h.it.id === a.id), '原命中在')
  assert.ok(hits.some((h) => h.it.id === b.id && h.why.includes('（关联）')), '同聊天的关联条补进来')
  assert.ok(!hits.some((h) => h.it.id === owner.id), '不跨板块')
  assert.ok(!hits.some((h) => h.it.id === q.id), 'quarantine 不被图带回')
  assert.ok(!hits.some((h) => h.it.id === inv.id), 'invalid 不被图带回')
  cfg.memory.graph.maxNeighbors = 0
  const none = mem.recall('暗号', { board: chatId })
  assert.ok(!none.some((h) => h.why.includes('（关联）')), 'maxNeighbors=0 时完全不扩展')
  cfg.memory.graph.maxNeighbors = 2
})

test('全局身份卡：群/抖音都有身份，但不带 owner 私事', () => {
  const v2 = { ...(cfg.memory.v2 || {}) }
  cfg.memory.v2 = { ...v2, enabled: true, shadow: false }
  mem.add({ text: '我的抖音昵称是测试昵称测试', kind: 'fact', scope: 'self', board: 'owner', tags: ['资料', '她自己'] })
  mem.add({ text: '主人生日是 9 月 5 日', kind: 'fact', scope: 'owner', about: '1', aboutName: '主人' })
  const g = mem.volatileFor({ kind: 'group', groupId: '9', chatId: 'group:9' }, 'sid-id-g')
  assert.match(g, /你是大肥鱼；主人是/)
  assert.match(g, /测试昵称测试/)
  assert.equal((g.match(/测试昵称测试/g) || []).length, 1, '身份卡和事实卡不重复')
  assert.doesNotMatch(g, /生日/)
  const d = mem.volatileFor({ kind: 'system', chatId: 'system:douyin' }, 'sid-id-d')
  assert.match(d, /你是大肥鱼；主人是/)
  assert.doesNotMatch(d, /生日/)
  cfg.memory.v2 = v2
})

test('读时补 scope：旧运行态写的无 scope 记录按生产规则补上，不用停机改文件', () => {
  const file = join(process.env.MEMORY_DATA_DIR, 'memories.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.items.push({ id: 'legacy01', text: '旧运行态写的一条群事', chatId: 'group:9', about: '', tags: ['抖音'], importance: 0.5, source: 'event', at: Date.now() })
  writeFileSync(file, JSON.stringify(raw), 'utf8')
  const hit = mem.list('旧运行态').find((m) => m.id === 'legacy01')
  assert.equal(hit.scope, 'group:9', '按 chatId 补成 group:9，不是按 tags 猜成 douyin')
  assert.deepEqual(mem.recall('群事', { board: 'group:9' }).map((h) => h.it.text), ['旧运行态写的一条群事'])
})
