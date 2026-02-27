---
name: tester-serverless-quality-gate
description: "Run serverless quality gates including deployment-toolchain checks and function smoke evidence. Use for serverless testing."
---

# 执行准则

1. 先验证部署工具链可用，再验证函数运行态证据。
2. 证据必须覆盖“命令-结果-触发输出”三段。
3. 对阻断问题给出可执行修复路径，优先小步自修。

## 必跑命令（优先）

- `node .forgeops/tools/platform-preflight.mjs --strict --json`（若存在）
- `node .forgeops/tools/platform-smoke.mjs --strict --json`（若存在）

## Serverless 平台闭环要求

1. 依赖清单存在（`package.json` / `pyproject.toml` / `requirements*.txt`）。
2. 部署/本地调试工具可解析（如 `serverless`、`sam`、`cdk`、`vercel`、`netlify`）。
3. 至少一条函数入口 smoke 证据可见（HTTP 或事件触发）。
4. 若存在基础设施模板（`serverless.yml`/`template.yaml`/`cdk.json` 等），需完成基本结构校验。
