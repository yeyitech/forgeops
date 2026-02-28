---
name: project-meta-android-copilot
description: "Project-level Android copilot for ForgeOps-managed repos. Use for developer/tester/reviewer work to enforce help-first flow, Android runtime checks, and evidence output."
---

# 适用范围

当前项目类型：`android`。  
用于 Developer / Tester / Reviewer 的项目级协作基线。

# 执行准则

1. 先加载项目上下文，再执行开发操作。
2. 严格执行先读后写、写后回读。
3. 结果统一输出 `Command / Result / Next`。

# Android 最小验收

1. `node .forgeops/tools/platform-preflight.mjs --strict --json`
2. `node .forgeops/tools/platform-smoke.mjs --strict --json`
3. 若存在 Gradle/项目脚本，补充执行最小回归。

# Run 恢复顺序

`forgeops run show <runId>` -> `forgeops run attach <runId>` -> `forgeops run resume <runId>`

# 禁止事项

1. 不跳过失败定位直接重试。
2. 不在未知上下文下直接覆盖 `.forgeops/workflow.yaml`。
