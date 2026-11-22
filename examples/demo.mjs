// 最小演示：用临时目录和假数据跑一遍「写事实/事件 → 检索 → 概览」。
// 不联网、不读真实记忆库。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MEMORY_DATA_DIR = mkdtempSync(join(tmpdir(), 'memory-design-demo-'))

const { createMemoryStore } = await import('../src/features/memory.js')
const { normalize } = await import('../src/core/config.js')

const cfg = normalize({
  ownerQQ: '10001',
  ownerName: '主人',
  memory: { enabled: true, v2: { enabled: true, shadow: false } },
})

const hub = {
  chatLogDays: () => [],
  chatLogOf: () => [],
  deleteChatLog: () => {},
}
const dsh = { get: () => null }
const log = { info() {}, warn() {}, debug() {} }
const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })

// 1) 两条长期事实
mem.add({ text: '主人不吃香菜', about: '主人', aboutName: '主人', scope: 'owner', chatId: 'private:10001', importance: 0.9 })
mem.add({ text: '主人喜欢白米饭', about: '主人', aboutName: '主人', scope: 'owner', chatId: 'private:10001', importance: 0.8 })

// 2) 一条带时间的经历
mem.addEvent({ text: '主人今天说想去看海', about: '主人', aboutName: '主人', scope: 'owner' })

// 3) 检索 + 概览
const hits = mem.recall('主人喜欢吃什么', { board: 'owner', limit: 3 })
const overview = mem.overview()

console.log('【检索】')
for (const h of hits) console.log('-', h.it?.text || h.text || h)
console.log('\n【事实卡】')
console.log(overview.card.text || '（空）')
console.log('\n【最近经历】')
console.log(overview.events?.text || overview.events || '（空）')
console.log('\n【统计】', overview.stats)
