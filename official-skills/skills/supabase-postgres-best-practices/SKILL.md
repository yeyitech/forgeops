---
name: supabase-postgres-best-practices
description: "Supabase 维护的 Postgres 性能与 RLS 安全最佳实践规则库（含索引、连接池、锁、分页、监控、JSONB 等）。用于设计/实现/审查数据库变更。"
---

# 来源与许可

- Upstream: `supabase/agent-skills`（skill: `supabase-postgres-best-practices`）
- License: MIT（见 `LICENSE.upstream.txt`）
- 说明：本技能携带 `references/*.md` 作为可按需加载的规则库。

# 适用范围

在以下场景启用本技能：

- 你在项目中使用 Postgres（无论是否通过 Supabase）。
- 你需要做性能优化（慢查询、缺索引、N+1、分页性能）。
- 你需要做多租户/权限隔离（RLS、权限、最小授权）。
- 你要做数据库相关评审：索引、锁、连接池、迁移策略等。

# 使用方式（最小加载）

1. 先确定问题域（只选 1-2 个），再打开对应 references 文档，不要一次性全读。
2. 优先使用 CRITICAL 规则：缺索引、连接耗尽、RLS 数据泄漏风险，这些属于阻断项。
3. 每次结论必须给出证据：SQL/EXPLAIN 或具体迁移/索引语句，以及预期收益/风险。

## 规则分类（与 references 前缀对应）

- `query-*`：查询性能（CRITICAL）
- `conn-*`：连接管理/连接池（CRITICAL）
- `security-*`：安全与 RLS（CRITICAL）
- `schema-*`：Schema 设计（HIGH）
- `lock-*`：并发与锁（MEDIUM-HIGH）
- `data-*`：数据访问模式（MEDIUM）
- `monitor-*`：监控与诊断（LOW-MEDIUM）
- `advanced-*`：高级特性（LOW）

## 常用入口（建议先看）

- RLS 基础：`references/security-rls-basics.md`
- RLS 性能：`references/security-rls-performance.md`
- 缺索引：`references/query-missing-indexes.md`
- 索引类型与覆盖索引：`references/query-index-types.md`、`references/query-covering-indexes.md`
- 连接池：`references/conn-pooling.md`
- 分页：`references/data-pagination.md`
- 锁与死锁：`references/lock-deadlock-prevention.md`
- EXPLAIN：`references/monitor-explain-analyze.md`

# 输出协议（固定）

你在实现/评审时需要输出下面结构（文本即可）：

```
DB REVIEW / PLAN
===============

Goal:
- ...

Rules Applied:
- [reference file] -> why

Change:
- SQL / migration / index DDL:
  - ...

Evidence:
- EXPLAIN / metrics / query pattern:
  - ...

Risk:
- lock risk:
- rollback:
- RLS / privilege risk:

Next:
- ...
```

