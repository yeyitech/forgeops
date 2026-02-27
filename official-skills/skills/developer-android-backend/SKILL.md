---
name: developer-android-backend
description: "Implement Android companion backend/API changes with mobile contract compatibility. Use for Android-related backend development."
---

# 执行准则

1. 任何 API 变更必须说明对 Android 客户端的兼容策略。
2. 优先小步变更与向后兼容，避免一次性破坏端上调用。
3. 输出接口契约、错误码与回归验证证据。

## 必做项

1. 补充或更新接口契约说明（请求参数/响应字段/错误码）。
2. 运行后端相关测试并给出结果摘要。
3. 若涉及登录、签名或鉴权，明确客户端联调验证路径。
