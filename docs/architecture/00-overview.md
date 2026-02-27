# 架构总览

Status: Active
Updated: 2026-02-26

## 范围

ForgeOps 负责“多步骤 AI 研发流水线”的控制与观测，强调：

- 运行时可替换
- 状态可追踪
- 失败可恢复

## 核心执行循环

1. 服务启动时执行强 precheck（git/gh 身份与开发凭据、codex runtime 可用性）。
2. 项目初始化时执行产品类型工具链 precheck（miniapp/web/ios/microservice/android/serverless）。
3. CLI/API 创建 run。
4. 创建 run 时读取项目级工作流配置（`<projectRoot>/.forgeops/workflow.yaml`）。
5. 创建 run 时注入项目上下文（`context.md` + `project.yaml` + `agent-skills.json` + `governance.md` + `invariants.json`）。
6. 创建 run 前执行 GitHub 强约束校验（git 仓库、git 身份已配置、origin=GitHub、gh 已登录）。
7. 为 run 创建独立 worktree（`<repo>/.forgeops/worktrees/<runId>`）与分支（`forgeops/<runId>`）。
8. Worker 按 DAG 依赖认领所有可执行 pending step（可并发）。
9. Runtime Adapter 在 run worktree 中执行 step，按统一解析器加载角色技能（优先级：project-local > user-global > official）。
10. `issue` 步骤会把需求升级为结构化 issue，并在信息缺失时补齐假设与偏好信号（写入 step outputs / artifacts）。
11. `cleanup` 步骤可产出技能候选并落盘到项目目录（`.forgeops/skills/candidates/`）以支持本地方法论沉淀。
12. `implement/test/review` 完成后自动执行不变量检查器（机械 gate，若配置了 `platform-smoke` 也会执行）。
13. 不变量 `error` 触发阻塞重试；`warn` 默认不阻塞，并在 `review` 步骤自动创建 follow-up GitHub issue。
14. Scheduler 读取 `<projectRoot>/.forgeops/scheduler.yaml`，按 Cron 周期同时托管 cleanup 与 issueAutoRun（按 GitHub label 触发 run）；cleanup 支持 `lite|deep`，其中定时默认 `deep`（单节点 cleanup 工作流）。
15. Store 推进 step/run 状态并记录事件与产物，同时聚合 `CI Gate` / `Platform Gate` 状态。
16. API + SSE 实时供前端展示；同时支持通过 `attach-terminal` 旁观指定 run/step/session 的 Codex thread（只读观测语义）。
17. 技能候选晋升走独立 PR 链路（CLI/API 手动触发 + 独立 worktree + draft PR 人审），不进入默认需求交付 DAG。
18. user-global 技能库固定在 `$FORGEOPS_HOME/skills-global`，通过独立 PR + `audit.ndjson` 做跨项目审计与沉淀。

默认交付步骤（线性示例）：

1. architect
2. issue
3. implement
4. test
5. review
6. cleanup（Garbage Collection）

## 组件划分

- 状态存储：`src/core/store.js`
- 工作流定义：`src/core/workflow.js`
- 运行时适配器：`src/runtime/*`
- 调度引擎：`src/worker/engine.js`
- 服务接口：`src/server/app.js`
- 仪表盘：`frontend/src/*`

## v1 非目标

- 多运行时智能调度优化
- 分布式 worker 集群
- 全自动发布流水线
