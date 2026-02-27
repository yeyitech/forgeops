---
name: tester-web-quality-gate
description: "Run web quality gates including functional, regression, and browser diagnostics checks. Use for web testing tasks."
---

# 执行准则

1. 按验收标准构建回归清单，并标注风险等级。
2. 优先执行自动化脚本，再做浏览器运行态复核。
3. 输出命令 -> 结果 -> 证据三段式结论。

## 必跑命令（优先）

- `node .forgeops/tools/platform-preflight.mjs --strict --json`（若存在）
- `node .forgeops/tools/platform-smoke.mjs --strict --json`（若存在）
