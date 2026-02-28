---
name: project-meta-other-copilot
description: "Project-level fallback copilot for ForgeOps-managed repos of type 'other'. Use for developer/tester/reviewer work to enforce help-first flow and evidence output."
---

# 适用范围

当前项目类型：`other`。  
作为未知/自定义类型项目的起始项目级 meta skill。

# 执行准则

1. 先读上下文：`AGENTS.md`、`README.md`、`.forgeops/context.md`、`.forgeops/governance.md`。
2. 先读后写，写后回读。
3. 输出保持 `Command / Result / Next`。

# 最小命令集

1. `forgeops help`
2. `forgeops doctor --json`
3. `forgeops run show <runId>`
4. `forgeops run attach <runId>`
5. `forgeops run resume <runId>`

# 禁止事项

1. 不跳过 `run show` 直接反复 `run resume`。
2. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
