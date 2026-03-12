---
name: deployment-patterns
description: "发布与部署模式：健康检查、回滚、变更分阶段、CI/CD 证据与发布前置条件清单。"
---

# 执行准则

1. 发布是可控实验：必须有监控指标、止损阈值与回滚路径。
2. 变更分阶段：高风险变更用 feature flag / 灰度 / 逐步迁移，禁止一次性硬切。
3. 可观测优先：上线前必须能回答“坏了怎么发现、怎么定位、怎么回退”。
4. 证据驱动放行：review/merge 必须看到构建、测试、平台验收等证据。

## 发布前置条件（最小清单）

- 构建产物可复现（固定依赖版本、构建命令明确）
- 健康检查与 readiness/liveness 明确
- 回滚方式明确（回滚命令/步骤/受影响范围）
- 数据变更有迁移计划（见 `database-migrations`）
- 关键指标基线明确（错误率、延迟、CPU/内存、队列积压、慢查询）

## 常见发布模式

- 蓝绿/金丝雀（优先推荐）
- 分批发布（batch rollout）
- 影子流量/回放（对高风险 API/逻辑变更）

## 输出协议（固定）

```
RELEASE CHECKLIST
=================

Scope:
- ...

Preconditions:
- ...

Rollout:
- ...

Rollback:
- ...

Monitoring:
- metrics:
- alerts:

Evidence:
- build/test/platform reports:
```

