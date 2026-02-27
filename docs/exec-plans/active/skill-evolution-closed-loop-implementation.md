# 技能本地化演化闭环实施计划（MVP）

Status: Active
Updated: 2026-02-25

## 关联设计

- `docs/design/skill-evolution-closed-loop.md`
- `docs/design/skill-driven-delivery.md`
- `docs/harness-engineering-guidelines.md`

## 背景与目标

当前 ForgeOps 已具备模板化技能初始化能力，但缺少项目运行期的技能升级闭环。

本计划目标是在不新增重平台实体前提下，落地一个可执行 MVP：

1. 让技能升级有证据、可评估、可回滚。
2. 防止技能文档从可执行契约退化为叙事口号。
3. 建立“模板技能 -> 项目本地化技能”的可追踪演化路径。

## 范围（In Scope）

1. 技能版本账本与演化日志（项目内文件）。
2. 技能契约结构与 linter（机械门禁）。
3. 候选技能提案与 trial 评估机制（先人工审批晋升）。
4. workflow prompt 注入技能版本上下文（稳定 + 试验态）。
5. 前端基础可视化（状态与关键指标只读展示）。

## 非范围（Out of Scope）

1. 全自动晋升/回滚（无人工确认）。
2. 跨项目全局技能市场或统一推荐系统。
3. 引入新的复杂数据库实体（优先复用现有 run/step/event 数据）。
4. 基于黑盒模型的自动调参。

## 里程碑与交付

## M0 设计冻结（Done）

1. 输出闭环设计文档与索引同步。
2. 明确生命周期状态、证据模型、晋升/回滚规则。

交付物：

- `docs/design/skill-evolution-closed-loop.md`

## M1 契约与门禁（Planned）

1. 定义 `SKILL.md` 结构化契约（5 段必填）。
2. 增加技能契约检查脚本（可复用现有 scripts 体系）。
3. 在 cleanup/review 阶段执行契约检查并输出 artifact。

目标文件（预期）：

- `src/core/skills.js`
- `scripts/check-skill-contract.js`（新增）
- `src/worker/engine.js`

验收：

1. 不符合契约结构的技能在检查阶段被明确阻断。
2. 检查输出可被 reviewer 和 cleanup 读取与引用。

## M2 版本账本与候选提案（Planned）

1. 在项目内落地：
- `.forgeops/skills/versions.json`
- `.forgeops/skills/evolution-log.ndjson`
2. 从 run/step/event 生成候选技能提案。
3. 先人工确认是否进入 trial，不自动晋升。

目标文件（预期）：

- `src/core/skills.js`
- `src/core/store.js`
- `src/worker/engine.js`

验收：

1. 每次候选提案可追溯到 run 证据。
2. 版本状态至少支持 baseline/candidate/trial/stable/deprecated。

## M3 Trial 评估与晋升判定（Planned）

1. 定义 trial 样本窗口（例如 5 runs 起）。
2. 输出对比指标：
- done/retry/failed 比例
- 平均 step 耗时
- blocker 级 review 风险数量
3. 生成晋升建议（人工审批）。

目标文件（预期）：

- `src/core/store.js`
- `src/worker/engine.js`
- `docs/exec-plans/tech-debt-tracker.md`

验收：

1. 试验结论有明确“晋升/继续试验/回滚”建议。
2. 结论包含指标和证据引用，不接受纯主观描述。

## M4 前端可视化与运营闭环（Planned）

1. 首页或项目页展示技能状态摘要（stable/trial/candidate）。
2. 展示最近一次晋升/回滚事件和关键指标。
3. 支持跳转查看证据与变更记录。

目标文件（预期）：

- `frontend/src/app-root.ts`
- `src/server/app.js`

验收：

1. 用户可在 UI 中查看技能演化状态与最近事件。
2. 演化记录可关联到 run 与 artifact。

## 工作分解结构（WBS）

1. 数据层
- 技能版本状态 schema 定义
- 演化日志写入与读取
- 评估指标聚合

2. 规则层
- 契约模板规范
- linter 与阈值配置
- 晋升/回滚判定规则

3. 执行层
- cleanup 触发候选提案
- reviewer 做晋升判定
- workflow 注入技能状态上下文

4. 展示层
- API 输出技能演化摘要
- UI 展示状态与证据入口

## 进度看板

| 里程碑 | 状态 | 目标日期 | 说明 |
| --- | --- | --- | --- |
| M0 设计冻结 | done | 2026-02-25 | 文档已完成并入索引 |
| M1 契约与门禁 | planned | 2026-02-28 | 先落地结构检查与阻断机制 |
| M2 版本账本与候选提案 | planned | 2026-03-03 | 建立演化记录与候选生成 |
| M3 Trial 评估与晋升判定 | planned | 2026-03-07 | 引入对比指标与判定建议 |
| M4 前端可视化与运营闭环 | planned | 2026-03-10 | 可视化与日常运营使用 |

## 决策日志

## 2026-02-25

1. 先文档先行，冻结闭环规则，再做代码实现。
2. MVP 阶段采用“人工审批晋升”，避免自动化误晋升风险。
3. 优先复用现有数据模型与文件体系，不新增重平台实体。

## 风险与回滚

1. 风险：契约门禁过严，阻塞正常交付。
- 缓解：先 warn-only 观测 1 个迭代，再切换为阻断。

2. 风险：指标口径不稳定导致错误晋升。
- 缓解：先固定最小指标集与样本窗口，避免频繁调参。

3. 风险：技能数量膨胀，维护成本上升。
- 缓解：定期 deprecate，并要求候选必须绑定重复问题证据。

4. 风险：trial 影响主线稳定性。
- 缓解：trial 比例受控，出现回归立即回滚到 stable。

## 回滚策略

1. 保留上一 stable 版本技能快照。
2. 触发回滚条件后，立即切换回 stable 并记录事件。
3. 回滚后生成 follow-up 候选，禁止直接重复晋升。

## 验收口径（MVP）

1. 任意技能升级均可追溯到 run 证据。
2. 任意技能状态变更均有日志记录（谁、何时、为什么）。
3. 任意不合规技能文档会被门禁识别。
4. 任意已晋升技能发生显著劣化时可快速回滚。

