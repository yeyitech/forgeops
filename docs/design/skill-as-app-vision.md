# Skill-as-App 愿景（非计划）

Status: Vision (Not Planned)
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

> 重要声明：本文是愿景文档，不是执行计划，不包含排期承诺、资源承诺或版本承诺。  
> 仅用于统一“技能即应用单元”的长期设计语言，当前阶段不按本文直接排期落地。

## 背景

ForgeOps 已具备技能从项目内候选到人审晋升的链路，但整体仍偏“能力片段”视角。
随着 Agent 交付复杂度提高，技能需要从“提示词补丁”升级为“可安装、可治理、可审计、可演化”的产品化单元。

本文提出的核心类比：

- 在 Agent 时代，`Skill` 对应传统系统中的 `App`。
- ForgeOps 需要承担“Skill Runtime + Skill Governance + Skill Distribution”三层能力。

## 愿景目标

- 统一技能生命周期：发现、安装、升级、回滚、淘汰全链路可追踪。
- 统一技能契约：输入输出、能力边界、证据产物、失败语义标准化。
- 统一技能治理：发布准入、权限控制、审计留痕、风险隔离可机械执行。
- 统一技能分发：项目内、用户全局、官方模板三层可组合并可回灌。

## 非目标（当前明确不做）

- 不把本文作为 active plan，不直接进入 `docs/exec-plans/active/`。
- 不在近期版本引入“自动安装任意第三方技能”的默认行为。
- 不在缺少审计与权限模型前，开放高风险技能自动执行路径。

## 概念映射（App 语义）

1. Skill Package（应用包）
- 对应 App 包体，包含 `SKILL.md`、元信息与可执行约束。

2. Skill Manifest（应用清单）
- 对应 App manifest，声明版本、能力、依赖、兼容范围与升级策略。

3. Skill Capability（应用权限）
- 对应 App permission，声明可使用的操作边界（读写代码、网络、部署、外部系统）。

4. Skill Registry（应用商店）
- 对应分发目录，支持 project-local、user-global、official 三层来源与优先级治理。

5. Skill Telemetry（应用观测）
- 对应运行指标，沉淀成功率、回滚率、成本、复发缺陷等质量信号。

## 生命周期愿景（Skill Lifecycle）

1. Discover
- 从 run 的 issue/cleanup 产物中识别高价值可复用方法。

2. Candidate
- 以候选技能形态落盘，保留来源证据（run/step/issue/artifacts）。

3. Promote
- 通过独立 PR 进入 project-local 或 user-global，执行人审与审计。

4. Distribute
- 根据治理策略将稳定技能回灌官方模板或组织级目录。

5. Operate
- 在真实 run 中持续观测技能贡献与风险，触发迭代或降级。

6. Retire
- 对失效或高风险技能执行弃用流程，并提供替代建议与回滚路径。

## 分层分发模型（未来）

1. Project-Local
- 项目私有技能，面向当前仓库快速演进。

2. User-Global
- 用户级复用技能，面向跨项目迁移与个人方法论沉淀。

3. Official/Org
- 官方或组织模板技能，面向稳定能力基线与规模化复用。

## 治理约束（未来实现必须满足）

- 默认最小权限：技能未声明能力即不可调用对应高风险动作。
- 默认可审计：任何安装/升级/降级都必须有事件与来源记录。
- 默认可回滚：技能升级必须支持版本 pin 与一键回退。
- 默认可解释：技能执行结果必须关联证据，禁止黑盒结论。
- 默认可观测：至少具备成功率、失败原因、成本三类指标。

## 立项前门槛（可量化，仍属愿景约束）

- 治理门槛：100% 技能变更可追溯到 PR 与审计事件。
- 回滚门槛：95% 技能升级失败场景可在 10 分钟内回退到上一个稳定版本。
- 质量门槛：引入 Skill-as-App 的试点项目中，重复性缺陷复发率下降 30% 以上。
- 成本门槛：核心技能升级后，平均 token 成本不高于升级前基线的 110%。
- 可用性门槛：技能安装与升级流程成功率达到 99%（不含外部平台故障）。

## 与现有能力的衔接

- 现有“候选 -> 晋升 PR”链路可作为 Skill Lifecycle 的 Promote 基座。
- 现有 `project-local > user-global > official` 解析优先级可作为分发决策基线。
- 现有 scheduler 自动晋升能力可作为“自动发布管道”的前置实验场。

## 关联文档

- `docs/design/skill-evolution-closed-loop.md`
- `docs/design/skill-promotion-pr-review-loop.md`
- `docs/design/skill-auto-promotion-scheduler.md`
- `docs/design/user-global-skill-library.md`
- `docs/design/skill-collective-evolution-service.md`
