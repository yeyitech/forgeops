# 技能本地化演化闭环设计

Status: Active
Updated: 2026-02-26

## 背景

ForgeOps 初始化阶段会基于 `productType + tech profile` 生成模板化技能：

- 角色映射：`<projectRoot>/.forgeops/agent-skills.json`
- 技能文档：`<projectRoot>/.forgeops/skills/*/SKILL.md`

该机制解决了冷启动问题，但真实项目会偏离模板假设：

- 同为 iOS 项目，约束可能来自签名、灰度发布、Crash 追踪、跨端协作等不同瓶颈。
- 同一模板技能在不同项目中的有效性会显著不同。

因此，技能不应停留在“初始化模板”，而应在运行中做有证据的本地化升级，并且可回滚、防退化。

## 目标

1. 让技能从模板化起点演化为项目本地最优实践。
2. 每次技能升级都有证据、门禁、结果评估与回滚路径。
3. 把“经验建议”升级为“可验证规则”，避免技能文档膨胀为口号集合。
4. 不新增重平台实体，优先复用现有 run/step/event/artifact 数据模型。

## 非目标

1. 不把 ForgeOps 改造成全局技能市场或通用知识库平台。
2. 不在 v1 引入复杂在线学习或黑盒自动调参。
3. 不跳过人工治理直接自动覆盖稳定技能。

## 核心原则

1. Baseline First：模板技能负责冷启动正确性，不追求一次性最优。
2. Evidence First：没有证据不允许升版技能。
3. Progressive Rollout：先试运行，再全量晋升。
4. Reversible：每次升级都能快速回滚。
5. Mechanical over Narrative：可执行检查优先于描述性文字。

## 生命周期模型

每个技能实例（按项目维度）进入以下状态：

1. `baseline`
- 来源：项目初始化模板技能。
- 允许触发候选提案，不允许直接覆盖为新默认。

2. `candidate`
- 来源：基于 run 失败模式/重复 review 反馈生成候选升级。
- 必须附带证据包与预期收益指标。

3. `trial`
- 在受控比例 run 中试运行（例如 10%-30%）。
- 采集对比指标：成功率、重试率、耗时、阻塞率。

4. `stable`
- 试运行达到门槛后晋升为默认技能版本。
- 写入技能版本账本，保留来源与判定依据。

5. `deprecated`
- 指标劣化、场景失效或被替代后下线。
- 不删除历史证据，保留可审计记录。

## 证据模型

### 最小证据单元（建议）

每个候选升级至少绑定：

1. 触发上下文
- `project_id`, `run_id`, `step_key`, `agent_id`, `issue_id?`

2. 失败/低效信号
- `status`（done/retry/failed）
- `retry_count`
- step 耗时与关键命令失败摘要

3. 产物证据
- 日志片段路径、测试输出路径、截图或结构化 artifact 引用

4. 提案内容
- 目标技能
- 新增/修改规则
- 预期改善指标

### 证据来源（复用现有模型）

- `run_steps`（状态、重试、耗时、错误）
- `events`（过程事件）
- `artifacts`（结构化输出）
- project docs（如 `docs/exec-plans/tech-debt-tracker.md`）

## 技能契约升级（防退化）

在 `SKILL.md` 层面引入结构化约束（推荐在 linter 强制）：

1. `Prerequisites`
- 环境依赖、权限边界、凭据前置。

2. `Probe Methods`
- 可使用的观测手段和降级路径。

3. `Verification Targets`
- 可测阈值和通过条件。

4. `Evidence Outputs`
- 证据产物路径、命名、结构要求。

5. `Failure Handling`
- 可重试失败与需升级处理的分界线。

没有以上结构的技能，不允许晋升为 `stable`。

## 门禁与晋升策略（MVP）

### 候选准入门槛

1. 同类失败模式出现 >= 3 次（或连续 2 次高严重度）。
2. 能定位到明确可执行改动，不接受抽象建议。

### 试运行门槛

1. `trial` 样本数 >= 5 runs（可按项目规模调整）。
2. 至少一个核心指标改善，且没有高严重度回归。

### 晋升门槛

1. `failed` 比例不高于 baseline。
2. `retry` 比例下降（或保持且耗时下降）。
3. reviewer 无新增 blocker 级风险。

### 回滚触发

1. 连续 2 次 run 出现同类高严重度回归。
2. 核心指标连续劣化超过阈值。

## 最小文件布局（项目内）

建议在项目根目录增加：

1. `.forgeops/skills/versions.json`
- 记录技能版本状态（baseline/candidate/trial/stable/deprecated）。

2. `.forgeops/skills/evolution-log.ndjson`
- 追加写入每次提案、试运行、晋升、回滚事件。

3. `.forgeops/skills/experiments/<skill-name>/<experiment-id>.md`
- 保存该次升级的证据摘要与判定结论。

4. `docs/exec-plans/tech-debt-tracker.md`
- 汇总高频失败模式与待晋升候选技能。

## 与现有模块映射

1. `src/core/skills.js`
- 继续负责模板技能生成。
- 增加版本元信息读写接口（不改变模板职责边界）。

2. `src/core/store.js`
- 聚合 run/step/event 指标，输出技能评估输入数据。

3. `src/worker/engine.js`
- 在 cleanup/review 阶段触发候选提案与晋升判定钩子。

4. `src/core/workflow.js`
- 在提示词中注入技能版本状态（例如 stable + 当前 trial）。

5. `frontend/src/app-root.ts`
- 展示技能状态、试运行结果、回滚记录（后续迭代）。

## 迭代计划

### Phase 1（文档与约束）

1. 固化本设计文档。
2. 定义技能契约模板与 linter 规则草案。
3. 明确评估指标与阈值。

### Phase 2（数据与账本）

1. 落地 `versions.json` + `evolution-log.ndjson`。
2. 生成候选提案（先人工审核，不自动晋升）。

### Phase 3（试运行与晋升）

1. 支持 trial 样本收集与对比。
2. 支持 stable 晋升与自动回滚。

## 验收标准（Design Ready）

1. 新项目初始化后，技能具备可演化的版本元信息入口。
2. 任意一次技能升级都能追溯到 run 证据与判定结论。
3. 技能文档不满足契约结构时，升级流程被机械阻断。
4. 发生劣化时能在一个周期内回滚到上一稳定版本。

