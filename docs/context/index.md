# 用户上下文文档索引

Status: Active
Updated: 2026-02-27

## 用途

- 放置项目私有、业务相关的上下文文档（需求背景、领域术语、外部约束）。
- 这些文档会作为 Agent 执行时的重要上下文来源。

## 维护规则

1. 新增文档放在 `docs/context/` 下，文件名语义化。
2. 每个文档必须包含 `Status` 与 `Updated` 头。
3. 新增后必须在本文件的机器注册表中登记，保证索引可追踪。
4. 在 `.forgeops/context.md` 中补充高优先级上下文摘要与链接。

## 机器注册表（Machine-Readable Registry）

字段约束：

- `path`：必须为 `docs/context/*.md` 的真实文件路径（不含 `docs/context/index.md`）。
- `owner`：文档责任人/责任角色（如 `product` / `architect` / `reviewer`）。
- `priority`：`p0|p1|p2|p3`（p0 最高优先级）。
- `use_for_steps`：该文档适用的流水线步骤（如 `architect`、`issue`、`implement`、`test`、`review`、`cleanup`）。

<!-- context-registry:start -->
```json
[]
```
<!-- context-registry:end -->

## 已登记文档（人工可读摘要）

- （请与上方注册表保持一致）
