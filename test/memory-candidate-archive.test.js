import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
const hub = { chatLogDays: () => [], chatLogOf: () => [], deleteChatLog() {}, lastTextOf: () => '', prevTextOf: () => '', speakersOf: () => [] }
const log = { info() {}, warn() {}, debug() {} }
const dsh = { get: () => null }
let cfg
let mem

before(async () => {
  process.env.MEMORY_DATA_DIR = mkdtempSync(join(tmpdir(), 'memory-design-cand-'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  const { normalize } = await import('../src/core/config.js')
  cfg = normalize({ ownerQQ: '1', ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { enabled: true, v2: { enabled: true, shadow: false } } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
})

const DAY = 86400_000

test('候选池：14 天没转正 → blocked（不再 pending）', () => {
  const now = Date.now()
  mem.addCandidate({ text: '小北说他养了只猫叫团子', aboutName: '小北', chatId: 'group:9', at: now - 15 * DAY })
  const r = mem.judgeCandidates({ now })
  assert.equal(r.blocked >= 1, true)
  assert.equal(mem.candidates().filter((c) => c.status === 'candidate').length, 0)
})

test('候选池：blocked 超过 30 天以后从池子里清掉，但记忆库不受影响', () => {
  const now = Date.now()
  const c = mem.addCandidate({ text: '很久以前的一句闲聊', chatId: 'group:9', at: now - 60 * DAY })
  const id = c.id || c.candidate?.id
  // 直接判一次，让它变 blocked 并记下 resolvedAt
  mem.judgeCandidates({ now })
  const after = mem.candidates({ includeResolved: true }).find((x) => x.id === id || x.text === '很久以前的一句闲聊')
  assert.ok(after, '候选应该还在（刚 blocked）')
  // 把 resolvedAt 往前推 40 天，再判一次 → 应该被清掉
  const later = now + 40 * DAY
  const r2 = mem.judgeCandidates({ now: later })
  assert.equal(r2.archived >= 1, true)
  assert.equal(mem.candidates({ includeResolved: true }).some((x) => x.text === '很久以前的一句闲聊'), false)
  // 记忆库没有多出这条
  assert.equal(mem.list('').some((m) => m.text.includes('很久以前的一句闲聊')), false)
})
