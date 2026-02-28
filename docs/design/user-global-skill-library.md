# User-Global 技能库与审计链路（ForgeOps Home）

Status: Active  
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

## 背景

项目内技能晋升（candidate -> PR）已可用，但跨项目复用还缺少“用户级固定空间”。  
需要一个不依赖单项目仓库的 user-global 技能库，用于沉淀个人/团队的方法论，并保持可审计。

## 目标

1. 固定 user-global 技能空间路径，作为跨项目共享入口。
2. 提供可审计链路（PR + 审计日志）。
3. 不影响标准需求流水线 DAG。

## 固定路径

以 `FORGEOPS_HOME` 为根（未配置时默认 `~/.forgeops`）：

1. 全局技能库根目录：`$FORGEOPS_HOME/skills-global/`
2. 全局技能内容：`$FORGEOPS_HOME/skills-global/skills/<skill-name>/SKILL.md`
3. 审计日志：`$FORGEOPS_HOME/skills-global/audit.ndjson`

说明：审计日志写入同一仓库并通过 PR 进入历史，以便人审与追溯。

## 审计位置与方式

1. 人审入口：全局技能库 GitHub PR（默认 draft）。
2. 审计载体：
- Git 历史（变更文件、提交人、review 记录）
- `audit.ndjson`（结构化事件，包含来源 project/run/issue/candidate）

## 分支命名语义

1. 自动化分支前缀（如 `codex/`）仅表示“由自动化代理发起变更”。
2. 分支前缀不代表运行时类型，不代表技能归属，不参与技能消费决策。
3. 运行时与技能消费仍由 workflow/runtime 与 `agent-skills.json` 决定。

最小审计字段建议：

1. `event`（promote_global_skill）
2. `project_id`
3. `candidate_path`
4. `skill_name`
5. `source_run`
6. `source_issue`
7. `branch`
8. `created_at`

## 晋升链路（MVP）

1. 从项目候选文件（`.forgeops/skills/candidates/*.md`）读取来源证据。
2. 在 `$FORGEOPS_HOME/skills-global` 创建独立 worktree 分支。
3. 生成/更新全局技能文件与 `audit.ndjson`。
4. 推送分支并创建 draft PR，等待人审。

自动化补充：

1. 可由 scheduler 的 `globalSkillPromotion` 定时触发候选评估与 PR 创建。
2. 自动触发与手动触发共用同一晋升实现，保证审计字段一致。

## 不变量

1. user-global 晋升不是 run step，不进入默认需求 DAG。
2. 候选来源必须在项目 candidate 目录下（防止任意路径注入）。
3. 全局库必须绑定 GitHub origin（与 ForgeOps GitHub 强流程一致）。

## 与现有文档关系

1. 项目内闭环：`docs/design/issue-driven-taste-and-skill-loop.md`
2. 本地演化：`docs/design/skill-evolution-closed-loop.md`
3. 群体进化：`docs/design/skill-collective-evolution-service.md`
4. 自动晋升调度：`docs/design/skill-auto-promotion-scheduler.md`
