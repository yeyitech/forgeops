---
name: reviewer-miniapp-merge-governance
description: "Review miniapp merge readiness with WeChat platform evidence gate. Use for miniapp PR review and merge decisions."
---

# 执行准则

1. 优先阻断平台不可运行风险，不把 miniapp 平台问题降级为样式问题。
2. 审查结论必须引用 test 阶段证据，不接受口头结论。
3. 需要明确“可合并/不可合并”与对应条件。

## 必查证据

1. `platform-preflight` 结果中 miniapp 工具链状态（微信开发者工具 CLI 可定位/可执行）。
2. `platform-smoke` 结果中 `miniapp.devtools.cli.service_port` 通过证据。
3. `platform-smoke` 结果中 `backend.health.reachable` 通过证据。
4. 页面路由/入口文件存在性证据（`miniapp/app.json` 与关键页面入口）。
5. 如遇端口冲突，需看到换端口重试证据（`PORT`、`FORGEOPS_BACKEND_PORT`、`FORGEOPS_BACKEND_HEALTH_URL`）。

## 审查结论规则

1. 缺失任一 required 平台证据时，直接阻断并要求补证据。
2. 高严重度风险（正确性/安全性/数据损坏）阻断合并。
3. 低严重度问题转 follow-up issue，不长期阻塞主线。
