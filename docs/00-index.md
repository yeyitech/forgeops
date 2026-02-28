# 文档地图（Docs Index）

Status: Active
Updated: 2026-02-27

## 目的

本文件是 `docs/` 目录内的索引入口，用于快速定位“当前任务最小必需上下文”。

原则：

- 先看地图，再按任务跳转。
- 不一次性加载全部文档。
- 规则优先于叙事，机械约束优先于口头约定。

## 仓库级入口（非 docs 目录）

- `FORGEOPS_META_SKILL.md`
  - 面向 Agent 的 ForgeOps CLI 元技能（控制面操作剧本与恢复策略，含 `project init` 默认自动打开 Dashboard 与 `--no-open-ui` 约束）。

## 目录索引

### 快速入口（User）

- `docs/user-quickstart.md`
  - 面向用户的 1 页上手卡（最小命令集与模式选择规则）。
- `docs/user-guide.md`
  - 面向用户的操作手册（启动、模式选择、典型流程与故障排查）。

### 架构层（Architecture）

- `docs/architecture/00-overview.md`
  - 控制平面边界、执行主循环、关键组件。
- `docs/architecture/layering.md`
  - 分层依赖方向与禁止依赖规则。
- `docs/architecture/ADR-0001.md`
  - 当前架构基线与跨 issue 增量决策。
- `docs/runtime-adapter-design.md`
  - Runtime Adapter 契约与当前 Codex 接入方式。

### 设计层（Design）

- `docs/design/core-beliefs.md`
  - 系统设计信念与工程倾向。
- `docs/design/codex-upstream-follow-policy.md`
  - Codex 上游跟随策略（Follow, Not Fork）与控制平面边界。
- `docs/design/skill-driven-delivery.md`
  - 场景化能力由技能承载的方法论（不枚举环境，不新增实体）。
- `docs/design/skills-policy-delivery-evidence.md`
  - 技能治理三层模型（Policy / Delivery / Evidence）与可运营指标。
- `docs/design/complexity-budget-and-reversibility.md`
  - 复杂度预算、可逆演进与四级升级阶梯。
- `docs/design/skill-evolution-closed-loop.md`
  - 技能从模板化到项目本地化的证据驱动演化闭环与防退化机制。
- `docs/design/skill-collective-evolution-service.md`
  - 默认离线 + 可选上报的技能群体进化中心服务设计与治理模型。
- `docs/design/issue-driven-taste-and-skill-loop.md`
  - 基于 issue 注入用户偏好、自动补齐缺口并在 cleanup 沉淀技能候选（不新增实体）。
- `docs/design/skill-promotion-pr-review-loop.md`
  - 基于候选技能创建独立晋升 PR，经人审后合并（与需求流水线解耦）。
- `docs/design/skill-auto-promotion-scheduler.md`
  - 定时扫描候选并自动提/更新 Draft PR（项目内与 user-global 双链路）。
- `docs/design/user-global-skill-library.md`
  - 在 `$FORGEOPS_HOME/skills-global` 建立用户级全局技能库与审计链路。
- `docs/design/platform-toolchain-quality-gate.md`
  - 产品类型工具链 preflight、Platform Gate 与 run 双闸门状态模型。
- `docs/design/existing-project-managed-onboarding-vision.md`
  - 既有项目托管与自动演进愿景（仅愿景，非执行计划）。
- `docs/design/skill-as-app-vision.md`
  - Skill-as-App 愿景（仅愿景，非执行计划）。
- `docs/design/codex-runtime-prompt-engineering.md`
  - Codex 提示词工程、AGENTS/Skills 注入机制与 ForgeOps 集成建议。
- `docs/design/codex-runtime-session-mechanics.md`
  - Codex 运行机制、长会话风险与上下文压缩机制调研。
- `docs/design/codex-runtime-stability-rollout-checklist.md`
  - Codex 长会话稳定性在 ForgeOps 的分阶段落地清单与验收口径。
- `docs/design/codex-runtime-session-liveview-contract.md`
  - Session LiveView 能力契约（会话观测、回放、移动端消费、受控操作）。
- `docs/harness-engineering-guidelines.md`
  - Harness Engineering 四大支柱与双循环模型。
- `docs/frontend-principles.md`
  - 控制台前端技术栈与视觉实现原则。

### 质量层（Quality）

- `docs/quality/golden-principles.md`
  - 熵增治理与垃圾回收 Agent 的黄金原则。
- `docs/quality/domain-grades.md`
  - 各域质量评分与改进方向。
- `docs/quality/verification-status.md`
  - 当前验证覆盖与已知限制。

### 元规则层（Meta）

- `docs/meta/doc-freshness.md`
  - 文档新鲜度规则与检查命令。
- `docs/meta/doc-structure.md`
  - 文档结构完整性规则与索引约束。

### 上下文层（Context）

- `docs/context/index.md`
  - 步骤级上下文文档索引与注册入口。

### 计划层（Plans）

- `docs/exec-plans/active/README.md`
  - 进行中的执行计划与决策日志。
- `docs/exec-plans/completed/README.md`
  - 已完成计划归档与复盘。
- `docs/exec-plans/tech-debt-tracker.md`
  - 技术债跟踪与清理优先级。

### 产品层（Product）

- `docs/product-specs/index.md`
  - 产品规格入口与收录清单。

### 参考层（References）

- `docs/references/index.md`
  - 外部稳定参考材料的索引入口。

## 任务导航

- 改流水线结构/并发：优先读 `docs/architecture/00-overview.md`。
- 改角色职责与技能协作：优先读 `docs/design/skill-driven-delivery.md`。
- 制定 Codex 上游跟随边界：优先读 `docs/design/codex-upstream-follow-policy.md`。
- 改技能治理策略层与证据层：优先读 `docs/design/skills-policy-delivery-evidence.md`。
- 做平台复杂度预算与可逆发布策略：优先读 `docs/design/complexity-budget-and-reversibility.md`。
- 设计技能本地化升级闭环：优先读 `docs/design/skill-evolution-closed-loop.md`。
- 设计技能群体进化中心服务：优先读 `docs/design/skill-collective-evolution-service.md`。
- 设计“issue 注入偏好 + cleanup 沉淀技能候选”闭环：优先读 `docs/design/issue-driven-taste-and-skill-loop.md`。
- 设计“候选技能 -> PR 人审晋升”闭环：优先读 `docs/design/skill-promotion-pr-review-loop.md`。
- 设计“候选技能定时自动晋升”调度链路：优先读 `docs/design/skill-auto-promotion-scheduler.md`。
- 设计 user-global 技能库与审计链路：优先读 `docs/design/user-global-skill-library.md`。
- 规划“技能即应用单元（Skill-as-App）”愿景：优先读 `docs/design/skill-as-app-vision.md`。
- 改技能统一解析优先级（project-local > user-global > official）：优先读 `docs/architecture/00-overview.md` 与 `docs/quality/verification-status.md`。
- 调优 Codex runtime 提示词/技能交互：优先读 `docs/design/codex-runtime-prompt-engineering.md`。
- 设计 Codex Session 实时观测与移动端消费：优先读 `docs/design/codex-runtime-session-liveview-contract.md`。
- 改约束与防漂移策略：优先读 `docs/quality/golden-principles.md`。
- 排查文档是否过时：优先读 `docs/meta/doc-freshness.md`。
- 排查知识库结构漂移：优先读 `docs/meta/doc-structure.md`。
- 跟踪复杂任务进度：优先读 `docs/exec-plans/active/README.md`。
