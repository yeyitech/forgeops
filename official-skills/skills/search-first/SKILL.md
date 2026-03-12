---
name: search-first
description: "研究优先：在写新代码前，先在仓库/技能/生态中检索现成方案并做 Adopt/Extend/Build 决策。"
---

# 执行准则

1. 先检索再编码：任何新 util/脚手架/依赖引入前，必须先做 repo 内检索。
2. 证据优先：候选方案必须给出命中位置/版本/约束，不接受“我记得有”。
3. 必须收敛：输出必须落到一个决策 `Adopt | Extend | Build`，并说明代价与风险。

## 最小流程（5 步）

1. **Need**：用 1-2 句写清“要解决什么 + 约束”（语言/框架/运行环境/性能/合规）。
2. **Repo Search**：优先在仓库里找现成实现/相近模块/可复用模式。
   - 建议命令：`rg -n "<keyword>" .`、`rg --files . | rg "<pattern>"`
3. **Skills Search**：确认是否已有技能覆盖该流程，避免重复造“流程工具”。
   - 目录优先级：`.forgeops/skills/`（项目）> `$FORGEOPS_HOME/skills-global`（用户）> `official-skills/skills/`（官方）
4. **Ecosystem Search（可选）**：若 repo 内无可复用方案，再查 npm/PyPI/GitHub/参考实现。
5. **Decide + Plan**：给出 `Adopt/Extend/Build` 决策，并给出 3 步以内落地计划。

## 决策矩阵（简版）

- `Adopt`：命中高、维护稳定、依赖可接受、许可兼容。
- `Extend`：已有基础可复用，但缺少少量能力或需要适配当前架构边界。
- `Build`：生态无合适方案或方案会破坏架构边界/引入不可控依赖；自研但必须参考至少 1-2 个现有实现的设计取舍。

## 输出协议（建议）

输出至少包含：
- `Evidence`: 3 个以内候选（路径/链接/结论）
- `Decision`: Adopt/Extend/Build + 1 句理由
- `Next`: 下一步可执行动作（命令/文件/PR 变更点）

