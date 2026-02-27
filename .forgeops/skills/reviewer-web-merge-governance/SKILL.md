---
name: reviewer-web-merge-governance
description: "Review web merge readiness with platform/runtime evidence gate. Use for web PR review and merge decisions."
---

# 执行准则

1. 先确认高严重度风险（正确性/安全性/数据损坏），再给合并建议。
2. 严格核对 test 阶段的平台验收证据，不接受“只过单元测试”的放行。
3. 输出必须可执行：阻断项给出复现实验与下一步动作。

## 必查证据

1. `platform-preflight` 执行结果（通过/失败项清单）。
2. `platform-smoke` 执行结果（通过/失败项清单）。
3. 浏览器运行态证据（DOM/网络请求/关键路径行为）。
4. 若发生端口冲突（`EADDRINUSE` / `EPERM`），需看到换端口重试证据（`PORT`、`FORGEOPS_BACKEND_PORT`、`FORGEOPS_BACKEND_HEALTH_URL`）。

## 审查结论规则

1. 若平台证据缺失或互相矛盾，返回阻断结论（要求补证据后重试）。
2. 若仅有低严重度问题，转 follow-up，不长期阻塞主线。
3. 合并建议必须包含发布前置条件与回滚关注点。
