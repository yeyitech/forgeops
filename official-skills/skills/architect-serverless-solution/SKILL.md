---
name: architect-serverless-solution
description: "Plan serverless backend architecture, event boundaries, and deployment guardrails. Use for serverless solution design."
---

# 执行准则

1. 明确函数边界、触发源（HTTP/Queue/Cron）与幂等策略。
2. 设计需覆盖部署契约（IaC 模板、环境变量、权限最小化）。
3. 先定义可验证路径（本地 invoke/smoke），再扩展到生产发布。

## 产出要求

1. 给出函数/资源拓扑与依赖关系（入口、存储、消息队列）。
2. 给出最小命令链（依赖安装、构建、验证、部署前检查）。
3. 给出失败回滚与成本风险控制策略（并发、超时、重试）。
