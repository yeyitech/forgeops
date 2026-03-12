---
name: github-actions-cicd
description: "GitHub Actions CI/CD 机械约束：workflow 结构、缓存与制品、环境保护、最小权限、OIDC、可审计证据与可回滚发布。"
---

# 执行准则

1. CI 结果必须可审计：每次合入/发布都要能回放证据（日志、制品、报告）。
2. 最小权限：默认只给 `GITHUB_TOKEN` 读权限；写权限按 job 局部提升。
3. 发布必须可回滚：发布 job 输出回滚指令、回滚窗口与“止损阈值”。
4. 分层：CI(构建/测试) 与 CD(发布) 分离，CD 使用 `environment` 保护与人工/策略闸门。

# 最小检查清单（机械）

## Workflow 结构

- `on: pull_request` 跑 CI（lint/test/build），`on: push` 或 `workflow_dispatch` 跑发布。
- 对外部 PR：不要在 `pull_request_target` 里执行不可信代码。
- 使用 `concurrency` 防止同分支并发重复发布。

## 缓存与制品

- Node/PNPM: `actions/setup-node` + cache；Python: `actions/setup-python`；Go: `actions/setup-go`。
- 关键产物用 `actions/upload-artifact` 保存（测试报告、覆盖率、构建产物、SBOM）。

## 环境与密钥

- 使用 GitHub Environments 管控：`environment: production` 并开启 required reviewers。
- 密钥只通过 `secrets.*` 注入，禁止回显。

## 权限与供应链安全

- 明确 `permissions:`（默认 `contents: read`）。
- 尽量用 OIDC（`id-token: write`）替代长生命周期云凭据。
- 固定第三方 Action 版本到 commit SHA（高风险场景）。

# 输出协议（固定）

在设计/评审 CI/CD 变更时，输出：

```
CI/CD PLAN
==========

Workflow(s):
- .github/workflows/<name>.yml

Triggers:
- PR:
- Release:

Gates:
- required checks:
- environment protection:

Evidence:
- artifacts:
- reports:

Rollback:
- command/steps:
- safe window:

Security:
- permissions:
- secrets:
- OIDC:
```
