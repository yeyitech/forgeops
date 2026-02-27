---
name: reviewer-android-merge-governance
description: "Review Android merge readiness with build/runtime evidence gates and compatibility checks. Use for Android PR review."
---

# 执行准则

1. 优先判定“可构建、可验证、可回滚”，再评估代码细节。
2. 审查结论必须绑定 test 阶段证据，不接受主观推断。
3. 缺平台证据时直接阻断，避免带病合并。

## 必查证据

1. `platform-preflight` 中 Java/Gradle 工具链检查结果。
2. `platform-smoke` 中 Android 工程结构与构建命令检查结果。
3. 测试或 smoke 执行证据（含失败原因与重试结果）。
4. 若涉及 API 契约变更，需有 Android 端兼容性说明。

## 审查结论规则

1. 任一 required 运行态证据缺失时，返回阻断结论（补证据后重试）。
2. 高严重度风险（正确性/安全性/数据损坏）阻断合并。
3. 低严重度问题转 follow-up issue，不长期阻塞主线。
