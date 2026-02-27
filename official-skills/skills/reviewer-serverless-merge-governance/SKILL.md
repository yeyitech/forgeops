---
name: reviewer-serverless-merge-governance
description: "Review serverless merge readiness with deployment evidence and runtime safety gates. Use for serverless PR review."
---

# 执行准则

1. 优先判定“可部署、可验证、权限可控”，再评估实现细节。
2. 审查结论必须绑定 test 阶段证据，不接受主观推断。
3. 缺平台证据时直接阻断，避免带病合并。

## 必查证据

1. `platform-preflight` 中依赖与部署工具链检查结果。
2. `platform-smoke` 中函数触发 smoke 或本地 invoke 证据。
3. 若涉及 IaC/权限变更，需有权限影响面和风险说明。
4. 若涉及事件重试/死信队列，需有可观测性或失败处理说明。

## 审查结论规则

1. 任一 required 运行态证据缺失时，返回阻断结论（补证据后重试）。
2. 高严重度风险（正确性/安全性/数据损坏）阻断合并。
3. 低严重度问题转 follow-up issue，不长期阻塞主线。
