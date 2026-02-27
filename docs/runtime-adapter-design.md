# Runtime Adapter 设计

Status: Active
Updated: 2026-02-25

## 目标

保证 ForgeOps “控制平面稳定”，同时允许运行时自由替换。

## 适配器契约

每个运行时实现以下能力：

- `kind`
- `capabilities()`
- `runStep({ cwd, prompt, model, outputSchema, onRuntimeEvent })`

统一返回：

- `status`: `done | retry | failed`
- `summary`: 执行摘要
- `rawOutput`: 原始输出
- `structured`: 结构化结果
- `runtime`: 进程/模型/线程/token 等元数据

## 当前实现

### 1) codex-exec-json（默认）

- 命令：`codex exec --json`
- 使用 `--output-schema` 强约束结果结构
- 从 JSONL 事件流写入状态与可观测数据

选择它作为 v1 默认的原因：

- 接入简单
- 行为清晰
- 足够支撑当前观测与控制需求

### 2) codex-app-server（实验）

- 命令：`codex app-server --listen stdio://`
- 协议：JSON-RPC over stdio

v1 不作为默认原因：

- 协议面更复杂
- 实验接口演进风险更高

## 后续扩展

同一契约可扩展到：

- Claude Code
- OpenCode
- 其他本地/远程智能体运行时
