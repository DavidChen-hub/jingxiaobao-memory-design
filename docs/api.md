# API 参考

> 这是 `src/features/memory.js` 的常用接口速查；完整实现以源码为准。

## 1. 配置

```js
import { normalize } from './src/core/config.js'
const cfg = normalize({ ownerQQ: '10001', ownerName: '主人' })
```

`normalize(raw)` 只归一化本仓库关心的字段：

- `ownerQQ` / `ownerName` / `botQQ`
- `model: { provider, model }`
- `memory`：`enabled`、`recallCount`、`dailyConsolidate`、`consolidateTimes`、`reviewRemindAt`、`decay`、`route`、`graph`、`identity`、`v2`

默认值：`decay = { eventHalfLifeDays: 30, eventForgetDays: 180 }`；`v2 = { enabled: false, shadow: true, cardMaxChars: 1500, recentMaxChars: 2400 }`；`consolidateTimes = ['04:00', '16:00']`。

## 2. 创建 store

```js
import { createMemoryStore } from './src/features/memory.js'

const mem = createMemoryStore({
  dsh,          // 宿主：至少提供 llm.stream（抽取/画像时需要）
  getConfig,    // () => normalize(...)
  hub,          // 聊天流水：chatLogDays/chatLogOf/deleteChatLog（整理时需要）
  log,          // { info, warn, debug }
})
```

`dsh.get('llm')` 也可以；`hub` 的方法只在 `consolidate()`、`contextFor()`、`volatileFor()` 里用。

## 3. 写入

```js
mem.add({
  text: '主人不吃香菜',
  about: '主人',          // 关于谁（QQ 或名字）
  aboutName: '主人',
  tags: ['饮食'],
  importance: 0.9,        // 0–1
  source: 'tool',         // tool / auto / import / event / turn
  chatId: 'private:10001',
  kind: 'fact',           // fact | event
  scope: 'owner',         // 可选；不传会按 chatId/about 推导
  board: '',              // 可选；self 经历常用
})

mem.addEvent({
  text: '主人今天说想去看海',
  about: '主人',
  aboutName: '主人',
  scope: 'owner',
})
```

- `kind` 不传默认 `fact`；拿不准的用 `event`，避免污染事实卡。
- `source: 'import'` 一律进 `quarantine`，显式 `scope` 也绕不过。
- 去重只在同一板块、同一 kind 内做；同一句话在群里和私聊是两条。

## 4. 读取 / 检索

```js
const hits = mem.recall('主人喜欢吃什么', {
  board: 'owner',        // 必填；空 board = fail-closed，一条都不给
  about: '10001',        // 可选：偏向某个人
  limit: 3,
  people: [{ qq: '10001', name: '主人' }],
})

for (const h of hits) console.log(h.it.text, h.score)
```

- `recall` 会按 `board` 过滤可见性，再跑 BM25 + 问法路由 + 图谱 1 跳。
- 管理视图（面板列表、日报）用 `overview()`，不要复用 `recall` 的可见性入口。

## 5. 注入

```js
const context = mem.contextFor({ kind: 'private', userId: '10001', chatId: 'private:10001' }, 'session-1')
const volatile = mem.volatileFor({ kind: 'private', userId: '10001', chatId: 'private:10001' }, 'session-1')
```

- `contextFor`：较稳定的部分（人物档案、身份卡等），适合放系统提示词。
- `volatileFor`：每轮变化的部分（事实卡、最近经历、最近原话、命中记忆），跟着消息走。
- 群聊的 `chat` 用 `{ kind: 'group', groupId: '123456', chatId: 'group:123456' }`。

## 6. 整理 / 候选池

```js
await mem.consolidate({ includeToday: true })   // 从聊天流水提炼；需要 hub
mem.tick()                                      // 定时任务入口（每天两次整理/清理）
```

候选池：

```js
mem.addCandidate({ text: '主人可能喜欢猫', key: 'pref.cat', confidence: 0.4 })
mem.judgeCandidates({ now: Date.now() })        // 3 次转正 / 14 天 block
mem.candidates()                                // 列表
mem.reviewQueue({ now: Date.now() })            // 今日/积压的待确认
mem.decideReview({ id, decision: 'fact' | 'event' | 'delete' })
```

## 7. 人物档案

```js
mem.profiles()                       // 全量档案（按板块+人）
await mem.buildProfile('10001', 'owner')
mem.setProfile('10001', '一段人物小档案', '主人', 'owner')
```

## 8. 概览 / 图谱

```js
const ov = mem.overview()
// ov.card.text / ov.events.text / ov.stats / ov.recent / ov.candidates

const g = mem.graph('owner')         // 只读投影：节点 + 边
```

## 9. 数据文件

```text
$MEMORY_DATA_DIR/memories.json
{
  "items": [{ id, text, kind: "fact"|"event", scope, board, about, aboutName, tags, importance, at, invalidAt? }],
  "profiles": { "owner|10001": { text, name, at } },
  "memoryCandidates": [{ id, text, key, confidence, mentions, status }],
  "insights": {}, "styles": {}, "lastConsolidate": ...
}
```

- 默认 `$MEMORY_DATA_DIR` 未设置时是 `~/.dsh/memory-design`。
- 测试和 demo 都写临时目录，不碰真实数据。

## 10. 约束

- 没有多写并发锁；同一进程内同步读写，跨进程不要同时写。
- 检索是 BM25，不是向量；语义近义靠问法路由补。
- 不包含 QQ/抖音/HTTP/面板；这些属于上游插件。
