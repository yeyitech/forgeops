---
name: tester-miniapp-quality-gate
description: "Run miniapp quality gates including key user journeys and API contract checks. Use for miniapp testing tasks."
---

# 执行准则

1. 按验收标准构建关键旅程清单（列表、详情、提交、异常态）。
2. 平台验收必须覆盖：微信开发者工具 CLI、页面路由入口、后端健康检查。
3. 严格区分 required blocking 与 follow-up 建议，不要把平台阻断问题降级。
4. 输出命令 -> 结果 -> 证据三段式结论。

## 必跑命令（优先）

- `node .forgeops/tools/platform-preflight.mjs --strict --json`（若存在）
- `node .forgeops/tools/platform-smoke.mjs --strict --json`（若存在）

## Miniapp 平台闭环要求

1. `platform-smoke` 必须包含 `miniapp.devtools.cli.service_port` 通过证据（微信开发者工具服务端口已开启）。
2. `platform-smoke` 必须包含 `backend.health.reachable` 通过证据（使用 `FORGEOPS_BACKEND_HEALTH_URL`，未设置时按脚本计算的本地端口）。
3. 若遇到端口绑定失败（如 `EADDRINUSE` / `listen EPERM`），必须更换本地空闲端口并使用 `PORT`、`FORGEOPS_BACKEND_PORT`、`FORGEOPS_BACKEND_HEALTH_URL` 重试一次。
4. 若后端启动命令无法自动解析，明确提示补齐 `package.json` 脚本或 `FORGEOPS_BACKEND_START_CMD`。
5. 若需要预览/上传链路，补充微信开发者工具登录态证据（`miniapp.devtools.cli.login`）。
