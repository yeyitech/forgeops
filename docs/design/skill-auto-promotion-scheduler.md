# 技能自动晋升调度链路（项目内 + User-Global）

Status: Active  
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

## 背景

当前链路已具备：

1. `cleanup` 可产出候选技能（`.forgeops/skills/candidates/*.md`）。
2. 候选可通过 CLI/API 手动晋升到项目技能或 user-global 技能仓，并走 Draft PR 人审。

仍存在缺口：

1. 候选增长后依赖人工逐条处理，吞吐受限。
2. 缺少“定时评估 + 自动提 PR”的治理闭环。
3. 同一技能在多次候选中应体现“编辑进化”，而非无限新增碎片技能。

## 目标

1. 新增独立定时链路，自动扫描候选并评估可晋升项。
2. 自动创建（或更新）Draft PR，最终仍由用户合并决定生效。
3. 与需求交付 run DAG 解耦，不阻塞 `architect -> issue -> implement -> test -> review -> cleanup`。
4. 保持“项目内优先本土化 + 全局技能审慎上收”的双层策略。

## 非目标

1. 不在 v1 自动合并技能 PR。
2. 不将技能晋升并入默认需求 run 步骤。
3. 不新增复杂中心化服务依赖（维持离线优先）。

## 核心职责边界

1. `cleanup` 只负责“回顾总结 + 候选沉淀”，不直接改正式技能。
2. 自动晋升调度器负责“定时扫描、评价、提 PR”。
3. 人类 reviewer 负责最终合并决策。

## 运行时写作策略（弱提示 + 强位置约束）

1. 技能写作能力默认由运行时 Agent（当前 Codex）承担，优先复用运行时已有的 `skill-creator`。
2. ForgeOps 控制面不复制一套“技能写作器”，只提供弱提示与强约束：
   - 弱提示：在实现/清理等步骤提示“涉及技能写作时优先使用 `skill-creator`”。
   - 强约束：目标路径与 PR 审查项固定，确保产物落在标准位置并可审计。
3. 标准目标路径：
   - 项目内：`.forgeops/skills/<skillName>/SKILL.md`
   - user-global：`$FORGEOPS_HOME/skills-global/skills/<skillName>/SKILL.md`

## 调度模型

在项目级 `.forgeops/scheduler.yaml` 新增两类 Job：

1. `skillPromotion`（项目内技能自动晋升）
2. `globalSkillPromotion`（user-global 技能自动晋升）

两者均支持：

1. `enabled`
2. `cron`
3. `onlyWhenIdle`
4. `maxPromotionsPerTick`
5. `minCandidateOccurrences`
6. `lookbackDays`
7. `minScore`
8. `draft`

`skillPromotion` 额外支持：

1. `roles`（可选，自动挂载到 `.forgeops/agent-skills.json`）

`globalSkillPromotion` 额外支持：

1. `requireProjectSkill`（是否要求项目内已存在同名技能）

## 候选评价（MVP）

对候选按 `skillName` 聚合，基于窗口期（`lookbackDays`）计算：

1. 复现次数（occurrences）
2. issue 多样性（unique issues）
3. run 多样性（unique runs）
4. 证据信号（`evidence/证据/proof` 等文本特征）
5. 结构完整性（`problem/approach` 信号）

得到 `score`，仅当：

1. `occurrences >= minCandidateOccurrences`
2. `score >= minScore`

才允许进入自动晋升队列。

## 晋升与“编辑进化”

1. 自动晋升使用稳定分支命名：
   - 项目内：`forgeops/skill-auto/project/<skillName>`
   - 全局：`forgeops/skill-auto/global/<skillName>`
2. 若该分支已有打开中的 PR，允许“更新已有 PR”（追加提交），避免重复开单。
3. 技能目标路径固定：
   - 项目内：`.forgeops/skills/<skillName>/SKILL.md`
   - 全局：`$FORGEOPS_HOME/skills-global/skills/<skillName>/SKILL.md`

由此同一技能会随时间持续编辑演进，而不是每次新增新文件。

## 防冲突与稳定性

1. `onlyWhenIdle=true` 时，项目有 `running` run 则跳过本次调度。
2. 每类 Job 每项目都有限流（`maxPromotionsPerTick`）。
3. 自动晋升失败仅记录事件，不影响需求 run 执行。
4. 生成分支均走独立 worktree，主工作区不受污染。
5. Scheduler 对 `node-cron` 的 `execution:missed` 事件做恢复触发（带节流），降低进程阻塞导致的漏跑风险。

## 事件与可观测

新增事件族：

1. `scheduler.skill_promotion.*`
2. `scheduler.global_skill_promotion.*`
3. `skills.auto.project.*`
4. `skills.auto.global.*`

用于追踪：

1. 调度注册/禁用/跳过原因
2. 本轮扫描与筛选统计
3. 实际提 PR 或更新 PR 的结果
4. 失败分类与错误信息

## 验收标准（MVP）

1. 定时任务可在不修改需求 DAG 的前提下自动推进技能 PR。
2. 项目内自动晋升能基于同名技能持续编辑（同路径更新）。
3. user-global 自动晋升能生成（或更新）Draft PR 并保留审计。
4. 文档索引、架构总览、验证状态与代码行为一致。

## 关联文档

1. `docs/design/issue-driven-taste-and-skill-loop.md`
2. `docs/design/skill-promotion-pr-review-loop.md`
3. `docs/design/user-global-skill-library.md`
4. `docs/design/skill-evolution-closed-loop.md`
