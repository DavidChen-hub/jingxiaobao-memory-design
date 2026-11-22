# Contributing

这是一个 **reference implementation**，优先可读、可审计、可移植，不追求功能覆盖上游全部能力。

## 提交前

1. `node --test --test-concurrency=1 "test/*.test.js"` 全绿；
2. `node --check` 改动的文件；
3. 不提交任何真实记忆、聊天记录、QQ/群号、配置、日志、备份、人格、人物图；
4. 涉及事实/经历判定的改动，先读 `docs/fact-vs-event.md`。

## 约定

- 一个 PR 只做一件事；行为改动要带测试。
- 不引入 npm 运行时依赖；保持本地 JSON + BM25 + 零外部服务。
- 不把上游插件模块（QQ/抖音/B 站/面板）搬进来；本仓库只做记忆核心。
- 新增第三方代码/素材时，更新 `THIRD-PARTY-NOTICES.md` 并保留原许可。

## 报告问题

请附：复现步骤、期望行为、实际行为、Node 版本；不要贴真实聊天内容或 QQ 号。
