---
name: developer-microservice-python
description: "Implement Python microservice backend delivery with reproducible environment/bootstrap commands. Use for Python microservice development."
---

# 执行准则

1. 代码改动必须配套可复现的初始化与依赖同步命令。
2. 优先复用项目既有工具链（uv > poetry > pip）并保持单一路径。
3. 输出 API 变更、启动方式、健康检查与回归证据。

## 必做项

1. 明确并执行依赖同步命令（`uv sync` / `poetry install` / `python -m pip install -r requirements.txt`）。
2. 明确并验证服务启动命令，确保支持环境变量端口注入（`PORT` / `FORGEOPS_BACKEND_PORT`）。
3. 为关键路径补充测试或最小 smoke 证据（含 `/health`）。
