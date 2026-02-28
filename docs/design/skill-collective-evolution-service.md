# 技能群体进化中心服务设计（Opt-in）

Status: Active
Updated: 2026-03-01

## 文档定位

- 本文档用于设计与演进讨论，可能包含“目标态/候选方案”。
- 当前已落地行为以代码与 `docs/quality/verification-status.md` 为准。
- 若文档与代码冲突，请在同一 PR 同步修正文档。

## 目标

为 ForgeOps 提供“跨项目经验聚合 -> 模板技能升级 -> 客户端安全分发”的可选中心化能力，同时保持默认离线可用。

本设计回答三个问题：

1. 是否必须联网才能进化技能？
2. 如何在保护隐私前提下聚合实践经验？
3. 如何把聚合结果稳定下发为模板库升级？

## 结论

1. 本地技能演化闭环不依赖中心服务。
2. 群体经验聚合与模板库自动进化需要可选通信。
3. 推荐策略是“默认离线 + 显式 Opt-in 上报 + 可验证发布包”。

## 范围与非范围

## 范围（In Scope）

1. 定义中心服务的最小数据模型与 API。
2. 定义客户端上报与拉取协议（脱敏、签名、版本化）。
3. 定义模板晋升、灰度、回滚治理流程。
4. 定义多租户隔离与数据保留策略（MVP 级别）。

## 非范围（Out of Scope）

1. 上传源码、完整日志、密钥等敏感原文。
2. 构建跨租户可见的原始样本查询系统。
3. 引入复杂实时流计算平台（先批处理聚合）。
4. 在 v1 直接自动覆盖客户端本地稳定技能。

## 设计原则

1. Privacy First
- 默认不上报；用户显式开启后才发送脱敏摘要。

2. Evidence over Opinion
- 模板晋升依赖指标与证据，不依赖主观偏好。

3. Backward Compatible
- 模板发布包可回滚、可版本对比、可灰度启用。

4. Runtime-neutral
- 中心服务不绑定单一运行时实现，复用 ForgeOps 控制平面抽象。

## 逻辑架构

1. 客户端（ForgeOps 实例）
- 本地执行 run/step，维护项目内技能演化账本。
- 在 Opt-in 条件下上报脱敏经验摘要。
- 定期拉取模板包更新并执行本地灰度策略。

2. 中心聚合服务
- 接收并校验上报数据（schema + 签名 + 配额）。
- 进行按 `productType + tech profile` 的聚合分析。
- 产出模板候选、评估结果、发布版本。

3. 模板发布仓库
- 承载模板包与元数据（manifest/changelog/signature）。
- 提供渠道化分发（canary/stable）。

## 双闭环模型

1. 项目内闭环（Local Loop）
- baseline -> candidate -> trial -> stable -> deprecated

2. 平台群体闭环（Collective Loop）
- collect -> aggregate -> candidate-template -> canary-release -> stable-release -> deprecate

两条闭环通过“脱敏摘要事件”耦合，不通过源码耦合。

## 客户端-中心通信模型

## 模式开关

1. `offline`（默认）
- 不与中心通信，仅本地闭环演化。

2. `collective-opt-in`
- 上报脱敏事件，接收模板更新建议。

## 上报事件（MVP）

1. `skill_delta`
- 含义：本地技能发生候选/晋升/回滚等变更。
- 关键字段：
  - `tenant_id`
  - `project_fingerprint`
  - `product_type`
  - `tech_profile`
  - `skill_name`
  - `from_version`
  - `to_version`
  - `change_type`（candidate|promote|rollback|deprecate）
  - `failure_pattern_hashes`
  - `evidence_refs`（仅路径指纹或摘要，不传原文）

2. `skill_outcome`
- 含义：技能变更后的效果窗口统计。
- 关键字段：
  - `window_runs`
  - `done_rate`
  - `retry_rate`
  - `failed_rate`
  - `p50_step_ms`
  - `p95_step_ms`
  - `blocker_count`
  - `before_after_delta`

3. `template_feedback`
- 含义：客户端对中心下发模板的采用与结果反馈。

## 拉取对象（MVP）

1. `template_manifest.json`
- 描述版本、适用范围、渠道、依赖、签名摘要。

2. `template_bundle.tgz`
- 模板技能集合与角色映射建议。

3. `release_notes.md`
- 变更原因、证据摘要、回滚条件。

## 脱敏与安全策略

1. 字段级脱敏
- 禁止上报源码、命令原文、凭据、URL 查询参数明文。
- 允许上报哈希化模式和统计指标。

2. 传输安全
- TLS + 租户级 token。
- 请求签名（防重放）与时间戳窗口校验。

3. 存储安全
- 按租户逻辑隔离。
- 原始事件保留时间受策略约束（例如 30-90 天）。

4. 合规开关
- 支持企业策略：`deny_upload`, `allow_metrics_only`, `allow_signed_bundle_only`。

## 模板晋升治理

## 候选准入

1. 至少 3 个独立项目上报同类模式。
2. 候选变更具备可执行规则，不接受纯叙述。

## Canary 晋升门槛

1. `failed_rate` 不上升。
2. `retry_rate` 或关键耗时显著改善。
3. blocker 风险不增加。

## Stable 晋升门槛

1. 连续两个窗口满足 canary 门槛。
2. 无高严重度回归告警。

## 回滚触发

1. 稳定版在任一窗口出现显著劣化。
2. 多租户共同反馈高严重度回归。

## 模板库管理策略

1. 模板元数据
- `template_id`, `version`, `status`, `owner`, `scope`, `deprecation_policy`

2. 发布渠道
- `canary`, `stable`, `deprecated`

3. 生命周期
- `experimental -> canary -> stable -> deprecated`

4. 变更要求
- 每次发布必须附带证据摘要与回滚版本。

## 与现有 ForgeOps 模块映射

1. 客户端侧
- `src/core/skills.js`：模板读写与版本元信息接入。
- `src/core/store.js`：指标聚合与事件提取。
- `src/server/app.js`：上报/拉取管理 API（可选开关）。
- `src/worker/engine.js`：在 cleanup/review 节点触发反馈输出。

2. 文档与治理侧
- `docs/design/skill-evolution-closed-loop.md`
- `docs/exec-plans/tech-debt-tracker.md`

## 分阶段落地建议

## Phase 1：协议冻结

1. 固化三类上报事件 schema。
2. 固化模板 manifest/bundle 规范。
3. 增加本地配置开关与默认离线策略。

## Phase 2：只读聚合

1. 仅做数据接收与分析，不自动发布。
2. 人工审核模板候选，输出建议报告。

## Phase 3：渠道发布

1. 上线 canary/stable 发布通道。
2. 客户端支持策略化拉取与本地灰度。

## Phase 4：自动回滚辅助

1. 引入劣化检测告警。
2. 触发“建议回滚”而非无条件强制回滚。

## 验收标准（MVP）

1. 离线模式下功能完整不退化。
2. Opt-in 客户端可安全上报并通过 schema 校验。
3. 中心可产出可签名模板包并被客户端识别。
4. 模板升级与回滚具备可追溯证据链。

