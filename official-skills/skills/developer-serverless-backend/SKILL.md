---
name: developer-serverless-backend
description: "Implement serverless backend functions with reproducible build/deploy-preflight evidence. Use for serverless development."
---

# 执行准则

1. 代码改动必须包含函数触发与执行路径验证证据。
2. 优先复用项目现有框架（Serverless/SAM/CDK/Vercel/Netlify），不混用多套部署链。
3. 输出部署前检查结果与环境变量变更说明。

## 必做项

1. 明确并执行依赖安装与构建命令。
2. 提供至少一条本地 invoke/smoke 证据（HTTP 或事件触发）。
3. 若涉及权限/IAM 变更，给出最小权限说明与风险提示。
