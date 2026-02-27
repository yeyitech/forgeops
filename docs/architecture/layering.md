# 分层约束

Status: Active
Updated: 2026-02-25

## 允许的依赖方向

`utils/types -> core -> runtime/worker/server/cli -> frontend`

## 规则

- `src/core` 不依赖 `src/runtime`、`src/server`、`src/worker`、`src/cli`、`frontend`。
- `src/runtime` 不依赖 `src/server` 与 `frontend`。
- `src/worker` 仅依赖 `core` 与 `runtime`。
- `src/server` 可依赖 `core` 与 `worker`，不依赖前端内部实现。
- `frontend` 仅通过 API 交互，不直接访问状态文件或 DB。

## 执行计划

- 引入静态 import 边界检查。
- 在 CI 中阻断越层依赖。
- 错误信息必须可教学、可修复。
