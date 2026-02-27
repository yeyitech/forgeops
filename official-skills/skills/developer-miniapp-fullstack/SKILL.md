---
name: developer-miniapp-fullstack
description: "Deliver integrated miniapp and backend features end-to-end. Use for cross-layer miniapp implementation tasks."
---

# 执行准则

1. 按用户旅程串联前后端改动。
2. 为关键路径补端到端验证脚本。
3. 保持可回滚与可观测。
4. 小程序端需保证 `app.json` 路由与页面脚本产物一致（`miniapp/pages/**.js`）。
5. 后端需提供可探测健康端点，并可被 `platform-smoke` 自动启停验证。
