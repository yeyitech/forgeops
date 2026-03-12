---
name: terraform-patterns
description: "Terraform/IaC 模式：state 管理、模块化、计划与审计、最小权限、漂移检测与安全回滚。"
---

# 执行准则

1. `terraform plan` 是证据：任何 apply 必须有对应 plan 与 review 痕迹。
2. state 是生产数据：必须远端存储 + 锁（如 S3+DynamoDB / Terraform Cloud）。
3. 模块化优先：把环境差异放在变量与 workspace/目录分层，避免复制粘贴。
4. 权限最小化：CI 用短期凭据（OIDC/STSes），避免长效 access key。

# 机械检查清单

## State / Backend

- 使用远端 backend，开启 locking。
- state bucket 开启版本控制与加密。

## Plan / Apply

- CI 产生 plan artifact（文本 + JSON，如果可行）。
- apply 受环境闸门保护（比如 GitHub Environments）。

## 变更安全

- 对破坏性变更显式标注（`create_before_destroy`、替换资源等）。
- 输出回滚策略：回退 commit + 重新 apply，或逐步恢复资源。

## 漂移与审计

- 定期 `plan` 检测 drift（无 apply）。
- 关键输出记录：版本、provider、变更摘要。

# 输出协议（固定）

```
TERRAFORM PLAN / REVIEW
======================

Backend/State:
- backend:
- locking:

Modules:
- affected modules:

Changes:
- resources add/change/destroy summary:

Evidence:
- plan artifact:
- policy checks:

Apply Gate:
- environment protection:
- approvals:

Rollback:
- steps:
- risks:
```
