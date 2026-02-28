# 平台工具链预检查与 Platform Gate 设计

Status: Active
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

## 背景与问题

在当前流水线中，`test` 步骤主要依赖仓库内可见的 `typecheck/test/invariants/docs` 命令。
这会导致一个典型 gap：

- 流水线可“自动通过”
- 但真实产品平台（微信小程序开发者工具、浏览器运行态、iOS 模拟器）仍可能失败

该问题本质上不是模型能力不足，而是 harness 缺少“平台运行态验证”这一层机械约束。

## 目标

1. 在项目初始化阶段，按产品类型执行工具链 preflight，提前暴露环境缺口。
2. 在默认工作流中将平台验收并入 `test` 闸门，强制平台验收证据进入流水线。
3. 把 run 状态拆分为 `CI Gate` 与 `Platform Gate`，避免“单一通过状态”掩盖风险。
4. 升级模板技能，使 tester/reviewer/developer 拥有可执行命令与证据产物约束，而非仅原则描述。

## 设计决策

## 1) Product Toolchain Preflight（初始化阶段）

- 新增核心模块：`src/core/platform-toolchain.js`
- 按产品类型执行 required checks：
  - miniapp：`node`、`npm`、微信开发者工具 CLI 可定位且可执行、微信开发者工具服务端口开启
  - web：`node`、`npm`（浏览器 DevTools 能力为 optional）
  - ios：`xcodebuild`、`xcrun`、`simctl`、macOS 平台
  - microservice：`python3/python`、`uv/poetry/pip`（至少一个依赖管理器可用）
  - android：`java`、`sdkmanager/adb`（至少一个 SDK 工具可用）
  - serverless：运行时命令（node/python）+ 依赖管理器 + 部署/本地仿真 CLI
- 初始化入口：
  - CLI：`forgeops project init`
  - API/UI：`POST /api/projects`
- 失败策略：required check 失败即阻断初始化，返回明确错误与 hint。

## 2) 项目级平台脚本（可执行契约）

项目初始化新增两个脚本：

- `.forgeops/tools/platform-preflight.mjs`
  - 负责产品类型工具链准备度检查
  - 支持 `--strict --json`
- `.forgeops/tools/platform-smoke.mjs`
  - 负责产品平台验收 smoke（例如 miniapp 页面入口、微信 CLI 运行态与后端健康检查）
  - 支持 `--strict --json`

当前 miniapp smoke 的 required gate 包括：

- `miniapp.devtools.cli.service_port`（服务端口开启）
- `backend.start.command`（后端启动命令可解析）
- `backend.health.reachable`（后端健康检查可达，默认使用 run 级隔离端口并探测 `/health`）

这两个脚本作为 tester 角色的确定性执行入口，减少“自由发挥”导致的验证漂移。

## 3) 默认 Workflow 将平台验收并入 `test`

默认顺序保持：

`architect -> issue -> implement -> test -> review -> cleanup`

设计意图：

- `test`：同时覆盖代码/契约验证（CI Gate）与平台运行态验证（Platform Gate）
- `platform-smoke`：仅作为历史配置兼容别名，解析时会映射到 `test`（不再作为独立步骤执行）
- `review`：在闸门结论基础上做合并决策

## 4) Run 双闸门状态模型

后端在 run 聚合信息中新增：

- `quality_gates.ci`
- `quality_gates.platform`
- `quality_gates.overall`

状态机取值：

- `passed | failed | running | pending | not_configured | skipped`

前端在“运行列表 / 项目概览 / run 详情”展示双闸门状态，降低“总状态绿色但平台未验收”的认知误差。

## 5) 技能模板升级策略

模板技能不再只描述原则，改为“原则 + 必跑命令 + 证据要求”：

- tester（miniapp/web/ios/microservice/android/serverless）要求执行平台脚本并输出证据摘要
- reviewer（miniapp/web/ios/microservice/android/serverless）要求按产品类型核对平台证据，不满足即阻断
- developer（尤其 miniapp/web/microservice/android/serverless）补充运行态与验收证据要求

目标是提升产物品味与可验收性，同时保持可执行性。

## 验收标准

1. 初始化时若缺少产品类型必需工具链，必须阻断并给出明确失败原因。
2. 新建项目默认 workflow 必须在 `test` 步骤产出平台验收证据（可选增加独立 `platform-smoke` 节点）。
3. run 列表与 run 详情可见 `CI Gate` 与 `Platform Gate` 双状态。
4. tester/reviewer 模板技能中可见平台脚本命令与证据要求。
5. 文档索引（`AGENTS.md` + `docs/00-index.md`）包含本设计文档引用。

## 非目标

- 本阶段不引入平台真机农场（cloud device farm）调度。
- 本阶段不强制所有仓库接入完整 e2e 框架（如 Playwright/XCUITest），但保留演进入口。
