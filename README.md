# ForgeOps

ForgeOps is a runtime-agnostic AI R&D control plane.

它不只是“再包一层 Agent CLI”，而是把团队日常的研发动作变成一条可观测、可恢复、可治理的交付系统：

`Idea -> Issue -> Run -> Step -> PR -> Merge`

当 AI 参与开发后，速度通常不是第一瓶颈，真正稀缺的是注意力和稳定性。ForgeOps 的目标是：在保持迭代速度的同时，压住熵增和复发性问题。

## Why ForgeOps

团队把 Agent 用起来后，经常会遇到这些问题：

- 交付过程不可追踪，失败只能靠聊天记录回忆。
- 改动能过 CI，但到真实运行环境才暴露问题。
- 局部修补越来越多，长期架构和文档持续漂移。
- 每次排障都像“重新认识这个项目”。

ForgeOps 提供的不是更多命令，而是更稳定的工程行为约束：

- Issue 驱动执行，需求入口统一。
- Run/Step 全链路状态可观测，可回放，可恢复。
- Quick / Standard 双模式路由，默认 `quick`，风险升高再升级。
- 质量闸门与周期治理并存，避免“交付完成但系统变脆弱”。

## User Stories

### 1. 小团队高频上线

“我们每天有很多小改动，想让 Agent 多干活，但不想每天盯流程细节。”

ForgeOps 提供 `quick` 默认路径，小改动可以低成本推进；一旦影响面变大，再切到 `standard`，不用推翻已有流程。

### 2. 中大型项目稳定交付

“我们需要可审计链路，知道每次改动是谁在什么步骤做了什么。”

ForgeOps 把执行拆成可追踪的 `Run -> Step -> Session`，并把状态结构化存储，不靠口头同步。

### 3. 需要本地探索 + 正式流水线并存

“我有时只想本地快速修一下；准备合并时再走正式流程。”

ForgeOps 支持 `forgeops codex project --local-only` 本地直改，也支持 issue/run 标准交付链路，两者可按场景切换。

### 4. 关注长期质量与技术债

“我们不是缺一次修复，而是缺防复发机制。”

ForgeOps 把治理动作纳入系统循环（如 cleanup、文档/结构校验、技能候选晋升），让经验可以沉淀为机制。

## What Makes It Different

- Runtime Adapter 边界稳定，当前默认接入 Codex，后续可扩展更多运行时。
- Issue-Only 交付模型，减少需求入口分裂。
- Worktree 隔离执行，降低并行任务互相污染。
- Session 支持恢复，优先复用上下文，降低中断成本。
- 平台质量闸门（Platform Gate）与 CI Gate 并存，减少“假完成”。

## Quick Start (60 Seconds)

如果你现在只想“马上用起来”，最快路径是安装一个技能给 Agent。

### Option A: 一条命令安装到 Codex（推荐）

```bash
bash scripts/install-forgeops-skill.sh --agent codex
```

默认会安装到：`~/.codex/skills/forgeops/SKILL.md`。

### Option B: 手动复制技能文件

```bash
mkdir -p ~/.codex/skills/forgeops
cp FORGEOPS_META_SKILL.md ~/.codex/skills/forgeops/SKILL.md
```

### Option C: 直接粘贴技能内容

把 [FORGEOPS_META_SKILL.md](FORGEOPS_META_SKILL.md) 的内容直接粘贴到你的 Agent 自定义指令里，也可以立即使用。

完成后重启 Codex，并在会话里直接下任务即可。

## Full Control Plane Setup (Optional, 10 Minutes)

如果你需要 Issue/Run 可审计流水线，再做完整初始化：

### 0) Prerequisites

- Node.js 22+
- `codex`, `git`, `gh` 可用
- 已配置全局 git 身份（`user.name` / `user.email`）
- 已配置 GitHub PAT（至少 `repo`, `workflow`）

### 1) Initialize a managed project

```bash
forgeops project init --name demo --type web --path /absolute/path/to/demo
```

### 2) Start control plane

```bash
forgeops start --port 4173
```

### 3) Pick a working mode

本地直改（不触发 issue/run 流水线）：

```bash
forgeops codex project --local-only
```

正式流水线（Issue -> Run）：

```bash
forgeops issue create <projectId> "修复登录重定向"
forgeops run list --project <projectId>
```

## Run Modes (Default: quick)

ForgeOps 现在只有两种 run mode：

- `quick`：单点修复、配置/脚本变更、文档更新、低风险回归
- `standard`：跨模块改造、架构变更、数据迁移、权限/安全相关变更

未显式传参时默认 `quick`。例如：

```bash
forgeops issue create <projectId> "修复埋点字段"
# 等价于 --mode quick
```

需要完整流程时显式指定：

```bash
forgeops issue create <projectId> "重构鉴权链路" --mode standard
```

## What `project init` Actually Does

`forgeops project init` 不只是建目录。默认会完成：

- 运行时与系统前置检查（runtime/git/github）
- 项目级 `.forgeops/*` 脚手架与治理文件落盘
- GitHub 仓库绑定/创建与分支初始化
- 项目注册到 ForgeOps store，接通后续 issue/run/scheduler 能力

面向用户的完整说明见：
- [docs/project-init-user-guide.md](docs/project-init-user-guide.md)

## Packaging Roadmap

接下来会提供 npm 包发布与更快安装入口，目标是：

- 支持 `npx` 直接使用 ForgeOps CLI。
- 提供 `npx` 一键安装命令（含技能安装/初始化引导）。
- 保持“仅复制技能即可使用”的零门槛路径。

## Documentation

- [docs/user-quickstart.md](docs/user-quickstart.md): 1 页上手卡（最小命令集）
- [docs/user-guide.md](docs/user-guide.md): 用户操作手册（模式、流程、排障）
- [docs/project-init-user-guide.md](docs/project-init-user-guide.md): 初始化动作详解
- [docs/index.md](docs/index.md): 网站首页（VitePress）
- [docs/architecture/00-overview.md](docs/architecture/00-overview.md): 架构总览
- [docs/harness-engineering-guidelines.md](docs/harness-engineering-guidelines.md): Harness 工程原则
- [docs/00-index.md](docs/00-index.md): 文档地图

## Project Website (GitHub Pages)

仓库已提供 GitHub Pages 自动部署工作流：

- Workflow: [.github/workflows/pages.yml](.github/workflows/pages.yml)
- 文档站框架：VitePress（`docs/` 目录）
- 顶部导航：GitHub Star/Fork 按钮 + 版本标识 + 语言切换
- 双语入口：`/zh/`（中文）与 `/en/`（English）
- 品牌页：`/zh/brand` 与 `/en/brand`
- 品牌完整页（HTML）：`/harness-engineering.html`

本地预览：

```bash
npm run docs:site:dev
```

构建静态站：

```bash
npm run docs:site:build
```

首次启用时，在仓库设置里把 Pages Source 设为 `GitHub Actions`。  
发布地址通常为：`https://<org-or-user>.github.io/<repo>/`。

## Current Status

- v1 默认运行时：Codex（`codex-exec-json`）
- 默认交付策略：Issue 驱动 + Quick 默认路由
- 目标：在不牺牲速度的前提下，把交付过程做成可持续治理的系统

## Contributing

欢迎提交 issue / PR。

推荐从这三份文档开始：

- [AGENTS.md](AGENTS.md)
- [docs/00-index.md](docs/00-index.md)
- [docs/architecture/00-overview.md](docs/architecture/00-overview.md)

如需先验证本地环境，可运行：

```bash
forgeops doctor
forgeops service status
```

## Acknowledgements

ForgeOps 的设计和落地过程中，参考并受益于 Codex 开源项目生态。  
特别致谢 [openai/codex](https://github.com/openai/codex) 对社区的开放贡献。

## License

This project is licensed under the MIT License.  
See [LICENSE](LICENSE) for details.
