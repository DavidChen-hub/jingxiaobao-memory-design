# jingxiaobao-memory-design

**一个 local-first 的社交 Agent 长期记忆参考实现**：事实卡 + 24h 经历段 + 最近原话 + 命中记忆，按「场合」隔离，事实与经历分开，零外部依赖。

> 本仓库从 `aureth-labs/dsh-aurabot-qq` 的 **1.1.6 本地分叉**抽取，MIT。
> 上游 `aureth-labs/dsh-aurabot-qq`（718★，1.2.1）是**另一套记忆实现**；本仓库不是上游官方，不保证实现或数据格式兼容。
> 本仓库**只含记忆核心**：不含 QQ 聊天、OneBot/SnowLuma、抖音评论/文章、B 站、空间、翻唱、语音、贴纸、人格、人物图、真实记忆库。

## 它解决什么

普通「向量库 + top-k」记忆用在聊天机器人上会踩五个坑：压缩即失忆、跨场合串味、事实和经历混在一个桶、检索只看关键词、成本随库线性涨。这套实现逐条对着改：

- **四层注入**：事实卡（长期）/ 最近经历（24h、带日期）/ 最近原话（防压缩）/ 命中记忆（BM25，最多 3 条）；
- **五板块隔离**：`owner` / `group:<群号>` / `douyin` / `friend:<QQ或名字>` / `self`，外加 `quarantine`、`public:bili`、`global`；缺板块一律不可见（fail-closed）；
- **事实 vs 经历**：能长期成立的是 `fact`，只在那一刻成立的是 `event`；事实不衰减、不进日期，事件带时间、按半衰期淡出；
- **候选池**：低置信内容先考察，3 次转正、14 天不出现淘汰；事件直接入库；
- **问法路由 + 记忆图谱**：主体/槽位/主题/日期加权，1 跳召回相关的事；
- **零外部依赖**：本地 JSON + 中文二元组 BM25，不需要向量库、嵌入模型或云服务。

完整设计见：[docs/design.md](docs/design.md)、[docs/architecture.md](docs/architecture.md)、[docs/api.md](docs/api.md)、[docs/fact-vs-event.md](docs/fact-vs-event.md)。

## 快速开始

要求 Node.js ≥ 22.13（只用内置模块，无 npm 依赖）。

```bash
node examples/demo.mjs
```

最小用法：

```js
import { createMemoryStore } from './src/features/memory.js'
import { normalize } from './src/core/config.js'

const cfg = normalize({ ownerQQ: '10001', ownerName: '主人', memory: { v2: { enabled: true, shadow: false } } })
const hub = { chatLogDays: () => [], chatLogOf: () => [], deleteChatLog: () => {} }
const mem = createMemoryStore({ dsh: { get: () => null }, getConfig: () => cfg, hub, log: console })

mem.add({ text: '主人不吃香菜', about: '主人', aboutName: '主人', scope: 'owner', chatId: 'private:10001', importance: 0.9 })
mem.addEvent({ text: '主人今天说想去看海', about: '主人', aboutName: '主人', scope: 'owner' })

const hits = mem.recall('主人喜欢吃什么', { board: 'owner' })
const overview = mem.overview()
```

数据默认写到 `$MEMORY_DATA_DIR`（未设置时是 `~/.dsh/memory-design`）；示例和测试都用临时目录，不会碰真实数据。

## 测试

```bash
node --test --test-concurrency=1 "test/*.test.js"
# 装了 npm 也可以用
npm test
```

必须串行（`--test-concurrency=1`）。当前 **130 个用例**全部通过。

## 目录

```text
src/features/memory.js          主逻辑（存储/检索/注入/整理/候选池）
src/features/memory/card.js     事实卡投影
src/features/memory/events.js   24h 事件段
src/features/memory/recent.js   最近原话
src/features/memory/route.js    问法路由
src/features/memory/graph.js    记忆图谱
src/features/memory/identity.js 身份卡
src/core/store.js               JSON 存储适配
src/core/llm.js                 LLM 接口适配（只依赖宿主 llm.stream）
src/core/config.js              最小配置归一化
test/                           130 个记忆用例（脱敏）
examples/demo.mjs               假数据演示
docs/design.md                  设计与开源说明
docs/architecture.md            架构图（Mermaid）
docs/api.md                     API 参考
docs/fact-vs-event.md           事实/经历判定标准
```

## 来源、许可与边界

- 代码 MIT，见 [LICENSE](LICENSE)；从 Aurabot 1.1.6 抽取，保留上游版权 `Aurabot contributors`，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- 本仓库**不含**真实记忆、聊天记录、QQ/群号、配置、日志、备份、人格文件、人物图或 dsh-pet 素材。
- 不是上游官方实现；上游 1.2.1 有自己的记忆架构（`memory-store.js` / `memory-vector.js`），不保证兼容。
- 定位是 **reference implementation**：优先可读、可审计、可移植；不追求功能覆盖上游全部能力。

## 维护

- 这是参考实现，不承诺 SLA；issue / PR 欢迎，但不保证响应时间。
- 如果长期无人维护，仓库会标 `archived`，README 保留“reference only, not maintained”。
- 不跟随上游整库合并；只选择性吸收适配器/思路改进。

## 致谢

设计上参考过这些开源项目的思路（只参考，未复制代码）：`Ido1um/DeepSeek-memory-Ido1um`、`kianajunjie/dsh-hippocampus`、`Phant0Meow/dsh-meow-memory`、`MingHuanYue/dsh-tide-memory`、`YeStarOne/dsh-plugin-memory-graph`、`Yuuyuko-uu/dsh-xingxi`、`AskTheWay/dsh-auto-memory`。如果发现遗漏，请提 issue。
