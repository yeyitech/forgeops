# 技能治理分层：Policy / Delivery / Evidence

Status: Active
Updated: 2026-02-27

## 背景

ForgeOps 与 Codex 都会“碰到技能能力”，但两者职责不同。
如果边界不清，容易出现：

- 同一能力双实现（维护成本高）
- 技能可见性漂移（ForgeOps 认为可用、运行时实际不可用）
- 上下文注入过量（token 成本高、稳定性下降）

## 目标

建立技能治理三层模型，确保“谁做什么”可验证、可演进。

## 三层模型

### 1) Policy 层（ForgeOps）

定义“应该用什么技能”：

- role -> skills 装配策略
- step 级技能裁剪与优先级
- 项目/用户/官方层组合策略
- run 创建时技能快照（用于审计）

产物：

- `.forgeops/agent-skills.json`
- run context 中 `agentSkills` 快照

### 2) Delivery 层（Codex Runtime）

定义“技能如何被加载并生效”：

- 技能发现与扫描
- 缓存与刷新
- 显式/隐式触发
- 运行时注入

原则：

- ForgeOps 不重实现 Delivery 内核。
- 通过 Runtime Adapter 与 prompt 策略完成协同。

### 3) Evidence 层（ForgeOps）

定义“技能是否产生价值”：

- 计划使用技能（planned）
- 实际触发技能（used）
- 使用后质量变化（返工率、重试率、gate 通过率）

目标：

- 技能从“文档资产”升级为“可运营资产”。

## 职责边界（机械约束）

ForgeOps 允许：

- 决策层策略（装配、裁剪、优先级、快照）
- 证据层追踪（planned/used/effective）

ForgeOps 禁止：

- 复刻运行时 skills loader
- 复刻运行时显式/隐式触发引擎
- 复刻 runtime 级缓存与刷新机制

## 提示词注入策略（降噪）

默认规则：

1. step prompt 仅注入“必需技能”清单，不注入全量技能正文。
2. 每个 step 建议技能预算：
- 核心技能：<= 3
- 场景技能：<= 2
3. 非关键技能通过路径引用与延迟加载方式提供，不进入默认主提示。

目的：

- 降低 token 税
- 降低长会话语义漂移风险

当前实现（2026-02-27）：

- 默认交付模式：`codex-native`
- 可通过环境变量回退：`FORGEOPS_SKILL_DELIVERY_MODE=legacy`
- `codex-native` 模式下，步骤提示词默认只保留有限技能显式引用（预算裁剪）。

## 技能快照与审计建议

run 创建时记录每个技能的最小快照字段：

- `name`
- `source`（project-local/user-global/official）
- `path`
- `contentHash`

用途：

- 保证同 run 内可追溯与可复现
- 避免运行中技能内容变化造成行为不一致

## 效果指标（建议）

核心指标：

1. `planned_skills_count`
2. `used_skills_count`
3. `skill_usage_hit_rate = used / planned`
4. `retry_after_skill_use_rate`
5. `gate_fail_after_skill_use_rate`

决策规则：

- 连续 2-4 周低命中/低收益技能进入清理候选。
- 高频高收益技能进入模板升级候选。

## 反模式

- 把技能当“长提示词拼接仓库”而非可执行能力单元。
- role 装配无限膨胀，不做 step 级裁剪。
- 无 planned/used/effective 证据，仅凭主观感受升级技能。

## 最小执行清单

1. 保持 `project-local > user-global > official` 优先级不变。
2. 为 step 增加技能预算规则与最小注入策略。
3. run 侧落地技能快照字段（含 hash）。
4. 增加技能有效性统计，并纳入 cleanup 周期复盘。
