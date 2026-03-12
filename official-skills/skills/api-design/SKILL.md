---
name: api-design
description: "REST API 设计规范：资源命名、状态码、分页、错误结构、幂等与版本策略。用于写 issue 验收与实现契约。"
---

# 执行准则

1. 契约先行：先写清请求/响应/错误，再写实现。
2. 语义化状态码：用 HTTP status 表达结果，不用 200 包一切。
3. 错误可定位：错误响应必须可被机器与人同时消费（code/message/details）。
4. 兼容性优先：新增字段向后兼容；破坏性变更必须版本化或分阶段迁移。

## 最小规范

### 资源与路径

- 资源用名词复数：`/api/v1/users`
- 子资源表达归属：`/api/v1/users/{id}/orders`
- 动作用动词但要克制：`/api/v1/orders/{id}/cancel`

### 状态码（常用）

- `200` 成功（有 body）
- `201` 创建成功（建议带 Location）
- `204` 成功（无 body）
- `400/422` 参数/语义校验失败
- `401/403` 鉴权/授权失败
- `404` 资源不存在
- `409` 冲突（幂等/状态冲突）
- `429` 限流
- `500` 未预期错误（不泄漏内部细节）

### 错误结构（推荐）

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "details": [
      { "field": "email", "message": "invalid_format" }
    ]
  }
}
```

### 分页（至少支持一种）

- offset：`page/per_page`
- cursor：`cursor/limit`（大数据量推荐）

## Issue 验收模板（可直接复用）

- Endpoint: `METHOD /path`
- Request:
  - params/query/body schema
- Response:
  - success shape
  - error shapes（至少列 2 个：校验失败、未授权/无权限）
- Semantics:
  - idempotent? rate limit?
- Evidence:
  - curl 示例
  - 测试用例位置

