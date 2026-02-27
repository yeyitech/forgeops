## 需求驱动的品位注入与技能沉淀闭环（不新增实体）

Status: Active  
Updated: 2026-02-26

## 背景

ForgeOps 已进入 `issue-only` 运行模型：每个 run 都绑定 GitHub Issue。  
在该模型下，系统成败的关键不只是“是否有模板技能”，还包括：

1. 用户的目标、偏好与审美能否被持续注入；
2. 模糊输入能否在流水线内被自动补齐；
3. 真实交付中的高价值做法能否沉淀为可复用技能。

约束：不新增平台实体类型，优先复用现有 `Issue + context + skills + run artifacts`。

## 目标

1. 把用户输入（含审美/风格偏好）作为一等信号进入流水线。
2. 在 `issue` 步骤自动补齐缺口，并显式记录假设，避免“因信息不全而停摆”。
3. 在 `cleanup` 步骤将可复用方法论沉淀为技能候选文档，形成项目内闭环。
4. 全流程不新增数据库实体，只复用现有 run/step/event/artifact 模型与文件系统。

## 非目标

1. 不引入新的“偏好实体表”或“审美评分实体”。
2. 不在 v1 实现自动发布到中心技能库。
3. 不要求用户一次性写出完美 Issue 才能启动 run。

## 三层注入通道（零新实体）

1. 任务级：GitHub Issue（标题/正文/评论）
- 承载本次需求目标、边界、风格关键词、禁忌项、验收标准。

2. 项目级：`<projectRoot>/.forgeops/context.md`
- 承载长期稳定偏好（语气、品牌风格、体验原则、质量底线）。

3. 方法级：`<projectRoot>/.forgeops/skills/*/SKILL.md`
- 承载已验证的可复用做法（流程、脚本、证据规范）。

## 运行闭环（Issue -> Delivery -> Skill Candidate）

1. `issue` 步骤（缺口补齐）
- 将粗糙需求转换为结构化开发 Issue。
- 缺失信息由 Agent 以“Assumptions”补齐并显式标注风险。
- 识别并保留用户输入中的偏好/审美约束（taste signals）。

2. `implement/test/review` 步骤（执行与验证）
- 优先遵循 `Issue + context + assigned skills` 三源约束。
- 将结论输出为结构化证据（命令、日志、产物）。

3. `cleanup` 步骤（方法论沉淀）
- 抽取本次 run 的复用价值（成功策略、失败修复模式、可机械化规则）。
- 输出 `skill-candidate` 产物并落盘为项目本地候选技能文档。

## 数据与存储策略（复用现有结构）

不新增数据表，仅使用：

1. `stepOutputs.issue`
- 保存结构化 issue 结果、假设列表、偏好信号摘要。

2. `artifacts`
- 保存 `issue markdown`、`cleanup report`、`skill-candidate` 等产物。

3. 项目文件系统
- 候选技能落盘目录：`<projectRoot>/.forgeops/skills/candidates/*.md`
- 作为“待晋升方法论”缓冲层，供后续人工/Agent 审核。

## 缺口补齐策略（Issue Quality Upgrade）

当输入不完整时，默认“补齐并继续”，而不是直接失败。建议最小补齐维度：

1. 目标用户与核心场景（若缺失，给默认假设并标注）。
2. 验收标准（可测条件，至少一条关键路径）。
3. 风格偏好与禁忌（若缺失，引用项目级 context 默认值）。
4. 风险与回滚（最小可执行回退方案）。

所有补齐内容必须进入 Issue 产物，保持可审计。

## 技能候选沉淀策略（Cleanup Distillation）

`cleanup` 输出候选时，建议最小字段：

1. `title`：候选技能名称（面向动作，而非抽象概念）。
2. `problem`：触发问题/场景。
3. `approach`：可复用做法（步骤化）。
4. `evidence`：对应 run 证据与结果。
5. `adoption`：建议落地范围（当前项目/跨项目模板候选）。

落盘时附带 run/issue 元信息，保证溯源。

## 验收标准（MVP）

1. 在不新增实体前提下，`issue` 步骤可输出“假设补齐 + 偏好信号”。
2. `cleanup` 步骤可稳定产出并落盘 `skill-candidate` 文档。
3. 任何一次候选沉淀都可追溯到 runId/issueId/证据产物。
4. 文档索引（AGENTS + docs/00-index）同步更新，可导航。

## 与现有文档关系

1. 方法论基线：`docs/design/skill-driven-delivery.md`
2. 本地演化闭环：`docs/design/skill-evolution-closed-loop.md`
3. 群体进化服务：`docs/design/skill-collective-evolution-service.md`

本文件聚焦“无新增实体”的落地路径：让 Issue 成为输入入口，让 Cleanup 成为沉淀出口。
