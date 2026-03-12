---
name: kubernetes-patterns
description: "Kubernetes 部署与运维模式：探针/资源/滚动发布/配置与密钥/RBAC/可观测与回滚，适用于设计、实现与评审。"
---

# 执行准则

1. 以回滚为前提设计 rollout：任何 Deployment 变更都要有可控回退路径。
2. 资源与探针是最低成本稳定性杠杆：没有 `resources`/`readinessProbe` 的服务默认不允许上线。
3. 配置与密钥外置：配置进 ConfigMap，密钥进 Secret 或外部 secret manager。
4. 可观测先行：指标/日志/追踪至少覆盖错误率、延迟、饱和度、重启率。

# 机械检查清单

## Deployment/Pod

- `readinessProbe` 与 `livenessProbe` 明确，避免假活。
- `resources.requests/limits` 设置合理范围。
- `securityContext` 尽量非 root，`readOnlyRootFilesystem`（可行时）。
- `terminationGracePeriodSeconds` 与 `preStop`（如需要）明确。

## 发布与回滚

- `strategy: RollingUpdate` 并设置 `maxUnavailable`/`maxSurge`。
- 关键服务建议 `PodDisruptionBudget`。
- 变更前后提供回滚命令：`kubectl rollout undo` 或回退 Helm release。

## 配置/密钥

- Config 与 Secret 不要混用；禁止把 secret 写进 ConfigMap。
- 避免把 secret 写进镜像或仓库。

## 权限

- RBAC 最小授权（service account 按 namespace/资源粒度）。

# 输出协议（固定）

```
K8S REVIEW / PLAN
================

Workload:
- kind/name/namespace:

Probes:
- readiness:
- liveness:

Resources:
- requests:
- limits:

Rollout:
- strategy:
- rollback:

Config:
- configmap:
- secrets:

Security:
- serviceAccount/RBAC:
- securityContext:

Evidence:
- kubectl diff/apply output:
- rollout status:
- metrics/alerts:
```
