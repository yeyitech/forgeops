# ForgeOps Brand Page: Harness Engineering

Status: Active
Updated: 2026-03-01

## Build Fast. Keep Entropy Under Control.

ForgeOps is not just another Agent CLI wrapper.
ForgeOps is an AI R&D control plane that turns `Issue -> Run -> Step -> PR` into an observable, recoverable, governable delivery system.

## When throughput grows, attention becomes the real bottleneck

In agent-driven engineering, the challenge is not only writing faster code. The challenge is reducing repeated failures, architectural drift, and stale documentation.

Common failure modes:

- Context distortion: critical project knowledge is not consistently injected.
- False quality signals: CI passes while real runtime behavior fails.
- Poor traceability: root causes are scattered across chat and log fragments.
- Entropy accumulation: local patches compound into systemic tech debt.

How ForgeOps addresses this:

- Structured workflow: project-level `workflow.yaml` governs execution.
- Dual runtime gates: both CI Gate and Platform Gate are enforced.
- Session recovery: resume context first, avoid costly restarts.
- Scheduled governance: cleanup and automation loops reduce entropy continuously.

## Harness is an executable discipline, not a slogan

### 1. Context Engineering

Use a short map (`AGENTS.md`), deep document index (`docs/00-index.md`), and skill assembly rules to control context size and improve re-entry.

### 2. Architectural Constraints

Turn boundaries, invariants, and dependency rules into machine-checkable constraints.

### 3. Observability

Track `run / step / session / events / artifacts` end-to-end for diagnosis and replay.

### 4. Garbage Collection

Move debt cleanup from ad-hoc incidents into a regular system loop.

## Dual Loop Model: Delivery Loop + Harness Loop

### Delivery loop (default 6 steps)

1. Architect: define boundaries and design constraints.
2. Issue: create a structured requirement entry.
3. Implement: build in isolated worktrees and commit safely.
4. Test: run tests and platform acceptance checks.
5. Review: converge on quality and risk.
6. Cleanup: reduce entropy and capture reusable capabilities.

### Harness loop (anti-regression)

1. Observe recurring failures.
2. Locate missing capabilities (tooling/rules/context).
3. Encode experience into mechanisms (docs/scripts/invariants/skills).
4. Verify recurrence drops in real execution.

## Core capabilities

- Runtime Adapter: stable boundary, Codex-first runtime today.
- GitHub strong process: Issue-Only intake and PR-based closure loop.
- Session Recovery: continue from interrupted context whenever possible.
- Quality Gates: invariants + platform acceptance.
- Scheduler Automation: cleanup / issue auto-run / skill promotion.
- Skill Governance: candidate promotion path decoupled from delivery DAG.

## Standard flow (How It Works)

1. Create or receive a GitHub issue.
2. Create a run and bind an isolated worktree.
3. Schedule and execute steps via DAG.
4. Enforce gates with budgeted self-healing rounds.
5. Merge PR, clean up, and write back final states.

## Verifiable capabilities (current)

- Stable runtime baseline on Node.js 22+.
- Structured documentation and process governance checks.
- Quick-by-default mode with explicit standard escalation.
- GitHub Pages automated publishing pipeline.

## Next evidence to publish

Before scaling the public narrative, prioritize three evidence types:

- Real runtime metrics (success rate, recovery rate, recurrence rate).
- User stories (team size, context, measurable outcomes).
- Public demos (docs site, sample repos, short walkthrough videos).
