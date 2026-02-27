# 技能群体进化中心服务实施计划（MVP）

Status: Active
Updated: 2026-02-25

## 关联设计

- `docs/design/skill-collective-evolution-service.md`
- `docs/design/skill-evolution-closed-loop.md`
- `docs/design/skill-driven-delivery.md`

## 背景与目标

ForgeOps 当前已经具备项目内技能本地化演化思路，但缺少跨项目经验聚合通道，无法将有效实践稳定回灌为模板技能库。

本计划目标是在“默认离线不受影响”的前提下，落地可选中心化能力：

1. 让 Opt-in 客户端上报脱敏技能经验摘要。
2. 让中心服务聚合并产出可验证模板候选。
3. 让客户端按渠道安全拉取模板包并支持回滚。

## 范围（In Scope）

1. 客户端与中心服务通信协议（上传/拉取）。
2. 最小事件 schema：`skill_delta`、`skill_outcome`、`template_feedback`。
3. 模板包发布协议：manifest + bundle + signature。
4. canary/stable 渠道治理与回滚策略。
5. 文档、索引与验收脚本同步更新。

## 非范围（Out of Scope）

1. 上传源码、原始日志、凭据等敏感数据。
2. 全自动无人工审批的模板晋升。
3. 复杂流式计算平台与实时在线学习。
4. 强制所有用户联网参与群体进化。

## 并行实施线

## A 线：API 与通信控制面

目标：定义并实现中心服务最小 API 面，支持租户隔离和 opt-in 控制。

核心接口（MVP）：

1. `POST /api/collective/events`
- 上传脱敏事件批次（支持幂等键）。

2. `GET /api/collective/templates/manifest`
- 拉取适配当前项目画像的模板清单。

3. `GET /api/collective/templates/:templateId/:version/bundle`
- 下载模板包与签名信息。

4. `POST /api/collective/templates/feedback`
- 回传模板采用结果与窗口效果。

## B 线：Schema 与数据治理

目标：冻结事件 schema、脱敏规则、数据保留与质量检查策略。

关键产出：

1. 事件 schema 文档与校验器。
2. 脱敏规则白名单/黑名单。
3. 租户隔离与保留策略（TTL/审计字段）。
4. 指标聚合口径（done/retry/failed、耗时、blocker）。

## C 线：发布协议与灰度治理

目标：建立模板版本发布、灰度分发、回滚闭环。

关键产出：

1. `template_manifest.json` 规范。
2. `template_bundle.tgz` 打包规范。
3. 签名与校验流程。
4. 渠道策略（canary -> stable -> deprecated）。
5. 回滚触发规则与执行手册。

## 里程碑与进度

| 里程碑 | 状态 | 目标日期 | 重点 |
| --- | --- | --- | --- |
| M0 设计冻结 | done | 2026-02-25 | 群体进化中心服务设计完成并入索引 |
| M1 协议冻结（API+Schema） | planned | 2026-02-28 | A/B 线完成接口与事件规范 |
| M2 聚合与候选报告 | planned | 2026-03-03 | 输出模板候选评估报告（人工审核） |
| M3 渠道发布与客户端拉取 | planned | 2026-03-07 | C 线打通 canary/stable 发布链路 |
| M4 回滚与运营化 | planned | 2026-03-10 | 劣化检测、回滚策略、运营手册 |

## WBS（按模块）

1. `src/server/app.js`
- 新增中心通信 API 开关与端点（可选启用）。

2. `src/core/store.js`
- 聚合本地 run/step 指标，生成可上报摘要。

3. `src/core/skills.js`
- 增加模板版本与发布元信息解析支持。

4. `src/worker/engine.js`
- cleanup/review 阶段产出结构化反馈事件。

5. `frontend/src/app-root.ts`
- 展示模板渠道版本、采纳状态、最近回滚事件（后续阶段）。

## 决策日志

## 2026-02-25

1. 采用“默认离线 + 明确 Opt-in”策略，避免破坏现有用户使用路径。
2. 先做事件摘要与发布协议，不做自动晋升。
3. 先以 canary 渠道验证，稳定后再推广 stable。

## 风险与缓解

1. 风险：脱敏不充分导致合规风险。
- 缓解：schema 层强制字段检查，默认拒绝未知字段。

2. 风险：指标口径不一致，导致模板误晋升。
- 缓解：先冻结 MVP 指标口径，不在阶段内频繁改口径。

3. 风险：中心发布包质量问题扩大影响。
- 缓解：强制 canary，设置回滚阈值与签名校验。

4. 风险：客户端接入成本过高。
- 缓解：先支持只读拉取模式，上报与发布能力分步启用。

## 回滚策略

1. 服务端保留最近两个 stable 版本模板包。
2. 客户端缓存上一个 stable 版本，拉取失败自动回退。
3. 出现回归时按租户或全局渠道快速降级至上一版本。

## 验收标准（MVP）

1. 离线模式下功能不回退，默认行为不变。
2. Opt-in 客户端可成功上报事件并通过 schema 校验。
3. 客户端可拉取并校验签名模板包。
4. canary 渠道出现劣化时可在一个发布窗口内回滚。
5. 全链路有可审计记录（事件、发布、回滚）。

