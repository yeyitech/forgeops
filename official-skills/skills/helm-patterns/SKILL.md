---
name: helm-patterns
description: "Helm Chart 模式：可复用 values、模板可维护性、版本策略、渲染验证、发布与回滚证据。"
---

# 执行准则

1. Helm 是发布工具，不是编程语言：模板保持可读，避免过度逻辑。
2. values 约定必须稳定：对外暴露的 `values.yaml` 是契约。
3. 发布必须可验证：渲染检查 + diff + 升级演练 + 回滚演练。

# 机械检查清单

## Chart 结构

- `Chart.yaml`：`name`/`version`/`appVersion` 清晰。
- `values.yaml`：提供默认值与注释。
- `templates/`：模块化，避免 1000 行大模板。

## 渲染与校验

- `helm lint` 必须通过。
- `helm template` 渲染输出可读，资源字段齐全。
- 变更前后 `helm diff upgrade`（如有插件）或等价 diff 证据。

## 发布与回滚

- `helm upgrade --install` 使用 `--atomic`（高风险环境）与 `--wait`。
- 回滚指令明确：`helm rollback <release> <revision>`。

# 输出协议（固定）

```
HELM PLAN / REVIEW
=================

Chart:
- name/version/appVersion:

Values Contract:
- new keys:
- breaking changes:

Validation:
- helm lint:
- helm template:
- diff evidence:

Release:
- upgrade command:
- flags (--wait/--atomic):

Rollback:
- rollback command:
- safe window:
```
