---
name: database-migrations
description: "数据库迁移与回滚策略：DDL/DML 分离、expand/contract、避免锁表、可观测与可逆变更。"
---

# 执行准则

1. 迁移是产品行为：任何 schema/data 变更必须可追踪、可回滚、可观测。
2. DDL/DML 分离：结构变更与数据回填禁止混在同一迁移里。
3. Expand/Contract：生产环境禁止“直接重命名/直接删除”导致瞬时破坏。
4. 避免长锁：任何可能锁表/重写全表的操作都必须给出替代方案。
5. 必须有回滚方案：无法回滚的迁移必须显式标注并提供降级路径。

## 典型安全路径（Expand/Contract）

1. Expand
   - 新增列（nullable 或带默认）
   - 新增索引（尽量并发/在线）
2. Backfill（独立步骤）
   - 分批回填，避免一次性更新全表
3. Dual-read/dual-write
   - 应用同时读写新旧字段（短期）
4. Contract
   - 切换到新字段
   - 删除旧字段/旧索引

## 最小检查清单

- 是否会锁表？是否会重写表？
- 是否需要停机窗口？如果需要，给出窗口与回滚。
- 是否需要并发索引/在线变更？迁移工具是否支持？
- 是否会影响读路径/写路径？是否已准备双写或兼容读取？
- 是否准备了监控指标（错误率/延迟/慢查询/队列积压）？

## 输出协议（固定）

```
MIGRATION PLAN
==============

Goal:
- ...

Steps:
1. Expand: ...
2. Backfill: ...
3. App rollout: ...
4. Contract: ...

Risks:
- ...

Rollback:
- ...

Evidence:
- migration files:
- commands:
- expected metrics:
```

