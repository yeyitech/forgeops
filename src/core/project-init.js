import fs from "node:fs";
import path from "node:path";
import { provisionProjectGitHubRemote } from "./git.js";
import { getProductTypeLabel } from "./product-type.js";
import {
  buildInvariantsConfig,
  buildInvariantsCheckerScript,
  buildInvariantsTestScript,
  getInvariantPaths,
} from "./invariants.js";
import {
  DEFAULT_SCHEDULER_CONFIG,
  buildSchedulerConfigYaml,
} from "./scheduler-config.js";
import { ensureProductToolchainReady } from "./platform-toolchain.js";
import { normalizeTechProfile, scaffoldProjectSkills } from "./skills.js";
import { buildWorkflowYaml } from "./workflow-config.js";

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function emitProgress(meta, stage, detail) {
  if (typeof meta?.onProgress !== "function") {
    return;
  }
  meta.onProgress({
    stage: String(stage),
    detail: String(detail ?? ""),
    at: new Date().toISOString(),
  });
}

function buildAgentsMarkdown(meta) {
  const projectName = String(meta?.name ?? "").trim() || "Project";
  const uiDoc = resolveUiGuidanceDoc(meta);
  const uiDocLine = uiDoc
    ? `- 类型化界面文档：\`${uiDoc.path}\``
    : "- 类型化界面文档：当前项目类型无前端/UI文档要求";

  return `# ${projectName} Agent 地图

本文件是目录地图，不是百科手册。优先按需加载最小上下文。

## 流程

1. Architect Agent
- 负责需求澄清与架构决策。
- 维护 docs/architecture 下的 ADR。

2. Issue Agent
- 把需求转成结构化 issue。
- 明确验收标准与 out-of-scope。

3. Developer Agent
- 按范围实现代码与测试。
- 输出简明交付摘要。

4. Tester Agent
- 验证行为与回归风险。

5. Reviewer Agent
- 做质量评估并给出发布建议。

6. Garbage Collection Agent
- 周期识别熵增与模式漂移。
- 输出小步清理任务，持续偿还技术债。
- 维护 docs/quality 下的质量评分与清理建议。

## 输出契约

所有 Agent 必须返回严格 JSON：
- status: done | retry | failed
- summary: 简短摘要
- outputs: string（可为空字符串）
- artifacts: array（可为空）
- notes: array（可为空）

## 角色技能装配

- 角色到技能映射：\`.forgeops/agent-skills.json\`
- 技能目录：\`.forgeops/skills/<skill-name>/SKILL.md\`
- 原则：同一角色可挂载多个技能（如 developer 可同时拥有 frontend/backend/fullstack 技能）。

## 文档地图

- 仓库级工程原则：\`harness-engineering-guidelines.md\`
- docs 总索引：\`docs/00-index.md\`
- 架构：\`docs/architecture/*\`
- 设计：\`docs/design/*\`
- 用户上下文：\`docs/context/index.md\`、\`docs/context/*.md\`
- 质量：\`docs/quality/*\`
- 元规则：\`docs/meta/*\`
- 计划：\`docs/exec-plans/*\`
${uiDocLine}

## 机械检查

- 文档新鲜度：\`node scripts/check-doc-freshness.js\`
- 文档结构：\`node scripts/check-doc-structure.js\`
- 平台工具链预检查：\`node .forgeops/tools/platform-preflight.mjs --strict --json\`
- 平台验收检查：\`node .forgeops/tools/platform-smoke.mjs --strict --json\`
`;
}

function buildProjectYaml(meta) {
  return `name: ${meta.name}
product_type: ${meta.productType}
tech_profile:
  language: ${meta.tech.language}
  frontend_stack: ${meta.tech.frontendStack}
  backend_stack: ${meta.tech.backendStack}
  ci_provider: ${meta.tech.ciProvider}
problem_statement: |
  ${String(meta.problemStatement || "").replace(/\n/g, "\n  ")}
success_metrics:
  - 首次端到端流水线可执行
  - UI 可展示 run 状态与产物
non_goals:
  - v1 不做多运行时调度优化
runtime:
  preferred: codex-exec-json
model_default: gpt-5.3-codex
`;
}

function buildContextMarkdown(meta) {
  return `# 项目上下文

## 产品一句话
${meta.name}：待补充

## 目标用户
- 待补充

## 核心问题
${String(meta.problemStatement || "").trim() || "待补充"}

## 非目标（v1）
- 待补充

## 业务边界
- 待补充

## 关键约束
- 产品类型：${meta.productTypeLabel} (${meta.productType})
- 语言：${meta.tech.language}
- 前端栈：${meta.tech.frontendStack}
- 后端栈：${meta.tech.backendStack}
- CI：${meta.tech.ciProvider}
- 运行时：codex-exec-json
- 默认模型：gpt-5.3-codex
- 角色技能配置：.forgeops/agent-skills.json
- 技能目录：.forgeops/skills/<skill-name>/SKILL.md
- 治理策略：.forgeops/governance.md
- 不变量配置：.forgeops/invariants.json
- 不变量检查器：.forgeops/tools/check-invariants.mjs
- 定时调度配置：.forgeops/scheduler.yaml
- 平台工具链预检查：.forgeops/tools/platform-preflight.mjs
- 平台验收检查：.forgeops/tools/platform-smoke.mjs
- 仓库级工程原则：harness-engineering-guidelines.md
- 文档地图：docs/00-index.md
- 用户上下文索引：docs/context/index.md
- 执行计划目录：docs/exec-plans/

## 交付标准
- 可执行
- 可观测
- 可回滚
- 文档可导航且可校验
`;
}

function buildGovernanceMarkdown() {
  return `# 研发治理策略（Agent-First）

## 目标

在高吞吐 Agent 研发模式下，用最小必要约束维持可持续速度，避免架构漂移和系统熵增。

## 双层约束模型

### 1) 硬边界（必须机械执行）

- 架构边界：分层、依赖方向、公共契约不可破坏。
- 正确性边界：类型、结构化日志、关键路径可靠性要求必须满足。
- 可复现边界：构建、测试、回滚路径可执行且可追踪。

### 2) 软约束（允许局部自治）

- 代码风格与实现细节允许差异化表达。
- 在硬边界内，Agent 可自主选择实现路径和重构方式。
- 人类偏好通过持续反馈进入规则，不强求一次到位。

## 合并哲学（高吞吐模式）

- 采用最小阻塞 gate：仅阻塞高严重度问题（正确性/安全性/数据损坏风险）。
- 对低严重度问题（样式、非关键 flaky）优先 follow-up，不长期阻塞主线。
- Pull Request 保持短生命周期，鼓励小步快跑与快速修正。

## 反馈闭环

1. 审查意见和线上缺陷先记录为可复现事实。
2. 复发问题优先升级为文档规则。
3. 文档规则继续复发时，升级为自动化检查（lint/test/script）。
4. Cleanup Agent 周期扫描并小步偿还技术债。

## 机械化检查基线

- 运行：\`node .forgeops/tools/check-invariants.mjs --format json\`
- 默认阻断：error 级违规（warnings 允许 follow-up）
- 检查范围：分层依赖、跨域耦合、Providers入口、边界解析、文件规模、日志规范
- 文档新鲜度：\`node scripts/check-doc-freshness.js\`
- 文档结构：\`node scripts/check-doc-structure.js\`
`;
}

function buildWebUiGuideMarkdown(updatedAt) {
  return `# 前端开发原则（Lit 栈）

Status: Active
Updated: ${updatedAt}

## 技术栈

- Framework: Lit（Web Components）
- Build Tool: Vite
- Language: TypeScript

## 视觉方向

- Dark-first 分层深灰
- 高对比强调色用于关键操作/状态
- 1px 细边框优先于重阴影
- 小圆角（4-6px）
- 面板化高密度布局

## 排版

- UI 文本：现代无衬线（Inter / Space Grotesk / Geist Sans）
- 数据/代码：等宽字体（JetBrains Mono / Fira Code）
- 层级主要通过颜色和字重表达

## CSS 规则

- 在 :root 中定义语义变量
- 主题通过变量覆盖切换
- 组件样式写在 Lit static styles 中
`;
}

function buildMiniappUiGuideMarkdown(updatedAt) {
  return `# 小程序界面与交互指南

Status: Active
Updated: ${updatedAt}

## 目标

保证小程序交互稳定、页面结构可验收，并与微信开发者工具约束一致。

## 页面结构规则

- 页面入口与 \`app.json#pages\` 声明保持一致。
- 页面脚本优先保证可运行产物（\`.js\`）可验收。
- 复杂交互分层拆分到组件，避免单页过重。

## 体验规则

- 首屏可用优先于动画复杂度。
- 网络请求必须有 loading/empty/error 三态。
- 关键交互路径要有最小 smoke 证据（可在平台验收中复现）。
`;
}

function buildIosUiGuideMarkdown(updatedAt) {
  return `# iOS UI 交付指南

Status: Active
Updated: ${updatedAt}

## 目标

在 iOS 交付中维持可构建、可回归、可演进的界面实现。

## 结构规则

- 视图层与业务层边界明确，避免 ViewController/SwiftUI View 过载。
- 状态驱动渲染优先，减少隐式副作用。
- 关键页面拆分为可测试组件，便于回归验证。

## 体验规则

- 优先保证可读性、交互反馈与错误态处理。
- 动效与视觉优化不应阻断主流程可用性。
- 重要页面变更需附带模拟器构建/运行证据。
`;
}

function buildAndroidUiGuideMarkdown(updatedAt) {
  return `# Android UI 交付指南

Status: Active
Updated: ${updatedAt}

## 目标

保证 Android 界面实现具备稳定构建与可回归能力。

## 结构规则

- UI 层按模块组织（feature/ui/domain/data），避免跨层耦合。
- 页面状态显式建模（loading/content/error）。
- 通用组件沉淀在共享模块，避免重复实现。

## 体验规则

- 交互反馈（点击、加载、失败）必须可见。
- 页面性能优先于复杂视觉效果。
- 核心交互路径需有可复现的构建/运行验收证据。
`;
}

function resolveUiGuidanceDoc(meta) {
  const productType = String(meta?.productType ?? "").trim().toLowerCase();
  if (productType === "web") {
    return {
      path: "docs/frontend-principles.md",
      content: buildWebUiGuideMarkdown,
    };
  }
  if (productType === "miniapp") {
    return {
      path: "docs/experience/miniapp-ui-guidelines.md",
      content: buildMiniappUiGuideMarkdown,
    };
  }
  if (productType === "ios") {
    return {
      path: "docs/experience/ios-ui-guidelines.md",
      content: buildIosUiGuideMarkdown,
    };
  }
  if (productType === "android") {
    return {
      path: "docs/experience/android-ui-guidelines.md",
      content: buildAndroidUiGuideMarkdown,
    };
  }
  return null;
}

function buildContextDocsIndexMarkdown(updatedAt) {
  return `# 用户上下文文档索引

Status: Active
Updated: ${updatedAt}

## 用途

- 放置项目私有、业务相关的上下文文档（需求背景、领域术语、外部约束）。
- 这些文档会作为 Agent 执行时的重要上下文来源。

## 维护规则

1. 新增文档放在 \`docs/context/\` 下，文件名语义化。
2. 每个文档必须包含 \`Status\` 与 \`Updated\` 头。
3. 新增后必须在本文件的机器注册表中登记，保证索引可追踪。
4. 在 \`.forgeops/context.md\` 中补充高优先级上下文摘要与链接。

## 机器注册表（Machine-Readable Registry）

字段约束：

- \`path\`：必须为 \`docs/context/*.md\` 的真实文件路径（不含 \`docs/context/index.md\`）。
- \`owner\`：文档责任人/责任角色（如 \`product\` / \`architect\` / \`reviewer\`）。
- \`priority\`：\`p0|p1|p2|p3\`（p0 最高优先级）。
- \`use_for_steps\`：该文档适用的流水线步骤（如 \`architect\`、\`issue\`、\`implement\`、\`test\`、\`review\`、\`cleanup\`）。

<!-- context-registry:start -->
\`\`\`json
[]
\`\`\`
<!-- context-registry:end -->

## 已登记文档（人工可读摘要）

- （请与上方注册表保持一致）
`;
}

function buildDocsIndexMarkdown(meta, updatedAt) {
  const uiDoc = resolveUiGuidanceDoc(meta);
  const uiSection = uiDoc
    ? `- \`${uiDoc.path}\``
    : "- （当前项目类型无前端文档要求）";

  return `# 文档地图（Docs Index）

Status: Active
Updated: ${updatedAt}

## 目的

本文件是项目知识库索引。Agent 必须先从这里定位需要加载的最小上下文。

## 目录

### 仓库级指南（Repo Root）
- \`harness-engineering-guidelines.md\`

### 架构
- \`docs/architecture/00-overview.md\`
- \`docs/architecture/layering.md\`
- \`docs/architecture/ADR-0001.md\`

### 设计
- \`docs/design/core-beliefs.md\`

### 类型化界面文档（按类型）
${uiSection}

### 用户上下文
- \`docs/context/index.md\`
- \`docs/context/*.md\`（按需补充并在 \`docs/context/index.md\` 登记）

### 质量
- \`docs/quality/domain-grades.md\`
- \`docs/quality/verification-status.md\`
- \`docs/quality/golden-principles.md\`

### 元规则
- \`docs/meta/doc-freshness.md\`
- \`docs/meta/doc-structure.md\`

### 计划与产品
- \`docs/exec-plans/active/README.md\`
- \`docs/exec-plans/completed/README.md\`
- \`docs/exec-plans/tech-debt-tracker.md\`
- \`docs/product-specs/index.md\`
- \`docs/references/index.md\`

## 当前项目

- 项目名：${meta.name}
- 产品类型：${meta.productTypeLabel} (${meta.productType})
`;
}

function buildArchitectureOverviewMarkdown(meta, updatedAt) {
  return `# 架构总览

Status: Active
Updated: ${updatedAt}

## 系统边界

- 产品类型：${meta.productTypeLabel} (${meta.productType})
- 运行时：codex-exec-json
- 目标：在可观测与可治理前提下保持高吞吐交付

## 默认交付流程

1. architect
2. issue
3. implement
4. test
5. review
6. cleanup

## 核心目录职责

- \`.forgeops/\`：流程、技能、治理与不变量配置
- \`docs/\`：记录系统（System of Record）
- \`scripts/\`：机械化检查脚本
`;
}

function buildLayeringMarkdown(updatedAt) {
  return `# 分层约束

Status: Active
Updated: ${updatedAt}

## 目标

通过机械约束维持依赖方向可预测，降低 Agent 漂移风险。

## 建议层级

Types -> Config -> Repo -> Service -> Runtime -> UI

## 规则

- 禁止跨域直接耦合。
- 跨切能力统一经 Providers 入口。
- 边界层必须做数据解析/校验。
`;
}

function buildCoreBeliefsMarkdown(updatedAt) {
  return `# 核心信念

Status: Active
Updated: ${updatedAt}

1. 控制平面价值不在“写代码”，而在“维持系统可持续交付”。
2. 上下文是稀缺资源，AGENTS.md 必须是短地图。
3. 复发问题必须升级为机制（规则/脚本/测试），而不是重复口头提醒。
4. 质量和速度不是二选一，关键是边界机械化、局部自治化。
`;
}

function buildHarnessGuideMarkdown(updatedAt) {
  return `# Harness Engineering 指南

Status: Active
Updated: ${updatedAt}

## 四大支柱

1. Context Engineering：地图化导航，按需加载。
2. Architectural Constraints：强制边界与依赖方向。
3. Observability：每个 run/step/session 可追踪。
4. Garbage Collection：周期治理熵增与漂移。

## 交付闭环

1. 发现失败模式
2. 定位缺失能力
3. 补规则/文档/脚本
4. 验证复发率下降
`;
}

function buildDomainGradesMarkdown(updatedAt) {
  return `# 质量评分（Domain Grades）

Status: Active
Updated: ${updatedAt}

| 领域 | 评分 | 说明 | 下一步 |
| --- | --- | --- | --- |
| 架构边界 | C | 已有初始约束，待覆盖更多场景 | 增加结构测试 |
| 测试可靠性 | C | 有基础验证，缺回归覆盖深度 | 补关键路径自动化 |
| 文档一致性 | C | 已建立索引，待持续园艺 | 每日 cleanup 校验 |
| 交付稳定性 | C | 流程可执行，待长期数据验证 | 建立趋势追踪 |
`;
}

function buildVerificationStatusMarkdown(updatedAt) {
  return `# 验证状态

Status: Active
Updated: ${updatedAt}

## 已完成

- 初始化脚手架可生成流程、技能、治理与文档骨架。
- 初始化前会执行产品类型工具链预检查（miniapp/web/ios/microservice/android/serverless）。
- 支持按工作流定义创建 run 并执行 DAG。
- 支持 cleanup 与 issueAutoRun 周期调度（scheduler）。

## 待验证

- 复杂并发场景下的吞吐与稳定性边界。
- 文档规则与真实代码行为的一致性。
- follow-up issue 的关闭周期与复发率。
`;
}

function buildGoldenPrinciplesMarkdown(updatedAt) {
  return `# 黄金原则（Entropy / Garbage Collection）

Status: Active
Updated: ${updatedAt}

1. 共享能力优先，避免重复造轮子。
2. 禁止 YOLO 式数据探测，边界必须校验。
3. 复发问题必须升级为机械约束。
4. 清理要小步、连续、可审阅。
`;
}

function buildDocFreshnessMarkdown(updatedAt) {
  return `# 文档新鲜度策略

Status: Active
Updated: ${updatedAt}

## 规则

- \`docs/\` 下所有 Markdown 文档必须包含 \`Updated: YYYY-MM-DD\`。
- 超过 45 天未更新的活跃文档视为 stale。
- 文件重命名/移动需同步更新 \`AGENTS.md\` 与 \`docs/00-index.md\`。

## 检查

\`\`\`bash
node scripts/check-doc-freshness.js
\`\`\`
`;
}

function buildDocStructureMarkdown(updatedAt) {
  return `# 文档结构策略

Status: Active
Updated: ${updatedAt}

## 目标

保证知识库可导航、可验证、可持续演进，而不是单体手册。

## 规则

- 必须存在仓库级工程原则：\`harness-engineering-guidelines.md\`。
- 必须存在 docs 总索引：\`docs/00-index.md\`。
- 必须存在用户上下文索引：\`docs/context/index.md\`。
- 用户上下文索引必须包含机器注册表，并满足字段约束：
  - \`path\`、\`owner\`、\`priority\`、\`use_for_steps\`
- 文档索引双向一致：
  - \`docs/*.md\`（动态目录除外）必须被索引文件引用。
  - 索引文件中声明的 \`docs/*.md\` 路径必须真实存在。
- 执行计划目录必须存在：\`docs/exec-plans/active\` 与 \`docs/exec-plans/completed\`。
- 技术债追踪文件必须存在：\`docs/exec-plans/tech-debt-tracker.md\`。

## 检查

\`\`\`bash
node scripts/check-doc-structure.js
\`\`\`
`;
}

function buildExecPlansActiveReadme(updatedAt) {
  return `# Active Plans

Status: Active
Updated: ${updatedAt}

放置正在执行的复杂任务计划，建议包含：

- 背景与目标
- 分阶段里程碑
- 决策日志
- 当前进度
`;
}

function buildExecPlansCompletedReadme(updatedAt) {
  return `# Completed Plans

Status: Active
Updated: ${updatedAt}

归档已完成计划，保留：

- 结果摘要
- 偏差与复盘
- 可复用策略
`;
}

function buildTechDebtTrackerMarkdown(updatedAt) {
  return `# 技术债追踪

Status: Active
Updated: ${updatedAt}

| ID | 问题 | 影响 | 优先级 | 状态 | 责任角色 |
| --- | --- | --- | --- | --- | --- |
| TD-001 | 待补充 | 待评估 | P2 | open | cleanup |
`;
}

function buildProductSpecsIndexMarkdown(updatedAt) {
  return `# Product Specs Index

Status: Active
Updated: ${updatedAt}

## 用法

- 新需求先在本目录沉淀规格，再进入 Issue 拆解。
- 每个规格需包含验收标准、非目标与风险。

## 列表

- （待补充）
`;
}

function buildReferenceIndexMarkdown(updatedAt) {
  return `# References

Status: Active
Updated: ${updatedAt}

放置长期稳定、可复用的外部参考材料（工具说明、规范摘要等）。
`;
}

function buildProjectDocFreshnessCheckScript() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const STALE_DAYS = 45;
const HEADER_PREFIX = "Updated:";

function listMarkdownFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function parseUpdatedDate(content) {
  const lines = content.split(/\\r?\\n/).slice(0, 20);
  for (const line of lines) {
    const idx = line.indexOf(HEADER_PREFIX);
    if (idx === -1) continue;
    const raw = line.slice(idx + HEADER_PREFIX.length).trim();
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  return null;
}

function daysBetween(a, b) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.log("docs/ directory not found; skipping freshness check.");
    process.exit(0);
  }

  const today = new Date();
  const files = listMarkdownFiles(DOCS_DIR);
  const missing = [];
  const stale = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, "utf8");
    const updated = parseUpdatedDate(content);
    if (!updated) {
      missing.push(rel);
      continue;
    }
    const age = daysBetween(today, updated);
    if (age > STALE_DAYS) {
      stale.push({ rel, age, updated: updated.toISOString().slice(0, 10) });
    }
  }

  if (missing.length === 0 && stale.length === 0) {
    console.log(\`OK: \${files.length} docs checked, freshness policy satisfied.\`);
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log("Missing Updated header:");
    for (const rel of missing) {
      console.log(\`- \${rel}\`);
    }
  }

  if (stale.length > 0) {
    console.log(\`Stale docs (> \${STALE_DAYS} days):\`);
    for (const item of stale) {
      console.log(\`- \${item.rel} (updated \${item.updated}, age \${item.age}d)\`);
    }
  }

  process.exit(1);
}

main();
`;
}

function buildProjectDocStructureCheckScript() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REQUIRED_FILES = [
  "AGENTS.md",
  "harness-engineering-guidelines.md",
  "docs/00-index.md",
  "docs/context/index.md",
  "docs/architecture/00-overview.md",
  "docs/design/core-beliefs.md",
  "docs/quality/verification-status.md",
  "docs/meta/doc-freshness.md",
  "docs/meta/doc-structure.md",
  "docs/exec-plans/tech-debt-tracker.md",
];
const REQUIRED_DIRS = [
  "docs/exec-plans/active",
  "docs/exec-plans/completed",
];
const STATIC_INDEX_FILES = [
  "AGENTS.md",
  "docs/00-index.md",
];
const DYNAMIC_PREFIXES = [
  "docs/exec-plans/active/",
  "docs/exec-plans/completed/",
];
const OPTIONAL_INDEX_FILES = [
  "docs/context/index.md",
];
const CONTEXT_INDEX_FILE = "docs/context/index.md";
const CONTEXT_REGISTRY_START = "<!-- context-registry:start -->";
const CONTEXT_REGISTRY_END = "<!-- context-registry:end -->";
const ALLOWED_CONTEXT_PRIORITIES = new Set(["p0", "p1", "p2", "p3"]);
const ALLOWED_STEP_KEYS = new Set([
  "architect",
  "issue",
  "implement",
  "test",
  "platform-smoke",
  "review",
  "cleanup",
]);

function listMarkdownFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function isDynamicDoc(relPath) {
  return DYNAMIC_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function parseReferencedDocPaths(text) {
  const source = String(text ?? "");
  const refs = new Set();
  const regex = /(harness-engineering-guidelines\\.md|docs\\/[A-Za-z0-9._\\/-]+\\.md)/g;
  for (const matched of source.matchAll(regex)) {
    const rel = String(matched[1] ?? "").trim();
    if (!rel) continue;
    refs.add(rel);
  }
  return refs;
}

function readProjectType() {
  const yamlPath = path.join(ROOT, ".forgeops", "project.yaml");
  if (!fs.existsSync(yamlPath)) return "";
  try {
    const content = fs.readFileSync(yamlPath, "utf8");
    const line = content
      .split(/\\r?\\n/)
      .find((item) => String(item ?? "").trim().startsWith("product_type:"));
    if (!line) return "";
    return line.split(":").slice(1).join(":").trim().toLowerCase();
  } catch {
    return "";
  }
}

function expectedUiDocForProductType(productType) {
  const normalized = String(productType ?? "").trim().toLowerCase();
  if (normalized === "web") return "docs/frontend-principles.md";
  if (normalized === "miniapp") return "docs/experience/miniapp-ui-guidelines.md";
  if (normalized === "ios") return "docs/experience/ios-ui-guidelines.md";
  if (normalized === "android") return "docs/experience/android-ui-guidelines.md";
  return "";
}

function collectIndexFiles() {
  const out = [...STATIC_INDEX_FILES];
  for (const rel of OPTIONAL_INDEX_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function extractContextRegistryJson(block) {
  const source = String(block ?? "").trim();
  if (!source) return "";

  const fenceMatch = source.match(/^\\\`\\\`\\\`(?:json)?[^\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n\\\`\\\`\\\`$/i);
  if (fenceMatch) {
    return String(fenceMatch[1] ?? "").trim();
  }

  const firstBracket = source.indexOf("[");
  const lastBracket = source.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return source.slice(firstBracket, lastBracket + 1).trim();
  }

  return "";
}

function readContextRegistry() {
  const abs = path.join(ROOT, CONTEXT_INDEX_FILE);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return {
      entries: [],
      errors: [\`missing context index file: \${CONTEXT_INDEX_FILE}\`],
    };
  }

  const text = fs.readFileSync(abs, "utf8");
  const start = text.indexOf(CONTEXT_REGISTRY_START);
  const end = text.indexOf(CONTEXT_REGISTRY_END);
  if (start === -1 || end === -1 || end <= start) {
    return {
      entries: [],
      errors: [\`invalid context registry markers in \${CONTEXT_INDEX_FILE}\`],
    };
  }

  const block = text.slice(start + CONTEXT_REGISTRY_START.length, end).trim();
  const raw = extractContextRegistryJson(block);
  if (!raw) {
    return {
      entries: [],
      errors: [\`missing json registry block in \${CONTEXT_INDEX_FILE}\`],
    };
  }

  const safeRaw = raw || "[]";
  try {
    const parsed = JSON.parse(safeRaw);
    if (!Array.isArray(parsed)) {
      return {
        entries: [],
        errors: [\`context registry must be a JSON array in \${CONTEXT_INDEX_FILE}\`],
      };
    }
    return {
      entries: parsed,
      errors: [],
    };
  } catch (err) {
    return {
      entries: [],
      errors: [\`invalid context registry JSON in \${CONTEXT_INDEX_FILE}: \${String(err?.message ?? err)}\`],
    };
  }
}

function listContextDocs() {
  const dir = path.join(ROOT, "docs", "context");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return listMarkdownFiles(dir)
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .filter((rel) => rel !== CONTEXT_INDEX_FILE);
}

function validateContextRegistry(registry, errors, referenced) {
  const entries = Array.isArray(registry?.entries) ? registry.entries : [];
  const registryErrors = Array.isArray(registry?.errors) ? registry.errors : [];
  for (const item of registryErrors) {
    errors.push(item);
  }
  if (registryErrors.length > 0) return;

  const seenPath = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const label = \`context registry entry[\${i}]\`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(\`\${label} must be an object\`);
      continue;
    }

    const docPath = String(entry.path ?? "").trim();
    const owner = String(entry.owner ?? "").trim();
    const priority = String(entry.priority ?? "").trim().toLowerCase();
    const steps = Array.isArray(entry.use_for_steps)
      ? entry.use_for_steps.map((step) => String(step ?? "").trim().toLowerCase()).filter(Boolean)
      : [];

    if (!docPath) {
      errors.push(\`\${label} missing field: path\`);
    } else {
      if (!docPath.startsWith("docs/context/") || !docPath.endsWith(".md") || docPath === CONTEXT_INDEX_FILE) {
        errors.push(\`\${label} invalid path: \${docPath}\`);
      }
      if (seenPath.has(docPath)) {
        errors.push(\`\${label} duplicate path: \${docPath}\`);
      } else {
        seenPath.add(docPath);
      }
      referenced.add(docPath);
      const abs = path.join(ROOT, docPath);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        errors.push(\`\${label} path not found: \${docPath}\`);
      }
    }

    if (!owner) {
      errors.push(\`\${label} missing field: owner\`);
    }

    if (!priority) {
      errors.push(\`\${label} missing field: priority\`);
    } else if (!ALLOWED_CONTEXT_PRIORITIES.has(priority)) {
      errors.push(\`\${label} invalid priority: \${priority} (expected p0|p1|p2|p3)\`);
    }

    if (steps.length === 0) {
      errors.push(\`\${label} missing field: use_for_steps\`);
    } else {
      for (const step of steps) {
        if (!ALLOWED_STEP_KEYS.has(step)) {
          errors.push(\`\${label} invalid use_for_steps item: \${step}\`);
        }
      }
    }
  }

  const contextDocs = listContextDocs();
  for (const rel of contextDocs) {
    if (!seenPath.has(rel)) {
      errors.push(\`context doc not registered: \${rel} (add to \${CONTEXT_INDEX_FILE} registry)\`);
    }
  }
}

function main() {
  const errors = [];

  for (const rel of REQUIRED_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      errors.push(\`missing required file: \${rel}\`);
    }
  }

  for (const rel of REQUIRED_DIRS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      errors.push(\`missing required directory: \${rel}\`);
    }
  }

  const docsDir = path.join(ROOT, "docs");
  if (fs.existsSync(docsDir)) {
    const docs = listMarkdownFiles(docsDir).map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
    const indexFiles = collectIndexFiles();
    const referenced = new Set();
    for (const rel of indexFiles) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, "utf8");
      for (const item of parseReferencedDocPaths(text)) {
        referenced.add(item);
      }
    }
    validateContextRegistry(readContextRegistry(), errors, referenced);

    const productType = readProjectType();
    const expectedUiDoc = expectedUiDocForProductType(productType);
    if (expectedUiDoc) {
      const expectedUiDocAbs = path.join(ROOT, expectedUiDoc);
      if (!fs.existsSync(expectedUiDocAbs) || !fs.statSync(expectedUiDocAbs).isFile()) {
        errors.push(\`missing type-specific ui doc: \${expectedUiDoc} (product_type=\${productType})\`);
      }
    }

    for (const rel of docs) {
      if (isDynamicDoc(rel)) continue;
      if (!referenced.has(rel)) {
        errors.push(\`unindexed doc: \${rel} (not referenced by index files)\`);
      }
    }

    for (const rel of referenced) {
      if (!rel.startsWith("docs/")) continue;
      if (isDynamicDoc(rel)) continue;
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        errors.push(\`indexed doc missing: \${rel} (referenced by index but file not found)\`);
      }
    }
  } else {
    errors.push("docs directory not found");
  }

  if (errors.length === 0) {
    console.log("OK: docs structure policy satisfied.");
    process.exit(0);
  }

  console.log("Doc structure check failed:");
  for (const item of errors) {
    console.log(\`- \${item}\`);
  }
  process.exit(1);
}

main();
`;
}

function buildProjectPlatformPreflightScript(meta) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PRODUCT_TYPE = ${JSON.stringify(String(meta.productType ?? "other"))};
const STRICT = process.argv.includes("--strict");
const JSON_OUTPUT = process.argv.includes("--json");

function run(command, args = [], timeout = 3500) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    ok: !result.error && result.status === 0,
    status: Number(result.status ?? -1),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : "",
  };
}

function resolveCommandPath(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const out = run(checker, [command], 1800);
  if (!out.ok) return "";
  const first = out.stdout.split(/\\r?\\n/).map((line) => line.trim()).find(Boolean);
  return first ?? "";
}

function resolveFirstCommandPath(commands) {
  const list = Array.isArray(commands) ? commands : [commands];
  for (const item of list) {
    const command = String(item ?? "").trim();
    if (!command) continue;
    const commandPath = resolveCommandPath(command);
    if (commandPath) {
      return {
        command,
        path: commandPath,
      };
    }
  }
  return {
    command: "",
    path: "",
  };
}

function check(id, title, ok, required, detail, hint = "") {
  return {
    id,
    title,
    ok: Boolean(ok),
    required: Boolean(required),
    detail: String(detail ?? ""),
    hint: String(hint ?? ""),
  };
}

function detectWechatCliPath() {
  const envPath = String(process.env.FORGEOPS_WECHAT_DEVTOOLS_CLI ?? "").trim();
  const candidates = [];
  if (envPath) candidates.push(envPath);
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
      "/Applications/wechatdevtools.app/Contents/MacOS/cli",
      "/Applications/微信开发者工具.app/Contents/MacOS/cli",
    );
  }
  for (const item of candidates) {
    const abs = path.resolve(item);
    if (fs.existsSync(abs)) return abs;
  }
  return "";
}

function probeWechatCliRuntime(cliPath) {
  if (!cliPath) {
    return {
      servicePortEnabled: false,
      loggedIn: false,
      detail: "cli path missing",
      hint: "先安装微信开发者工具并配置 FORGEOPS_WECHAT_DEVTOOLS_CLI。",
    };
  }

  const probe = spawnSync(cliPath, ["islogin", "--lang", "zh"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: "n\\n",
    timeout: 8000,
  });
  const stdout = String(probe.stdout ?? "").trim();
  const stderr = String(probe.stderr ?? "").trim();
  const combined = stdout + "\\n" + stderr;
  const combinedLower = combined.toLowerCase();
  const servicePortDisabled = combinedLower.includes("service port disabled")
    || combined.includes("服务端口已关闭")
    || combined.includes("工具的服务端口已关闭");
  const servicePortEnabled = !servicePortDisabled;
  const loggedIn = probe.status === 0
    || combinedLower.includes("islogin: true")
    || combinedLower.includes("is login: true")
    || combined.includes("已登录");

  let detail = "";
  if (servicePortDisabled) {
    detail = "检测到 IDE 服务端口关闭";
  } else if (probe.error) {
    detail = String(probe.error.message ?? probe.error);
  } else if (combined.trim()) {
    detail = combined.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" | ");
  } else {
    detail = "exit=" + String(probe.status ?? -1);
  }

  return {
    servicePortEnabled,
    loggedIn,
    detail,
    hint: servicePortEnabled
      ? ""
      : "打开微信开发者工具 -> 设置 -> 安全设置，开启“服务端口”；或首次 CLI 提示时输入 y。",
  };
}

function miniappChecks() {
  const out = [];
  const nodePath = resolveCommandPath("node");
  out.push(check("toolchain.node", "Node.js 命令可用", Boolean(nodePath), true, nodePath ? "node=" + nodePath : "未找到 node 命令", "安装 Node.js 并确保 PATH 可访问。"));
  const npmPath = resolveCommandPath("npm");
  out.push(check("toolchain.npm", "npm 命令可用", Boolean(npmPath), true, npmPath ? "npm=" + npmPath : "未找到 npm 命令", "安装 npm 并确保 PATH 可访问。"));
  const supported = process.platform === "darwin" || process.platform === "win32";
  out.push(check("miniapp.platform.supported", "微信开发者工具平台支持", supported, true, "platform=" + process.platform, supported ? "" : "请在 macOS 或 Windows 上运行 miniapp 验收。"));
  const cliPath = detectWechatCliPath();
  out.push(check("miniapp.devtools.cli.path", "微信开发者工具 CLI 可定位", Boolean(cliPath), true, cliPath ? "cli=" + cliPath : "未找到微信开发者工具 CLI", "安装微信开发者工具，或设置 FORGEOPS_WECHAT_DEVTOOLS_CLI。"));
  if (cliPath) {
    const help = run(cliPath, ["--help"], 5000);
    out.push(check("miniapp.devtools.cli.exec", "微信开发者工具 CLI 可执行", help.ok, true, help.ok ? "cli --help 执行成功" : (help.stderr || help.error || "执行失败"), "检查 CLI 路径权限或重新安装微信开发者工具。"));
    const runtimeProbe = probeWechatCliRuntime(cliPath);
    out.push(check("miniapp.devtools.cli.service_port", "微信开发者工具服务端口已开启", runtimeProbe.servicePortEnabled, true, runtimeProbe.detail, runtimeProbe.hint));
    out.push(check("miniapp.devtools.cli.login", "微信开发者工具登录状态可用", runtimeProbe.loggedIn, false, runtimeProbe.loggedIn ? "islogin 检测通过（已登录）" : "未检测到登录态（不阻断初始化）", runtimeProbe.loggedIn ? "" : "如需 preview/upload 自动化，请先执行微信开发者工具登录。"));
  }
  return out;
}

function webChecks() {
  const out = [];
  const nodePath = resolveCommandPath("node");
  out.push(check("toolchain.node", "Node.js 命令可用", Boolean(nodePath), true, nodePath ? "node=" + nodePath : "未找到 node 命令", "安装 Node.js 并确保 PATH 可访问。"));
  const npmPath = resolveCommandPath("npm");
  out.push(check("toolchain.npm", "npm 命令可用", Boolean(npmPath), true, npmPath ? "npm=" + npmPath : "未找到 npm 命令", "安装 npm 并确保 PATH 可访问。"));
  const browserPath = resolveCommandPath("google-chrome")
    || resolveCommandPath("chromium")
    || resolveCommandPath("chromium-browser")
    || resolveCommandPath("msedge");
  const appExists = process.platform === "darwin" && (fs.existsSync("/Applications/Google Chrome.app") || fs.existsSync("/Applications/Microsoft Edge.app"));
  out.push(check("web.browser.devtools", "浏览器 DevTools 验收能力", Boolean(browserPath || appExists), false, browserPath ? "browser=" + browserPath : (appExists ? "发现可用浏览器 App" : "未探测到 Chrome/Chromium/Edge"), "建议安装 Chrome/Chromium/Edge 以支持 Web UI 自动化验收。"));
  return out;
}

function iosChecks() {
  const out = [];
  const isDarwin = process.platform === "darwin";
  out.push(check("ios.platform.darwin", "iOS 工具链平台支持", isDarwin, true, "platform=" + process.platform, isDarwin ? "" : "iOS 验收仅支持 macOS。"));
  const xcodebuildPath = resolveCommandPath("xcodebuild");
  out.push(check("ios.xcodebuild.path", "xcodebuild 命令可用", Boolean(xcodebuildPath), true, xcodebuildPath ? "xcodebuild=" + xcodebuildPath : "未找到 xcodebuild", "安装 Xcode Command Line Tools：xcode-select --install"));
  const xcrunPath = resolveCommandPath("xcrun");
  out.push(check("ios.xcrun.path", "xcrun 命令可用", Boolean(xcrunPath), true, xcrunPath ? "xcrun=" + xcrunPath : "未找到 xcrun", "安装 Xcode 并确认 xcrun 在 PATH 中可用。"));
  if (xcodebuildPath) {
    const version = run("xcodebuild", ["-version"], 5000);
    out.push(check("ios.xcodebuild.version", "xcodebuild 版本检查", version.ok, true, version.ok ? version.stdout.split(/\\r?\\n/).slice(0, 2).join(" | ") : (version.stderr || version.error || "执行失败"), "检查 xcode-select 指向与 Xcode 安装状态。"));
  }
  if (xcrunPath) {
    const simctl = run("xcrun", ["simctl", "list", "devices"], 7000);
    out.push(check("ios.simctl.devices", "iOS 模拟器设备列表可读取", simctl.ok, true, simctl.ok ? "xcrun simctl list devices 执行成功" : (simctl.stderr || simctl.error || "执行失败"), "打开 Xcode 完成首次组件安装并初始化 Simulator Runtime。"));
  }
  return out;
}

function microserviceChecks() {
  const out = [];
  const python = resolveFirstCommandPath(["python3", "python"]);
  out.push(check(
    "toolchain.python",
    "Python 命令可用",
    Boolean(python.path),
    true,
    python.path ? (python.command + "=" + python.path) : "未找到 python3/python 命令",
    python.path ? "" : "安装 Python 3.10+ 并确保 PATH 可访问。"
  ));

  if (python.path) {
    const version = run(python.command, ["--version"], 3000);
    out.push(check(
      "toolchain.python.version",
      "Python 版本可读取",
      version.ok,
      true,
      version.ok ? (version.stdout || version.stderr || "python version ok") : (version.stderr || version.error || "执行失败"),
      version.ok ? "" : "检查 Python 安装或 PATH 配置。"
    ));
  }

  const deps = resolveFirstCommandPath(["uv", "poetry", "pip3", "pip"]);
  out.push(check(
    "microservice.python.deps.manager",
    "Python 依赖管理器可用（uv/poetry/pip）",
    Boolean(deps.path),
    true,
    deps.path ? (deps.command + "=" + deps.path) : "未找到 uv/poetry/pip3/pip",
    deps.path ? "" : "建议安装 uv（首选）或 poetry/pip，并确保命令在 PATH 中可用。"
  ));

  const pytestPath = resolveCommandPath("pytest");
  out.push(check(
    "microservice.python.pytest",
    "pytest 命令可用",
    Boolean(pytestPath),
    false,
    pytestPath ? "pytest=" + pytestPath : "未找到 pytest 命令",
    pytestPath ? "" : "建议安装 pytest 以支持微服务自动化回归。"
  ));
  return out;
}

function androidChecks() {
  const out = [];
  const javaPath = resolveCommandPath("java");
  out.push(check(
    "android.java.path",
    "Java 命令可用",
    Boolean(javaPath),
    true,
    javaPath ? ("java=" + javaPath) : "未找到 java 命令",
    javaPath ? "" : "安装 JDK 17+ 并确保 PATH 可访问。"
  ));

  if (javaPath) {
    const version = run("java", ["-version"], 4000);
    out.push(check(
      "android.java.version",
      "Java 版本可读取",
      version.ok,
      true,
      version.ok ? (version.stderr || version.stdout || "java version ok") : (version.stderr || version.error || "执行失败"),
      version.ok ? "" : "检查 JDK 安装与 JAVA_HOME/PATH 配置。"
    ));
  }

  const sdkTool = resolveFirstCommandPath(["sdkmanager", "adb"]);
  out.push(check(
    "android.sdk.tool",
    "Android SDK 工具可用（sdkmanager/adb）",
    Boolean(sdkTool.path),
    true,
    sdkTool.path ? (sdkTool.command + "=" + sdkTool.path) : "未找到 sdkmanager/adb 命令",
    sdkTool.path ? "" : "安装 Android SDK Platform-Tools / Command-line Tools 并配置 PATH。"
  ));

  const gradlePath = resolveCommandPath("gradle");
  out.push(check(
    "android.gradle.path",
    "Gradle 命令可用",
    Boolean(gradlePath),
    false,
    gradlePath ? ("gradle=" + gradlePath) : "未找到 gradle 命令",
    gradlePath ? "" : "建议安装 Gradle，或在仓库中使用 ./gradlew。"
  ));

  return out;
}

function serverlessChecks() {
  const out = [];
  const runtime = resolveFirstCommandPath(["node", "python3", "python"]);
  out.push(check(
    "serverless.runtime.command",
    "Serverless 运行时命令可用（node/python）",
    Boolean(runtime.path),
    true,
    runtime.path ? (runtime.command + "=" + runtime.path) : "未找到 node/python3/python 命令",
    runtime.path ? "" : "安装 Node.js 或 Python 并确保 PATH 可访问。"
  ));

  const deps = resolveFirstCommandPath(["npm", "pnpm", "yarn", "uv", "poetry", "pip3", "pip"]);
  out.push(check(
    "serverless.deps.manager",
    "依赖管理器可用",
    Boolean(deps.path),
    true,
    deps.path ? (deps.command + "=" + deps.path) : "未找到 npm/pnpm/yarn/uv/poetry/pip",
    deps.path ? "" : "安装至少一种依赖管理器并确保 PATH 可访问。"
  ));

  const deployTool = resolveFirstCommandPath(["serverless", "sls", "sam", "cdk", "vercel", "netlify", "aws"]);
  out.push(check(
    "serverless.deploy.tool",
    "部署/本地仿真工具可用",
    Boolean(deployTool.path),
    true,
    deployTool.path ? (deployTool.command + "=" + deployTool.path) : "未找到 serverless/sam/cdk/vercel/netlify/aws",
    deployTool.path ? "" : "按项目技术栈安装对应 CLI（例如 serverless、sam、cdk、vercel 或 netlify）。"
  ));

  return out;
}

function otherChecks() {
  const nodePath = resolveCommandPath("node");
  return [
    check("toolchain.node", "Node.js 命令可用", Boolean(nodePath), true, nodePath ? "node=" + nodePath : "未找到 node 命令", "安装 Node.js 并确保 PATH 可访问。"),
  ];
}

function pickChecks() {
  if (PRODUCT_TYPE === "miniapp") return miniappChecks();
  if (PRODUCT_TYPE === "ios") return iosChecks();
  if (PRODUCT_TYPE === "microservice") return microserviceChecks();
  if (PRODUCT_TYPE === "android") return androidChecks();
  if (PRODUCT_TYPE === "serverless") return serverlessChecks();
  if (PRODUCT_TYPE === "web") return webChecks();
  return otherChecks();
}

function main() {
  const checks = pickChecks();
  const requiredFailed = checks.filter((item) => item.required && !item.ok);
  const report = {
    productType: PRODUCT_TYPE,
    checkedAt: new Date().toISOString(),
    ok: requiredFailed.length === 0,
    checks,
    failedRequired: requiredFailed.map((item) => ({
      id: item.id,
      detail: item.detail,
      hint: item.hint,
    })),
  };

  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
  } else {
    process.stdout.write("Platform preflight checks:\\n");
    for (const item of checks) {
      const badge = item.ok ? "OK" : (item.required ? "FAIL" : "WARN");
      process.stdout.write("- [" + badge + "] " + item.id + " " + item.title + " :: " + item.detail + "\\n");
    }
  }

  if (STRICT && !report.ok) {
    process.exit(1);
    return;
  }
}

main();
`;
}

function buildProjectPlatformSmokeScript(meta) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const PRODUCT_TYPE = ${JSON.stringify(String(meta.productType ?? "other"))};
const STRICT = process.argv.includes("--strict");
const JSON_OUTPUT = process.argv.includes("--json");

function check(id, title, ok, required, detail, hint = "") {
  return {
    id,
    title,
    ok: Boolean(ok),
    required: Boolean(required),
    detail: String(detail ?? ""),
    hint: String(hint ?? ""),
  };
}

function run(command, args = [], timeout = 5000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : "",
  };
}

function resolveCommandPath(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const out = run(checker, [command], 1800);
  if (!out.ok) return "";
  const first = out.stdout.split(/\\r?\\n/).map((line) => line.trim()).find(Boolean);
  return first ?? "";
}

function resolveFirstCommandPath(commands) {
  const list = Array.isArray(commands) ? commands : [commands];
  for (const item of list) {
    const command = String(item ?? "").trim();
    if (!command) continue;
    const commandPath = resolveCommandPath(command);
    if (commandPath) {
      return {
        command,
        path: commandPath,
      };
    }
  }
  return {
    command: "",
    path: "",
  };
}

function detectWechatCliPath() {
  const envPath = String(process.env.FORGEOPS_WECHAT_DEVTOOLS_CLI ?? "").trim();
  const candidates = [];
  if (envPath) candidates.push(envPath);
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
      "/Applications/wechatdevtools.app/Contents/MacOS/cli",
      "/Applications/微信开发者工具.app/Contents/MacOS/cli",
    );
  }
  for (const item of candidates) {
    const abs = path.resolve(item);
    if (fs.existsSync(abs)) return abs;
  }
  return "";
}

function probeWechatCliRuntime(cliPath) {
  if (!cliPath) {
    return {
      servicePortEnabled: false,
      loggedIn: false,
      detail: "cli path missing",
      hint: "先安装微信开发者工具并配置 FORGEOPS_WECHAT_DEVTOOLS_CLI。",
    };
  }

  const probe = spawnSync(cliPath, ["islogin", "--lang", "zh"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: "n\\n",
    timeout: 8000,
  });
  const stdout = String(probe.stdout ?? "").trim();
  const stderr = String(probe.stderr ?? "").trim();
  const combined = stdout + "\\n" + stderr;
  const combinedLower = combined.toLowerCase();
  const servicePortDisabled = combinedLower.includes("service port disabled")
    || combined.includes("服务端口已关闭")
    || combined.includes("工具的服务端口已关闭");
  const servicePortEnabled = !servicePortDisabled;
  const loggedIn = probe.status === 0
    || combinedLower.includes("islogin: true")
    || combinedLower.includes("is login: true")
    || combined.includes("已登录");

  let detail = "";
  if (servicePortDisabled) {
    detail = "检测到 IDE 服务端口关闭";
  } else if (probe.error) {
    detail = String(probe.error.message ?? probe.error);
  } else if (combined.trim()) {
    detail = combined.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" | ");
  } else {
    detail = "exit=" + String(probe.status ?? -1);
  }

  return {
    servicePortEnabled,
    loggedIn,
    detail,
    hint: servicePortEnabled
      ? ""
      : "打开微信开发者工具 -> 设置 -> 安全设置，开启“服务端口”；或首次 CLI 提示时输入 y。",
  };
}

function readJsonFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function resolvePythonCommand() {
  const python = resolveFirstCommandPath(["python3", "python"]);
  return python.path ? python.command : "";
}

function resolvePythonDependencySyncCommand() {
  const fromEnv = String(process.env.FORGEOPS_PYTHON_DEPS_SYNC_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_PYTHON_DEPS_SYNC_CMD",
    };
  }
  const python = resolvePythonCommand();
  const hasPyproject = fs.existsSync(path.join(ROOT, "pyproject.toml"));
  const hasRequirements = fs.existsSync(path.join(ROOT, "requirements.txt"));
  const uv = resolveCommandPath("uv");
  if (hasPyproject && uv) {
    return {
      command: "uv sync",
      source: "pyproject.toml + uv",
    };
  }
  const poetry = resolveCommandPath("poetry");
  if (hasPyproject && poetry) {
    return {
      command: "poetry install",
      source: "pyproject.toml + poetry",
    };
  }
  if (hasRequirements && python) {
    return {
      command: python + " -m pip install -r requirements.txt",
      source: "requirements.txt + pip",
    };
  }
  return null;
}

function resolvePythonBackendStartCommand(backendPort) {
  const fromEnv = String(process.env.FORGEOPS_BACKEND_START_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_BACKEND_START_CMD",
    };
  }

  const python = resolvePythonCommand();
  if (!python) return null;

  const asgiCandidates = [
    { file: path.join(ROOT, "app", "main.py"), module: "app.main:app" },
    { file: path.join(ROOT, "service", "main.py"), module: "service.main:app" },
    { file: path.join(ROOT, "api", "main.py"), module: "api.main:app" },
    { file: path.join(ROOT, "main.py"), module: "main:app" },
  ];
  const asgi = asgiCandidates.find((item) => fs.existsSync(item.file));
  if (asgi) {
    return {
      command: python + " -m uvicorn " + asgi.module + " --host 127.0.0.1 --port " + String(backendPort),
      source: "python uvicorn auto-detect",
    };
  }

  if (fs.existsSync(path.join(ROOT, "manage.py"))) {
    return {
      command: python + " manage.py runserver 127.0.0.1:" + String(backendPort),
      source: "manage.py runserver",
    };
  }

  if (fs.existsSync(path.join(ROOT, "main.py"))) {
    return {
      command: python + " main.py",
      source: "main.py",
    };
  }
  return null;
}

function resolveBackendStartCommand(backendPort) {
  const fromEnv = String(process.env.FORGEOPS_BACKEND_START_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_BACKEND_START_CMD",
    };
  }

  const packageJson = readJsonFile("package.json");
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const preferred = [
    "backend:dev",
    "dev:backend",
    "dev:api",
    "start:backend",
    "start:api",
    "server",
    "start",
    "dev",
  ];
  const picked = preferred.find((name) => Boolean(scripts[name]));
  if (picked) {
    return {
      command: "npm run " + picked,
      source: "package.json#scripts." + picked,
    };
  }

  if (PRODUCT_TYPE === "microservice") {
    return resolvePythonBackendStartCommand(backendPort);
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHttp(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function tailText(input, maxLines = 8, maxChars = 800) {
  const text = String(input ?? "").trim();
  if (!text) return "";
  const lines = text.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-maxLines).join(" | ");
  if (tail.length <= maxChars) return tail;
  return tail.slice(0, Math.max(40, maxChars - 3)) + "...";
}

function hashText(text) {
  const source = String(text ?? "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % 1_000_000;
  }
  return hash;
}

function resolveRunScopedPort(defaultPort = 3000) {
  const fromEnv = Number(process.env.FORGEOPS_BACKEND_PORT ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) {
    return Math.floor(fromEnv);
  }

  const normalizedRoot = String(ROOT ?? "").split(path.sep).join("/");
  const matched = normalizedRoot.match(/\\/\\.forgeops\\/worktrees\\/([^/]+)/);
  const runId = String(matched?.[1] ?? "").trim();
  const seed = runId || normalizedRoot || String(process.pid);
  const offset = hashText(seed) % 1000;
  const candidate = defaultPort + offset;
  if (candidate < 1 || candidate > 65535) return defaultPort;
  return candidate;
}

async function runBackendHealthSmoke() {
  const checks = [];
  const backendPort = resolveRunScopedPort(3000);
  const defaultHealthUrl = "http://127.0.0.1:" + String(backendPort) + "/health";
  const healthUrl = String(process.env.FORGEOPS_BACKEND_HEALTH_URL ?? defaultHealthUrl).trim() || defaultHealthUrl;
  const commandInfo = resolveBackendStartCommand(backendPort);
  checks.push(check(
    "backend.start.command",
    "后端启动命令可解析",
    Boolean(commandInfo?.command),
    true,
    commandInfo?.command
      ? ("command=" + commandInfo.command + " (" + commandInfo.source + ")")
      : "未找到后端启动命令",
    commandInfo?.command
      ? ""
      : "请在 package.json 提供 backend:dev/dev:backend/start:backend/start，或设置 FORGEOPS_BACKEND_START_CMD。"
  ));
  if (!commandInfo?.command) return checks;

  const backendProcess = spawn(commandInfo.command, {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      PORT: String(backendPort),
      FORGEOPS_BACKEND_PORT: String(backendPort),
      FORGEOPS_BACKEND_HEALTH_URL: healthUrl,
    },
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  backendProcess.stdout?.on("data", (chunk) => {
    stdoutChunks.push(String(chunk ?? ""));
    if (stdoutChunks.length > 10) stdoutChunks.shift();
  });
  backendProcess.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk ?? ""));
    if (stderrChunks.length > 10) stderrChunks.shift();
  });

  const timeoutMs = Number(process.env.FORGEOPS_BACKEND_START_TIMEOUT_MS ?? 30000);
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);
  let reachable = false;
  let responseStatus = 0;
  let lastError = "";

  while (Date.now() < deadline) {
    const probed = await probeHttp(healthUrl, 1200);
    if (probed.ok) {
      reachable = true;
      responseStatus = Number(probed.status ?? 0);
      break;
    }
    lastError = String(probed.error ?? "");
    if (backendProcess.exitCode !== null) {
      break;
    }
    await delay(1000);
  }

  if (backendProcess.exitCode === null && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
    await delay(1000);
    if (backendProcess.exitCode === null && !backendProcess.killed) {
      backendProcess.kill("SIGKILL");
    }
  }

  const stdoutTail = tailText(stdoutChunks.join(""));
  const stderrTail = tailText(stderrChunks.join(""));
  const detailParts = [];
  detailParts.push("port=" + String(backendPort));
  detailParts.push("url=" + healthUrl);
  detailParts.push("command=" + commandInfo.command);
  if (reachable) {
    detailParts.push("status=" + String(responseStatus));
  } else if (backendProcess.exitCode !== null) {
    detailParts.push("backend exited with code " + String(backendProcess.exitCode));
  } else if (lastError) {
    detailParts.push(lastError);
  } else {
    detailParts.push("health probe timeout");
  }
  if (!reachable && stdoutTail) detailParts.push("stdout_tail=" + stdoutTail);
  if (!reachable && stderrTail) detailParts.push("stderr_tail=" + stderrTail);

  checks.push(check(
    "backend.health.reachable",
    "后端健康检查可达",
    reachable,
    true,
    detailParts.join(" | "),
    reachable
      ? ""
      : "确保后端提供健康检查端点，并通过 FORGEOPS_BACKEND_HEALTH_URL 指定 URL（默认使用 run 级隔离端口）。"
  ));

  return checks;
}

async function miniappChecks() {
  const out = [];
  const miniappRoot = path.join(ROOT, "miniapp");
  out.push(check(
    "miniapp.root.exists",
    "miniapp 目录存在",
    fs.existsSync(miniappRoot),
    true,
    fs.existsSync(miniappRoot) ? "miniapp 目录已找到" : "缺少 miniapp 目录",
    "请确保小程序工程位于项目根目录 miniapp/ 下。"
  ));

  const appJsonPath = path.join(ROOT, "miniapp", "app.json");
  out.push(check(
    "miniapp.app_json.exists",
    "miniapp/app.json 存在",
    fs.existsSync(appJsonPath),
    true,
    fs.existsSync(appJsonPath) ? "app.json 已找到" : "缺少 miniapp/app.json",
    "确认小程序目录结构与 app.json 配置。"
  ));

  const appJson = readJsonFile(path.join("miniapp", "app.json"));
  const pages = Array.isArray(appJson?.pages) ? appJson.pages : [];
  out.push(check(
    "miniapp.app_json.pages",
    "app.json 声明 pages 列表",
    pages.length > 0,
    true,
    pages.length > 0 ? "pages=" + pages.length : "app.json 未配置 pages",
    "在 app.json 中声明页面路由。"
  ));

  for (const rawPage of pages) {
    const page = String(rawPage ?? "").trim();
    if (!page) continue;
    const jsPath = path.join(ROOT, "miniapp", page + ".js");
    const tsPath = path.join(ROOT, "miniapp", page + ".ts");
    const hasJs = fs.existsSync(jsPath);
    out.push(check(
      "miniapp.page_entry." + page,
      "页面脚本存在: " + page,
      hasJs,
      true,
      hasJs ? "entry=" + path.relative(ROOT, jsPath) : "缺少 " + path.relative(ROOT, jsPath),
      fs.existsSync(tsPath)
        ? "发现 TypeScript 源文件，请先生成 .js 产物后再验收（例如 npm run build:miniapp）。"
        : "补充页面 JS 入口文件。"
    ));
  }

  const projectConfigPath = path.join(ROOT, "miniapp", "project.config.json");
  out.push(check(
    "miniapp.project_config.exists",
    "miniapp/project.config.json 存在",
    fs.existsSync(projectConfigPath),
    true,
    fs.existsSync(projectConfigPath) ? "project.config.json 已找到" : "缺少 miniapp/project.config.json",
    "导入微信开发者工具前需要项目配置文件。"
  ));

  const cliPath = detectWechatCliPath();
  out.push(check(
    "miniapp.devtools.cli.path",
    "微信开发者工具 CLI 可定位",
    Boolean(cliPath),
    true,
    cliPath ? "cli=" + cliPath : "未找到微信开发者工具 CLI",
    "安装微信开发者工具，或设置 FORGEOPS_WECHAT_DEVTOOLS_CLI。"
  ));
  if (cliPath) {
    const help = run(cliPath, ["--help"], 5000);
    out.push(check(
      "miniapp.devtools.cli.exec",
      "微信开发者工具 CLI 可执行",
      help.ok,
      true,
      help.ok ? "cli --help 执行成功" : (help.stderr || help.error || "执行失败"),
      "检查 CLI 路径权限或重新安装微信开发者工具。"
    ));
    const runtimeProbe = probeWechatCliRuntime(cliPath);
    out.push(check(
      "miniapp.devtools.cli.service_port",
      "微信开发者工具服务端口已开启",
      runtimeProbe.servicePortEnabled,
      true,
      runtimeProbe.detail,
      runtimeProbe.hint
    ));
    out.push(check(
      "miniapp.devtools.cli.login",
      "微信开发者工具登录状态可用",
      runtimeProbe.loggedIn,
      false,
      runtimeProbe.loggedIn ? "islogin 检测通过（已登录）" : "未检测到登录态（不阻断）",
      runtimeProbe.loggedIn ? "" : "如需 preview/upload 自动化，请先登录微信开发者工具。"
    ));
  }

  const backendChecks = await runBackendHealthSmoke();
  out.push(...backendChecks);

  return out;
}

function webChecks() {
  const out = [];
  const packageJson = readJsonFile("package.json");
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const hasBuild = Boolean(scripts.build || scripts["frontend:build"] || scripts.verify);
  out.push(check(
    "web.scripts.build",
    "存在可执行构建/验证脚本",
    hasBuild,
    true,
    hasBuild ? "已发现 build/verify 相关脚本" : "package.json 缺少 build/verify 相关脚本",
    "至少提供 build、verify 或 frontend:build 之一作为 web 验收入口。"
  ));
  const hasPlaywright = Boolean(scripts.e2e || scripts["test:e2e"] || scripts["smoke:web"]);
  out.push(check(
    "web.scripts.e2e",
    "存在 Web UI smoke/e2e 脚本",
    hasPlaywright,
    false,
    hasPlaywright ? "已发现 e2e/smoke 脚本" : "未发现 e2e/smoke 脚本",
    "建议增加 Playwright/Chrome DevTools 验收脚本。"
  ));
  return out;
}

function iosChecks() {
  const out = [];
  const entries = fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [];
  const hasProject = entries.some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"));
  out.push(check(
    "ios.workspace.exists",
    "Xcode 工程存在",
    hasProject,
    true,
    hasProject ? "已探测到 .xcodeproj/.xcworkspace" : "未探测到 Xcode 工程",
    "初始化 iOS 项目后应生成 .xcodeproj 或 .xcworkspace。"
  ));
  if (hasProject) {
    const xcodebuildList = run("xcodebuild", ["-list"], 7000);
    out.push(check(
      "ios.xcodebuild.list",
      "xcodebuild -list 可执行",
      xcodebuildList.ok,
      true,
      xcodebuildList.ok ? "xcodebuild -list 执行成功" : (xcodebuildList.stderr || xcodebuildList.error || "执行失败"),
      "检查工程路径、Xcode 配置与签名配置。"
    ));
  }
  return out;
}

async function microserviceChecks() {
  const out = [];
  const python = resolvePythonCommand();
  const hasPyproject = fs.existsSync(path.join(ROOT, "pyproject.toml"));
  const hasRequirements = fs.existsSync(path.join(ROOT, "requirements.txt"))
    || fs.existsSync(path.join(ROOT, "requirements-dev.txt"));

  out.push(check(
    "microservice.python.manifest",
    "Python 依赖清单存在",
    hasPyproject || hasRequirements,
    true,
    hasPyproject
      ? "found pyproject.toml"
      : (hasRequirements ? "found requirements*.txt" : "未找到 pyproject.toml 或 requirements*.txt"),
    hasPyproject || hasRequirements ? "" : "请提供 pyproject.toml 或 requirements*.txt。"
  ));

  out.push(check(
    "microservice.python.command",
    "Python 命令可用",
    Boolean(python),
    true,
    python ? ("python=" + python) : "未找到 python3/python 命令",
    python ? "" : "安装 Python 3.10+ 并确保 PATH 可访问。"
  ));

  const depSync = resolvePythonDependencySyncCommand();
  out.push(check(
    "microservice.python.deps.sync",
    "依赖同步命令可解析",
    Boolean(depSync?.command),
    true,
    depSync?.command
      ? ("command=" + depSync.command + " (" + depSync.source + ")")
      : "未解析到依赖同步命令",
    depSync?.command
      ? ""
      : "建议配置 uv/poetry/pip 路径，或设置 FORGEOPS_PYTHON_DEPS_SYNC_CMD。"
  ));

  const backendChecks = await runBackendHealthSmoke();
  out.push(...backendChecks);
  return out;
}

function resolveAndroidBuildCommand() {
  const fromEnv = String(process.env.FORGEOPS_ANDROID_BUILD_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_ANDROID_BUILD_CMD",
    };
  }

  const gradleWrapper = path.join(ROOT, "gradlew");
  if (fs.existsSync(gradleWrapper)) {
    return {
      command: "./gradlew assembleDebug",
      source: "gradlew",
    };
  }

  const gradle = resolveCommandPath("gradle");
  const hasGradleProject = fs.existsSync(path.join(ROOT, "settings.gradle"))
    || fs.existsSync(path.join(ROOT, "settings.gradle.kts"))
    || fs.existsSync(path.join(ROOT, "build.gradle"))
    || fs.existsSync(path.join(ROOT, "build.gradle.kts"));
  if (gradle && hasGradleProject) {
    return {
      command: "gradle assembleDebug",
      source: "gradle command + gradle files",
    };
  }
  return null;
}

function androidChecks() {
  const out = [];
  const hasGradleProject = fs.existsSync(path.join(ROOT, "settings.gradle"))
    || fs.existsSync(path.join(ROOT, "settings.gradle.kts"))
    || fs.existsSync(path.join(ROOT, "build.gradle"))
    || fs.existsSync(path.join(ROOT, "build.gradle.kts"));
  out.push(check(
    "android.gradle.project",
    "Android Gradle 工程文件存在",
    hasGradleProject,
    true,
    hasGradleProject ? "found settings.gradle/build.gradle" : "未找到 Gradle 工程文件",
    "请确认仓库根目录包含 Android Gradle 工程（settings.gradle/build.gradle）。"
  ));

  const hasManifest = fs.existsSync(path.join(ROOT, "app", "src", "main", "AndroidManifest.xml"));
  out.push(check(
    "android.manifest.exists",
    "AndroidManifest 存在",
    hasManifest,
    true,
    hasManifest ? "found app/src/main/AndroidManifest.xml" : "缺少 app/src/main/AndroidManifest.xml",
    "请确保 Android app 模块结构完整。"
  ));

  const buildCommand = resolveAndroidBuildCommand();
  out.push(check(
    "android.build.command",
    "Android 构建命令可解析",
    Boolean(buildCommand?.command),
    true,
    buildCommand?.command
      ? ("command=" + buildCommand.command + " (" + buildCommand.source + ")")
      : "未解析到 Android 构建命令",
    buildCommand?.command
      ? ""
      : "设置 FORGEOPS_ANDROID_BUILD_CMD，或提供 gradlew/gradle 工程文件。"
  ));
  return out;
}

function resolveServerlessSmokeCommand() {
  const fromEnv = String(process.env.FORGEOPS_SERVERLESS_SMOKE_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_SERVERLESS_SMOKE_CMD",
    };
  }

  const packageJson = readJsonFile("package.json");
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const preferred = ["smoke:serverless", "test:functions", "verify", "test"];
  const picked = preferred.find((name) => Boolean(scripts[name]));
  if (picked) {
    return {
      command: "npm run " + picked,
      source: "package.json#scripts." + picked,
    };
  }

  const deployTool = resolveFirstCommandPath(["serverless", "sls", "sam", "cdk", "vercel", "netlify", "aws"]);
  if (deployTool.path) {
    return {
      command: deployTool.command + " --help",
      source: deployTool.command,
    };
  }
  return null;
}

function serverlessChecks() {
  const out = [];
  const hasInfraManifest = fs.existsSync(path.join(ROOT, "serverless.yml"))
    || fs.existsSync(path.join(ROOT, "serverless.yaml"))
    || fs.existsSync(path.join(ROOT, "template.yml"))
    || fs.existsSync(path.join(ROOT, "template.yaml"))
    || fs.existsSync(path.join(ROOT, "cdk.json"))
    || fs.existsSync(path.join(ROOT, "vercel.json"))
    || fs.existsSync(path.join(ROOT, "netlify.toml"));
  out.push(check(
    "serverless.infra.manifest",
    "Serverless 基础设施清单存在",
    hasInfraManifest,
    true,
    hasInfraManifest ? "found serverless/infra manifest" : "未找到 serverless 模板清单文件",
    "请提供 serverless.yml/template.yaml/cdk.json/vercel.json/netlify.toml 之一。"
  ));

  const hasDepsManifest = fs.existsSync(path.join(ROOT, "package.json"))
    || fs.existsSync(path.join(ROOT, "pyproject.toml"))
    || fs.existsSync(path.join(ROOT, "requirements.txt"))
    || fs.existsSync(path.join(ROOT, "requirements-dev.txt"));
  out.push(check(
    "serverless.deps.manifest",
    "依赖清单存在",
    hasDepsManifest,
    true,
    hasDepsManifest ? "found dependency manifest" : "未找到 package.json/pyproject.toml/requirements*.txt",
    "请补充依赖清单文件。"
  ));

  const smokeCommand = resolveServerlessSmokeCommand();
  out.push(check(
    "serverless.smoke.command",
    "Serverless smoke 命令可解析",
    Boolean(smokeCommand?.command),
    true,
    smokeCommand?.command
      ? ("command=" + smokeCommand.command + " (" + smokeCommand.source + ")")
      : "未解析到 serverless smoke 命令",
    smokeCommand?.command
      ? ""
      : "设置 FORGEOPS_SERVERLESS_SMOKE_CMD，或在 package.json 增加 smoke:serverless/test:functions 脚本。"
  ));
  return out;
}

function otherChecks() {
  return [
    check("other.smoke.placeholder", "通用 smoke 检查", true, true, "other 类型暂无额外平台 smoke 约束"),
  ];
}

async function pickChecks() {
  if (PRODUCT_TYPE === "miniapp") return miniappChecks();
  if (PRODUCT_TYPE === "ios") return iosChecks();
  if (PRODUCT_TYPE === "microservice") return microserviceChecks();
  if (PRODUCT_TYPE === "android") return androidChecks();
  if (PRODUCT_TYPE === "serverless") return serverlessChecks();
  if (PRODUCT_TYPE === "web") return webChecks();
  return otherChecks();
}

async function main() {
  const checks = await pickChecks();
  const requiredFailed = checks.filter((item) => item.required && !item.ok);
  const report = {
    productType: PRODUCT_TYPE,
    checkedAt: new Date().toISOString(),
    ok: requiredFailed.length === 0,
    checks,
    failedRequired: requiredFailed.map((item) => ({
      id: item.id,
      detail: item.detail,
      hint: item.hint,
    })),
  };

  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
  } else {
    process.stdout.write("Platform smoke checks:\\n");
    for (const item of checks) {
      const badge = item.ok ? "OK" : (item.required ? "FAIL" : "WARN");
      process.stdout.write("- [" + badge + "] " + item.id + " " + item.title + " :: " + item.detail + "\\n");
    }
  }

  if (STRICT && !report.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  const message = String(err?.message ?? err);
  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({
      productType: PRODUCT_TYPE,
      checkedAt: new Date().toISOString(),
      ok: false,
      checks: [],
      failedRequired: [
        {
          id: "platform-smoke.runtime.error",
          detail: message,
          hint: "检查平台 smoke 脚本执行环境。",
        },
      ],
    }, null, 2) + "\\n");
  } else {
    process.stderr.write("Platform smoke runtime error: " + message + "\\n");
  }
  process.exit(1);
});
`;
}

export function initProjectScaffold(meta) {
  const rootPath = path.resolve(meta.rootPath);
  const updatedAt = new Date().toISOString().slice(0, 10);
  emitProgress(meta, "preflight.start", `执行产品工具链预检查: ${getProductTypeLabel(meta.productType)} (${meta.productType})`);
  const preflight = ensureProductToolchainReady({
    productType: meta.productType,
    onCheck: (item) => {
      const mode = item.required ? "required" : "optional";
      emitProgress(
        meta,
        "preflight.check",
        `[${mode}] ${item.ok ? "OK" : "FAIL"} ${item.id} · ${item.title}${item.detail ? ` · ${item.detail}` : ""}`
      );
    },
  });
  emitProgress(meta, "preflight.done", `预检查通过：required_failed=${preflight.failedRequired.length}`);
  const tech = normalizeTechProfile(meta);
  const resolvedMeta = {
    ...meta,
    productTypeLabel: getProductTypeLabel(meta.productType),
    tech,
  };

  emitProgress(meta, "scaffold.start", `初始化项目目录: ${rootPath}`);
  ensureDir(rootPath);

  const dirs = [
    ".forgeops",
    ".forgeops/tools",
    ".forgeops/tests",
    "docs",
    "docs/architecture",
    "docs/context",
    "docs/design",
    "docs/experience",
    "docs/quality",
    "docs/meta",
    "docs/exec-plans",
    "docs/exec-plans/active",
    "docs/exec-plans/completed",
    "docs/product-specs",
    "docs/references",
    "scripts",
  ];
  for (const dir of dirs) {
    ensureDir(path.join(rootPath, dir));
  }
  emitProgress(meta, "scaffold.dirs.ready", `目录结构准备完成（${dirs.length}项）`);

  const writes = [];
  emitProgress(meta, "scaffold.files.core", "写入核心配置与上下文文件");
  writes.push({ path: "AGENTS.md", created: writeIfMissing(path.join(rootPath, "AGENTS.md"), buildAgentsMarkdown(resolvedMeta)) });
  writes.push({ path: ".forgeops/project.yaml", created: writeIfMissing(path.join(rootPath, ".forgeops/project.yaml"), buildProjectYaml(resolvedMeta)) });
  writes.push({ path: ".forgeops/workflow.yaml", created: writeIfMissing(path.join(rootPath, ".forgeops/workflow.yaml"), buildWorkflowYaml()) });
  writes.push({ path: ".forgeops/context.md", created: writeIfMissing(path.join(rootPath, ".forgeops/context.md"), buildContextMarkdown(resolvedMeta)) });
  writes.push({ path: ".forgeops/governance.md", created: writeIfMissing(path.join(rootPath, ".forgeops/governance.md"), buildGovernanceMarkdown()) });

  const invariantPaths = getInvariantPaths(rootPath);
  emitProgress(meta, "scaffold.files.invariants", "写入不变量配置与检查脚本");
  writes.push({ path: ".forgeops/invariants.json", created: writeIfMissing(invariantPaths.configPath, buildInvariantsConfig(resolvedMeta)) });
  writes.push({ path: invariantPaths.checkerPathRelative, created: writeIfMissing(invariantPaths.checkerPath, buildInvariantsCheckerScript()) });
  writes.push({ path: ".forgeops/tests/invariants-smoke.mjs", created: writeIfMissing(invariantPaths.testPath, buildInvariantsTestScript()) });
  writes.push({
    path: ".forgeops/scheduler.yaml",
    created: writeIfMissing(
      path.join(rootPath, ".forgeops", "scheduler.yaml"),
      buildSchedulerConfigYaml(DEFAULT_SCHEDULER_CONFIG)
    ),
  });
  emitProgress(meta, "scaffold.files.platform", "写入平台预检查与平台验收脚本");
  writes.push({
    path: ".forgeops/tools/platform-preflight.mjs",
    created: writeIfMissing(
      path.join(rootPath, ".forgeops", "tools", "platform-preflight.mjs"),
      buildProjectPlatformPreflightScript(resolvedMeta),
    ),
  });
  writes.push({
    path: ".forgeops/tools/platform-smoke.mjs",
    created: writeIfMissing(
      path.join(rootPath, ".forgeops", "tools", "platform-smoke.mjs"),
      buildProjectPlatformSmokeScript(resolvedMeta),
    ),
  });

  emitProgress(meta, "scaffold.files.docs", "写入 docs 记录系统骨架与检查脚本");
  const uiDoc = resolveUiGuidanceDoc(resolvedMeta);
  writes.push({ path: "docs/00-index.md", created: writeIfMissing(path.join(rootPath, "docs/00-index.md"), buildDocsIndexMarkdown(resolvedMeta, updatedAt)) });
  writes.push({ path: "docs/context/index.md", created: writeIfMissing(path.join(rootPath, "docs/context/index.md"), buildContextDocsIndexMarkdown(updatedAt)) });
  writes.push({ path: "docs/architecture/00-overview.md", created: writeIfMissing(path.join(rootPath, "docs/architecture/00-overview.md"), buildArchitectureOverviewMarkdown(resolvedMeta, updatedAt)) });
  writes.push({ path: "docs/architecture/layering.md", created: writeIfMissing(path.join(rootPath, "docs/architecture/layering.md"), buildLayeringMarkdown(updatedAt)) });
  writes.push({
    path: "docs/architecture/ADR-0001.md",
    created: writeIfMissing(
      path.join(rootPath, "docs/architecture/ADR-0001.md"),
      `# ADR-0001\n\nStatus: Draft\nUpdated: ${updatedAt}\n\n## Context\n- 记录本项目的关键架构决策背景。\n\n## Decision\n- 待 Architect Agent 决策。\n\n## Consequences\n- 待补充。\n`
    ),
  });
  writes.push({ path: "docs/design/core-beliefs.md", created: writeIfMissing(path.join(rootPath, "docs/design/core-beliefs.md"), buildCoreBeliefsMarkdown(updatedAt)) });
  writes.push({
    path: "harness-engineering-guidelines.md",
    created: writeIfMissing(path.join(rootPath, "harness-engineering-guidelines.md"), buildHarnessGuideMarkdown(updatedAt)),
  });
  if (uiDoc) {
    writes.push({
      path: uiDoc.path,
      created: writeIfMissing(path.join(rootPath, uiDoc.path), uiDoc.content(updatedAt)),
    });
  }
  writes.push({ path: "docs/quality/domain-grades.md", created: writeIfMissing(path.join(rootPath, "docs/quality/domain-grades.md"), buildDomainGradesMarkdown(updatedAt)) });
  writes.push({ path: "docs/quality/verification-status.md", created: writeIfMissing(path.join(rootPath, "docs/quality/verification-status.md"), buildVerificationStatusMarkdown(updatedAt)) });
  writes.push({ path: "docs/quality/golden-principles.md", created: writeIfMissing(path.join(rootPath, "docs/quality/golden-principles.md"), buildGoldenPrinciplesMarkdown(updatedAt)) });
  writes.push({ path: "docs/meta/doc-freshness.md", created: writeIfMissing(path.join(rootPath, "docs/meta/doc-freshness.md"), buildDocFreshnessMarkdown(updatedAt)) });
  writes.push({ path: "docs/meta/doc-structure.md", created: writeIfMissing(path.join(rootPath, "docs/meta/doc-structure.md"), buildDocStructureMarkdown(updatedAt)) });
  writes.push({ path: "docs/exec-plans/active/README.md", created: writeIfMissing(path.join(rootPath, "docs/exec-plans/active/README.md"), buildExecPlansActiveReadme(updatedAt)) });
  writes.push({ path: "docs/exec-plans/completed/README.md", created: writeIfMissing(path.join(rootPath, "docs/exec-plans/completed/README.md"), buildExecPlansCompletedReadme(updatedAt)) });
  writes.push({ path: "docs/exec-plans/tech-debt-tracker.md", created: writeIfMissing(path.join(rootPath, "docs/exec-plans/tech-debt-tracker.md"), buildTechDebtTrackerMarkdown(updatedAt)) });
  writes.push({ path: "docs/product-specs/index.md", created: writeIfMissing(path.join(rootPath, "docs/product-specs/index.md"), buildProductSpecsIndexMarkdown(updatedAt)) });
  writes.push({ path: "docs/references/index.md", created: writeIfMissing(path.join(rootPath, "docs/references/index.md"), buildReferenceIndexMarkdown(updatedAt)) });
  writes.push({ path: "scripts/check-doc-freshness.js", created: writeIfMissing(path.join(rootPath, "scripts/check-doc-freshness.js"), buildProjectDocFreshnessCheckScript()) });
  writes.push({ path: "scripts/check-doc-structure.js", created: writeIfMissing(path.join(rootPath, "scripts/check-doc-structure.js"), buildProjectDocStructureCheckScript()) });

  emitProgress(meta, "scaffold.skills", "生成角色技能映射与技能包模板");
  const skillScaffold = scaffoldProjectSkills({
    ...resolvedMeta,
    rootPath,
  });
  writes.push(...skillScaffold.writes);

  emitProgress(meta, "scaffold.git", "初始化 Git 仓库并绑定 GitHub 远程（可能耗时）");
  const git = provisionProjectGitHubRemote({
    rootPath,
    projectName: resolvedMeta.name,
    githubRepo: resolvedMeta.githubRepo ?? null,
    visibility: resolvedMeta.githubVisibility === "public" ? "public" : "private",
    branchProtection: resolvedMeta.branchProtection !== false,
    description: resolvedMeta.problemStatement ?? "",
    defaultBranch: "main",
    onProgress: meta.onProgress,
  });

  const createdCount = writes.filter((item) => item.created).length;
  const existsCount = writes.length - createdCount;
  emitProgress(
    meta,
    "scaffold.done",
    `脚手架完成：created=${createdCount}, exists=${existsCount}, skills=${Object.keys(skillScaffold.roleMap).length} roles`
  );

  return {
    rootPath,
    writes,
    tech,
    roleSkills: skillScaffold.roleMap,
    git,
  };
}
