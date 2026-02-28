---
name: project-meta-serverless-copilot
description: "Project-level serverless copilot for ForgeOps-managed repos. Use for developer/tester/reviewer work to enforce help-first flow, serverless runtime checks, and evidence output."
---

# 适用范围

当前项目类型：`serverless`。  
用于 Developer / Tester / Reviewer 的项目级协作基线。

# 执行准则

1. 先读项目上下文，再执行任何变更。
2. 先探测后写入，写后立即回读确认。
3. 必须提供可运行证据与下一步决策。

# Serverless 最小验收

1. `node .forgeops/tools/platform-preflight.mjs --strict --json`
2. `node .forgeops/tools/platform-smoke.mjs --strict --json`
3. 若涉及部署/函数命令，必须记录关键输出与失败点。

# Run 模式

1. `quick`：局部逻辑与脚本调整。
2. `standard`：函数契约/部署配置/基础设施变更。

# 禁止事项

1. 不缺少运行态 smoke 证据就判定完成。
2. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
