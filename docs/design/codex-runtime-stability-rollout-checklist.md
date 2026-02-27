# Codex 长会话稳定性落地清单（ForgeOps）

Status: Active
Updated: 2026-02-26

## 目的

把 `docs/design/codex-runtime-session-mechanics.md` 的研究结论转成可执行的接入任务，面向 ForgeOps 当前默认运行时 `codex-exec-json`，并保持 Runtime Adapter 边界稳定。

## 适用范围

- 默认运行时：`codex-exec-json`（`src/runtime/codex-exec-json.js`）
- 执行引擎：`src/worker/engine.js`
- 会话持久化与事件流：`src/core/store.js`、`src/server/app.js`
- UI 观测面：`frontend/src/app-root.ts`

## 总体策略

1. 先做观测和告警，不改核心调度语义。  
2. 再做策略化阈值（切线程提示、压缩风险提示）。  
3. 最后做体验增强（UI 可视化、自动建议回收）。  

## 阶段划分

### 阶段 P0（立即执行，低风险）

目标：先让系统“看得见”长会话风险。

| ID | 任务 | 落点文件 | 验收标准 |
| --- | --- | --- | --- |
| P0-1 | 统一会话事件基线（resume attempt/result、thread/turn 生命周期） | `src/runtime/codex-exec-json.js`、`src/worker/engine.js` | `run` 详情可稳定看到 `runtime.thread.resume.attempt`、`runtime.thread.resumed`、`runtime.turn.started`、`runtime.turn.completed/failed` |
| P0-2 | 在 session 记录中固化 thread/turn 追踪字段 | `src/core/store.js` | 每个 step 的 `sessions` 记录均含 `thread_id`、`turn_id`、`requested_model`、`effective_model` |
| P0-3 | 补充“长会话风险”判定事件（仅事件，不阻塞） | `src/worker/engine.js` | 当同一 step 重复续跑且持续失败时，发出 `runtime.session.risk` 事件，run 不中断 |
| P0-4 | 在 API/SSE 中保持事件透传 | `src/server/app.js` | 前端可实时订阅并展示新增 `runtime.session.risk` 事件 |

说明：P0 不改变 `done/retry/failed` 判定，仅新增观测能力。

### 阶段 P1（短期执行，中风险）

目标：引入策略阈值与可解释告警。

| ID | 任务 | 落点文件 | 验收标准 |
| --- | --- | --- | --- |
| P1-1 | 增加运行策略配置（项目级） | `.forgeops/context.md`（约定）+ `src/core/store.js`（读取） | 可为项目设置 `longSessionPolicy`，不配置时使用默认值 |
| P1-2 | 策略阈值触发告警 | `src/worker/engine.js` | 达到阈值时发 `runtime.session.rotate.recommended`，并附带原因 |
| P1-3 | 失败回退路径标准化 | `src/runtime/codex-exec-json.js` | resume 失败后 fallback 到 fresh run，且结果里显式标记 `resumeAttempted=true`、`resumeSucceeded=false` |
| P1-4 | 输出可读建议（非阻塞） | `src/worker/engine.js` | 在 step 事件中追加“建议新开线程/拆小任务”的建议文本，不改变状态机 |

建议默认阈值（P1）：

- `maxResumeFailuresPerStep = 2`
- `maxRetriesPerStep = 3`（沿用现有重试语义）
- `sessionRiskWindowMinutes = 30`

### 阶段 P2（中期执行，增强）

目标：让风险治理进入产品闭环。

| ID | 任务 | 落点文件 | 验收标准 |
| --- | --- | --- | --- |
| P2-1 | UI 增加“会话健康度”卡片 | `frontend/src/app-root.ts` | 每个 step 可看到 session 健康状态（normal/risk/rotate-recommended） |
| P2-2 | 自动汇总风险到技术债 | `src/core/store.js`、`docs/exec-plans/tech-debt-tracker.md` | 同类风险重复触发后生成追踪项 |
| P2-3 | 为 runtime adapter 增加稳定性能力声明 | `src/runtime/index.js`、`docs/runtime-adapter-design.md` | `capabilities()` 可识别 `session_resume`、`risk_signal` 等能力 |
| P2-4 | 增加回归验证脚本 | `scripts/` + `docs/quality/verification-status.md` | 有最小烟测覆盖“resume 成功/失败 fallback/风险告警” |

## 推荐配置模型（文档约定）

用于后续在项目上下文中声明运行策略。

```yaml
runtimePolicy:
  longSession:
    maxResumeFailuresPerStep: 2
    sessionRiskWindowMinutes: 30
    recommendRotateOnRepeatedCompaction: true
    recommendRotateOnModelSwitchResume: true
```

约束：

- 该配置在 P1 前属于文档约定；P1 实现读取逻辑后生效。
- 若未配置，使用内置默认值，不阻断 run。

## 事件与字段规范（建议）

新增事件名建议：

- `runtime.session.risk`
- `runtime.session.rotate.recommended`

事件 payload 最小字段：

- `stepId`
- `threadId`
- `turnId`
- `reason`
- `evidence`（数组，记录触发条件）
- `recommendedAction`

session 记录建议字段（优先复用现有列）：

- `thread_id`
- `turn_id`
- `requested_model`
- `effective_model`
- `status`
- `error`

## 验收口径（DoD）

1. 对同一问题，系统能区分：
- “可恢复重试”
- “建议切新线程”
- “直接失败”
2. 运行详情页可追踪一次 step 的完整 session 轨迹（含 resume 与 fallback）。
3. 新增能力不破坏现有 `step.done/step.retry/step.failed` 语义。
4. 文档治理检查通过：
- `node scripts/check-doc-structure.js`
- `node scripts/check-doc-freshness.js`

## 与现有实现的对齐说明

当前实现已具备以下基础能力：

- 会话续跑与失败回退：`src/runtime/codex-exec-json.js`
- runtime 事件转发到 store：`src/worker/engine.js`
- session 落库字段（thread/turn/model/status）：`src/core/store.js`

本清单只是在此基础上增加“风险信号与策略层”，不改 Runtime Adapter 核心契约：

- `status: done | retry | failed`
- `summary/rawOutput/structured/runtime`

## 关联文档

- `docs/design/codex-runtime-session-mechanics.md`
- `docs/runtime-adapter-design.md`
- `docs/quality/verification-status.md`
- `docs/exec-plans/tech-debt-tracker.md`
