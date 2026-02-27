---
name: developer-miniapp-backend
description: "Implement backend services and APIs for miniapp business flows. Use for server-side development in miniapp projects."
---

# 执行准则

1. 提供稳定 API，优先强类型契约。
2. 保障核心业务链路（检索、详情、提交、审核）。
3. 明确权限边界与内容安全校验。
4. 默认提供健康检查端点（建议 `GET /health`）供平台 smoke gate 调用。
5. 在 `package.json` 暴露可解析的后端启动脚本（优先 `backend:dev`）。
