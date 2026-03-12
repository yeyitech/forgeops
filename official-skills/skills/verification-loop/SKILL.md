---
name: verification-loop
description: "交付验证闭环：平台预检/验收 + 项目构建测试 + 不变量与文档闸门 + diff 审计，输出可复现的证据报告。"
---

# 执行准则

1. 先平台后项目：优先跑 `.forgeops/tools/platform-preflight.mjs` 与 `platform-smoke.mjs`（若存在）。
2. 失败即停：任何关键闸门失败必须先定位 root cause，再继续。
3. 证据可复现：报告必须包含“命令 + 关键输出片段 + 结论”。
4. 不跑空验收：如果项目有自己的 `package.json` 脚本，必须补跑项目自有命令。

## 最小必跑清单（按顺序）

1. 平台预检查（若存在）
   - `node .forgeops/tools/platform-preflight.mjs --strict --json`
2. 平台验收（若存在）
   - `node .forgeops/tools/platform-smoke.mjs --strict --json`
3. 项目自有验证（存在则跑）
   - `npm run build`
   - `npm test`
   - `npm run check`
4. 不变量检查（若存在）
   - `node .forgeops/tools/check-invariants.mjs --format json`
5. 文档闸门（本次涉及 docs/ 或 markdown 时强制跑）
   - `node scripts/check-doc-freshness.js`
   - `node scripts/check-doc-structure.js`
6. Diff 审计
   - `git diff --stat`
   - `git diff`

## 报告格式（固定）

```
VERIFICATION REPORT
==================

platform-preflight: PASS|FAIL  (evidence: ...)
platform-smoke:     PASS|FAIL  (evidence: ...)
build:              PASS|FAIL  (evidence: ...)
tests:              PASS|FAIL  (evidence: ...)
check:              PASS|FAIL  (evidence: ...)
invariants:         PASS|FAIL  (evidence: ...)
docs:               PASS|FAIL  (evidence: ...)
diff-review:        PASS|FAIL  (files: N)

Blockers:
1. ...

Next:
- ...
```

