---
name: project-meta-web-copilot
description: "Project-level web delivery copilot for ForgeOps-managed repos. Use for developer/tester/reviewer work to enforce project runtime commands, run-mode routing, and evidence-first checks."
---

# 适用范围

当前项目类型：`web`。  
本技能用于 Developer / Tester / Reviewer 的项目级协作，不替代角色专业技能。

# 执行准则

1. 先确认项目上下文，再执行命令：`AGENTS.md -> docs/00-index.md -> .forgeops/context.md -> .forgeops/governance.md`。
2. 所有执行遵循“先读后写”：先 `show/list/status`，再 `create/set/resume`。
3. 结果必须提供证据：命令、关键输出、失败点或验证结论。

# 渐进式披露流程

1. 先跑命令面探测：`forgeops help`、`forgeops project list`、`forgeops doctor --json`。
2. 再按任务进入子域（run/workflow/scheduler/skill），一次只引入当前任务必需命令。
3. 写操作后必须回读确认生效（`show/list`）。

# Web 交付矩阵（最小必跑）

1. 平台预检查：`node .forgeops/tools/platform-preflight.mjs --strict --json`
2. 平台 smoke：`node .forgeops/tools/platform-smoke.mjs --strict --json`
3. 若项目存在 `package.json`，优先补充并执行项目自有命令（如 `npm run test` / `npm run lint` / `npm run build`）。
4. 若 smoke 失败，先定位失败环节，再决定是否恢复 run，不允许盲目重跑。

# Run Mode 路由

1. `quick`：小范围修复、文档修订、低风险增量。
2. `standard`：跨模块改动、架构调整、工具链/配置变更、需完整回归。

# 输出协议

每次关键动作后输出三行：

1. `Command`: 执行命令
2. `Result`: 关键结果（status/id/error/evidence）
3. `Next`: 下一步或停止条件

# 禁止事项

1. 不跳过 `run show` 直接连续 `run resume`。
2. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
3. 不把一次性 issue 临时信息沉淀为长期技能规则。
