# 文档结构策略

Status: Active
Updated: 2026-02-25

## 目标

让仓库知识库保持可导航、可验证、可维护，避免回退为单体手册。

## 规则

- 必须有 docs 总索引：`docs/00-index.md`。
- 文档移动/重命名必须同步更新 `AGENTS.md` 与 `docs/00-index.md`。
- 核心文档必须能从地图入口被找到（索引覆盖）。
- 执行计划目录必须存在：
  - `docs/exec-plans/active/`
  - `docs/exec-plans/completed/`
- 技术债必须有持续记录文件：`docs/exec-plans/tech-debt-tracker.md`。

## 检查命令

```bash
node scripts/check-doc-structure.js
```
