# ForgeOps 核心概念（中文）

Status: Active
Updated: 2026-02-28

## 目的

本文件是 ForgeOps 根目录下的中文核心概念总览，用于统一团队对系统本质的理解。
它记录三件事：

1. 当前已实现的概念（实现真相）。
2. 这些概念之间的关系与边界。
3. 哪些概念属于愿景层（非计划、非排期承诺）。

本文件是“概念地图”，不是完整 API/CLI 手册。

## 范围

- 包含：控制平面概念、数据模型、执行主循环、运行时抽象、治理与技能演进链路。
- 不包含：完整 API 参数细节、完整 CLI 参数细节、前端交互细节。

## 1) 系统身份

ForgeOps 是 AI 研发流程的控制平面（Control Plane）。
核心价值是：用可观测、可约束、可恢复的方式编排多步骤交付。

概念锚点：
- `docs/architecture/00-overview.md`
- `docs/runtime-adapter-design.md`
- `docs/harness-engineering-guidelines.md`

## 2) 一级领域对象

| 概念 | 定义 | 主要存储/来源 |
| --- | --- | --- |
| `Project` | 被 ForgeOps 托管的仓库根目录及其产品元信息。 | `projects` 表（`src/core/store.js`） |
| `Issue` | GitHub 需求入口，驱动 run 创建。 | GitHub + run 中的 `github_issue_id` |
| `Run` | 一次流程执行实例（属于某个项目，通常绑定 issue）。 | `runs` 表 |
| `Step` | Run 中的执行节点（DAG 节点），带依赖、重试、runtime 信息。 | `steps` 表 |
| `Session` | Step 运行时会话记录（pid/thread/turn/model/token）。 | `sessions` 表 |
| `Event` | 不可变结构化事件流，用于生命周期追踪与诊断。 | `events` 表 |
| `Artifact` | 结构化交付产物/证据（报告、候选技能、issue markdown 等）。 | `artifacts` 表 |
| `Lock` | 关键流程并发控制机制。 | `locks` 表 |

数据模型锚点：
- `src/core/store.js` 中 migration 的 `CREATE TABLE` 段落。

## 3) 核心执行循环

高层执行链路：

1. 启动前执行 runtime/tooling/凭据 precheck。
2. 初始化或注册项目。
3. 基于 project + issue + workflow + context 快照创建 run。
4. 为 run 创建隔离 worktree/branch。
5. Worker 按 DAG 依赖认领可执行 pending step。
6. Runtime Adapter 执行 step 并发出结构化事件。
7. Engine 执行机械 gate（platform/invariants/docs）。
8. Store 推进状态并落盘产物。
9. API/SSE 对外提供可观测状态流。
10. Scheduler 执行周期性自动化任务。

锚点：
- `docs/architecture/00-overview.md`

## 4) Workflow 概念

| 概念 | 定义 | 说明 |
| --- | --- | --- |
| `Workflow` | 项目级 DAG 流程定义，来源 `.forgeops/workflow.yaml`。 | 未自定义时使用默认流程。 |
| `默认步骤` | `architect -> issue -> implement -> test -> review -> cleanup`。 | 默认线性形态。 |
| `Step 模板` | 内建步骤契约，包含角色、提示词契约、重试策略、输出约束。 | 定义于 `src/core/workflow.js`。 |
| `输出契约` | Runtime 必须返回固定 JSON 结构与状态枚举。 | `STEP_OUTPUT_SCHEMA`。 |
| `Workflow controls` | 自动合并、合并方式、自动关 issue、冲突重试等项目级控制。 | 在 workflow/store 中解析校验。 |

Run mode：
- `standard`：按项目 workflow 正常执行。
- `quick`：低成本短路径执行（若配置不满足会回落）。

锚点：
- `src/core/workflow.js`
- `src/core/store.js`（`resolveRunWorkflowByMode`）
- `docs/user-guide.md`

## 5) Runtime 抽象概念

| 概念 | 定义 |
| --- | --- |
| `Runtime Adapter` | 控制平面与模型运行时之间的稳定契约层。 |
| `Runtime Registry` | Runtime 的注册与获取机制，解耦 orchestration 与 runtime 实现。 |
| `codex-exec-json` | 当前默认 runtime（`codex exec --json`）。 |
| `codex-app-server` | 实验 runtime（非 v1 默认路径）。 |
| `Resume 语义` | step 可尝试 thread 续跑，续跑无效时可回退 fresh 执行。 |

契约形态：
- 输入：`{ cwd, prompt, model, outputSchema, onRuntimeEvent }`
- 输出：`{ status, summary, rawOutput, structured, runtime }`

锚点：
- `docs/runtime-adapter-design.md`
- `src/runtime/index.js`
- `src/runtime/codex-exec-json.js`

## 6) 状态与可恢复性概念

| 概念 | 定义 |
| --- | --- |
| `认领 pending step` | Engine 在并发限制内持续认领可执行步骤。 |
| `retry-or-fail` | 失败按重试策略推进，超限则失败。 |
| `orphan recovery` | 服务重启后恢复遗留运行步骤。 |
| `session resume risk` | 长会话续跑失败会触发风险事件与 rotate 建议。 |
| `tracked thread` | CLI 维护会话线程映射，确保可预期恢复。 |

锚点：
- `src/worker/engine.js`
- `src/core/store.js`
- `src/cli/index.js`（`forgeops codex session|project`）

## 7) 质量闸门概念（机械治理）

ForgeOps 的闸门是可执行约束，不是口头规范。

| 闸门 | 作用范围 | 触发点 |
| --- | --- | --- |
| `Platform Gate` | 产品运行态验收（preflight + smoke） | `test` 步骤 |
| `Invariant Gate` | 架构/边界不变量约束 | `implement/test/review` |
| `Docs Gate` | 文档新鲜度与结构完整性 | `cleanup` 步骤 |
| `follow-up issue` | 对 invariant warning 自动形成后续 issue（按策略） | 通常在 `review` |

锚点：
- `src/worker/engine.js`
- `docs/design/platform-toolchain-quality-gate.md`
- `docs/harness-engineering-guidelines.md`

## 8) 上下文概念

上下文是分层显式设计：

| 层级 | 典型文件 | 用法 |
| --- | --- | --- |
| 项目基础上下文 | `.forgeops/context.md`、`.forgeops/governance.md` | 用于项目助手和 step 提示词种子 |
| 步骤级上下文 | `docs/context/*.md` + `docs/context/index.md` 注册表 | 按步骤选择注入 |
| 角色能力上下文 | `.forgeops/agent-skills.json` + skills 内容 | 决定角色可执行能力 |

重要规则：
- `docs/context/*.md` 不会自动替你登记/整理；只有注册后才会被步骤级消费。

锚点：
- `src/core/store.js`（`loadProjectContext`、`loadProjectGovernance`、`loadStepScopedContextDocs`）
- `docs/context/index.md`

## 9) 技能系统概念（当前实现）

Skill 是角色能力单元，不是临时提示词片段。

### 9.1 技能解析优先级

1. `project-local`（`<projectRoot>/.forgeops/skills/...`）
2. `user-global`（`$FORGEOPS_HOME/skills-global/skills/...`）
3. `official`（`official-skills/skills/...`）

锚点：
- `src/core/skills.js`（`resolveSkillDescriptorByPriority`）

### 9.2 技能升级链路（已实现路径）

1. 官方模板提供初始能力基线。
2. run 执行过程中产生可复用方法与证据。
3. `cleanup` 输出 `skill-candidate` 产物。
4. 候选技能通过独立 PR 晋升（人审）。
5. 候选可晋升到 project-local 或 user-global 技能库。
6. scheduler 可自动触发候选晋升提案。

锚点文档：
- `docs/design/skill-evolution-closed-loop.md`
- `docs/design/issue-driven-taste-and-skill-loop.md`
- `docs/design/skill-promotion-pr-review-loop.md`
- `docs/design/skill-auto-promotion-scheduler.md`
- `docs/design/user-global-skill-library.md`

## 10) 调度器概念

Scheduler 是项目级周期自动化编排器。

主要任务族：

1. `cleanup` 周期治理。
2. `issueAutoRun` 按标签规则自动拉起 run。
3. `skillPromotion` 项目内候选技能自动晋升。
4. `globalSkillPromotion` user-global 候选技能自动晋升。
5. 主干同步相关维护任务。

锚点：
- `src/worker/scheduler.js`
- 项目配置：`.forgeops/scheduler.yaml`

## 11) 可观测性概念

| 观测面 | 作用 |
| --- | --- |
| `/api/events` | 拉取事件快照历史，支持回放与排障。 |
| `/api/events/stream` | SSE 实时事件流（含 replay 与 heartbeat）。 |
| run-step-session 关联 | 所有事件/产物都可追溯到执行上下文。 |
| attach-terminal | 受控旁观 runtime thread 的终端能力。 |

锚点：
- `src/server/app.js`

## 12) Codex 交互入口概念

ForgeOps 提供两个 Codex 入口角色：

1. `forgeops codex session`
- ForgeOps 用法助手（平台视角）。
- 默认在 ForgeOps 仓库根目录启动。

2. `forgeops codex project`
- 项目协作助手（项目视角）。
- 按 cwd 或 `--project` 匹配托管项目。
- 支持 `--local-only` 与 `--fresh`。

两者都支持 tracked thread 语义，确保恢复行为可预测。

锚点：
- `src/cli/index.js`（`commandCodex`）

## 13) 治理哲学概念

来自 Harness Engineering 的四大支柱：

1. Context Engineering
2. Architectural Constraints
3. Observability
4. Garbage Collection

工程含义：
- 不只修一次结果。
- 要补机制，让同类失败更难复发。

锚点：
- `docs/harness-engineering-guidelines.md`
- `docs/design/core-beliefs.md`

## 14) 愿景概念（非计划）

以下概念仅为方向，不构成当前版本承诺：

1. 既有项目托管与自动演进愿景  
- `docs/design/existing-project-managed-onboarding-vision.md`

2. Skill-as-App 愿景  
- `docs/design/skill-as-app-vision.md`

## 15) v1 非目标

- 多运行时智能调度优化。
- 分布式 worker 集群。
- 全自动发布流水线。

锚点：
- `docs/architecture/00-overview.md`

## 16) 一句话关系图

`Project -> Issue -> Run -> Steps(DAG) -> Runtime Session -> Events/Artifacts -> Gates -> Review/Cleanup -> Skill Candidates -> Promotion(Project/User-Global) -> Reuse/Evolution`
