---
name: project-meta-generic-copilot
description: "Project-level generic delivery copilot for ForgeOps-managed repos. Use for developer/tester/reviewer work to enforce help-first discovery, run recovery order, and evidence output."
---

# 适用范围

用于非 `web/microservice` 的项目类型，作为项目级协作基线技能。

# 执行准则

1. 先读项目上下文，再执行改动。
2. 先做只读探测（`help/show/list/status`），再做写操作。
3. 每次写操作后必须回读确认是否生效。

# 最小命令集

1. `forgeops help`
2. `forgeops doctor --json`
3. `forgeops run show <runId>`
4. `forgeops run attach <runId>`
5. `forgeops run resume <runId>`

# 输出协议

每次关键动作后输出三行：

1. `Command`: 执行命令
2. `Result`: 关键结果（status/id/error/evidence）
3. `Next`: 下一步或停止条件

# 禁止事项

1. 不跳过 `run show` 直接连续 `run resume`。
2. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
