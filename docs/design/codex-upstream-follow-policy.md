# Codex 上游跟随策略（Follow, Not Fork）

Status: Active
Updated: 2026-02-27

## 背景

ForgeOps 的长期目标是做 AI 研发控制平面，不是重造上游运行时。
Codex 已在以下能力上持续快速演进：

- Prompt 组装与上下文管理
- 技能加载/注入与隐式识别
- MCP 加载、路由、审批与鉴权
- 沙箱与执行安全策略
- 长会话压缩、恢复与运行时稳定性

在这些能力上，个人项目很难长期追平上游演进速度。

## 目标

建立明确边界：ForgeOps 跟随 Codex 上游节奏，聚焦控制平面高杠杆能力，避免维护分叉。

## 原则

1. Follow，不 Fork
- 不在 ForgeOps 内复刻 Codex 的运行时核心机制。
- 上游已有能力优先通过配置、适配与策略接入，不做本地重实现。

2. 控制平面优先
- ForgeOps 聚焦 run/step/session 编排、质量闸门、证据链、恢复与审计。
- 回合内智能（prompt 细节、技能注入、MCP 内核）交由 Codex。

3. 适配器隔离
- 运行时差异通过 Runtime Adapter 吸收。
- 禁止在业务编排层直接依赖某个 runtime 的私有协议细节。

## 责任边界

ForgeOps 负责：

- 任务编排：workflow、依赖、重试、并发、恢复
- 治理策略：platform/invariants/docs gate
- 证据沉淀：events/artifacts/sessions
- 运营闭环：失败模式 -> 规则/技能/脚本升级

Codex 负责：

- turn 内 prompt 组装与策略注入
- 技能发现、加载、缓存、显式/隐式触发
- MCP 生命周期与工具调用路由
- 沙箱/审批策略执行与长会话压缩恢复

## 决策规则（新增能力时）

先回答三个问题：

1. 这是 turn 内问题还是 turn 间问题？
- turn 内：优先使用 Codex 原生能力。
- turn 间：优先在 ForgeOps 控制平面实现。

2. 是否已有上游稳定能力？
- 有：接入/配置，不重造。
- 无：先以 adapter 扩展实现，避免渗透到编排核心。

3. 是否可逆？
- 必须具备 feature flag 或降级路径。
- 2-4 周无指标收益则回滚。

## 禁止项

- 在 ForgeOps 中新增与 Codex 重叠的 skills loader/sandbox manager/MCP router。
- 为规避上游限制而在控制平面硬编码 runtime 私有行为。
- 将实验性上游接口直接写入默认主路径，且无降级开关。

## 运行节奏建议

1. 周期性跟踪
- 每周检查上游变更摘要，评估是否影响兼容层。

2. 升级策略
- 小步跟随，优先兼容层改造，不做破坏性重构。

3. 风险控制
- 关键能力保持 smoke 验证：
  - run create -> execute -> gates -> observe
  - session resume/fallback
  - skills resolve + step prompt injection

## PR 检查清单（建议）

- [ ] 该变更属于控制平面职责，未复刻上游运行时内核。
- [ ] 与 Runtime Adapter 边界一致，无跨层耦合。
- [ ] 有可逆开关或降级路径。
- [ ] 更新了 `docs/00-index.md` 与 `AGENTS.md` 索引（如新增文档/能力）。
