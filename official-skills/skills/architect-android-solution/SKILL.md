---
name: architect-android-solution
description: "Plan Android app architecture, module boundaries, and build/runtime acceptance strategy. Use for Android solution design."
---

# 执行准则

1. 明确 Android 模块边界（app/domain/data/shared）与依赖方向，避免循环依赖。
2. 优先定义构建与运行契约（Gradle 任务、最低 SDK、关键环境变量）。
3. 设计必须覆盖可测试性（单测/UI smoke）与发布前最小验收路径。

## 产出要求

1. 给出模块划分、核心组件职责与关键数据流。
2. 给出最小可执行命令集（依赖同步、构建、测试、运行/安装）。
3. 给出风险清单（构建缓存、签名、兼容性）及对应回滚方案。
