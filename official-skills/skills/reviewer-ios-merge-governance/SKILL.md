---
name: reviewer-ios-merge-governance
description: "Review iOS merge readiness with simulator/toolchain evidence gate. Use for iOS PR review and merge decisions."
---

# 执行准则

1. 先判定 iOS 运行链路是否可复现，再评估代码质量细节。
2. 审查结论必须绑定命令证据与输出摘要。
3. 明确发布风险与回滚策略，不给模糊建议。

## 必查证据

1. `platform-preflight` 结果（`xcodebuild`、`xcrun`、`simctl` 可用性）。
2. `platform-smoke` 结果（iOS 平台 required gate 通过情况）。
3. `xcodebuild -version` 输出证据。
4. `xcrun simctl list devices` 输出证据。
5. 若涉及构建/模拟器运行，需提供对应成功或失败日志摘要。

## 审查结论规则

1. 工具链或模拟器证据缺失时，直接阻断并要求补齐。
2. 高严重度风险（正确性/安全性/数据损坏）阻断合并。
3. 低严重度问题转 follow-up issue，不长期阻塞主线。
