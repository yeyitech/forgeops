# 文档新鲜度策略

Status: Active
Updated: 2026-02-25

## 规则

- `docs/` 下每个文档前部必须包含 `Updated: YYYY-MM-DD`。
- 活跃领域文档超过 45 天未更新，视为 stale。
- 文档重命名/移动必须同 PR 更新 AGENTS 索引。

## 节奏

- 每周：快速 stale 扫描
- 每月：架构与质量文档复核

## 检查命令

```bash
node scripts/check-doc-freshness.js
node scripts/check-doc-structure.js
```
