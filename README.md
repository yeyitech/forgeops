# ForgeOps

ForgeOps 是一个面向 AI 研发流程的控制平面（Control Plane），核心目标是把“想法 -> 需求 -> 开发 -> 测试 -> 审查”变成可观测、可恢复、可复用的流水线。

当前 v0.1 聚焦：

- 运行时抽象（Runtime Adapter）
- Codex 运行时接入（`codex exec --json`）
- 多步骤状态机（run/step/session/events/artifacts）
- SSE 实时状态流
- Lit + Vite + TypeScript 仪表盘

默认 Agent 角色（v1）：

- Architect
- Issue
- Developer
- Tester
- Reviewer
- Garbage Collection（熵增治理）

每个角色可挂载多个技能（Skill），例如 `developer` 可同时挂载 `frontend`、`backend`、`fullstack` 技能。

## 快速入口

- `FORGEOPS_META_SKILL.md`：面向 Agent 的 ForgeOps CLI 元技能（控制面操作剧本与恢复策略，含 `project init` 默认自动打开 Dashboard 与 `--no-open-ui` 约束）。
- `docs/00-index.md`：文档地图与任务导航。

## 环境要求

- Node.js 22+
- 本机可用 `codex` 命令
- 本机可用 `git` 命令
- 已配置 git 身份（强依赖）：`git config --global user.name` 与 `git config --global user.email`
- 本机可用 `gh` 命令
- 系统级必须配置 GitHub Personal access token (classic)（在「系统配置」页设置）
- PAT scope 至少包含：`repo`、`workflow`（缺失会阻断自动化 GitHub 流程）

## 快速开始

1. 在目标目录初始化项目元信息（默认会初始化 git 仓库、创建/绑定 GitHub origin，并推送首个分支）：

```bash
forgeops project init --name my-project --type web --path /abs/path/to/my-project
```

可选参数：

- `--type <type>`：产品类型（`web`=WEB应用，`miniapp`=微信小程序，`ios`=IOS APP，`microservice`=微服务后端，`android`=Android APP，`serverless`=Serverless 后端，`other`=其他类型）。

- `--language <lang>`：主语言（如 `typescript` / `swift`）。
- `--frontend-stack <stack>`：前端栈（如 `lit+vite` / `swiftui`）。
- `--backend-stack <stack>`：后端栈（如 `nodejs-fastify` / `python-fastapi`）。
- `--ci-provider <name>`：CI 提供方（默认 `github-actions`）。
- `--github-repo owner/name`：指定远程仓库。
- `--github-public` / `--github-private`：仓库可见性（默认 private）。
- `--branch-protection`：显式开启 `main` 分支保护（默认行为）。
- `--no-branch-protection`：初始化时跳过 `main` 分支保护。
- `--no-open-ui`：初始化完成后不自动打开 Dashboard（默认会尝试打开 `http://127.0.0.1:4173`）。

初始化后会生成：

- `official-skills/skills/<skill-name>/SKILL.md`：ForgeOps 仓内预置的官方技能模板源（初始化时按需下发到项目）
- `.forgeops/agent-skills.json`：角色 -> 技能清单映射
- `.forgeops/skills/<skill-name>/SKILL.md`：遵循技能规范的技能目录
- `.forgeops/governance.md`：硬边界与软约束、最小阻塞 gate 的治理策略
- `.forgeops/invariants.json`：架构/边界不变量配置
- `.forgeops/tools/check-invariants.mjs`：自定义不变量检查器
- `.forgeops/tests/invariants-smoke.mjs`：结构化 smoke 测试脚本
- `.forgeops/scheduler.yaml`：项目级 Cron 调度配置（cleanup / issue auto-run / skill auto-promotion）
- `.forgeops/tools/platform-preflight.mjs`：产品类型工具链预检查脚本
- `.forgeops/tools/platform-smoke.mjs`：平台运行态 smoke 验收脚本

2. 启动 ForgeOps 控制面：

```bash
forgeops start --port 4173
```

启动时会执行强校验（失败即拒绝启动）：
- Git/GitHub：`git`、`gh`、全局 git 身份、系统配置中的 GitHub PAT(scope 校验)
- Runtime：`codex --version`（当前仅支持 Codex 运行时）

项目初始化时会额外执行产品类型工具链 precheck（失败即阻断 init）：
- miniapp：微信开发者工具 CLI 可定位且可执行
- web：Node/npm（浏览器 DevTools 能力作为建议项）
- ios：xcodebuild/xcrun/simctl（仅 macOS）
- microservice：python3/python + uv/poetry/pip（依赖管理器至少一个可用）
- android：java + sdkmanager/adb（Gradle 命令作为建议项）
- serverless：node/python + 依赖管理器 + 部署/本地仿真 CLI（serverless/sam/cdk/vercel/netlify/aws）

推荐在长期运行环境下使用服务托管（守护进程）：

```bash
forgeops service install --host 127.0.0.1 --port 4173
forgeops service status
```

当前支持：
- macOS：`launchd`（user agent）
- Linux：`systemd --user`

3. 启动前端（开发模式）：

```bash
cd frontend
npm install
npm run dev
```

## OSS 一键分发（不依赖 npm publish）

当无法发布到 npm/GitHub Release 时，可用 OSS 承载安装包与安装脚本。

维护者发布（本仓库执行）：

```bash
npm run release:oss -- --base-url https://<your-oss-domain>/forgeops
```

说明：`release:oss` 会先自动构建 `frontend/dist`，再打包发布，安装后可直接打开 UI（无需用户再手动 `npm run build`）。
安装脚本默认会自动初始化 user-global 技能 Git 仓库（默认仓库名 `forgeops-user-global-skills`，默认 private、默认不启用分支保护）。

产物位于 `dist/oss-release/`：

- `forgeops-<version>.tgz`
- `forgeops-<version>.tgz.sha256`
- `latest.json`
- `install-latest.sh`

将这 4 个文件上传到同一个 OSS 前缀后，把下面一条命令发给使用者：

```bash
curl -fsSL https://<your-oss-domain>/forgeops/install-latest.sh | bash
```

说明：

- 安装脚本会自动下载 tgz、校验 SHA256、安装 `forgeops`、执行 `forgeops doctor`。
- 可通过环境变量在安装阶段一键写入 Git 配置与 PAT：
  - `FORGEOPS_GIT_USER_NAME` + `FORGEOPS_GIT_USER_EMAIL`：写入全局 git 身份。
  - `FORGEOPS_GITHUB_PAT`：直接写入 PAT。
  - `FORGEOPS_GITHUB_PAT_FILE`：从文件读取 PAT（优先级低于 `FORGEOPS_GITHUB_PAT`）。
  - `FORGEOPS_HOME`：指定 ForgeOps 运行目录（默认 `~/.forgeops`，PAT 写入 `<FORGEOPS_HOME>/github-auth.json`）。
- 安装脚本默认会执行 `forgeops skill global-init --private --no-branch-protection` 初始化 user-global 技能仓库。
- 默认会自动初始化演示项目：`forgeops-demo`（路径默认 `~/project/forgeops-demo`，默认 `--no-branch-protection`）。
- 默认会自动创建 2 个 demo issue：
  - 基线需求 issue（不自动运行）；
  - Quick 模式运行 issue（`--mode quick`，自动触发首个 run）。
- 默认会自动安装并启动控制面服务（`forgeops service install + restart`），并尝试打开 Dashboard（默认 `http://127.0.0.1:4173`）。
- 若仅安装不初始化：`FORGEOPS_INSTALL_SKIP_INIT=1` 后再执行上述命令。
- 若仅初始化项目但跳过 demo issue 自动创建：`FORGEOPS_INSTALL_BOOTSTRAP_DEMO=0`。
- 若仅跳过 user-global 技能仓库初始化：`FORGEOPS_INSTALL_SKIP_GLOBAL_SKILLS_INIT=1`。
- 若指定 user-global 远端仓库：`FORGEOPS_GLOBAL_SKILLS_REPO=owner/repo`。
- 若需要为 demo 项目启用分支保护：`FORGEOPS_PROJECT_BRANCH_PROTECTION=1`（默认 `0` 以兼容权限受限账号）。
- 若跳过自动 Dashboard 拉起：`FORGEOPS_INSTALL_SKIP_DASHBOARD_SETUP=1`。
- 若只跳过自动打开浏览器：`FORGEOPS_INSTALL_OPEN_DASHBOARD=0`。
- 自定义 Dashboard 地址：`FORGEOPS_DASHBOARD_HOST`、`FORGEOPS_DASHBOARD_PORT`。

示例（安装时一键完成 git + PAT 配置）：

```bash
FORGEOPS_INSTALL_SKIP_INIT=1 \
FORGEOPS_GIT_USER_NAME="your-name" \
FORGEOPS_GIT_USER_EMAIL="you@example.com" \
FORGEOPS_GITHUB_PAT="ghp_xxx" \
curl -fsSL https://<your-oss-domain>/forgeops/install-latest.sh | bash
```

## 项目级流水线配置

每个项目都可以通过 `<projectRoot>/.forgeops/workflow.yaml` 自定义流程（支持 DAG 依赖并发）。

示例：

```yaml
id: my-workflow-v1
name: 我的项目流水线
auto_merge: true
merge_method: squash
auto_close_issue_on_merge: true
auto_merge_conflict_max_attempts: 2
steps:
  - key: architect
  - key: issue
    depends_on: [architect]
  - key: implement
    depends_on: [issue]
  - key: test
    depends_on: [implement]
  - key: review
    depends_on: [test]
  - key: cleanup
    depends_on: [review]
```

可用步骤键（当前版本）：

- `architect`
- `issue`
- `implement`
- `test`
- `review`
- `cleanup`

兼容说明：

- 历史配置中的 `platform-smoke` 会在解析时自动映射为 `test`（并入同一验收职责，不再作为独立步骤执行）。

配置校验规则：

- `auto_merge` 为项目级可选开关（默认 `true`）。
- `merge_method` 为自动合并策略（`squash|merge|rebase`，默认 `squash`）。
- `auto_close_issue_on_merge` 为 PR 自动合并成功后自动关闭关联 issue 开关（默认 `true`）。
- `steps` 必须非空。
- 不允许未知步骤键。
- 不允许重复步骤键。
- `depends_on` 不允许引用不存在步骤。
- 不允许循环依赖，且必须至少有一个入口步骤（无依赖）。

## 项目上下文管理

每个项目建议维护：

- `<projectRoot>/.forgeops/context.md`
- `<projectRoot>/.forgeops/project.yaml`
- `<projectRoot>/.forgeops/agent-skills.json`
- `<projectRoot>/.forgeops/governance.md`
- `<projectRoot>/.forgeops/invariants.json`

这些文件会在创建 run 时注入上下文。Agent 会按“角色技能映射”按需加载技能，保持上下文精简且可重入。

## 不变量强制执行

- 检查命令：`node .forgeops/tools/check-invariants.mjs --format json`
- 默认检查：
- 分层依赖方向（Types/Config/Repo/Service/Runtime/UI）
- Cross-domain 直接耦合
- Providers 唯一入口（横切关注点）
- 边界数据解析约束（boundary parse）
- 文件规模、结构化日志基线
- 机械 gate：`implement/test/review` 步骤完成后，Engine 会自动运行不变量检查。
- 阻塞策略：`error` 阻塞并触发重试；`warn` 允许 follow-up。
- Follow-up 策略（默认）：在 `review` 步骤发现 warning 时自动创建 GitHub issue（不阻塞）。
- 策略配置入口：`<projectRoot>/.forgeops/invariants.json > policy.followup`
  - `createGithubIssueOnWarnings`：是否开启 warning 自动建 issue
  - `onlyAtStep`：仅在哪个步骤创建（默认 `review`）
  - `maxItems`：issue 中最多写入多少条 warning 明细

## GitHub 强流程与并发 Worktree

ForgeOps v1 使用强约束流程：

- `run create` 前置校验必须通过（git 仓库、`origin`=GitHub、系统 PAT 可用且 scope 满足要求）。
- `run create` 采用 Issue-Only 模式：必须绑定一个 GitHub Issue（`issueId` 必填）。
- `project init` 完成后会自动为 `main` 开启 GitHub 分支保护策略（优先严格策略，必要时回退到基础保护）。
- 每次 `run create` 会自动创建独立 worktree 与分支。
- worktree 路径：`<repo>/.forgeops/worktrees/<runId>`。
- 分支命名：`forgeops/<runId>`。
- 基线引用：优先 `origin/HEAD`（例如 `origin/main`）。
- 调度执行目录会切换到 run 的 worktree，因此多个 run 可并发开发且互不污染。
- `implement` 步骤完成后会自动执行 `commit + push + PR create(draft)`（创建者为系统配置 PAT 对应账号）；若 PR 已存在则复用。
- `test/review` 步骤会在同一 PR 上持续回写进展评论。
- `test` 默认同时承担平台验收（执行 `platform-preflight` / `platform-smoke` 脚本）并优先尝试小步自修（受预算约束），只有无法安全修复时才阻断失败。
- `test` 步骤完成前，Engine 会强制执行 `platform-preflight` 与 `platform-smoke` 机械闸门；任一失败都会触发该步骤重试/失败，确保是“真实可运行产物”验收。
- 各产品类型都可在平台验收里注入真实运行态命令并采集日志证据（stdout/stderr）：
  - `miniapp`：`FORGEOPS_MINIAPP_DEBUG_CMD`（或 `smoke:miniapp|miniapp:smoke|test:miniapp`）
  - `web`：`FORGEOPS_WEB_SMOKE_CMD`（或 `smoke:web|test:e2e|e2e`）
  - `ios`：`FORGEOPS_IOS_SMOKE_CMD`（默认回退 `xcodebuild -list`）
  - `microservice`：`FORGEOPS_MICROSERVICE_SMOKE_CMD`（可选；同时强制依赖同步与健康检查证据）
  - `android`：`FORGEOPS_ANDROID_SMOKE_CMD`（默认回退 Android 构建命令）
  - `serverless`：`FORGEOPS_SERVERLESS_SMOKE_CMD`（或 `smoke:serverless|test:functions|verify|test`）
- 默认流水线里的 `cleanup` 发生在 run worktree 分支上（属于合并前的增量清理，不是 main 分支清理）。
- run 完成后若 `workflow.yaml` 的 `auto_merge=true`（默认），会在 cleanup 后执行最终闸门（invariants + docs checks）并按 `merge_method` 自动合并 PR。
- 自动合并成功后默认会自动关闭关联 issue（可通过 `auto_close_issue_on_merge=false` 关闭）。
- 若 `merge_method=merge` 且目标分支启用了 `required_linear_history`，会在合并前发出告警事件并跳过自动合并（避免等待 GitHub merge 报错）。
- PR 合并后会自动尝试同步项目主工作区默认分支到远端最新（fast-forward）；若工作区非干净或分支已分叉则跳过并记录事件。
- PR 合并后会自动归档清理该 run 的 worktree（移除 `<repo>/.forgeops/worktrees/<runId>`，并尝试删除本地 `forgeops/<runId>` 分支）。

## 定时自动化（Cron）

每个项目可独立配置 `.forgeops/scheduler.yaml`，默认会启用四类 Cron 任务：

- cleanup：每日熵增清理与质量回收（支持 `mode=lite|deep`）。
- issueAutoRun：扫描 GitHub Issue 并自动触发 run（`label` 可做过滤；设置为 `*` 表示处理全部 open issue）。
- skillPromotion：扫描项目内候选技能并自动提/更新项目技能 Draft PR（人审合并生效）。
- globalSkillPromotion：扫描候选并自动提/更新 user-global 技能 Draft PR（默认要求项目内已有同名技能）。

说明：

- 标准默认工作流中的 `cleanup` 属于 **lite**（交付链路内的增量清理）。
- 定时 `cleanup` 默认使用 **deep**（单节点专用清理工作流，仅执行 cleanup 节点）。
- 在 Issue-Only 模式下，定时 `cleanup` 会自动创建/复用对应 GitHub Issue，再触发关联 run。

默认配置示例：

```yaml
version: 1
enabled: true
timezone: UTC
cleanup:
  enabled: true
  mode: deep
  cron: 0 3 * * *
  task: 执行每日熵增清理与质量回收
  onlyWhenIdle: true
issueAutoRun:
  enabled: true
  cron: "*/1 * * * *"
  label: "forgeops:ready"
  onlyWhenIdle: true
  maxRunsPerTick: 3
skillPromotion:
  enabled: true
  cron: "15 */6 * * *"
  onlyWhenIdle: true
  maxPromotionsPerTick: 1
  minCandidateOccurrences: 2
  lookbackDays: 14
  minScore: 0.6
  draft: true
  roles: []
globalSkillPromotion:
  enabled: true
  cron: "45 */12 * * *"
  onlyWhenIdle: true
  maxPromotionsPerTick: 1
  minCandidateOccurrences: 3
  lookbackDays: 30
  minScore: 0.75
  requireProjectSkill: true
  draft: true
```

## 故障恢复（Step + Session）

- 进程中断/重启后，Engine 启动时会自动回收孤儿步骤：将 `running` 步骤重新置为 `pending`，并继续调度执行。
- 运行时会尝试复用该步骤最近一次可恢复会话（`thread_id`）：
  - `codex-exec-json`：优先 `codex exec resume <thread_id>`，失败自动回退到普通 `codex exec`。
  - `codex-app-server`：优先在原 `thread_id` 上继续 `turn/start`，失败自动新建 thread 继续执行。
- 即使 session 续跑失败，run 也不会直接中断，会回退到“同一 step 重跑”；worktree 中已落盘代码会保留。

管理方式：

- CLI：
  - `forgeops scheduler show <projectId>`
  - `forgeops scheduler set <projectId> --cleanup-mode deep --cron "0 2 * * *" --timezone "Asia/Shanghai" --task "每日熵增清理"`
  - `forgeops scheduler set <projectId> --issue-auto-cron "*/1 * * * *" --issue-auto-label "forgeops:ready" --issue-auto-only-when-idle true --issue-auto-max-runs-per-tick 3`
  - `forgeops scheduler set <projectId> --issue-auto-label "*"`（处理全部 open issue）
  - `forgeops scheduler set <projectId> --skill-auto-enabled true --skill-auto-cron "15 */6 * * *" --skill-auto-min-occurrences 2 --skill-auto-min-score 0.6`
  - `forgeops scheduler set <projectId> --global-skill-auto-enabled true --global-skill-auto-cron "45 */12 * * *" --global-skill-auto-require-project-skill true`
- UI：
  - 选中项目后，在「项目调度配置（Cron）」面板修改并保存。
- API：
  - `GET /api/projects/:id/scheduler`
  - `PUT /api/projects/:id/scheduler`

## 工作流配置管理（workflow.yaml）

每个项目的工作流定义位于 `<projectRoot>/.forgeops/workflow.yaml`，支持通过 CLI / UI / API 管理。

支持在 `review` 步骤配置“有限次自愈”参数（推荐开发期启用）：

- `auto_fix_enabled`：是否允许 review 尝试自动修复（`true/false`）
- `auto_fix_max_turns`：最多自愈回合数（超出后标记失败并等待人工介入）
- `auto_fix_max_files`：单回合最多修改文件数预算
- `auto_fix_max_lines`：单回合最多修改行数预算
- `auto_fix_allowlist`：允许自动修复的类别（逗号分隔或内联数组）
- `auto_merge`（顶层）：run 完成后是否自动合并 PR（默认 `true`）
- `merge_method`（顶层）：自动合并策略（`squash|merge|rebase`，默认 `squash`）
- `auto_close_issue_on_merge`（顶层）：PR 自动合并成功后是否自动关闭关联 issue（默认 `true`）
- `auto_merge_conflict_max_attempts`（顶层）：PR 合并冲突时自动修复并重试次数（`0-8`，默认 `2`；`0` 表示直接转人工）
- merge 队列锁忙（`merge_queue_busy`）时会进入 `deferred`，不会将 run 标记为失败。

示例：

```yaml
id: forgeops-default-v1
name: ForgeOps 默认流水线
auto_merge: true
merge_method: squash
auto_close_issue_on_merge: true
auto_merge_conflict_max_attempts: 2
steps:
  - key: architect
  - key: issue
    depends_on:
      - architect
  - key: implement
    depends_on:
      - issue
  - key: test
    depends_on:
      - implement
  - key: review
    depends_on:
      - test
    auto_fix_enabled: true
    auto_fix_max_turns: 2
    auto_fix_max_files: 6
    auto_fix_max_lines: 200
    auto_fix_allowlist: ci,tooling,typecheck,docs
  - key: cleanup
    depends_on:
      - review
```

管理方式：

- CLI：
  - `forgeops workflow show <projectId>`
  - `forgeops workflow set <projectId> --yaml-file ./workflow.yaml`
  - `forgeops workflow set <projectId> --auto-merge-conflict-max-attempts 3`
  - `forgeops workflow set-conflict-retries <projectId> 3`
  - `forgeops workflow get-conflict-retries <projectId>`
  - `forgeops workflow set <projectId> --reset-default`
- UI：
  - 选中项目后，在「工作流配置（workflow.yaml）」面板直接编辑 YAML 并保存。
- API：
  - `GET /api/projects/:id/workflow`
  - `PUT /api/projects/:id/workflow`（body: `{ "yaml": "..." }` 或 `{ "resetDefault": true }`）

## 系统配置（System）

系统配置为独立二级页面，统一管理 Runtime / Git / GitHub / Doctor。  
其中 git 是系统级配置项之一，不和单个项目绑定。

- CLI：
  - `forgeops doctor`
  - `forgeops doctor --json`
- UI：
  - 进入「系统配置」页，可查看 Runtime 状态、维护全局 git 身份、配置 GitHub PAT（classic）并校验 scope，并查看 Doctor 明细。
  - 同页提供机器观测与进程观测：CPU / 内存 / 磁盘 / 设备信息，以及相关进程快照（默认折叠显示 Top 5，可展开）与进程角色标签（核心控制面/核心执行器/Agent Worker），并保留运行时/版本控制/工具链/未知的补充标签。
- API：
  - `GET /api/doctor`
  - `GET /api/system/config`
  - `PUT /api/system/config`（支持更新全局 git 身份与 GitHub PAT）

## 常用 CLI

```bash
forgeops start
forgeops project init --name demo --type web --path /tmp/demo
forgeops project list
forgeops project metrics <projectId>
forgeops issue create <projectId> "新增登录模块"
forgeops issue create <projectId> "修复埋点字段" --mode quick
forgeops issue create <projectId> "新增登录模块" --no-auto-run
forgeops issue list <projectId>
forgeops skill global-status
forgeops skill global-init --private --no-branch-protection
forgeops skill candidates <projectId>
forgeops skill resolve <projectId>
forgeops skill promote <projectId> --candidate .forgeops/skills/candidates/xxx.md --name miniapp-ui-polish --roles developer,tester
forgeops skill promote-global <projectId> --candidate .forgeops/skills/candidates/xxx.md --name miniapp-ui-polish
forgeops run create <projectId> "实现 OAuth 登录" --issue 123
forgeops run create <projectId> "修复 iOS 启动崩溃" --issue 456 --mode quick
forgeops run list --project <projectId>
forgeops run show <runId>
forgeops run stop <runId>
forgeops run resume <runId>
forgeops run stop-all [--project PROJECT_ID]
forgeops run resume-all [--project PROJECT_ID]
forgeops run attach <runId> [--step STEP_KEY] [--session SESSION_ID] [--thread THREAD_ID]
forgeops codex session [--client auto|app|cli] [--session-key KEY] [--cwd DIR] [--prompt TEXT] [--model MODEL] [--fresh]
forgeops codex project [--project PROJECT_ID] [--cwd DIR] [--client auto|app|cli] [--session-key KEY] [--prompt TEXT] [--model MODEL] [--local-only] [--fresh]
forgeops service install --host 127.0.0.1 --port 4173
forgeops service start
forgeops service stop
forgeops service restart
forgeops service status
forgeops service logs --lines 120
forgeops service uninstall
forgeops scheduler show <projectId>
forgeops scheduler set <projectId> --cron "0 2 * * *" --timezone "Asia/Shanghai"
forgeops scheduler set <projectId> --issue-auto-cron "*/1 * * * *" --issue-auto-label "forgeops:ready"
forgeops scheduler set <projectId> --issue-auto-label "*"
forgeops scheduler set <projectId> --skill-auto-enabled true --skill-auto-cron "15 */6 * * *" --skill-auto-min-occurrences 2 --skill-auto-min-score 0.6
forgeops scheduler set <projectId> --global-skill-auto-enabled true --global-skill-auto-cron "45 */12 * * *" --global-skill-auto-require-project-skill true
forgeops workflow show <projectId>
forgeops workflow set <projectId> --yaml-file ./workflow.yaml
forgeops workflow set <projectId> --auto-merge-conflict-max-attempts 3
forgeops workflow set-conflict-retries <projectId> 3
forgeops workflow get-conflict-retries <projectId>
forgeops doctor
forgeops doctor --json
```

说明：
- `forgeops issue create/list` 直接操作 GitHub Issue，不再使用本地 issue 管理。
- `forgeops issue create` 默认会自动触发一个关联 run；可通过 `--no-auto-run` 关闭。
- `forgeops issue create --mode quick` 会给 Issue 打上 `forgeops:quick` 标签，自动 run 走 quick 模式。
- `forgeops issue create` 创建的 issue 会自动附加 `forgeops:ready` 标签（run 启动后会自动切换为 `forgeops:running`）。
- `forgeops skill candidates/promote` 是独立技能治理链路，不会插入或阻塞标准需求 run DAG。
- Scheduler 已支持独立技能治理 job：`skillPromotion`（项目内）与 `globalSkillPromotion`（user-global），定时扫描候选并自动提/更新 Draft PR。
- `forgeops skill resolve` 可查看角色技能最终生效结果（优先级：`project-local > user-global > official`）。
- `forgeops skill global-status/promote-global` 面向 user-global 技能库（固定路径：`$FORGEOPS_HOME/skills-global`，默认 `~/.forgeops/skills-global`）。
- 技能晋升创建的 Draft PR 会自动追加 reviewer checklist 评论，便于人审收敛。
- `forgeops run create` 必须提供 `--issue`（仅接受 GitHub Issue 编号，例如 `123` 或 `#123`）。
- `forgeops run create` 的 `task` 参数可选；缺省时会按 Issue 自动生成任务文案。
- `forgeops run create --mode quick|standard` 可选择执行模式：
  - `quick`：优先只走 `implement -> test -> cleanup`（若项目 workflow 不含这些 step，会自动回落 `standard`）。
  - `standard`：默认模式，按项目 workflow 正常执行。
- `forgeops run stop` 会把运行中的 run 置为 `paused`，并优先通过 `SIGSTOP` 冻结当前执行会话（不中断 thread）。
- `forgeops run resume` 同时支持两类恢复：
  - `failed` run：按失败 step 重排并重试；
  - `paused` run：优先 `SIGCONT` 继续原会话，若进程不存在则回退为同一 `thread_id` 的续跑。
- `forgeops run stop-all` / `forgeops run resume-all` 支持批量停/续：
  - 默认作用于全部项目；
  - 可通过 `--project <projectId>` 仅作用于当前项目。
- Codex 运行时默认以最高权限执行（`danger-full-access` + `approval_policy=never`），并在 `resume` 续跑链路保持同等权限，避免重试阶段权限降级。
- 如需显式关闭该强制策略（不建议），可设置环境变量：`FORGEOPS_ENFORCE_DANGER_SANDBOX=false`。
- 当 run 关联 GitHub Issue 时，系统会自动回写标签状态：`forgeops:running` / `forgeops:done` / `forgeops:failed`（仅作外部可见盖章，不作为强约束）。
- 当 run 关联 GitHub Issue 时，系统会自动回写评论进展：`run started`、`pr linked`、`step completed`、`run completed/failed`（评论中包含对应 step 的 `runtime_session_id`）。
- `forgeops run attach` 与 UI“在终端旁观”能力等价，都会打开 `codex resume --all <thread_id>`；若 run 仍在运行，建议只旁观不要发送新 prompt。
- Codex 交互入口分为两个角色：
  - `forgeops codex session`：ForgeOps 使用助手（偏平台流程与命令使用），默认在 ForgeOps 仓库根目录启动，并维护可复用 thread id。
  - `forgeops codex project`：项目协作助手（偏具体项目推进），在项目上下文里继续工作并复用项目线程。
- `forgeops codex session --session-key forgeops-meta` 可显式指定追踪 key（默认即 `forgeops-meta`）；同 key 会复用同一 thread。
- `forgeops codex project` 面向“进入具体项目后继续开发”的场景：
  - 默认根据当前 `cwd` 自动匹配已托管项目（也可显式传 `--project`）；
  - 默认在项目根目录启动会话，并使用 `session-key=project:<projectId>` 追踪项目线程；
  - 首次启动会把 `.forgeops/context.md` 与 `.forgeops/governance.md` 摘要注入启动提示，确保带着项目上下文进入会话；
  - 启动提示内置 run mode 路由规则（`quick` vs `standard`），并要求创建 run 时显式传 `--mode`；
  - `--local-only`：本地直改模式，只允许代码/测试/文档操作，禁止触发 `forgeops issue *` 和 `forgeops run *` 流水线命令；
  - 默认不注入 `FORGEOPS_META_SKILL.md`，避免覆盖项目自身上下文；如需注入可传 `--meta-skill PATH`。
- `forgeops codex session --client auto` 默认策略：优先保证“同一 tracked thread 可恢复”（走 CLI `resume`）；避免误开新会话。
- `forgeops codex session --fresh` / `forgeops codex project --fresh`：强制忽略当前 tracked thread，启动全新会话；会话结束后会把新 thread 写回追踪映射。
- `forgeops codex session --client app` 为显式 App 模式：会打开 Codex App，但当前 CLI 能力无法按 thread id 直接定位到指定会话（可能进入新会话或需手动切换）。
- `forgeops codex session` 的 CLI 路径使用交互式 `codex`（`source-kind=cli`，可被 Codex App 默认会话列表识别），首轮默认注入 `FORGEOPS_META_SKILL.md` 作为执行约束（可用 `--no-meta-skill` 关闭，或用 `--meta-skill` 指定路径）。
- 追踪映射持久化在 `$FORGEOPS_HOME/codex-session-registry.json`（默认 `~/.forgeops/codex-session-registry.json`）。

## 服务托管（Daemon）

ForgeOps 提供统一服务命令，避免手工维护 `launchd/systemd` 配置：

- 安装并启动：
  - `forgeops service install`
- 启停与状态：
  - `forgeops service start`
  - `forgeops service stop`
  - `forgeops service restart`
  - `forgeops service status`
- 日志与卸载：
  - `forgeops service logs --lines 120`
  - `forgeops service uninstall`

可选参数（install/start）：
- `--host`、`--port`、`--poll-ms`、`--concurrency`
- `--runtime-home DIR`（默认 `~/.forgeops`）

## API 概览

- `GET /api/health`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/engine`
- `POST /api/engine`（动态调整并发/轮询）
- `GET /api/doctor`
- `GET /api/system/config`
- `PUT /api/system/config`
- `GET /api/projects/:id/issues`
- `POST /api/projects/:id/issues`
- `GET /api/projects/:id/metrics`
- `GET /api/projects/:id/scheduler`
- `PUT /api/projects/:id/scheduler`
- `GET /api/projects/:id/workflow`
- `PUT /api/projects/:id/workflow`
- `GET /api/projects/:id/skills/candidates`
- `GET /api/projects/:id/skills/resolve`
- `POST /api/projects/:id/skills/promote`
- `GET /api/skills/global`
- `POST /api/skills/global/promote`
- `GET /api/runs?projectId=<id>`
- `POST /api/runs`（Issue-Only：`projectId` 与 `issueId` 必填，`task` 可选）
- `GET /api/runs/:id`
- `POST /api/runs/:id/resume`
- `POST /api/runs/:id/attach-terminal`（仅允许 localhost 调用，返回终端拉起结果）
- `GET /api/events/stream?runId=<id>`（SSE）

`GET /api/projects/:id/metrics` 返回：
- GitHub API 口径工作项计数：`issue_count_all/open/closed`、`pr_count_all/open/closed`（基于项目绑定仓库 `origin`）
- 稳定口径代码指标：`code_lines`、`code_files`、`code_languages`（优先 Git tracked files）
- 7 天趋势：`code_trend_7d`（`git log --numstat` 聚合 added/deleted/net/commit）
- Token 指标：`token_total`、`token_input_total`、`token_output_total`、`token_cached_input_total`、`token_cache_hit_rate`
- run 状态分布、项目已运行时长等聚合指标

`POST /api/projects` 可选字段：

- `language`、`frontendStack`、`backendStack`、`ciProvider`
- `githubRepo`（例如 `owner/repo`）
- `githubVisibility`（`private` / `public`，默认 `private`）

## 文档入口（中文为主）

- `AGENTS.md`：文档地图（索引）
- `docs/00-index.md`
- `docs/architecture/00-overview.md`
- `docs/architecture/layering.md`
- `docs/design/core-beliefs.md`
- `docs/design/skill-driven-delivery.md`
- `docs/harness-engineering-guidelines.md`
- `docs/frontend-principles.md`
- `docs/quality/domain-grades.md`
- `docs/quality/verification-status.md`
- `docs/quality/golden-principles.md`
- `docs/meta/doc-freshness.md`
- `docs/meta/doc-structure.md`
- `docs/exec-plans/active/README.md`
- `docs/exec-plans/completed/README.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/product-specs/index.md`
- `docs/references/index.md`

## 文档治理检查（新鲜度 + 结构）

```bash
npm run docs:check
```
