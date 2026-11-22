# Changelog

## 0.1.0 — 2026-11-22

第一个独立参考实现版本。

- 从 Aurabot `1.1.6` 的本地分叉抽出记忆核心：事实卡、24h 事件段、最近原话、候选池、问法路由、记忆图谱、身份卡。
- 增加两个最小适配器：`src/core/store.js`（JSON 存储）、`src/core/llm.js`（只依赖宿主 `llm.stream`）。
- 增加最小配置归一化 `src/core/config.js`。
- 17 个记忆测试文件全部迁入并脱敏，**130 个用例通过**。
- 增加 `examples/demo.mjs` 假数据演示。
- 增加 `docs/design.md`、`docs/fact-vs-event.md`、README、MIT LICENSE、THIRD-PARTY-NOTICES、GitHub Actions（Node 22/24）。
- 明确边界：不含 QQ/抖音/评论/文章/B 站/空间/人格/人物图/真实记忆。
