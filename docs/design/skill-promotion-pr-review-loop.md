# 技能候选晋升 PR 审查闭环（独立于需求流水线）

Status: Active  
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

## 背景

`cleanup` 步骤已经可以在项目内产出技能候选（`.forgeops/skills/candidates/*.md`）。  
下一步要解决的是：如何把候选技能稳定升级为正式技能，同时避免误升级导致模板退化。

约束：

1. 不新增平台实体类型；
2. 复用 Git/GitHub 强流程；
3. 不影响标准需求交付流水线（architect -> issue -> implement -> test -> review -> cleanup；可选扩展 `platform-smoke`）。

## 目标

1. 技能升级必须经过 PR（默认 draft）并支持人审。
2. 技能升级链路与“需求交付 run”解耦，避免互相阻塞。
3. 候选晋升结果可追溯到候选文件、run、issue 与证据。
4. 支持作为自动晋升调度链路的执行底座（定时触发仍走同一 PR 审查模型）。

## 非目标

1. 不在 v1 实现“自动合并技能 PR”。
2. 不在 v1 实现“跨项目自动上报中心库”。
3. 不要求每个候选都必须自动晋升。

## 核心策略：双轨闭环（Delivery / Promotion）

1. Delivery 轨（需求交付）
- 继续按现有 run DAG 交付需求，不新增阻塞步骤。
- cleanup 只负责提炼候选技能，不负责直接改写正式技能库。

2. Promotion 轨（技能治理）
- 由 CLI/API 手动触发“候选晋升”动作。
- 也可由 scheduler 定时触发“自动晋升动作”（见 `docs/design/skill-auto-promotion-scheduler.md`）。
- ForgeOps 使用独立 worktree 分支生成技能变更并发起 PR。
- 人类 reviewer 在 PR 中审查后决定合并/驳回。
- 涉及技能内容重写时，优先由运行时 Agent 调用 `skill-creator` 完成（控制面只做路径与审查约束）。

## 晋升动作（MVP）

输入：

1. `projectId`
2. `candidate`（候选技能文件路径）
3. `skillName`（可选，默认由候选标题 slug 化）
4. `description`（可选，默认由候选标题生成）
5. `roles`（可选，决定是否写入 `.forgeops/agent-skills.json`）

执行：

1. 读取候选文档元信息（title/source/run/issue/generated_at）。
2. 在独立 worktree 分支中生成/更新：
   - `.forgeops/skills/<skillName>/SKILL.md`
   - `.forgeops/agent-skills.json`（仅在传入 roles 时更新）
3. 追加本地晋升日志（用于可追溯审计）。
4. 推送分支并创建 GitHub PR（默认 draft）。

输出：

1. PR 链接、分支、变更文件列表；
2. 候选与 PR 的可追溯映射（candidate -> branch -> prNumber）。

## 冲突隔离与不变量

1. 晋升链路不是 run step，不占用需求流水线重试/闸门预算。
2. 晋升使用独立 worktree 分支，不污染主工作区。
3. 仅允许从 `.forgeops/skills/candidates/` 读取候选，禁止跨目录注入。
4. 生成 PR 时默认 draft，避免未审方法直接进入主线。

## 审查基线（PR Checklist）

1. `problem` 是否指向真实高频问题。
2. `approach` 是否可执行、可复现、可验证。
3. `evidence` 是否能回溯到 run/issue/日志。
4. `adoption scope` 是否明确（项目内 / 模板候选）。
5. 是否与现有技能冲突或重复。

## PR 标签约定（GitHub Label）

1. 项目内技能晋升 PR 自动打标：
   - `forgeops:skill-promotion`
   - `forgeops:skill-project`
   - `forgeops:auto` 或 `forgeops:manual`
2. user-global 技能晋升 PR 自动打标：
   - `forgeops:skill-promotion`
   - `forgeops:skill-global`
   - `forgeops:auto` 或 `forgeops:manual`
3. 标签写入失败不阻断主链路，但会产生日志事件用于补偿治理。

## 验收标准（MVP）

1. 可以列出项目内候选技能并选择一项晋升。
2. 可以创建独立技能晋升 PR（默认 draft）。
3. 标准需求流水线在启用晋升功能后行为不变。
4. 文档索引与架构说明已同步。

## 关联文档

1. `docs/design/issue-driven-taste-and-skill-loop.md`
2. `docs/design/skill-evolution-closed-loop.md`
3. `docs/design/skill-collective-evolution-service.md`
4. `docs/design/skill-auto-promotion-scheduler.md`
