import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let normalize
let deriveMemoryScope
let scopeOfChat
let scopeVisible
let boardFromChatId
const logs = new Map()
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
let cfg
let mem

before(async () => {
  process.env.MEMORY_DATA_DIR = mkdtempSync(join(tmpdir(), 'memory-design-scope-'))
  ;({ createMemoryStore, deriveMemoryScope, scopeOfChat, scopeVisible, boardFromChatId } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({ ownerQQ: '1', ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { v2: { enabled: true, shadow: false } } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
})

test('板块推导：五块各归各的', () => {
  const o = { ownerQQ: '1' }
  assert.equal(deriveMemoryScope({ ...o, chatId: 'private:1' }), 'owner')
  assert.equal(deriveMemoryScope({ ...o, chatId: 'private:2' }), 'friend:2')
  assert.equal(deriveMemoryScope({ ...o, chatId: 'group:9' }), 'group:9')
  assert.equal(deriveMemoryScope({ ...o, chatId: 'qzone' }), 'self')
  assert.equal(deriveMemoryScope({ ...o, source: 'diary', text: '我在 QQ 空间写过：…' }), 'self')
  assert.equal(deriveMemoryScope({ ...o, tags: ['空间'], text: '在空间回复了朋友C' }), 'self')
  assert.equal(deriveMemoryScope({ ...o, source: 'import', text: '旧档案：阿强喜欢钓鱼' }), 'quarantine')
  assert.equal(deriveMemoryScope({ ...o, text: '在抖音私信里回了主人：晚安' }), 'owner')
  assert.equal(deriveMemoryScope({ ...o, text: '在抖音回复了一条评论：好吃' }), 'douyin')
  assert.equal(deriveMemoryScope({ ...o, source: 'event', about: '2529325723', text: '在朋友A的直播间' }), 'douyin')
  assert.equal(deriveMemoryScope({ ...o, source: 'auto', aboutName: '朋友A', text: '朋友A是我的朋友' }), 'friend:朋友A')
})

test('可见性：群看不见主人/朋友私事，朋友和群各自收窄，隔离区永不注入', () => {
  assert.equal(scopeVisible({ scope: 'owner' }, 'owner'), true)
  assert.equal(scopeVisible({ scope: 'owner' }, 'douyin'), false, '抖音是公开场，不带主人私事')
  assert.equal(scopeVisible({ scope: 'owner' }, 'group:9'), false)
  assert.equal(scopeVisible({ scope: 'friend:朋友A' }, 'owner'), true)
  assert.equal(scopeVisible({ scope: 'friend:朋友A' }, 'friend:朋友A'), true)
  assert.equal(scopeVisible({ scope: 'friend:朋友A' }, 'douyin'), false, 'A 决策：抖音不带朋友的事')
  assert.equal(scopeVisible({ scope: 'friend:朋友A' }, 'group:9'), false)
  assert.equal(scopeVisible({ scope: 'group' }, 'group:77'), true, '群公共事实跨群')
  assert.equal(scopeVisible({ scope: 'group:9' }, 'group:77'), false)
  assert.equal(scopeVisible({ scope: 'self' }, 'group:9'), true)
  assert.equal(scopeVisible({ scope: 'quarantine' }, 'owner'), false)
  assert.equal(scopeVisible({ scope: 'group:9' }, 'group:9'), true)
  assert.equal(scopeVisible({ scope: 'group:9' }, 'group:8'), false, '别的群看不见')
  // T-027 P0-mini：抖音公开活动进群聊；owner 板仍然不进群
  assert.equal(scopeVisible({ scope: 'douyin' }, 'group:9'), true, '抖音公开活动群里也能提')
  assert.equal(scopeVisible({ scope: 'douyin' }, 'douyin'), true)
  assert.equal(scopeVisible({ scope: 'douyin' }, 'owner'), true)
  assert.equal(scopeVisible({ scope: 'owner' }, 'group:9'), false, 'P0 搁置：主人板仍不进群')
})

test('聊天 → 板块', () => {
  assert.equal(scopeOfChat({ kind: 'private', userId: '1' }, '1'), 'owner')
  assert.equal(scopeOfChat({ kind: 'private', userId: '2' }, '1'), 'friend:2')
  assert.equal(scopeOfChat({ kind: 'group', groupId: '9' }, '1'), 'group:9')
  assert.equal(scopeOfChat({ kind: 'system' }, '1'), 'douyin')
  assert.equal(scopeOfChat(null, '1'), '')
  assert.equal(boardFromChatId('private:1', '1'), 'owner')
  assert.equal(boardFromChatId('private:3', '1'), 'friend:3')
  assert.equal(boardFromChatId('qzone', '1'), 'self')
})

test('注入隔离：主人私聊的卡里没有群的事实', () => {
  mem.add({ text: '主人不吃香菜', aboutName: '主人', about: '1', chatId: 'private:1', importance: 0.9, source: 'panel' })
  mem.add({ text: '群里有人说阿司爱下棋', aboutName: '司至年', about: '777', chatId: 'group:9', importance: 0.9, source: 'auto' })

  const text = mem.volatileFor({ kind: 'private', userId: '1', chatId: 'private:1' }, 's-private-1')
  assert.match(text, /不吃香菜/)
  assert.doesNotMatch(text, /阿司爱下棋/)
})

test('抖音会话也能拿到记忆（只给抖音/朋友/自己，不带主人私事和群）', () => {
  mem.add({ text: '主人的私房事不该出现在抖音', aboutName: '主人', about: '1', chatId: 'private:1', importance: 0.9, source: 'panel' })
  mem.addEvent({ text: '在抖音回复了一条评论：好玩', tags: ['抖音'], importance: 0.5 })
  const text = mem.volatileFor({ kind: 'system', chatId: 'system:douyin' }, 's-dy-1')
  assert.match(text, /回复了一条评论/)
  assert.doesNotMatch(text, /私房事/)
})
