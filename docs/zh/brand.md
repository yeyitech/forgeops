# ForgeOps 品牌页：Harness Engineering

Status: Active
Updated: 2026-03-01

## Build Fast. Keep Entropy Under Control.

ForgeOps 不是“再包一层 Agent CLI”。
ForgeOps 是 AI 研发流水线的控制平面，把 `Issue -> Run -> Step -> PR` 做成可观测、可恢复、可治理的工程系统。

## ForgeOps 不是一个 Skill，而是一支研发 Agent Team 的控制面

ForgeOps 本体是控制平面，不是单个 skill。
但为了让任意 Agent Runtime 都能无缝进入控制面，我们提供一个 **Meta Skill** 作为入口（当前对 Codex 体验最好）：

- skill 指导 agent 调用 `forgeops` CLI，进入项目托管工作流
- ForgeOps 默认以 Codex 为 runtime，编排多角色团队：架构师、需求管理、研发、测试、评审、治理/垃圾回收
- 每一步动作都落成 `Run -> Step -> Session` 可观测状态，失败可恢复、结果可复盘

对使用者来说，你只需要准备：

- 网络与账号（GitHub / Codex token）
- 一个可运行的项目仓库

## 吞吐量上来后，真正稀缺的是注意力

在 Agent 驱动研发里，问题不只是写得更快，而是避免反复踩坑、架构漂移和文档失真。

常见问题面：

- 上下文失真：关键知识无法稳定注入到每次执行。
- 质量假阳性：CI 通过但平台真实运行失败。
- 过程不可追溯：失败原因分散在聊天和日志碎片里。
- 熵增累积：一次次“热修”最终变成系统性技术债。

ForgeOps 的处理方式：

- 结构化工作流：项目级 `workflow.yaml` 统一执行主循环。
- 运行态双闸门：CI Gate 与 Platform Gate 同时存在。
- 会话恢复机制：优先续跑上下文，避免中断导致重做。
- 周期清理与治理：cleanup + 调度任务持续回收熵增。

## CLI 可以返回“状态卡片”（SVG）

当你需要把“现在系统到底在干什么”快速贴到 issue / 群里 / 会话里时，ForgeOps CLI 可以直接生成一张 SVG 图并保存到配置目录（默认 `~/.forgeops/charts/`）。Agent 在 skill 指导下执行命令即可拿到图片路径并发送。

```bash
forgeops chart system
forgeops chart project <projectId>
forgeops chart run <runId>
forgeops chart run <runId> --step implement
forgeops chart session <sessionId>
```

## Harness 不是口号，是可执行约束

### 1. Context Engineering

用短地图（`AGENTS.md`）+ 深文档索引（`docs/00-index.md`）+ 技能装配约束，控制上下文规模并提高可重入性。

### 2. Architectural Constraints

把边界、不变量、依赖方向从“约定”变成“可检查规则”。

### 3. Observability

`run / step / session / events / artifacts` 全链路可追踪，可定位、可复盘、可比较。

### 4. Garbage Collection

把技术债回收纳入系统周期，而不是等事故后再临时清理。

## 双循环模型：交付循环 + Harness 循环

### 交付循环（默认 6 步）

1. Architect：定义边界与方案约束。
2. Issue：形成结构化需求入口。
3. Implement：在独立 worktree 开发与提交。
4. Test：执行测试与平台验收。
5. Review：评审与风险收敛。
6. Cleanup：回收熵增并沉淀可复用能力。

### Harness 循环（防复发）

1. 观测失败模式。
2. 定位缺失能力（工具/规则/上下文）。
3. 把经验写成机制（文档/脚本/不变量/技能）。
4. 在真实运行中验证复发率下降。

## 核心能力

- Runtime Adapter：运行时边界稳定，当前默认接入 Codex。
- GitHub 强流程：Issue-Only 入口 + PR 归档闭环。
- Session Recovery：中断后优先恢复上下文继续执行。
- Quality Gates：不变量校验 + 平台验收双闸门。
- Scheduler Automation：cleanup / issue auto-run / skill promotion 定时化。
- Skill Governance：技能候选独立晋升，和需求交付解耦。

## 标准路径（How It Works）

1. 创建或接收 GitHub Issue。
2. 创建 Run 并绑定隔离 worktree。
3. 按 DAG 调度 step。
4. 执行质量闸门与预算内自愈。
5. PR 合并、收尾清理、回写状态。

## 可证实能力（当前）

- Node.js 22+ 的稳定运行基线。
- 文档与流程的结构化治理检查。
- 默认 quick 路由 + standard 升级策略。
- GitHub Pages 自动化发布文档站。

## 下一步建议

当你把 ForgeOps 对外展示为开源项目时，建议优先补齐三类证据：

- 真实运行指标（成功率、恢复率、失败复发率）。
- 用户故事案例（团队规模、场景、结果）。
- 可公开演示链接（docs、示例仓、演示视频）。
