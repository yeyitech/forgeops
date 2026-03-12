---
name: gitops-argocd
description: "GitOps/Argo CD 模式：声明式发布、同步策略、漂移控制、回滚、应用编排与多环境治理。"
---

# 执行准则

1. Git 是唯一事实来源：集群状态应由 Git 声明驱动，手工改集群视为 drift。
2. 分环境治理：dev/staging/prod 分离，发布权限与策略分离。
3. 回滚要快：回滚等价于回退 Git revision 并触发同步。
4. 漂移可见：开启 drift 检测并把 drift 作为阻断项。

# 机械检查清单

## 应用定义

- Application / ApplicationSet 定义清晰：source(repo/path/targetRevision) 与 destination(server/namespace)。
- sync policy 明确：自动/手动，是否 `prune`，是否 `selfHeal`。

## 安全与权限

- Argo CD RBAC 最小化：按项目/应用分权。
- 生产环境建议使用审批闸门（人审或策略）。

## 发布与回滚

- 发布证据：同步前后的 revision、健康状态、资源 diff。
- 回滚步骤：回退 Git revision -> Argo sync -> 健康验证。

# 输出协议（固定）

```
GITOPS / ARGOCD PLAN
===================

Apps:
- app/appset:
- env:

Sync Policy:
- auto/manual:
- prune:
- selfHeal:

Evidence:
- revision:
- health:
- diff:

Rollback:
- revert commit:
- sync:
- verify:

RBAC:
- roles:
- constraints:
```
