---
name: project-meta-ios-copilot
description: "Project-level iOS copilot for ForgeOps-managed repos. Use for developer/tester/reviewer work to enforce help-first flow, iOS runtime checks, and evidence output."
---

# 适用范围

当前项目类型：`ios`。  
用于 Developer / Tester / Reviewer 的项目级协作基线。

# 执行准则

1. 优先读取上下文与治理约束，再开始改动。
2. 所有操作遵循“先探测后执行、执行后回读”。
3. 输出必须包含命令与可验证证据，不做主观结论。

# iOS 最小验收

1. `node .forgeops/tools/platform-preflight.mjs --strict --json`
2. `node .forgeops/tools/platform-smoke.mjs --strict --json`
3. 若项目定义了构建/测试命令，补充执行并记录结果。

# Run 模式

1. `quick`：低风险小改动。
2. `standard`：跨模块改造、工具链变更、需完整回归。

# 禁止事项

1. 不缺失运行证据就给出“可合并”。
2. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
