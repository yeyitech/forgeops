---
name: tester-ios-quality-gate
description: "Run iOS quality gates including XCTest, simulator diagnostics, and release risk checks. Use for iOS testing tasks."
---

# 执行准则

1. 按验收标准构建回归清单并区分阻塞风险。
2. 先机械化脚本，再少量探索验证。
3. 输出命令 -> 结果 -> 证据三段式结论。

## 必跑命令（优先）

- `node .forgeops/tools/platform-preflight.mjs --strict --json`（若存在）
- `node .forgeops/tools/platform-smoke.mjs --strict --json`（若存在）
- `xcodebuild -version`
- `xcrun simctl list devices`
