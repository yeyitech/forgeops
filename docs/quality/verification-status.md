# 验证状态

Status: Active
Updated: 2026-02-27

## 已验证

- CLI 关键命令可执行（project/issue/run/resume/attach/start）。
- API 与 SSE 可访问。
- Lit 前端可构建并加载。
- Codex 运行时接入可产生 step/session/event 状态。
- 默认工作流已包含 cleanup（Garbage Collection）步骤定义。
- run 创建已支持项目级 `.forgeops/workflow.yaml` 配置与校验。
- run 创建已支持 DAG 依赖校验（入口步骤、引用合法性、无循环）。
- run 创建会注入项目上下文文件 `.forgeops/context.md`。
- project init 可自动初始化 git 仓库并创建/绑定 GitHub origin（依赖 `gh auth`）。
- project init 完成后会自动尝试保护 `main` 分支（严格策略优先，失败回退到基础保护策略；可通过 `--branch-protection|--no-branch-protection` 显式控制）。
- GitHub 强流程 precheck 已包含 git 身份校验（`user.name` + `user.email`）与 `gh auth`。
- 系统启动前已增加 runtime precheck（当前校验 `codex --version`）。
- run 创建已接入 GitHub 强约束校验，并为每个 run 自动创建独立 git worktree 分支。
- run 完成后默认会在 cleanup 后执行最终闸门（invariants + docs checks）并自动合并 PR（可通过 workflow `auto_merge` 项目级关闭，并可通过 `merge_method` 选择 `squash|merge|rebase`）。
- PR 自动合并冲突支持 Agent 自动修复重试（默认 2 次，可通过 workflow `auto_merge_conflict_max_attempts` 配置，取值 `0-8`）。
- merge 队列锁忙时会进入 deferred（`merge_queue_busy`），不会将 run 判定为失败。
- PR 自动合并成功后默认会自动关闭关联 issue（可通过 workflow `auto_close_issue_on_merge` 项目级关闭）。
- 自动合并在 `merge_method=merge` 且目标分支启用 `required_linear_history` 时，会提前发出告警事件并跳过（避免等待 GitHub merge 报错）。
- PR 合并后会自动触发主分支同步与 run worktree 归档清理（含本地分支删除尝试）。
- project init 已支持角色多技能初始化：生成 `.forgeops/agent-skills.json` 与 `.forgeops/skills/*/SKILL.md`。
- run 提示词已注入角色技能清单与技术画像（language/frontend/backend/ci）。
- run 提示词已注入治理策略（硬边界 + 软约束 + 最小阻塞 gate）。
- `issue` 步骤已支持输入缺口补齐策略（Assumptions/Open Questions）与用户偏好信号提取（基于 issue + context）。
- project init 已接入产品类型工具链预检查（miniapp/web/ios/microservice/android/serverless），required 失败会阻断初始化。
- project init 已生成平台验收脚本（`.forgeops/tools/platform-preflight.mjs`、`.forgeops/tools/platform-smoke.mjs`）。
- 默认工作流已收敛为 6 步（architect -> issue -> implement -> test -> review -> cleanup），平台验收并入 `test` 步骤。
- `test` 角色已强化为“先小步自修再阻断”的执行策略（默认更少人工 resume 交互）。
- `test` 步骤已接入 engine 级平台闸门（强制执行 `platform-preflight` + `platform-smoke`，失败即重试/失败）。
- 平台验收已扩展为全类型可注入运行态命令并采集日志证据（miniapp/web/ios/microservice/android/serverless），用于阻断判定与调试回放。
- run 列表与 run 详情已聚合并展示 `CI Gate` / `Platform Gate` 双状态。
- API 已支持运行中动态调整并发度（`POST /api/engine`）。
- project init 已生成不变量配置与检查器（`.forgeops/invariants.json` + `.forgeops/tools/check-invariants.mjs`）。
- `implement/test/review` 步骤已接入 engine 级不变量自动检查（error 阻塞）。
- `review` 步骤上的不变量 warning 已支持自动创建 GitHub follow-up issue（默认非阻塞，可配置）。
- 已支持在 PR 合并后自动尝试同步项目主工作区默认分支到远端最新（fast-forward）。
- 已新增项目级 Cron 调度配置（`.forgeops/scheduler.yaml`），并在服务启动后自动注册 cleanup 与 issueAutoRun 两类定时任务；cleanup 支持 `lite|deep`（定时默认 deep 单节点）。
- `cleanup` 步骤已支持输出并落盘技能候选（`skill-candidate` -> `.forgeops/skills/candidates/*.md`）。
- 已提供技能候选晋升链路（CLI/API）：从 `.forgeops/skills/candidates/*.md` 生成独立 worktree 分支并创建 draft PR（可选写入角色技能映射），与需求 run DAG 解耦。
- 已提供 user-global 技能库状态与晋升链路（CLI/API）：固定路径 `$FORGEOPS_HOME/skills-global`，通过 PR 与 `audit.ndjson` 审计跨项目晋升。
- Scheduler 已支持独立技能治理 Cron：`skillPromotion`（项目内自动晋升）与 `globalSkillPromotion`（user-global 自动晋升）。
- 自动晋升已支持同分支更新打开中的 Draft PR（`allowUpdateExistingPr`），使同名技能可持续编辑演进而非重复新增。
- 已提供官方技能仓目录 `official-skills/`（标准 `SKILL.md`），替代 JS 内嵌模板作为初始化源。
- 已提供技能统一解析器与来源优先级：`project-local > user-global > official`，并在 prompt 注入中展示来源。
- 已提供按产品类型差异化 reviewer 技能注入（web/miniapp/ios/microservice/android/serverless），review 阶段会校验平台证据完整性。
- 已提供技能解析查看入口：CLI `forgeops skill resolve <projectId>` 与 API `GET /api/projects/:id/skills/resolve`。
- 技能晋升 PR（项目内 / user-global）已支持自动追加 reviewer checklist 评论模板（自动评论）。
- 已提供 scheduler 配置管理通道（CLI + API + UI）。
- 已提供 workflow 配置管理通道（CLI + API + UI）。
- 已提供 run 会话旁观能力（CLI `run attach` + API `POST /api/runs/:id/attach-terminal` + UI 四个入口）。
- project init 已支持生成 docs 记录系统骨架（`docs/00-index.md`、`docs/design/*`、`docs/quality/*`、`docs/meta/*`、`docs/exec-plans/*`）。
- 已新增文档结构机械检查脚本：`node scripts/check-doc-structure.js`。
- `npm run docs:check` 已升级为 freshness + structure 双检查。

## 已知限制

- 完整端到端成功率受运行时网络与模型输出稳定性影响。
- 不同团队的 Web/MiniApp/iOS/Microservice/Android/Serverless 平台验收深度仍取决于项目内脚本完善度（模板已给出基础入口）。

## 下一步验证

1. 增加 Mock Runtime 的确定性集成测试。
2. 增加 API + Worker + SSE 的烟雾测试脚本。
3. 增加前端运行详情渲染测试。
4. 增加熵增扫描的周期任务（定时触发）与回归用例。
