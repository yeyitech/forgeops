---
name: forgeops
description: "Operate ForgeOps via CLI with help-first progressive disclosure. Use when agents need deterministic control-plane orchestration without overloading context."
---

# 目标

把 ForgeOps 当成控制面来编排，保证操作可复现、可追踪、可恢复。

# 适用场景

1. 需要创建/维护项目、issue、run 等控制面对象。
2. 需要定位 run 失败并恢复执行。
3. 需要调整 `workflow` / `scheduler` / `skills` 配置并验证生效。

# 渐进式披露（默认工作方式）

1. **先拿命令面，不先背细节**：先执行 `forgeops help`。
2. **按任务缩小到单条命令**：只填当前任务必需参数，不提前注入长参数串。
3. **先读后写**：先 `show/list/status/doctor`，再 `set/create/resume/promote`。
4. **一步一验**：每次写操作后立即回读（`show/list`）确认结果。

> 注意：当前 CLI 细粒度子命令 `--help` 不是全量覆盖。
> `forgeops project init --help` 这类命令可能触发真实执行，不可当成安全 help。

# 执行原则（强约束）

1. **优先 CLI 契约**：主路径只用 `forgeops ...`，不绕过到 sqlite 或临时脚本。
2. **最小副作用**：默认不做破坏性动作；自动化场景优先 `--no-open-ui`。
3. **失败先定位再恢复**：先 `run show` / `run attach`，再决定是否 `run resume`。
4. **证据闭环**：每轮给出 `Command`、`Result`、`Next`。

# 最小命令集（按任务加载）

## 环境探测

```bash
forgeops help
forgeops doctor --json
forgeops service status
forgeops project list
forgeops status --json
```

## 可观测证据（状态卡片）

当你需要把“现在系统到底在干什么”作为证据贴到 issue/群/会话里，优先生成图片卡片（默认写入 `~/.forgeops/charts/`，或用 `--out` 指定绝对路径）。

```bash
# 系统级（推荐 PNG：更像产品卡片）
forgeops chart system --format png --width 1280 --height 900

# 项目级
forgeops chart project <projectId> --format png --width 1280 --height 900
```

输出建议：

1. 优先用 `--json` 拿到 `path`，再把图片路径作为证据发出去。
2. 不要用终端内联图片；只需要返回图片文件路径即可。

## 项目初始化（仅在用户确认后执行）

```bash
forgeops project init --name <name> --type <type> --path <abs_path> --no-open-ui
```

## Issue -> Run 闭环

```bash
forgeops issue create <projectId> "<title>" --description "<desc>"
forgeops run list --project <projectId>
forgeops run show <runId>
forgeops run attach <runId>
forgeops run sessions <runId>
forgeops run resume <runId>
```

## Session LiveView（旁观/导出）

用于观察 ForgeOps 管理的 runtime 会话，不需要改 Codex 源码：

```bash
# 查看 run 下所有 step sessions（可按 step/status 过滤）
forgeops run sessions <runId> --with-thread

# 导出某个 session 的日志（用于审计/排障）
forgeops run session export <sessionId> --lines 2000 --out <path>
```

执行原则：

1. 先 `run sessions` 找到目标 sessionId，再做 export。
2. 日志内容可能包含敏感信息：默认只摘要关键片段，避免全量粘贴到公开渠道。

## 配置回读与更新

```bash
forgeops workflow show <projectId>
forgeops workflow set <projectId> --yaml-file <path>
forgeops scheduler show <projectId>
forgeops scheduler set <projectId> --enabled true --cleanup-enabled true --cron "0 3 * * *"
```

## 环境变量管理（system/project/run/step 四级作用域）

用于让 agent 执行时拿到必需的 token / endpoint 等（会在 step 启动时自动注入 runtime env）。默认输出会对 secret 脱敏，只有加 `--show` 才会打印真实值。

```bash
# system 级：影响所有项目/所有 run
forgeops env set system OPENAI_API_KEY=... --secret
forgeops env ls system

# project 级：仅影响该项目
forgeops env set project <projectId> SUPABASE_URL=... --plain
forgeops env ls project <projectId>

# step 级：只影响该 run 的某个 step（优先级最高）
forgeops env set step <runId> implement DATABASE_URL=... --secret
forgeops env effective step <runId> implement
```

强约束：

1. 默认不要在输出里打印 secret（不要用 `--show`），除非用户明确要求。
2. 不要尝试覆盖 ForgeOps/Codex 保留 env（例如 `FORGEOPS_*` / `CODEX_*` / `HOME` 等）。

## 技能治理

```bash
forgeops skill resolve <projectId>
forgeops skill candidates <projectId>
forgeops skill promote <projectId> --candidate <candidatePath> --name <skillName>
forgeops skill promote-global <projectId> --candidate <candidatePath> --name <skillName>
```

# 故障处理顺序

1. 用户说“失败/跑不通”：
   - `forgeops run show <runId>`
   - `forgeops run attach <runId>`（必要时带 `--step`）
   - 判断后再 `forgeops run resume <runId>`
2. 用户说“配置没生效”：
   - 先 `workflow show` 或 `scheduler show`
   - 执行 `set`
   - 再 `show` 回读
3. 用户说“技能没注入”：
   - `forgeops skill resolve <projectId>`
   - 核对来源优先级（project-local > user-global > official）

# 输出模板

每次执行后输出三行：

1. `Command`: 完整命令
2. `Result`: 关键结果（id/status/error/路径）
3. `Next`: 下一步或停止条件

# 禁止事项

1. 未确认上下文前，不直接覆盖 `.forgeops/workflow.yaml`。
2. 不跳过 `run show` 就反复 `run resume`。
3. 不把演练数据混入正式项目（需要时显式清理）。
