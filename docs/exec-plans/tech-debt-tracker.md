# 技术债追踪

Status: Active
Updated: 2026-02-27

| ID | 问题 | 影响 | 优先级 | 状态 | 责任角色 |
| --- | --- | --- | --- | --- | --- |
| TD-001 | 文档结构检查能力刚建立，需要持续迭代规则覆盖 | 上下文治理稳定性 | P1 | open | cleanup |
| TD-002 | 技能升级闭环缺失，模板技能无法稳定本地化演进（关联计划：`docs/exec-plans/active/skill-evolution-closed-loop-implementation.md`） | 交付稳定性、技能质量治理 | P1 | in-progress | architect/reviewer/cleanup |
| TD-003 | 缺少群体进化通信与模板发布治理，跨项目经验无法系统回灌（关联计划：`docs/exec-plans/active/skill-collective-evolution-service-implementation.md`） | 模板库演化效率、跨项目复用能力 | P1 | in-progress | architect/platform/reviewer |
| TD-004 | 已有项目托管能力尚未产品化（安全接管、自动识别问题、基于 Harness 的持续演进；愿景见 `docs/design/existing-project-managed-onboarding-vision.md`） | 存量项目接入效率与自动治理能力 | P2 | open | architect/platform/issue-manager |

## 决策记录

- 2026-02-27：当前阶段优先“新项目托管”主路径；已有项目托管暂不纳入近期实现范围。
- 2026-02-27：已有项目托管的目标方向是“接管后自动演进”，不是一次性脚手架覆盖。

## TD-004 目标边界（后续）

- 接管入口默认只读探测，先输出风险与变更计划，再执行写入动作。
- 接管后持续按 Harness Engineering 思路运行：识别问题、形成可执行改进清单、驱动验证闭环。
- 支持自动识别高价值问题并创建 issue/backlog（在人工可审计约束下执行）。
- 优先以增量重构方式演进，不破坏现有项目结构与研发节奏。
- 参考约束文档：`docs/harness-engineering-guidelines.md`。
