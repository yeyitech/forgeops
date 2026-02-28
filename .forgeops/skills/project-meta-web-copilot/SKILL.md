---
name: project-meta-web-copilot
description: "Project-level web copilot for ForgeOps repository. Use for developer/tester/reviewer work to enforce help-first execution, run-mode routing, and evidence output."
---

# Scope

This is the project-level meta skill for the ForgeOps repository (`web` type).
Apply it for developer/tester/reviewer turns before role-specific skills.

# First-Read Order

1. `AGENTS.md`
2. `README.md`
3. `.forgeops/context.md`
4. `.forgeops/governance.md`

# Execution Contract

1. Help-first: start from `forgeops help` and narrow to required commands.
2. Read-before-write: run `show/list/status` before `create/set/resume`.
3. Verify-after-write: every mutation must be followed by readback confirmation.
4. Evidence output: always return `Command / Result / Next`.

# Local Agile Mode (Project Root)

When working inside this repository root, prefer project-copilot flow:

1. Use `forgeops codex` (auto routes to project mode in managed project cwd).
2. Keep changes small and shippable; escalate from `quick` to `standard` only when scope expands.
3. For run failures: `forgeops run show <runId>` -> `forgeops run attach <runId>` -> `forgeops run resume <runId>`.

# Web Quality Minimum

1. `node .forgeops/tools/platform-preflight.mjs --strict --json`
2. `node .forgeops/tools/platform-smoke.mjs --strict --json`
3. If relevant, run repo checks (`npm run check`, `npm run docs:check`) before closing work.

# Do Not

1. Do not loop `run resume` without reading failure details.
2. Do not overwrite `.forgeops/workflow.yaml` without explicit confirmation.
3. Do not persist temporary issue-specific instructions into long-term skill text.
