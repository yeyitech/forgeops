# 领域质量评分

Status: Active
Updated: 2026-02-25

| 领域 | 评分 | 当前状态 | 下一步 |
|---|---|---|---|
| Runtime Adapter（Codex exec） | B | 执行与事件采集可用 | 增加错误分类与重试策略细化 |
| Workflow 状态机 | B+ | 步骤推进与重试逻辑可用 | 增加卡死步骤 watchdog |
| API/SSE 可观测性 | B | 核心接口可用 | 增加按条件过滤与分页 |
| 前端仪表盘（Lit） | B | 项目/运行/步骤/事件已可视化 | 增强 issue/PR/代码产物聚合视图 |
| 架构约束自动化 | C | 文档化完成 | 接入 CI 的边界检查 |
| 熵增治理（Garbage Collection） | C+ | 已定义 cleanup 角色与黄金原则 | 增加定时清理 run 与自动生成微型修复 PR |
