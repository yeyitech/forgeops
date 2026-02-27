---
name: forgeops-meta-cli-orchestrator
description: "Operate ForgeOps control-plane workflows via CLI end-to-end (project/issue/run/workflow/scheduler/skills). Use when agents need deterministic ForgeOps orchestration instead of ad-hoc shell behavior."
---

# 目标

把 ForgeOps 当成“可编排控制面”使用，而不是只当普通代码仓库。
本技能面向 Agent，要求通过 ForgeOps CLI 完成可复现、可追踪、可恢复的流水线操作。

# 适用场景

1. 需要从 0 到 1 创建项目、issue、run，并验证流水线闭环。
2. 需要排障 run 失败、恢复执行、旁观 thread。
3. 需要调整 workflow/scheduler/engine 配置并验证生效。
4. 需要推进技能候选晋升（项目内或 user-global）。

# 执行原则（必须遵守）

1. **先探测后写入**：任何变更前先跑只读命令确认上下文（projectId/runId/状态）。
2. **优先 CLI 契约**：优先使用 `forgeops ...` 命令，不绕过到 sqlite 或临时脚本做主路径操作。
3. **最小副作用**：默认不做破坏性操作；dry-run 优先用隔离目录与显式标记。
4. **证据闭环**：每次执行后输出“命令 + 关键结果 + 下一步决策”。
5. **失败可恢复**：遇到失败优先 `run show` 定位，再 `run resume`，不要盲重跑全流程。

# 标准流程（命令剧本）

## A. 环境与服务探测

```bash
forgeops service status
forgeops doctor --json
forgeops project list
```

若控制面服务未安装/未运行，优先使用后台服务模式：

```bash
forgeops service install
forgeops service start
```

## B. 项目初始化（可选）

```bash
forgeops project init \
  --name <name> \
  --type web|miniapp|ios|microservice|android|serverless|other \
  --path <abs_path>
```

默认会在初始化成功后尝试打开 Dashboard（`http://127.0.0.1:4173`）。
在 CI/脚本化场景可显式关闭自动打开：

```bash
forgeops project init --name <name> --type <type> --path <abs_path> --no-open-ui
```

只做本地演练时，可显式关闭分支保护：

```bash
forgeops project init --name <name> --type <type> --path <abs_path> --no-branch-protection
```

## C. Issue -> Run 闭环

创建 issue（默认自动触发 run）：

```bash
forgeops issue create <projectId> "<title>" --description "<desc>"
```

查看 run：

```bash
forgeops run list --project <projectId>
forgeops run show <runId>
```

失败恢复：

```bash
forgeops run resume <runId>
```

旁观 thread（排障优先）：

```bash
forgeops run attach <runId>
forgeops run attach <runId> --step <stepKey>
```

## D. 流水线与调度配置

```bash
forgeops workflow show <projectId>
forgeops workflow set <projectId> --yaml-file <path_to_workflow_yaml>

forgeops scheduler show <projectId>
forgeops scheduler set <projectId> --enabled true --cleanup-enabled true --cron "0 3 * * *"
```

## E. 技能解析与晋升

查看有效技能装配（角色映射来自 official + user-global + project-local 合并；同名技能内容按 project-local > user-global > official 优先级解析）：

```bash
forgeops skill resolve <projectId>
```

项目内技能候选晋升：

```bash
forgeops skill candidates <projectId>
forgeops skill promote <projectId> --candidate <candidatePath> --name <skillName> --roles developer,tester
```

晋升到 user-global：

```bash
forgeops skill promote-global <projectId> --candidate <candidatePath> --name <skillName>
```

# 决策规则（Agent 内部）

1. 当用户说“跑不通/失败了”时，固定顺序：
   - `forgeops run show <runId>`
   - 读取失败 step、error、retry_count
   - 判断是否可 `forgeops run resume <runId>`
2. 当用户说“配置没生效”时，固定顺序：
   - `forgeops workflow show <projectId>` 或 `forgeops scheduler show <projectId>`
   - 再执行 `set`
   - 再 `show` 回读确认
3. 当用户说“技能没注入”时，固定顺序：
   - `forgeops skill resolve <projectId>`
   - 核对角色技能来源与路径
   - 决定是补 `official` 映射还是项目本地技能

# 输出格式（建议）

每次执行 CLI 后输出 3 行：

1. `Command`: 执行的完整命令
2. `Result`: 关键结果（id/status/url/失败点）
3. `Next`: 下一步操作或停止条件

# 禁止事项

1. 不要在未知上下文下直接改 `.forgeops/workflow.yaml` 并覆盖用户已有策略。
2. 不要跳过 `run show` 直接反复 `run resume`。
3. 不要把 `dry-run` 产生的项目/数据混入正式环境；需要时执行清理。
