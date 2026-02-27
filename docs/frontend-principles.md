# 前端开发原则（Lit 栈）

Status: Active
Updated: 2026-02-26

## 1. 技术栈（必须）

- 框架：Lit（Web Components）
- 构建：Vite
- 语言：TypeScript
- 组件：类组件 + Shadow DOM

要求：

- 不引入 React/Vue 重运行时依赖
- 局部状态优先 reactive properties
- 全局状态保持轻量和可追踪

## 2. 视觉基调

- Dark-first 深色优先
- 分层深灰，不用纯黑
- 高对比强调色用于关键操作与状态
- 1px 细边框优先于重阴影
- 小圆角（4-6px）保持专业感

## 3. 排版

- UI 文本：现代无衬线（Inter/Space Grotesk/Geist Sans）
- 数据与代码：强制等宽字体（JetBrains Mono/Fira Code）
- 层级以颜色/字重表达，不靠极端字号差

## 4. 布局与组件

- 面板化（IDE 风格）
- 高密度信息展示
- 操作状态即时反馈（loading/success/error）
- 状态指示简洁、稳定、可扫描
- 运行实况右侧细节区采用单窗口 Tab（事件流/产物）切换，避免重复信息源并保持固定滚动容器
- 运行实况中的“终端旁观”入口可在 run/session/step 多粒度触发，语义统一为旁观 Codex thread

## 5. CSS 实现规则

- `:root` 中定义语义化 CSS Variables
- 主题切换尽量仅通过变量值
- 组件样式放在 Lit `static styles`
- 通过变量暴露可定制点，避免全局污染
