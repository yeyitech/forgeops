---
name: security-review
description: "安全审查清单：输入边界、鉴权、密钥、依赖与执行权限。用于 reviewer/高风险变更的阻断项检查。"
---

# 执行准则

1. 先列阻断项：正确性/安全性/数据损坏风险优先于样式与重构建议。
2. 以边界为单位审查：任何“外部输入进入系统”的入口都必须有验证与权限控制。
3. 禁止规则投机：不得通过修改治理/检查配置来“消音”，必须修复真实问题。

## 必查清单（最小版）

### 1) Secrets / Credentials

- 禁止硬编码密钥（token/api_key/password/private_key）。
- 仅允许通过环境变量或安全注入机制读取。
- 变更后必须 `rg -n` 复查敏感字符串模式（示例：`sk-`、`api_key`、`Authorization:`）。

### 2) Input Validation

- 所有用户输入/外部系统输入必须在边界处校验（schema/allowlist），禁止“用到哪校验哪”。
- 错误信息不得泄漏内部实现细节（路径/堆栈/凭据）。

### 3) AuthZ / AuthN

- 新增/修改接口必须明确：谁能调用？什么条件下拒绝？默认拒绝。
- 涉及权限、角色、资源归属时必须有负向测试或可复现验证步骤。

### 4) Supply Chain / Execution

- 新增依赖必须说明用途与替代方案，避免引入过重依赖或不可控脚本。
- 禁止引入不受控的 `curl | bash` 安装链路到仓库自动化。
- 对任何 shell 执行（`spawn`, `exec`, scripts）检查输入拼接与注入风险。

### 5) Governance Integrity（ForgeOps 特有）

- 不允许为了通过 gate 修改 `.forgeops/invariants.json` / `.forgeops/tools/*` 的规则阈值。
- 若需要调整规则，必须先给出复发证据与替代验证机制，再做最小变更。

## 输出协议（建议）

- `Blockers`：必须修复的安全问题（含复现路径/触发条件）
- `Non-blocking`：可 follow-up 的建议
- `Evidence`：命令/关键输出/文件路径

