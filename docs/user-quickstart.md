# ForgeOps 1 页上手卡

Status: Active
Updated: 2026-03-01

## 30 秒先看结论

- 小改动先走 `quick`，大改动走 `standard`。
- 只想本地改代码：`forgeops codex project --local-only`。
- 需要可审计交付链路：用 Issue 驱动 run。

---

## 最小命令集（建议收藏）

```bash
# 1) 初始化项目
forgeops project init --name demo --type web --path /absolute/path/to/demo

# 2) 查看项目 ID
forgeops project list

# 3A) 本地直改（不触发 issue/run 流水线）
forgeops codex project --local-only

# 3B) 正式流水线（Issue -> Run）
forgeops issue create <projectId> "需求标题" --mode quick
forgeops run list --project <projectId>

# 4) 旁观运行中的 Codex thread
forgeops run attach <runId>
```

---

## 初始化到底做了啥（半页版）

执行：

```bash
forgeops project init --name demo --type web --path /absolute/path/to/demo
```

会按 4 步完成初始化：

1. 运行时检查：确认 `codex` 可用（`codex --version`）。
2. 系统检查：确认 `git`/`gh`、全局 git 身份、GitHub PAT 可用。
3. 脚手架落盘：创建 `.forgeops/*`、`docs/*`、技能模板、治理与校验脚本。
4. GitHub 绑定 + Store 注册：初始化/校验 git、绑定或创建远程仓库、推送分支、注册项目到 ForgeOps。

注意：

- 初始化不是“只建目录”，它会接通后续 Issue/Run 流水线所需的基础设施。
- 默认会尝试启用 `main` 分支保护（可用 `--no-branch-protection` 关闭）。
- 默认会尝试打开 Dashboard（可用 `--no-open-ui` 关闭）。

需要完整说明请看：`docs/project-init-user-guide.md`。

---

## quick / standard 怎么选

### quick（省 token）

适用：

- 单点修复、配置/脚本改动、文档更新
- 影响面清晰、可快速回归

命令：

```bash
forgeops issue create <projectId> "修复 XXX" --mode quick
# 或
forgeops run create <projectId> --issue 123 --mode quick
```

### standard（完整流程）

适用：

- 跨模块、架构/契约变更
- 数据模型、权限、安全、发布风险较高

命令：

```bash
forgeops issue create <projectId> "重构 XXX" --mode standard
# 或
forgeops run create <projectId> --issue 456 --mode standard
```

---

## GitHub 手工创建 Issue 会自动跑吗

默认：只处理 `open` 且带 `forgeops:ready` 的 issue。  
如果 issue 带 `forgeops:standard`，自动 run 走 `standard`；否则默认走 `quick`。

改成“处理全部 open issue”：

```bash
forgeops scheduler set <projectId> --issue-auto-label "*"
```

---

## 3 个常见排障命令

```bash
forgeops doctor
forgeops service status
forgeops service logs --lines 200
```

---

## 一句话工作约定（推荐）

- 默认 `quick`，有风险再升级 `standard`。
- 个人探索用 `--local-only`，准备合入前走标准流水线。
- 保持 scheduler cleanup 开启，定期做文档新鲜度和结构治理。
