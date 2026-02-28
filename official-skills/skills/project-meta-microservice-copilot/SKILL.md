---
name: project-meta-microservice-copilot
description: "Project-level microservice delivery copilot for ForgeOps-managed repos. Use for developer/tester/reviewer work to enforce dependency bootstrap, health checks, run-mode routing, and evidence-first checks."
---

# 适用范围

当前项目类型：`microservice`。  
本技能用于 Developer / Tester / Reviewer 的项目级协作，不替代角色专业技能。

# 执行准则

1. 先读取项目上下文：`AGENTS.md -> docs/00-index.md -> .forgeops/context.md -> .forgeops/governance.md`。
2. 先做只读探测，再做写操作；每次写操作后立即回读确认。
3. 结论必须附运行证据，尤其是依赖同步、服务启动与健康检查证据。

# 渐进式披露流程

1. 命令面探测：`forgeops help`、`forgeops project list`、`forgeops doctor --json`。
2. 依任务进入 run/workflow/scheduler/skill 子域，不提前注入长命令串。
3. 故障优先定位再恢复：`run show -> run attach -> run resume`。

# Microservice 交付矩阵（最小必跑）

1. 平台预检查：`node .forgeops/tools/platform-preflight.mjs --strict --json`
2. 平台 smoke：`node .forgeops/tools/platform-smoke.mjs --strict --json`
3. 依赖同步优先级：`uv` > `poetry` > `pip`（保持单一路径，不混用）。
4. 必须验证服务健康端点（如 `/health`）或项目定义等价检查。

# Run Mode 路由

1. `quick`：低风险修复、局部实现、无跨模块契约变化。
2. `standard`：API/数据契约变更、依赖升级、基础设施变更、需完整回归。

# 输出协议

每次关键动作后输出三行：

1. `Command`: 执行命令
2. `Result`: 关键结果（status/id/error/evidence）
3. `Next`: 下一步或停止条件

# 禁止事项

1. 不在同一变更中混用多套依赖管理命令。
2. 不缺失健康检查证据就给出“可合并”结论。
3. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
