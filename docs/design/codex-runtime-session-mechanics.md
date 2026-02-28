# Codex 运行机制与长会话压缩深度调研

Status: Active
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

## 目的与范围

本报告在上一份提示词工程调研的基础上，继续回答三个运行时问题：

1. Codex 的运行机制核心是什么，为什么可以长时间稳定运行。
2. 一个 session 长时间运行会出现什么问题。
3. 会话上下文压缩（compaction）是如何实现的。

本次仅基于本地源码，不做二手资料转述。

## 研究样本（源码范围）

- `~/ai-workflow/codex/codex-rs/core/src/codex.rs`
- `~/ai-workflow/codex/codex-rs/core/src/tasks/mod.rs`
- `~/ai-workflow/codex/codex-rs/core/src/compact.rs`
- `~/ai-workflow/codex/codex-rs/core/src/compact_remote.rs`
- `~/ai-workflow/codex/codex-rs/core/src/context_manager/history.rs`
- `~/ai-workflow/codex/codex-rs/core/src/context_manager/updates.rs`
- `~/ai-workflow/codex/codex-rs/core/src/thread_manager.rs`
- `~/ai-workflow/codex/codex-rs/core/src/unified_exec/mod.rs`
- `~/ai-workflow/codex/codex-rs/core/src/unified_exec/process_manager.rs`
- `~/ai-workflow/codex/codex-rs/core/src/message_history.rs`
- `~/ai-workflow/codex/codex-rs/core/src/rollout/recorder.rs`
- `~/ai-workflow/codex/codex-rs/protocol/src/openai_models.rs`
- `~/ai-workflow/codex/codex-rs/core/src/client.rs`

## 一、运行机制核心与稳定性来源

### 1.1 队列驱动的单会话状态机

Codex 会话本质是 queue-pair 模式：提交通道 + 事件通道。

- 提交通道是有界队列（`bounded(512)`），限制上游无穷写入：`codex-rs/core/src/codex.rs:319`。
- 事件通道由会话统一产出，`submission_loop` 串行消费操作：`codex-rs/core/src/codex.rs:320`、`codex-rs/core/src/codex.rs:3611`。
- Thread manager 要求首个事件必须是 `SessionConfigured`，用于保障启动一致性：`codex-rs/core/src/thread_manager.rs:526`、`codex-rs/core/src/thread_manager.rs:533`。

结论：状态更新路径集中，避免多入口并发修改历史导致的会话撕裂。

### 1.2 单活跃任务与可中断生命周期

- 每次 `spawn_task` 先中断当前任务，再注册新任务：`codex-rs/core/src/tasks/mod.rs:116`、`codex-rs/core/src/tasks/mod.rs:122`。
- 中断流程包含 cancellation token、短暂优雅等待、随后强制 abort：`codex-rs/core/src/tasks/mod.rs:259`、`codex-rs/core/src/tasks/mod.rs:268`、`codex-rs/core/src/tasks/mod.rs:273`。
- 用户主动中断时会终止 unified exec 子进程，清理侧效应：`codex-rs/core/src/tasks/mod.rs:184`、`codex-rs/core/src/tasks/mod.rs:245`。

结论：turn 生命周期可控，长运行时不会因为“历史任务悬挂”无限积累。

### 1.3 网络不稳定下的重试与降级

采样请求在 `run_sampling_request` 中执行重试与退避：

- 先进行可重试错误判定：`codex-rs/core/src/codex.rs:5464`。
- 按 provider 重试预算退避重连：`codex-rs/core/src/codex.rs:5468`、`codex-rs/core/src/codex.rs:5484`。
- websocket 重试耗尽后可自动切 HTTPS fallback：`codex-rs/core/src/codex.rs:5471`、`codex-rs/core/src/codex.rs:5477`。

结论：对瞬时网络抖动有工程缓冲层，而不是一次失败即崩。

### 1.4 可恢复持久化（rollout + resume/fork）

- 会话启动时会根据 `InitialHistory` 重建历史与基线：`codex-rs/core/src/codex.rs:1621`。
- 恢复时重建历史、恢复 token 信息、恢复工具选择：`codex-rs/core/src/codex.rs:1675`、`codex-rs/core/src/codex.rs:1685`、`codex-rs/core/src/codex.rs:1690`。
- Rollout recorder 以 JSONL 持久化并支持 flush/ack：`codex-rs/core/src/rollout/recorder.rs:70`、`codex-rs/core/src/rollout/recorder.rs:93`、`codex-rs/core/src/rollout/recorder.rs:99`。

结论：稳定性不仅是“本进程不挂”，也包括“挂后可恢复”。

### 1.5 资源上限机制

- unified exec 输出上限、token 上限、进程数上限（64）是硬编码保护：`codex-rs/core/src/unified_exec/mod.rs:60`、`codex-rs/core/src/unified_exec/mod.rs:62`。
- 进程池接近上限时按 LRU + 保护集进行 prune：`codex-rs/core/src/unified_exec/process_manager.rs:696`、`codex-rs/core/src/unified_exec/process_manager.rs:722`、`codex-rs/core/src/unified_exec/process_manager.rs:738`。
- 全局 message history 文件写入有锁，并按 hard/soft cap 裁剪：`codex-rs/core/src/message_history.rs:69`、`codex-rs/core/src/message_history.rs:159`、`codex-rs/core/src/message_history.rs:238`。

结论：长运行的“稳定”核心是有限资源原则，不是无限缓存。

## 二、长时间单 session 的问题与风险

### 2.1 多次压缩后的语义漂移

源码直接给出 warning：长线程 + 多次 compaction 会降低模型准确性，建议新开线程。

- 证据：`codex-rs/core/src/compact.rs:275`。

### 2.2 压缩是有损过程

Local compact 的替换历史以“摘要 + 有预算的用户消息”为主，保留窗口为 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20000`。

- 证据：`codex-rs/core/src/compact.rs:33`、`codex-rs/core/src/compact.rs:371`、`codex-rs/core/src/compact.rs:390`。

Remote compact 还会过滤大量非核心条目（如 reasoning、tool call/output），天然丢信息。

- 证据：`codex-rs/core/src/compact_remote.rs:205`、`codex-rs/core/src/compact_remote.rs:215`。

### 2.3 token 估算误差会影响触发时机

`ContextManager` 明确说明 token 估算是 byte-based 粗略下界，不是 tokenizer 精算。

- 证据：`codex-rs/core/src/context_manager/history.rs:117`。

结果是可能“偏早压缩”或“偏晚压缩”。

### 2.4 预采样压缩有已知 TODO 缺口

`run_turn` 的 TODO 指出：pre-turn compaction 目前未计入即将加入的 context updates + 用户输入。

- 证据：`codex-rs/core/src/codex.rs:4789`。

这会导致边界场景下阈值判断不够前瞻。

### 2.5 事件通道无界带来的背压风险

事件通道是 `unbounded()`。

- 证据：`codex-rs/core/src/codex.rs:320`。

如果前端/消费者异常慢读，存在内存压力放大的工程风险。

### 2.6 长会话跨模型恢复风险

恢复线程时若当前模型与历史模型不一致，会发出性能告警。

- 证据：`codex-rs/core/src/codex.rs:1660`。

这意味着长线程跨模型迁移会放大不可预期行为。

## 三、会话上下文压缩机制

### 3.1 阈值模型

- `auto_compact_token_limit` 默认为 context window 的 90%，且配置值会被 clamp 到 90% 上限：`codex-rs/protocol/src/openai_models.rs:239`、`codex-rs/protocol/src/openai_models.rs:263`。
- `effective_context_window_percent` 默认 95%，用于计算可用窗口：`codex-rs/protocol/src/openai_models.rs:210`、`codex-rs/core/src/codex.rs:601`。

### 3.2 触发点

1. Turn 前预采样检查：`run_pre_sampling_compact`。  
证据：`codex-rs/core/src/codex.rs:5131`。
2. Turn 中采样后检查：若达到阈值且 `needs_follow_up`，先 compact 再继续推理。  
证据：`codex-rs/core/src/codex.rs:5005`、`codex-rs/core/src/codex.rs:5022`。

### 3.3 执行分支：Local vs Remote

- OpenAI provider 走 remote compact：`codex-rs/core/src/codex.rs:5204`。
- 其他 provider 走 local compact：`codex-rs/core/src/codex.rs:5212`。

### 3.4 Local compact 流程

1. 注入 compact prompt，触发一次专用 compact turn。  
证据：`codex-rs/core/src/compact.rs:91`、`codex-rs/core/src/compact.rs:96`。
2. 从历史中取最后 assistant 内容，构造摘要文本。  
证据：`codex-rs/core/src/compact.rs:233`、`codex-rs/core/src/compact.rs:234`。
3. 按 token 预算从新到旧选取用户消息，必要时截断。  
证据：`codex-rs/core/src/compact.rs:390`、`codex-rs/core/src/compact.rs:402`。
4. 替换历史并重算 token usage。  
证据：`codex-rs/core/src/compact.rs:262`、`codex-rs/core/src/compact.rs:264`。

### 3.5 Remote compact 流程

1. 通过 compact endpoint 请求模型压缩历史。  
证据：`codex-rs/core/src/client.rs:295`、`codex-rs/core/src/compact_remote.rs:111`。
2. 对返回历史做清洗（过滤 developer 与非目标 user 项等）。  
证据：`codex-rs/core/src/compact_remote.rs:186`、`codex-rs/core/src/compact_remote.rs:205`。
3. 必要时回插 canonical initial context，再替换历史并重算 token。  
证据：`codex-rs/core/src/compact_remote.rs:187`、`codex-rs/core/src/compact_remote.rs:152`、`codex-rs/core/src/compact_remote.rs:154`。

### 3.6 压缩后的语境连续性保障

Codex 不是每次全量注入环境，而是“基线 + diff”：

- 如果 `reference_context_item` 缺失，走全量初始上下文注入。
- 否则仅注入 settings diff（环境/权限/协作模式/个性等）。

证据：`codex-rs/core/src/codex.rs:3095`、`codex-rs/core/src/codex.rs:3112`、`codex-rs/core/src/codex.rs:3131`、`codex-rs/core/src/context_manager/updates.rs:120`。

## 四、对 ForgeOps 的直接启发（面向接入）

1. 将“长会话可持续”定义为工程能力，而非模型能力。  
要求在 runtime adapter 层明确：中断、重试、降级、恢复、限流这五类状态。
2. 把 compaction 视作“损耗操作”，做可观测化。  
至少记录：触发原因、触发次数、压缩前后 token、是否 remote/local。
3. 让 UI 或运行日志在达到阈值时提示“切新线程”。  
该建议在 Codex 核心中已有内置警示，可在控制平面复用同类语义。

## 五、结论

Codex 之所以能稳定长跑，不在于单点算法，而在于一组互相配合的工程机制：

- 会话串行状态机（避免并发写乱序）
- 任务可中断与生命周期治理
- 采样重试与传输降级
- rollout 持久化与可恢复
- 工具与历史的资源上限控制
- token 阈值驱动的自动压缩

但长 session 不是“无代价”：多轮 compaction 会持续损耗语义保真度，应在产品侧明确“何时换线程”的运营策略。
