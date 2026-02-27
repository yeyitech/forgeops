---
name: developer-android-app
description: "Implement Android app delivery with reproducible Gradle commands and runtime evidence. Use for Android app development."
---

# 执行准则

1. 代码改动必须附带可复现构建命令与执行结果摘要。
2. 优先复用项目既有 Gradle/AGP 配置，不额外引入复杂工程结构。
3. 输出改动影响范围（模块、页面、API）与验证证据。

## 必做项

1. 明确并执行构建命令（优先 `./gradlew`，其次 `gradle`）。
2. 至少提供一组测试或 smoke 证据（`test`/`connectedAndroidTest`/自定义脚本）。
3. 说明兼容性边界（minSdk/targetSdk、设备或模拟器假设）。
