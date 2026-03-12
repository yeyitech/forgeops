# ForgeOps 项目初始化在做什么（面向用户）

Status: Active
Updated: 2026-03-01

## 适用场景

- 你准备第一次托管一个项目到 ForgeOps。
- 你想知道 `forgeops project init` 会改哪些东西、失败会卡在哪。
- 你需要向团队解释“初始化不是只建目录”。

---

## 一句话结论

`forgeops project init` 做的是“强校验 + 工程脚手架 + GitHub 绑定 + 控制面注册”，目标是让项目从第一天就满足可执行、可观测、可恢复的交付链路。

---

## 初始化命令

```bash
forgeops project init --name demo --type web --path /absolute/path/to/demo
```

常见可选参数：

- `--github-repo owner/name`：绑定到指定 GitHub 仓库。
- `--github-public|--github-private`：仓库可见性（默认 private）。
- `--branch-protection|--no-branch-protection`：是否启用 `main` 分支保护（默认启用）。
- `--no-open-ui`：初始化后不自动拉起 Dashboard。

---

## 初始化 4 个阶段（与 CLI 输出一致）

### 1. 运行时检查：Codex

- 检查本机能否找到 `codex` 命令。
- 执行 `codex --version` 确认运行时可用。
- 失败时直接退出，不会继续写项目文件。

### 2. 系统检查：Git / GitHub 开发权限

- 检查 `git` 和 `gh` 命令是否可用。
- 检查全局 git 身份是否配置（`user.name` + `user.email`）。
- 检查系统配置中的 GitHub PAT 是否存在、是否有效、scope 是否满足要求。
- 任一失败都会阻断初始化。

### 3. 初始化脚手架（目录 / 文档 / 技能 / GitHub）

这一步是核心，包含四类动作：

1. 产品类型工具链预检查（Preflight）
- 按 `--type` 执行 required 检查（例如 web 校验 node/npm，ios 校验 xcode 工具链，android 校验 java/sdk）。
- required 项失败会直接阻断初始化。

2. 写入项目治理与运行配置
- 关键文件：`.forgeops/project.yaml`、`.forgeops/workflow.yaml`、`.forgeops/context.md`、`.forgeops/governance.md`、`.forgeops/invariants.json`、`.forgeops/scheduler.yaml`。
- 平台脚本：`.forgeops/tools/platform-preflight.mjs`、`.forgeops/tools/platform-smoke.mjs`。
- 注意：默认“仅在文件不存在时写入”，已有文件不会被强制覆盖。

3. 写入 docs 与检查脚本骨架
- 创建 `docs/` 各层目录与基础文档（architecture/design/quality/meta/plans 等）。
- 写入文档检查脚本：`scripts/check-doc-freshness.js`、`scripts/check-doc-structure.js`。

4. 生成角色技能配置
- 写入 `.forgeops/agent-skills.json`。
- 从仓内官方模板渲染并落地 `.forgeops/skills/<skill-name>/SKILL.md`。
- 技能层优先级为：`project-local > user-global > official`（运行时解析时生效）。

技能配置格式说明（v3）：

- `.forgeops/agent-skills.json` 的 `roles.<agentId>` 不再只是 skill name 字符串列表，而是对象数组：
  - `name`: skill 名称
  - `whenSteps`: 该 skill 在哪些 stepKey 生效（例如 `["implement"]`）
  - `priority`: 优先级（用于排序/选择）
  - `tags`: 标签（用于治理与可观测）
- 运行时按 `whenSteps` 做 step-scoped 筛选，不再做“固定数量截断”。
- 在 Issue step 完成后，ForgeOps 会基于 Issue 意图（title/description/task）自动为后续 step 追加少量高信号技能：
  - 例如出现 `Supabase/Postgres/RLS` 会自动追加 `supabase-postgres-best-practices` 到 `implement/test/review`
  - 出现 `deployment/CI/CD/docker/k8s` 会追加 `deployment-patterns` / `docker-patterns`

另外还会做 GitHub 绑定：

- 确保是 git 仓库（必要时 `git init`）。
- 确保默认分支（默认 `main`）。
- 自动补 `.gitignore` 中的 `.forgeops/worktrees/` 忽略规则。
- 若无首次提交，会自动创建一次初始提交。
- 绑定或创建 GitHub 远程仓库并推送。
- 默认启用 `main` 分支保护（除非显式 `--no-branch-protection`）。

### 4. 注册到 ForgeOps Store

- 将项目记录写入 ForgeOps 本地数据库（用于后续 `project list` / `issue` / `run` 操作）。
- 若同一路径项目已存在，则复用原记录，不重复创建。
- 最后打印 `Project ready`、仓库信息和已创建文件列表。

---

## 初始化完成后，你“立刻可用”的能力

- 可以 `forgeops project list` 查看项目 ID。
- 可以 `forgeops issue create <projectId> "需求标题"` 直接开工（未指定模式时默认 quick）。
- 可以在 Dashboard 查看 run、step、事件与产物。
- 可以用 `forgeops run attach <runId>` 在终端旁观运行线程。

---

## 初始化不会做什么

- 不会自动创建业务需求 issue（除非你后续执行 issue/run 命令）。
- 不会自动安装你的业务依赖（如 `npm install` / `pip install`）。
- 不会覆盖你已经存在的同名配置文档（默认只补缺失文件）。

---

## 常见失败点与处理建议

1. 报 `Runtime precheck failed`
- 原因：本机没有可用 `codex` 命令或 `codex --version` 失败。
- 处理：先修复 Codex 安装与 PATH，再重试。

2. 报 `GitHub flow precheck failed`
- 原因：`gh` 不可用、git 身份未配置、PAT 缺失或 scope 不足。
- 处理：补齐 git 全局身份，配置并校验 PAT 后重试。

3. 报 `Product toolchain precheck failed`
- 原因：产品类型 required 工具链缺失（例如 ios 缺 Xcode）。
- 处理：按报错中的 check id 和 hint 安装对应工具链。

4. 报“origin 不是 github.com”
- 原因：目标目录已有非 GitHub 远程。
- 处理：修正远程地址，或换一个目录重新初始化。

---

## 推荐下一步

```bash
forgeops project list
forgeops issue create <projectId> "初始化后第一条需求"
forgeops run list --project <projectId>
```
