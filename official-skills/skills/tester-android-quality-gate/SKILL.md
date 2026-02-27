---
name: tester-android-quality-gate
description: "Run Android quality gates including build/test/smoke evidence and toolchain checks. Use for Android testing."
---

# 执行准则

1. 先验证工具链可用，再验证构建与测试结果。
2. 证据必须覆盖“命令-结果-关键信号”，不接受仅结论描述。
3. 对阻断问题给出可执行修复路径，优先小步自修。

## 必跑命令（优先）

- `node .forgeops/tools/platform-preflight.mjs --strict --json`（若存在）
- `node .forgeops/tools/platform-smoke.mjs --strict --json`（若存在）

## Android 平台闭环要求

1. Java 与 Gradle/Gradle Wrapper 工具链可用。
2. Android 工程结构存在（`settings.gradle*`/`build.gradle*` 与 `app/src/main/AndroidManifest.xml`）。
3. 构建命令可解析并可执行（`./gradlew assemble...` 或项目定义命令）。
4. 至少一项测试或 smoke 证据可见（单测、仪器测试、或项目定义 smoke）。
