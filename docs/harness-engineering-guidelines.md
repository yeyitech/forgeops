# Harness Engineering 指南

Status: Active
Updated: 2026-02-26

## 为什么需要这份文档

ForgeOps 不只是调度器，而是 AI 研发系统的“控制系统”。
这份文档定义我们如何通过约束、反馈与可观测性保证长期稳定交付。

## 核心原则

当智能体失败时，不只修一次结果。
要补一条机制，让同类错误更难再次发生。

## 四大支柱

### 1. Context Engineering

- `AGENTS.md` 保持短小，只做导航。
- 深层知识放在仓库版本化文档中。
- 智能体运行时不可见的信息，视为不存在。
- 角色能力通过 Skill 装配（`agent-skills.json` -> `skills/*/SKILL.md`），同一角色可挂多个技能并按需加载。
- 执行计划是一等产物：活跃计划与归档计划均放在 `docs/exec-plans/` 并纳入版本控制。

### 2. Architectural Constraints

- 通过可执行规则强制架构边界。
- 把 lint/test 失败信息设计成“教学反馈”。
- 让错误信息直接指导下一次修复。
- 约束粒度聚焦不变量（边界、依赖方向、可复现性），不要微观规定具体实现手法。
- 对产品型项目补“平台运行态约束”：CI 通过不等于平台通过。

### 3. Observability

- 每个 run/step/session 都可追踪。
- 每个失败都必须有结构化原因。
- 需求尽量转成可测指标。
- 场景化探测能力通过技能与脚本承载，不在平台层枚举实体（见 `docs/design/skill-driven-delivery.md`）。
- 运行状态需区分 `CI Gate` 与 `Platform Gate`，避免单一绿灯掩盖平台风险。

### 4. Garbage Collection

- 通过周期任务识别文档漂移、规则漂移、架构退化。
- 自动提出修复（issue/PR），对抗系统熵增。
- 周期策略由项目级 `.forgeops/scheduler.yaml` 管理（Cron + 时区 + 空闲执行策略）。
- 每日文档园艺至少执行：
  - `node scripts/check-doc-freshness.js`
  - `node scripts/check-doc-structure.js`

## 双循环模型

### 交付循环

1. Architect
2. Issue
3. Implement
4. Test
5. Review
6. Cleanup（Garbage Collection）

### Harness 循环

1. 观测失败模式
2. 定位缺失能力或约束
3. 补文档/工具/规则
4. 验证复发率下降

## 完成标准

Harness 变更只有在以下条件满足时才算完成：

- 已进入仓库版本控制
- 能自动检查或自动观测
- 在真实运行中降低重复失败

## Garbage Collection 运行建议

1. 每次 run 结束都执行一次 `cleanup` 步骤（lite），做增量清理。
2. 每天至少一次后台清理 run（建议 mode=deep，单节点 cleanup），专门扫描熵增模式。
3. 清理结果必须回写质量文档：
- `docs/quality/domain-grades.md`
- `docs/quality/verification-status.md`
- 必要时补 `docs/quality/golden-principles.md` 的机械规则。
