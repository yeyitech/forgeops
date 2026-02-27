# Codex Session LiveView 能力契约（ForgeOps）

Status: Active
Updated: 2026-02-26

## 背景与目标

用户目标不是“看日志”，而是“真的看某个 Agent Session 在如何干活”。

ForgeOps 在该场景中的定位：

- 提供稳定、可审计、可多端消费（Web/移动端）的 Session 观测能力。
- 将 Codex runtime 的原始事件转化为可查询、可回放、可实时订阅的能力接口。

本契约聚焦能力提供层，不限定具体前端技术实现。

## 范围与非目标

范围：

- Session 元数据查询
- Session 事件时间线（历史回放）
- Session 实时流（tail）
- Session 证据视图（命令、输出、文件改动、检查结果）
- 受控操作入口（resume/fork/interruption）的接口约束

非目标：

- 不暴露模型原始思维链（chain-of-thought）
- 不要求移动端直接解析 runtime 原始协议
- 不在本阶段改造运行时核心调度语义

## 体验定义（产品语言）

给定一个 `runtime_session_id`，用户应能在 10 秒内回答：

1. 这个 session 属于哪个 `run/step/agent`。
2. 它当前在做什么（正在执行什么 turn/工具/命令）。
3. 它刚刚做了什么（可回放时间线）。
4. 它造成了什么结果（改动/测试/错误证据）。
5. 下一步可做什么（继续观察、fork、resume、中断）。

## 能力分层（Provider Model）

### L1: Session Metadata

读取会话基础状态，不含大体量事件。

最小字段：

- `sessionId`
- `runId`
- `stepId`
- `agentId`
- `runtime`
- `status`
- `threadId`
- `turnId`
- `requestedModel`
- `effectiveModel`
- `startedAt`
- `endedAt`

### L2: Session Timeline

标准化事件流，支持历史分页与实时订阅。

最小事件字段：

- `id`（单调递增）
- `sessionId`
- `ts`
- `eventType`
- `severity`（`info|warn|error`）
- `payload`

### L3: Session Evidence

用于“真正在干活”的证据面：

- 命令执行摘要（命令、退出码、耗时、输出片段）
- 文件改动摘要（路径、增删行、阶段）
- 检查器/测试结果（通过/失败与摘要）
- 风险信号（resume fallback、long-session risk、rotate recommended）

### L4: Session Control（受控）

操作能力与观察能力分离：

- `resume`（执行动作，可能有副作用）
- `fork`（推荐动作，低副作用）
- `interrupt`（中断动作）

约束：观察接口必须只读，控制接口必须单独鉴权并有审计记录。

## 事件规范（标准化）

建议事件域：

- `lifecycle.*`
- `runtime.*`
- `tool.*`
- `exec.*`
- `artifact.*`
- `risk.*`
- `control.*`

建议首批事件名：

- `lifecycle.session.started`
- `lifecycle.turn.started`
- `lifecycle.turn.completed`
- `lifecycle.turn.failed`
- `runtime.thread.started`
- `runtime.thread.resumed`
- `runtime.resume.fallback`
- `exec.command.started`
- `exec.command.chunk`
- `exec.command.completed`
- `artifact.files.changed`
- `artifact.test.completed`
- `risk.session.flagged`
- `risk.rotate.recommended`

事件 payload 建议保底字段：

- `reason`（触发原因）
- `evidence`（数组，证据片段）
- `trace`（可选，thread/turn/call 关联）

## API 契约（v1）

### 1) Session 元数据

`GET /api/sessions/:id`

响应（示例）：

```json
{
  "data": {
    "sessionId": "sess_xxx",
    "runId": "run_xxx",
    "stepId": "step_xxx",
    "agentId": "developer",
    "runtime": "codex-exec-json",
    "status": "running",
    "threadId": "thread_xxx",
    "turnId": "turn_xxx",
    "requestedModel": "gpt-5.3-codex",
    "effectiveModel": "gpt-5.3-codex",
    "startedAt": "2026-02-26T02:00:00.000Z",
    "endedAt": null
  }
}
```

### 2) Session 时间线（历史）

`GET /api/sessions/:id/events?afterId=<id>&limit=<n>`

约束：

- 默认 `limit=100`，上限建议 `500`。
- 按 `id` 升序返回，便于前端增量合并。

### 3) Session 实时流

`GET /api/sessions/:id/stream?sinceId=<id>`

协议：

- SSE（`text/event-stream`）
- 事件名统一为 `session-event`
- payload 与 `/events` 单条格式一致

### 4) Session 证据聚合

`GET /api/sessions/:id/evidence`

返回：

- 最近命令摘要
- 最近文件变更摘要
- 最近检查结果摘要
- 当前风险状态

### 5) Resume 命令模板（只读）

`GET /api/sessions/:id/resume-command`

返回：

- `threadId`
- `runtime`
- 可复制命令模板
- 风险提示（`resume may trigger real execution`）

注意：该接口不执行 resume，只提供操作建议。

## 移动端消费契约（Snapshot）

为降低移动端复杂度，提供聚合快照接口：

`GET /api/mobile/sessions/:id/snapshot`

返回结构：

- `meta`（会话元数据）
- `now`（当前状态卡）
- `highlights`（最近关键事件）
- `evidence`（关键证据）
- `actions`（可执行动作及权限）

约束：

- 控制在单次响应 50KB 以内。
- 默认返回最近 20 条关键事件（可配置）。

## 权限与安全

权限分级：

- `session:read`：读取 meta/events/evidence
- `session:control`：resume/fork/interruption

策略约束：

- `resume` 默认二次确认，且必须写审计日志。
- 对输出做敏感信息遮蔽（token/key/secret 常见模式）。
- 对大输出做截断并保留 hash，避免存储膨胀。

## 存储与保留策略

建议新增 `session_runtime_events` 持久化表（或等效存储）：

- `id`
- `session_id`
- `run_id`
- `step_id`
- `ts`
- `event_type`
- `severity`
- `payload_json`
- `raw_line`（可选，限长）

保留策略建议：

- 热数据：14 天
- 冷归档：按项目策略
- 超限按时间分段裁剪，保留关键事件优先

## 与现有代码映射

推荐落点：

- runtime 采集：`src/runtime/codex-exec-json.js`
- 事件汇聚：`src/worker/engine.js`
- session 存储：`src/core/store.js`
- API/SSE：`src/server/app.js`
- UI 展示：`frontend/src/app-root.ts`

## 分阶段实施建议

### P0（最小可用）

- `/api/sessions/:id`
- `/api/sessions/:id/events`
- `/api/sessions/:id/stream`
- `resume-command` 只读接口

### P1（体验增强）

- `/evidence` 聚合接口
- `risk.*` 事件体系
- Web 端 Session LiveView 面板

### P2（多端能力化）

- `/api/mobile/sessions/:id/snapshot`
- 控制动作权限矩阵
- 跨 runtime 统一事件字典

## 验收标准（DoD）

1. 给定任意 `runtime_session_id`，可在 10 秒内定位对应 run/step/thread。
2. 可回放该 session 的完整关键事件链路。
3. 可实时观察运行状态变化（SSE）。
4. 观察与控制接口权限隔离，且控制有审计。
5. 不破坏现有 `step.done/retry/failed` 语义。

## 关联文档

- `docs/design/codex-runtime-session-mechanics.md`
- `docs/design/codex-runtime-stability-rollout-checklist.md`
- `docs/runtime-adapter-design.md`
- `docs/quality/verification-status.md`
