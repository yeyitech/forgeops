---
name: tester-microservice-quality-gate
description: "Run Python microservice quality gates including dependency bootstrap and health smoke checks. Use for microservice testing."
---

# 执行准则

1. 先验证工具链与依赖同步，再验证服务可运行性。
2. 证据必须覆盖“命令-结果-健康检查”三段，不接受口头结论。
3. 对阻断问题给出可执行修复路径，优先小步自修。

## 必跑命令（优先）

- `node .forgeops/tools/platform-preflight.mjs --strict --json`（若存在）
- `node .forgeops/tools/platform-smoke.mjs --strict --json`（若存在）

## Microservice 平台闭环要求

1. 依赖清单存在且可解析（`pyproject.toml` 或 `requirements*.txt`）。
2. 依赖同步命令可解析（`uv sync` / `poetry install` / `pip install -r ...`）。
3. 服务启动命令可解析（优先项目约定命令，其次环境变量注入）。
4. 健康检查证据必须可见（`/health` 或项目定义健康端点）。
