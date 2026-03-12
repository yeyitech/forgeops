# ForgeOps 用户使用手册

Status: Active
Updated: 2026-03-01

## 适用对象

- 希望用 ForgeOps 管理 AI 研发流水线的项目负责人与开发者。
- 需要在“本地直接改代码”与“Issue 驱动流水线”之间切换的团队。

---

## 1. 核心概念（先看这 5 个）

- `Project`：一个被 ForgeOps 托管的代码仓目录。
- `Issue`：GitHub 需求入口（自动化 run 绑定对象）。
- `Run`：一次流水线执行实例（从 issue 派生，包含多个 step）。
- `Workflow`：项目级流程定义（默认 6 步，可在 `.forgeops/workflow.yaml` 自定义）。
- `Run Mode`：
  - `quick`：轻流程，优先 `implement -> test -> cleanup`。
  - `standard`：按项目 workflow 正常执行（显式指定时启用）。

---

## 2. 两种工作方式（建议按场景选）

### A. 本地直改（不走 Issue/Run 流水线）

适合：快速修复、探索性改动、先本地验证再决定是否入流水线。

```bash
forgeops codex project --local-only
```

行为说明：

- 在当前项目上下文打开项目助手会话。
- 只做本地代码/测试/文档操作。
- 提示词会约束禁止执行 `forgeops issue *` / `forgeops run *`。

### B. Issue 驱动流水线（走可审计交付链）

适合：正式需求交付、需要审计链路、需要 PR 合并和自动收尾。

```bash
# 创建 issue + 自动触发 run
forgeops issue create <projectId> "实现 XXX 功能"

# 或手动创建 run（必须绑定 issue；未指定 mode 默认 quick）
forgeops run create <projectId> --issue 123
```

---

## 3. 快速上手（10 分钟）

### 步骤 1：初始化项目

```bash
forgeops project init --name demo --type web --path /absolute/path/to/demo
```

### 步骤 2：查看项目

```bash
forgeops project list
```

### 步骤 3：选择执行方式

- 本地直改：`forgeops codex project --local-only`
- 流水线交付：`forgeops issue create ...` 或 `forgeops run create ...`

---

## 4. Run Mode 使用规则

### `quick`（省 token 优先）

推荐用于：

- 单文件/小范围修复
- 配置、脚本、文档、轻量回归
- 影响面清晰且低风险变更

命令示例：

```bash
forgeops issue create <projectId> "修复埋点字段" --mode quick
forgeops run create <projectId> --issue 123 --mode quick
```

### `standard`（完整流程优先）

推荐用于：

- 跨模块改造
- 接口契约变更
- 数据模型/迁移
- 安全、权限、发布风险较高需求

命令示例：

```bash
forgeops issue create <projectId> "重构鉴权链路" --mode standard
forgeops run create <projectId> --issue 456 --mode standard
```

---

## 5. 用户在 GitHub 手工创建 Issue，会自动处理吗？

会，但默认有筛选条件。

默认策略：

- 只扫描 `open` issue。
- 默认只处理带 `forgeops:ready` 标签的 issue。
- 若 issue 带 `forgeops:standard`，自动 run 会走 `standard`；否则默认走 `quick`。

你可以改成“处理全部 open issue”：

```bash
forgeops scheduler set <projectId> --issue-auto-label "*"
```

常见调优：

```bash
# 即使有运行中的 run 也继续拉取新 issue
forgeops scheduler set <projectId> --issue-auto-only-when-idle false

# 每轮最多创建 run 数量
forgeops scheduler set <projectId> --issue-auto-max-runs-per-tick 5
```

---

## 6. 常用命令清单

### 项目与配置

```bash
forgeops project list
forgeops project metrics <projectId>
forgeops workflow show <projectId>
forgeops scheduler show <projectId>
```

### Issue / Run

```bash
forgeops issue list <projectId>
forgeops issue create <projectId> "需求标题" --mode quick
forgeops run list --project <projectId>
forgeops run show <runId>
forgeops run sessions <runId>
forgeops run stop <runId>
forgeops run resume <runId>
forgeops run attach <runId>
```

### Codex 助手

```bash
# ForgeOps 用法助手（平台视角）
forgeops codex session

# 项目协作助手（项目视角）
forgeops codex project

# 项目本地直改模式
forgeops codex project --local-only
```

---

## 7. 推荐团队操作约定

- 先用 `quick`，发现影响面扩大再升到 `standard`。
- 大需求先在 Issue 描述写清验收标准，再触发 run。
- 日常允许本地直改（`--local-only`），但合入前走一次标准流水线。
- 保持 scheduler cleanup 开启，用于定期文档新鲜度和结构治理。

---

## 8. 常见问题（FAQ）

### Q1：`run create` 为什么报必须要 issue？

- ForgeOps 当前是 Issue-Only 模式。
- 先创建 GitHub issue，再 `run create --issue <id>`。

### Q2：为什么我的手工 issue 没被自动拉起？

优先检查：

- 是否 `open`。
- 是否有 `forgeops:ready`（除非你把 `issue-auto-label` 设为 `*`）。
- 调度是否被 `onlyWhenIdle` 或 `maxRunsPerTick` 限制。

### Q3：我只想让助手本地改，不要动流水线。

- 用 `forgeops codex project --local-only`。

### Q4：我装了很多全局 skills，担心 run 里上下文被挤爆，或者不同角色的 skills 混进来。

ForgeOps 在运行流水线 step 时，会默认以“托管模式”启动 Codex，目标是让 **每个 step 的 agent 只看见本角色的 skills**，并且减少用户全局 skills 对上下文窗口的挤占：

- ForgeOps 会在 run worktree 下创建 role-scoped skills 根目录：`<worktree>/.agents/skills/`
  - 里面只会放当前 step 的 `agent_id` 对应的 skills（以符号链接方式挂载）。
- ForgeOps 会默认隔离 Codex 状态目录（`CODEX_HOME`/SQLite）到 worktree：
  - `<worktree>/.forgeops-runtime/codex-home/`
- ForgeOps 会默认隔离 OS Home（避免扫描到你真实 home 下的 `~/.agents/skills`）：
  - `<worktree>/.forgeops-runtime/home/`
- `forgeops run attach <runId>` 会自动探测上述托管目录并带上相同环境变量，否则可能 resume 不到 thread。
- 你也可以先用 `forgeops run sessions <runId> --with-thread` 找到可 resume 的 session/thread，再用 `forgeops run attach <runId> --session <sessionId>` 精确旁观。

导出某个 step 的 Codex session 日志（JSONL）用于审计/复盘：

```bash
forgeops run session export <sessionId>

# 只导出最后 200 行，便于快速排障
forgeops run session export <sessionId> --lines 200
```

另外，ForgeOps 会在 Issue step 完成后，根据 Issue 意图（task/title/description）为后续 step 自动追加少量高信号技能（step-scoped），减少“初始化时猜不准”的问题：

- 数据库/迁移相关：自动追加 `database-migrations`
- API 契约相关：自动追加 `api-design`
- E2E/Playwright/Cypress：自动追加 `e2e-testing`
- 部署/CI/CD/Docker/K8S：自动追加 `deployment-patterns` / `docker-patterns`
- Supabase/Postgres/RLS：自动追加 `supabase-postgres-best-practices`

如需临时关闭隔离（不推荐，除非你明确知道为什么）：

```bash
# 不隔离 CODEX_HOME（可能会把你本机的全局 skills 列表带进 prompt 的 Skills section）
export FORGEOPS_CODEX_ISOLATE_HOME=false

# 不隔离 HOME（可能会扫描到 ~/.agents/skills）
export FORGEOPS_CODEX_ISOLATE_OS_HOME=false
```

ForgeOps 不会在 step prompt 里强制把所有 skills 的 `SKILL.md` 正文一次性注入上下文，而是把该角色可用 skills 列表（含路径）放在 prompt 里，运行时按需打开对应 `SKILL.md` 即可。

---

## 9. 验证与排障

```bash
forgeops doctor
forgeops service status
forgeops service logs --lines 200
```

如果有文档结构相关报错，先执行：

```bash
npm run docs:check
```
