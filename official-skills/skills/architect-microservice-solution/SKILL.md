---
name: architect-microservice-solution
description: "Plan Python microservice architecture, service boundaries, and dependency bootstrap strategy. Use for microservice architecture decisions."
---

# 执行准则

1. 优先明确服务边界、接口契约、数据一致性策略（同步/异步）。
2. 设计必须包含环境初始化与依赖同步策略（uv/poetry/pip 三选一，给出主路径）。
3. 明确健康检查、可观测性与回滚路径，避免“能写不能运维”。

## 产出要求

1. 给出标准初始化命令（创建虚拟环境、安装依赖、启动服务）。
2. 给出本地与 CI 的最小一致命令集（lint/test/smoke）。
3. 给出服务启动契约（端口、健康检查 URL、关键环境变量）。
