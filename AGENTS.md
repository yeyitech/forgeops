# ForgeOps Agent 地图

本文件是“目录地图”，不是“百科手册”。
请按任务最小化加载相关文档，不要一次性塞入全部上下文。

## 加载规则

- 先读本文件，再按任务跳转子文档。
- 只加载当前任务必需内容。
- 优先机械约束与可验证规则，而非长篇描述。
- 文档与代码冲突时：同一 PR 内修复文档。

## 项目目标

ForgeOps 是运行时无关的 AI 研发流水线控制平面。
当前 v1 默认接入 Codex（`codex-exec-json`），同时保持 Runtime Adapter 边界稳定，便于后续接入更多运行时。

## 文档索引

### 0. 快速入口

- `README.md`
  - 启动方式、CLI、API 总览。
- `FORGEOPS_META_SKILL.md`
  - 面向 Agent 的 ForgeOps CLI 元技能（控制面操作剧本与恢复策略）。
- `docs/00-index.md`
  - docs 目录地图与任务导航。

### 1. 架构真相层

- `docs/architecture/00-overview.md`
  - 系统边界、数据流、执行主循环。
- `docs/architecture/layering.md`
  - 依赖方向与分层约束。
- `docs/runtime-adapter-design.md`
  - Runtime Adapter 契约与当前实现。

### 2. 设计原则层

- `docs/design/core-beliefs.md`
  - 关键工程信念与决策倾向。
- `docs/design/skill-driven-delivery.md`
  - 场景化能力由技能承载的方法论与契约建议。
- `docs/design/skill-evolution-closed-loop.md`
  - 技能从模板化到项目本地化的证据驱动升级闭环。
- `docs/design/skill-collective-evolution-service.md`
  - 默认离线 + 可选上报的技能群体进化中心服务设计。
- `docs/design/issue-driven-taste-and-skill-loop.md`
  - 基于 issue 注入用户偏好、自动补齐缺口并在 cleanup 沉淀技能候选（不新增实体）。
- `docs/design/skill-promotion-pr-review-loop.md`
  - 基于候选技能创建独立晋升 PR，经人审后合并（与需求流水线解耦）。
- `docs/design/user-global-skill-library.md`
  - 在 `$FORGEOPS_HOME/skills-global` 建立用户级全局技能库与审计链路。
- `docs/design/platform-toolchain-quality-gate.md`
  - 产品类型工具链 preflight、Platform Gate 与双闸门验收设计。
- `docs/design/codex-runtime-prompt-engineering.md`
  - Codex 提示词工程、AGENTS/Skills 注入链路与集成策略。
- `docs/design/codex-runtime-session-mechanics.md`
  - Codex 运行机制、长会话风险与上下文压缩机制调研。
- `docs/design/codex-runtime-stability-rollout-checklist.md`
  - Codex 长会话稳定性落地清单（阶段、任务、验收标准）。
- `docs/design/codex-runtime-session-liveview-contract.md`
  - Session LiveView 能力契约（观测、回放、移动端消费、受控操作）。
- `docs/harness-engineering-guidelines.md`
  - Harness Engineering 原则与落地方式。
- `docs/frontend-principles.md`
  - Lit 栈前端设计与实现约束。

### 3. 质量与治理层

- `docs/quality/domain-grades.md`
  - 各域质量评分与改进项。
- `docs/quality/verification-status.md`
  - 当前验证状态与已知限制。
- `docs/quality/golden-principles.md`
  - 熵增治理与垃圾回收 Agent 的机械约束。
- `docs/meta/doc-freshness.md`
  - 文档新鲜度规则与检查方式。
- `docs/meta/doc-structure.md`
  - 文档结构完整性规则与检查方式。

### 4. 计划与规格层

- `docs/exec-plans/active/README.md`
  - 进行中的执行计划与决策日志。
- `docs/exec-plans/completed/README.md`
  - 已完成计划归档。
- `docs/exec-plans/tech-debt-tracker.md`
  - 技术债持续追踪。
- `docs/product-specs/index.md`
  - 产品规格入口。
- `docs/references/index.md`
  - 外部参考索引入口。

## 代码地图

- `src/core/`：工作流定义、状态存储、项目初始化
- `src/runtime/`：运行时适配器
- `src/worker/`：步骤调度与执行引擎
- `src/server/`：API 与 SSE
- `src/cli/`：命令行入口
- `frontend/src/`：Lit 仪表盘

## 场景 -> 文档

- 改工作流行为：
  - `src/core/workflow.js`、`src/core/store.js`、`docs/architecture/00-overview.md`
  - 项目级配置入口：`<projectRoot>/.forgeops/workflow.yaml`
  - 配置管理：`src/core/workflow-config.js`、`src/cli/index.js`、`src/server/app.js`、`frontend/src/app-root.ts`
- 改 GitHub 强流程 / worktree 并发：
  - `src/core/git.js`、`src/core/project-init.js`、`src/core/store.js`
  - `README.md`、`docs/architecture/00-overview.md`
- 改角色技能包装配（role -> multi-skills）：
  - `src/core/skills.js`、`official-skills/skills/*/SKILL.md`、`.forgeops/agent-skills.json`、`.forgeops/skills/*/SKILL.md`
  - `src/core/store.js`、`src/core/workflow.js`
- 设计技能本地化升级闭环（模板技能 -> 项目技能）：
  - `docs/design/skill-evolution-closed-loop.md`、`docs/design/skill-driven-delivery.md`
  - `src/core/skills.js`、`src/core/store.js`、`src/worker/engine.js`
- 设计 issue 驱动的品位注入与技能沉淀闭环（不新增实体）：
  - `docs/design/issue-driven-taste-and-skill-loop.md`、`docs/design/skill-driven-delivery.md`
  - `src/core/workflow.js`、`src/core/store.js`、`src/core/skills.js`
- 设计技能候选晋升 PR 人审链路（与需求流水线解耦）：
  - `docs/design/skill-promotion-pr-review-loop.md`、`docs/design/skill-evolution-closed-loop.md`
  - `src/core/store.js`、`src/core/git.js`、`src/cli/index.js`、`src/server/app.js`
- 设计 user-global 技能库与审计链路（跨项目复用）：
  - `docs/design/user-global-skill-library.md`、`docs/design/skill-collective-evolution-service.md`
  - `src/core/store.js`、`src/cli/index.js`、`src/server/app.js`
- 设计技能群体进化（跨项目经验聚合 -> 模板升级）：
  - `docs/design/skill-collective-evolution-service.md`、`docs/design/skill-evolution-closed-loop.md`
  - `src/core/skills.js`、`src/core/store.js`、`src/server/app.js`
- 设计场景化观测/验证策略（不新增实体）：
  - `docs/design/skill-driven-delivery.md`、`docs/harness-engineering-guidelines.md`
  - `<projectRoot>/.forgeops/skills/*/SKILL.md`、`<projectRoot>/.forgeops/context.md`
- 改产品类型工具链 preflight / 平台验收闸门：
  - `docs/design/platform-toolchain-quality-gate.md`、`docs/architecture/00-overview.md`
  - `src/core/platform-toolchain.js`、`src/core/project-init.js`、`src/core/workflow.js`、`src/core/store.js`
- 调优 Codex 提示词/技能装配策略：
  - `docs/design/codex-runtime-prompt-engineering.md`、`docs/runtime-adapter-design.md`
  - `src/runtime/codex-exec-json.js`、`src/worker/engine.js`
- 研究 Codex 长会话稳定性/压缩机制：
  - `docs/design/codex-runtime-session-mechanics.md`、`docs/runtime-adapter-design.md`
  - `src/runtime/codex-exec-json.js`、`src/worker/engine.js`
- 落地 Codex 长会话稳定性改造（按清单实施）：
  - `docs/design/codex-runtime-stability-rollout-checklist.md`、`docs/runtime-adapter-design.md`
  - `src/runtime/codex-exec-json.js`、`src/worker/engine.js`、`src/core/store.js`
- 补充 Codex Session 真实运行观测能力（Web/移动端）：
  - `docs/design/codex-runtime-session-liveview-contract.md`、`docs/runtime-adapter-design.md`
  - `src/runtime/codex-exec-json.js`、`src/core/store.js`、`src/server/app.js`、`frontend/src/app-root.ts`
- 改不变量机械约束（custom linter / structural tests）：
  - `src/core/invariants.js`、`src/core/templates/invariants-checker.mjs`
  - `.forgeops/invariants.json`、`.forgeops/tools/check-invariants.mjs`
  - `src/worker/engine.js`（implement/test/review 自动 gate）
- 改定时清理调度（Cron / Garbage Collection）：
  - `src/core/scheduler-config.js`、`.forgeops/scheduler.yaml`
  - `src/worker/scheduler.js`、`src/cli/index.js`、`src/server/app.js`
- 改项目上下文输入：
  - `<projectRoot>/.forgeops/context.md`、`src/core/store.js`、`src/core/workflow.js`
- 加新运行时：
  - `src/runtime/index.js`、`docs/runtime-adapter-design.md`、`docs/architecture/layering.md`
  - 启动前置校验：`src/runtime/preflight.js`
- 改 UI 规则：
  - `frontend/src/app-root.ts`、`docs/frontend-principles.md`
- 排查稳定性问题：
  - `docs/harness-engineering-guidelines.md`、`docs/quality/verification-status.md`
- 做熵增治理/技术债回收：
  - `docs/quality/golden-principles.md`、`docs/quality/domain-grades.md`、`src/core/workflow.js`
- 做复杂任务执行计划：
  - `docs/exec-plans/active/README.md`、`docs/exec-plans/completed/README.md`
  - `docs/exec-plans/tech-debt-tracker.md`

## 维护约束

- 本文件保持精简（建议 < 200 行）。
- 新增文档必须在这里挂索引。
- 文件移动/重命名要同步更新索引。
- 合并前运行：`node scripts/check-doc-freshness.js`。
- 合并前运行：`node scripts/check-doc-structure.js`。
