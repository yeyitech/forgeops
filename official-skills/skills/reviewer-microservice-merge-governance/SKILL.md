---
name: reviewer-microservice-merge-governance
description: "Review Python microservice merge readiness with dependency/bootstrap and runtime evidence gates. Use for microservice PR review."
---

# 执行准则

1. 优先判定“可运行性与可复现性”，再评估代码细节。
2. 审查结论必须绑定 test 阶段证据，不接受主观推断。
3. 缺平台证据时直接阻断，避免带病合并。

## 必查证据

1. `platform-preflight` 中 Python 工具链与依赖管理器检查结果。
2. `platform-smoke` 中依赖同步命令与服务启动命令检查结果。
3. 健康检查证据（`/health` 或项目定义健康端点）。
4. 若依赖升级，需有回归验证与风险说明。

## 审查结论规则

1. 任一 required 运行态证据缺失时，返回阻断结论（要求补证据后重试）。
2. 高严重度风险（正确性/安全性/数据损坏）阻断合并。
3. 低严重度问题转 follow-up issue，不长期阻塞主线。
