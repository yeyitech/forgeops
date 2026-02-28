# ForgeOps Core Concepts

Status: Active
Updated: 2026-02-28

## Purpose

This file is the root-level canonical record of ForgeOps core concepts.
It documents:

1. What exists now (implementation truth).
2. How core concepts relate to each other.
3. Which concepts are vision-only and not scheduled for delivery.

This file is a concept map, not a replacement for detailed design docs.

## Scope

- In scope: control-plane concepts, data model, execution loop, runtime abstraction, governance and skill evolution chain.
- Out of scope: full API details, full CLI reference, frontend interaction details.

## 1) System Identity

ForgeOps is an AI R&D control plane.
Its core value is: orchestrate multi-step delivery with observability, constraints, and recoverability.

Concept anchors:
- Architecture overview: `docs/architecture/00-overview.md`
- Runtime boundary: `docs/runtime-adapter-design.md`
- Harness philosophy: `docs/harness-engineering-guidelines.md`

## 2) Primary Domain Objects

| Concept | Definition | Primary storage / source |
| --- | --- | --- |
| `Project` | A managed repository root with product metadata and governance context. | `projects` table in `src/core/store.js` |
| `Issue` | GitHub requirement entry that drives run creation in issue-driven flow. | GitHub + `github_issue_id` in runs |
| `Run` | One workflow execution instance bound to a project (and typically an issue). | `runs` table |
| `Step` | One execution node in a run DAG with retry/runtime metadata. | `steps` table |
| `Session` | Runtime session record for step execution (pid/thread/turn/model/tokens). | `sessions` table |
| `Event` | Immutable structured event stream for run/step lifecycle and diagnostics. | `events` table |
| `Artifact` | Structured output evidence from steps (reports, issue markdown, candidates). | `artifacts` table |
| `Lock` | Concurrency control for critical operations. | `locks` table |

Data-model anchors:
- `src/core/store.js` migration block (`CREATE TABLE ...`)

## 3) Core Execution Loop

High-level loop:

1. Precheck runtime/tooling and credentials.
2. Initialize/register project.
3. Create run from project + issue + workflow + context snapshot.
4. Create worktree/branch isolation for run.
5. Worker claims runnable pending steps by DAG dependency.
6. Runtime adapter executes step and emits structured events.
7. Engine enforces mechanical gates (platform, invariants, docs).
8. Store updates state, artifacts, and final status.
9. API/SSE streams state to UI/consumers.
10. Scheduler performs periodic maintenance and automation tasks.

Anchor:
- `docs/architecture/00-overview.md`

## 4) Workflow Concepts

| Concept | Definition | Notes |
| --- | --- | --- |
| `Workflow` | Project-level DAG definition loaded from `.forgeops/workflow.yaml`. | Defaults exist when not customized. |
| `Default steps` | `architect -> issue -> implement -> test -> review -> cleanup`. | Linear default form of DAG. |
| `Step template` | Built-in step contract including role, prompt contract, retries, output schema. | Defined in `src/core/workflow.js`. |
| `Output contract` | Runtime must return strict JSON object with fixed keys and status enum. | `STEP_OUTPUT_SCHEMA`. |
| `Workflow controls` | Project-level controls for auto merge, merge method, issue auto-close, conflict retries. | Parsed/validated in workflow/store. |

Run mode concepts:
- `standard`: run project workflow as configured.
- `quick`: reduced workflow for lower-cost/short-cycle execution (fallbacks if not applicable).

Anchors:
- `src/core/workflow.js`
- `src/core/store.js` (`resolveRunWorkflowByMode`)
- `docs/user-guide.md` (run mode semantics)

## 5) Runtime Abstraction Concepts

| Concept | Definition |
| --- | --- |
| `Runtime Adapter` | Stable interface between control plane and model runtime process. |
| `Runtime Registry` | Runtime factory/lookup that decouples orchestration from runtime implementation. |
| `codex-exec-json` | Default runtime implementation using `codex exec --json`. |
| `codex-app-server` | Experimental runtime path, non-default in v1. |
| `Resume semantics` | Step execution can attempt thread resume, with fallback to fresh execution when resume is invalid. |

Runtime contract:
- Input: `{ cwd, prompt, model, outputSchema, onRuntimeEvent }`
- Output: `{ status, summary, rawOutput, structured, runtime }`

Anchors:
- `docs/runtime-adapter-design.md`
- `src/runtime/index.js`
- `src/runtime/codex-exec-json.js`

## 6) State and Recoverability Concepts

| Concept | Definition |
| --- | --- |
| `Claim-next pending` | Engine pulls executable steps while respecting DAG and concurrency. |
| `Retry-or-fail` | Step failure route with bounded retries; exhausted retries fail run. |
| `Orphan recovery` | Engine recovers unfinished running steps after restart. |
| `Session resume risk` | Long-session resume failures produce risk events and rotation recommendation. |
| `Tracked codex thread` | CLI tracks workspace session thread ids for deterministic resume behavior. |

Anchors:
- `src/worker/engine.js`
- `src/core/store.js`
- `src/cli/index.js` (`forgeops codex session|project`)

## 7) Quality Gate Concepts (Mechanical Governance)

Gate model is not optional narrative, it is executable enforcement.

| Gate | Scope | Trigger point |
| --- | --- | --- |
| `Platform Gate` | Product runtime readiness (`platform-preflight` + `platform-smoke`) | `test` step |
| `Invariant Gate` | Structural/architecture constraints from `.forgeops/invariants.json` | `implement`, `test`, `review` |
| `Docs Gate` | Documentation freshness/structure checks | `cleanup` step |
| `Follow-up issue` | Auto-issue for invariant warnings based on policy | usually `review` |

Anchors:
- `src/worker/engine.js`
- `docs/design/platform-toolchain-quality-gate.md`
- `docs/harness-engineering-guidelines.md`

## 8) Context Concepts

Context is layered and explicit.

| Layer | Typical files | Usage |
| --- | --- | --- |
| Project base context | `.forgeops/context.md`, `.forgeops/governance.md` | Seeded into project assistant and step prompts |
| Step-scoped context | `docs/context/*.md` + registry in `docs/context/index.md` | Selected by step (`architect`, `issue`, `implement`, `test`, `review`, `cleanup`) |
| Agent/skills context | `.forgeops/agent-skills.json` + skills content | Role capability shaping |

Important rule:
- Files in `docs/context/` are not automatically managed for you; they are consumed when registered.

Anchors:
- `src/core/store.js` (`loadProjectContext`, `loadProjectGovernance`, `loadStepScopedContextDocs`)
- `docs/context/index.md`

## 9) Skill System Concepts (Current State)

Skill is the execution capability unit bound to roles.

### 9.1 Skill resolution priority

1. `project-local` (`<projectRoot>/.forgeops/skills/...`)
2. `user-global` (`$FORGEOPS_HOME/skills-global/skills/...`)
3. `official` (`official-skills/skills/...`)

Anchor:
- `src/core/skills.js` (`resolveSkillDescriptorByPriority`)

### 9.2 Skill evolution chain (implemented path)

1. Official template as initial capability.
2. Run execution produces reusable methods/evidence.
3. Cleanup emits `skill-candidate` artifacts.
4. Candidates are promoted through independent PR (human review).
5. Candidate can be promoted to project-local or user-global skill library.
6. Scheduler can automate candidate promotion proposal generation.

Anchor docs:
- `docs/design/skill-evolution-closed-loop.md`
- `docs/design/issue-driven-taste-and-skill-loop.md`
- `docs/design/skill-promotion-pr-review-loop.md`
- `docs/design/skill-auto-promotion-scheduler.md`
- `docs/design/user-global-skill-library.md`

## 10) Scheduler Concepts

Scheduler is project-scoped periodic automation orchestrator.

Managed job families:

1. `cleanup` periodic governance runs.
2. `issueAutoRun` from GitHub issue labels/rules.
3. `skillPromotion` project skill candidate auto-promotion.
4. `globalSkillPromotion` user-global candidate auto-promotion.
5. Mainline sync related maintenance.

Anchor:
- `src/worker/scheduler.js`
- Project config: `.forgeops/scheduler.yaml`

## 11) Observability Concepts

| Surface | Purpose |
| --- | --- |
| API snapshots (`/api/events`) | Pull recent event history for debugging or UI replay. |
| SSE stream (`/api/events/stream`) | Real-time event feed with replay and heartbeat. |
| Run-step-session linkage | Every event/artifact can be traced back to run and step context. |
| Attach terminal | Controlled way to observe runtime thread behavior in terminal. |

Anchor:
- `src/server/app.js`

## 12) Codex Interaction Concepts

ForgeOps exposes two codex entry roles:

1. `forgeops codex session`
- ForgeOps usage coach (platform-oriented).
- Default workspace is ForgeOps repo root.

2. `forgeops codex project`
- Managed project copilot (project-oriented).
- Resolves managed project by cwd or `--project`.
- Supports `--local-only` and `--fresh`.

Both use tracked thread semantics for deterministic resume.

Anchor:
- `src/cli/index.js` (`commandCodex`)

## 13) Governance Philosophy Concepts

From Harness Engineering:

1. Context Engineering
2. Architectural Constraints
3. Observability
4. Garbage Collection

Operational meaning:
- Not only fix outcomes once.
- Add mechanism so similar failures are less likely to recur.

Anchor:
- `docs/harness-engineering-guidelines.md`
- `docs/design/core-beliefs.md`

## 14) Vision Concepts (Not Planned)

These concepts are recorded as direction only.
They are not active implementation commitments.

1. Existing project managed onboarding and continuous auto-evolution:
- See `docs/design/existing-project-managed-onboarding-vision.md`

2. Skill-as-App model:
- Skill as installable/governable/distributable app unit.
- See `docs/design/skill-as-app-vision.md`

## 15) Non-goals (Current v1)

- Multi-runtime smart scheduler optimization.
- Distributed worker cluster.
- Fully autonomous release pipeline.

Anchor:
- `docs/architecture/00-overview.md`

## 16) One-Line Concept Graph

`Project -> Issue -> Run -> Steps(DAG) -> Runtime Session -> Events/Artifacts -> Gates -> Review/Cleanup -> Skill Candidates -> Promotion(Project/User-Global) -> Reuse/Evolution`
