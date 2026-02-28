# Codex 运行时提示词工程与技能加载机制调研

Status: Active
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

## 目的与范围

本报告用于回答三个问题：

1. Codex 为什么会在完成任务后给出“下一步建议”？
2. Codex 的 AGENTS/Skills 是怎么被加载并注入上下文的？
3. ForgeOps 在接入 Codex 作为首个 Runtime 时，应该如何设计反馈闭环，且避免“过度约束导致效果变差”？

调研范围为本地源码（示例路径）：

- `~/ai-workflow/codex/codex-rs/protocol`
- `~/ai-workflow/codex/codex-rs/core`
- `~/ai-workflow/codex/codex-rs/codex-api`

## 结论摘要

1. “任务完成后给优化建议”主要是指令层行为，不是后处理拼接。
2. 上下文注入是分层组装：`base_instructions` -> developer instructions -> user instructions（含 AGENTS + Skills section）-> turn 内显式 skill 注入。
3. AGENTS.md 在 Codex 中是“路径级拼接文档”，并有字节预算；它更像地图入口，不适合塞成百科。
4. Skills 是一等机制：支持多作用域加载、显式/隐式触发、依赖提示、权限画像与审批流程。
5. 对 ForgeOps 最优策略不是增加更多平台实体，而是“边界强约束 + 局部自治 + 建议回收闭环”。

## 1. Prompt 组装链路（Codex 内部）

### 1.1 Base Instructions 来源

- `BASE_INSTRUCTIONS_DEFAULT` 来自默认提示词文件：`codex-rs/protocol/src/models.rs`。
- 默认文本文件是：`codex-rs/protocol/src/prompts/base_instructions/default.md`。
- session 初始化时 `base_instructions` 优先级为：
  - `config.base_instructions`
  - 会话历史里的 `session_meta.base_instructions`
  - 当前 model 的默认 instructions
- 见：`codex-rs/core/src/codex.rs`（session 初始化注释与实现）。

### 1.2 Initial Context 注入顺序

`build_initial_context()` 会按顺序注入：

1. 权限/沙箱 developer instructions（由 approval/sandbox policy 生成）
2. 开发者附加指令（developer_instructions）
3. memory/tool 相关 developer instructions（feature 开启时）
4. collaboration mode developer instructions
5. personality/apps/commit attribution 等 developer instructions（按 feature）
6. user instructions

见：`codex-rs/core/src/codex.rs` 的 `build_initial_context()`。

### 1.3 User Instructions 的组成

`get_user_instructions()` 的输出由以下部分拼接：

1. 配置里的 `user_instructions`
2. 项目文档（`AGENTS.md` 链）
3. 可选 JS REPL 指令块（feature）
4. Skills 列表与使用规则（skills section）
5. ChildAgents 层级信息（feature）

见：`codex-rs/core/src/project_doc.rs`、`codex-rs/core/src/skills/render.rs`。

## 2. AGENTS 与 Skills 的真实工作机制

### 2.1 AGENTS.md 不是单点文件

Codex 会从 project root 到当前目录收集文档（默认 `AGENTS.md`，支持 fallback），按路径顺序拼接，并受 `project_doc_max_bytes` 限制。

这天然支持“渐进式披露”，也解释了为什么“大一统 AGENTS.md”会快速退化。

见：`codex-rs/core/src/project_doc.rs`。

### 2.2 Skills 发现与加载

Skills 根目录来自多作用域并去重：

- Repo
- User
- System（含缓存系统技能）
- Admin
- 以及 repo agents 扩展路径

加载后会：

- 扫描 `SKILL.md`
- 解析 frontmatter（name/description）
- 可选读取 metadata（interface/dependencies/policy/permissions）
- 生成隐式触发索引（scripts 目录与 skill doc 路径）

见：`codex-rs/core/src/skills/loader.rs`、`codex-rs/core/src/skills/model.rs`、`codex-rs/core/src/skills/manager.rs`。

### 2.3 显式触发与注入

- 显式提及（`$skill-name` 或结构化输入 path）通过 `collect_explicit_skill_mentions()` 识别。
- 识别后 `build_skill_injections()` 会把 `SKILL.md` 正文变成 `SkillInstructions` 注入当前 turn。
- 依赖项（如 env var）可通过 `request_user_input` 动态补齐。

见：`codex-rs/core/src/skills/injection.rs`、`codex-rs/core/src/skills/env_var_dependencies.rs`、`codex-rs/core/src/codex.rs` 的 `run_turn()`。

### 2.4 隐式触发、审批与权限

- shell/unified_exec 在执行命令前会检测是否调用了 skill scripts 或读取 skill doc，记录隐式调用埋点。
- 若开启相关 feature，可对隐式 skill 执行要求用户审批。
- skill metadata 里的 permissions 会编译成 sandbox/approval profile（路径规范化与平台权限）。

见：

- `codex-rs/core/src/skills/invocation_utils.rs`
- `codex-rs/core/src/tools/handlers/shell.rs`
- `codex-rs/core/src/tools/handlers/unified_exec.rs`
- `codex-rs/core/src/skills/permissions.rs`

## 3. 为什么 Codex 会给“下一步建议”

目前证据表明主因是提示词约束，而非运行时后处理：

- 默认 base instructions 明确要求：若存在合理 next step，简洁提出。
- 同一文件也持续强化“next steps”“actionable guidance”等输出风格。
- `MessagePhase` 在协议层主要用于区分 commentary 与 final answer 的流式渲染语义，不是建议生成器。

见：

- `codex-rs/protocol/src/prompts/base_instructions/default.md`
- `codex-rs/protocol/src/models.rs`
- `codex-rs/protocol/src/items.rs`

未发现“在 final answer 后自动附加建议文本”的统一后处理模块。

## 4. 对 ForgeOps 的设计启发（不新增平台实体）

### 4.1 保持“强边界 + 弱风格约束”

- 把不可退让项做成机械规则（invariants/lints/tests）。
- 把实现偏好保持为技能建议，不强制绑定库或具体写法。
- 让 agent 在边界内充分自治，避免 prompt 变成“微观管理手册”。

### 4.2 把“建议”作为可回收资产，而不是强制流程

建议在 ForgeOps 中做轻量捕获，不新增复杂实体：

1. 从 run 的 final answer 摘取“建议/后续优化项”（结构化提取器）。
2. 分类为：
   - `workflow`
   - `skill`
   - `context-doc`
   - `code-quality`
   - `observability`
3. 写入项目文档与 issue 闭环：
   - `docs/exec-plans/tech-debt-tracker.md`
   - 或创建 follow-up GitHub issue（按阈值/策略）。

重点：捕获是“建议池”，不是每条都阻塞主线。

### 4.3 Runtime 观测字段建议（Codex v1）

可优先采集：

- session/thread/run/step 关联 ID
- model slug、reasoning level
- tool 调用轨迹与失败原因
- token usage（可选字段，服务端不保证每次返回）
- message phase（commentary/final）

注意：token usage 在协议中是 `Option`，应按“缺省可用”设计面板与统计。

## 5. 与 ForgeOps 当前原则的一致性评估

本次调研结果与 ForgeOps 既有方向一致：

- `AGENTS.md` 做地图，而不是百科
- Skill 驱动场景能力，而不是平台枚举实体
- Harness Engineering 依赖可执行约束与反馈循环
- 清理/熵增治理采用周期任务持续偿债

差异点在于：可进一步强化“建议回收 -> 文档/规则升级”的半自动闭环。

## 6. 建议的最小落地清单

1. 在 run 完成后增加“建议提取器”（仅提取，不阻塞）。
2. 为建议定义最小 schema（title/type/impact/evidence/source_step）。
3. 将高频建议自动汇总到 `docs/exec-plans/tech-debt-tracker.md`。
4. 当同类建议重复出现超过阈值时，自动创建 follow-up issue。
5. 每周由 cleanup 角色将“重复建议”升级为可执行规则或技能更新。

## 证据文件清单

- `~/ai-workflow/codex/codex-rs/protocol/src/prompts/base_instructions/default.md`
- `~/ai-workflow/codex/codex-rs/protocol/src/models.rs`
- `~/ai-workflow/codex/codex-rs/core/src/codex.rs`
- `~/ai-workflow/codex/codex-rs/core/src/project_doc.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/render.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/loader.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/model.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/manager.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/injection.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/invocation_utils.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/env_var_dependencies.rs`
- `~/ai-workflow/codex/codex-rs/core/src/skills/permissions.rs`
- `~/ai-workflow/codex/codex-rs/core/src/tools/handlers/shell.rs`
- `~/ai-workflow/codex/codex-rs/core/src/tools/handlers/unified_exec.rs`
- `~/ai-workflow/codex/codex-rs/protocol/src/items.rs`
- `~/ai-workflow/codex/codex-rs/codex-api/src/common.rs`
