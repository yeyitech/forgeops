---
name: project-meta-miniapp-copilot
description: "Project-level miniapp copilot for ForgeOps-managed repos. Use for developer/tester/reviewer work to enforce help-first flow, miniapp runtime checks, and evidence output."
---

# 适用范围

当前项目类型：`miniapp`。  
用于 Developer / Tester / Reviewer 的项目级协作基线。

# 执行准则

1. 先读项目上下文：`AGENTS.md -> docs/00-index.md -> .forgeops/context.md -> .forgeops/governance.md`。
2. 先读后写：先 `show/list/status`，再 `create/set/resume`。
3. 写后回读：每次变更后立即 `show/list` 验证。
4. 输出统一三段：`Command / Result / Next`。

# Miniapp 最小验收

1. `node .forgeops/tools/platform-preflight.mjs --strict --json`
2. `node .forgeops/tools/platform-smoke.mjs --strict --json`
3. 若有项目脚本，补充执行最小回归（如 `npm run test` / `npm run lint`）。

# Run 恢复顺序

`forgeops run show <runId>` -> `forgeops run attach <runId>` -> `forgeops run resume <runId>`

# 禁止事项

1. 不跳过 `run show` 直接重复 `run resume`。
2. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
