import fs from "node:fs";
import path from "node:path";

export const WORKFLOW_ID = "forgeops-default-v1";
export const WORKFLOW_NAME = "ForgeOps 默认流水线";
const DEFAULT_WORKFLOW_CONTROLS = Object.freeze({
  autoMerge: true,
  mergeMethod: "squash",
  autoCloseIssueOnMerge: true,
});
const WORKFLOW_MERGE_METHODS = new Set(["squash", "merge", "rebase"]);
const DEFAULT_WORKFLOW_FALLBACK_STEP_KEYS = Object.freeze([
  "architect",
  "issue",
  "implement",
  "test",
  "review",
  "cleanup",
]);

const SHARED_OUTPUT_CONTRACT = `
Output requirements (strict):
- Return ONLY a JSON object. No markdown fences, no extra text.
- Must include keys: status, summary, outputs, artifacts, notes.
- status must be one of: done, retry, failed.
- outputs must be a string (use empty string when none).
- artifacts must be an array (use [] when empty).
- notes must be an array (use [] when empty).
- artifacts items shape: {"kind": "string", "title": "string", "content": "string"}
`;

const DEFAULT_REVIEW_AUTO_FIX_POLICY = Object.freeze({
  enabled: true,
  maxTurns: 2,
  maxFiles: 6,
  maxLines: 200,
  allowlist: ["ci", "tooling", "typecheck", "docs"],
});

function parseBooleanLike(value, fallback) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeWorkflowMergeMethod(value, fallback = "squash", sourceLabel = "") {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (WORKFLOW_MERGE_METHODS.has(text)) return text;
  if (sourceLabel) {
    throw new Error(
      `Invalid workflow config: merge_method must be one of squash, merge, rebase in ${sourceLabel}`
    );
  }
  return fallback;
}

function parseNonNegativeInt(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const num = Number(text);
  if (!Number.isFinite(num)) return fallback;
  const out = Math.floor(num);
  return out >= 0 ? out : fallback;
}

function parsePositiveInt(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const num = Number(text);
  if (!Number.isFinite(num)) return fallback;
  const out = Math.floor(num);
  return out >= 1 ? out : fallback;
}

function parseStringList(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }
  const text = String(raw ?? "").trim();
  if (!text) return [];

  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  if (text.includes(",")) {
    return text
      .split(",")
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  return [text];
}

function normalizeReviewAutoFixPolicy(rawPolicy, sourceLabel = "<workflow>", stepKey = "review") {
  const base = DEFAULT_REVIEW_AUTO_FIX_POLICY;
  const raw = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};

  const enabled = parseBooleanLike(raw.enabled, base.enabled);
  const maxTurns = parseNonNegativeInt(raw.maxTurns, base.maxTurns);
  const maxFiles = parsePositiveInt(raw.maxFiles, base.maxFiles);
  const maxLines = parsePositiveInt(raw.maxLines, base.maxLines);
  const allowlist = parseStringList(raw.allowlist);

  if (maxTurns > 8) {
    throw new Error(
      `Invalid workflow config: step '${stepKey}' auto_fix_max_turns must be <= 8 in ${sourceLabel}`
    );
  }

  if (!enabled && maxTurns > 0) {
    return {
      enabled: false,
      maxTurns: 0,
      maxFiles,
      maxLines,
      allowlist: allowlist.length > 0 ? allowlist : [...base.allowlist],
    };
  }

  if (enabled && maxTurns === 0) {
    throw new Error(
      `Invalid workflow config: step '${stepKey}' auto_fix_enabled=true requires auto_fix_max_turns >= 1 in ${sourceLabel}`
    );
  }

  return {
    enabled,
    maxTurns,
    maxFiles,
    maxLines,
    allowlist: allowlist.length > 0 ? allowlist : [...base.allowlist],
  };
}

function renderReviewAutoFixSection(promptMeta = {}) {
  const rawPolicy = promptMeta?.stepPolicy?.reviewAutoFix
    && typeof promptMeta.stepPolicy.reviewAutoFix === "object"
    ? promptMeta.stepPolicy.reviewAutoFix
    : DEFAULT_REVIEW_AUTO_FIX_POLICY;
  const policy = normalizeReviewAutoFixPolicy(rawPolicy, "prompt");
  const attempt = Number(promptMeta?.attempt ?? 1);
  const maxAttempts = Number(promptMeta?.maxAttempts ?? (policy.maxTurns + 1));
  const budgetScopes = policy.allowlist.join(", ");

  return [
    "Review Auto-Fix policy:",
    `- enabled: ${policy.enabled ? "true" : "false"}`,
    `- max_turns: ${policy.maxTurns}`,
    `- current_attempt: ${attempt}/${maxAttempts}`,
    `- change_budget: files<=${policy.maxFiles}, lines<=${policy.maxLines}`,
    `- allowed_scope: ${budgetScopes}`,
    "",
    "Execution rules:",
    "1. If a blocking issue is within allowed scope and budget, apply a minimal fix directly in this PR branch.",
    "2. Run verification commands and summarize what changed and what passed/failed.",
    "3. After applying a fix, return status=retry to trigger one more review turn.",
    "4. If issue is out-of-scope or exceeds budget, return status=failed with explicit manual handoff.",
    "5. When no blocking issue remains, return status=done.",
  ].join("\n") + "\n";
}

function renderProjectContextSection(ctx) {
  const text = String(ctx.projectContext ?? "").trim();
  if (!text) {
    return "Project context:\n- (none)\n";
  }
  return `Project context:\n${text}\n`;
}

function renderGitHubFlowSection(ctx) {
  const issue = ctx?.issue && typeof ctx.issue === "object" ? ctx.issue : null;
  const pr = ctx?.pullRequest && typeof ctx.pullRequest === "object" ? ctx.pullRequest : null;

  const issueNumber = String(issue?.number ?? issue?.id ?? "").trim();
  const issueTitle = String(issue?.title ?? "").trim();
  const issueUrl = String(issue?.url ?? "").trim();
  const prNumber = String(pr?.number ?? "").trim();
  const prUrl = String(pr?.url ?? "").trim();
  const prBranch = String(pr?.headRefName ?? pr?.branch ?? "").trim();
  const prBase = String(pr?.baseRefName ?? pr?.baseRef ?? "").trim();

  return [
    "GitHub context:",
    issueNumber
      ? `- issue: #${issueNumber}${issueTitle ? ` ${issueTitle}` : ""}`
      : "- issue: -",
    issueUrl ? `- issue_url: ${issueUrl}` : "- issue_url: -",
    prNumber ? `- pull_request: #${prNumber}` : "- pull_request: -",
    prUrl ? `- pull_request_url: ${prUrl}` : "- pull_request_url: -",
    prBranch ? `- pull_request_head: ${prBranch}` : "- pull_request_head: -",
    prBase ? `- pull_request_base: ${prBase}` : "- pull_request_base: -",
  ].join("\n") + "\n";
}

function renderTechProfileSection(ctx) {
  const profile = ctx.projectTechProfile;
  if (!profile || typeof profile !== "object") {
    return "Tech profile:\n- (not configured)\n";
  }
  const language = String(profile.language ?? "").trim() || "-";
  const frontendStack = String(profile.frontendStack ?? "").trim() || "-";
  const backendStack = String(profile.backendStack ?? "").trim() || "-";
  const ciProvider = String(profile.ciProvider ?? "").trim() || "-";
  return `Tech profile:\n- language: ${language}\n- frontend: ${frontendStack}\n- backend: ${backendStack}\n- ci: ${ciProvider}\n`;
}

function renderAgentSkillsSection(ctx, agentId) {
  const raw = ctx.agentSkills && typeof ctx.agentSkills === "object"
    ? ctx.agentSkills[agentId]
    : null;
  const items = Array.isArray(raw) ? raw : [];
  if (items.length === 0) {
    return "Assigned skills:\n- (none)\n";
  }

  const lines = items.map((item) => {
    const name = String(item?.name ?? "").trim() || "unknown-skill";
    const description = String(item?.description ?? "").trim();
    const filePath = String(item?.path ?? "").trim();
    const source = String(item?.source ?? "").trim();
    const sourceText = source ? ` {source=${source}}` : "";
    return `- ${name}${description ? `: ${description}` : ""}${sourceText}${filePath ? ` [${filePath}]` : ""}`;
  });

  return `Assigned skills:\n${lines.join("\n")}\n\nSkill loading policy:\n- Load only the needed SKILL.md files listed above.\n- Keep context usage minimal and task-relevant.\n`;
}

function renderGovernanceSection(ctx) {
  const text = String(ctx.projectGovernance ?? "").trim();
  if (!text) {
    return "Governance policy:\n- (not configured)\n";
  }
  return `Governance policy:\n${text}\n`;
}

function renderInvariantSection(ctx) {
  const cfg = ctx.projectInvariants;
  if (!cfg || typeof cfg !== "object") {
    return "Invariant config:\n- (not configured)\n";
  }
  return `Invariant config:\n${JSON.stringify(cfg, null, 2)}\n`;
}

export const STEP_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["done", "retry", "failed"] },
    summary: { type: "string" },
    outputs: {
      type: "string",
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["kind", "title", "content"],
      },
    },
    notes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["status", "summary", "outputs", "artifacts", "notes"],
};

export const WORKFLOW_STEPS = [
  {
    key: "architect",
    agentId: "architect",
    runtime: "codex-exec-json",
    model: "gpt-5.3-codex",
    maxRetries: 1,
    buildPrompt: (ctx) => `You are the Architect Agent for ForgeOps.

Project:
- Name: ${ctx.project.name}
- Product type: ${ctx.project.productType}
- Problem statement: ${ctx.project.problemStatement}

Task:
${ctx.task}

${renderProjectContextSection(ctx)}
${renderGitHubFlowSection(ctx)}
${renderTechProfileSection(ctx)}
${renderGovernanceSection(ctx)}
${renderInvariantSection(ctx)}
${renderAgentSkillsSection(ctx, "architect")}

Goals:
1. Clarify scope and non-goals.
2. Propose target architecture (frontend/backend split, service boundaries).
3. Identify required local environment (Node/Python/Go/tooling versions).
4. Define first milestone delivery plan.
5. Create/update context map artifacts (AGENTS.md + docs/00-index.md + ADR-0001 + active exec plan).

${SHARED_OUTPUT_CONTRACT}
`,
  },
  {
    key: "issue",
    agentId: "issue-manager",
    runtime: "codex-exec-json",
    model: "gpt-5.3-codex",
    maxRetries: 1,
    buildPrompt: (ctx) => `You are the Issue Agent.

Project:
- Name: ${ctx.project.name}
- Product type: ${ctx.project.productType}

Task:
${ctx.task}

${renderProjectContextSection(ctx)}
${renderGitHubFlowSection(ctx)}
${renderTechProfileSection(ctx)}
${renderGovernanceSection(ctx)}
${renderInvariantSection(ctx)}
${renderAgentSkillsSection(ctx, "issue-manager")}

Previous outputs:
${JSON.stringify(ctx.stepOutputs, null, 2)}

Goals:
1. Convert task into a structured development issue.
2. Define acceptance criteria that are testable.
3. Define in-scope and out-of-scope.
4. Preserve user intent/taste signals from Issue + project context.
5. If key inputs are missing, fill gaps with explicit assumptions (do not block by default).
6. Output one artifact with issue markdown.

Input quality policy:
- Missing details are normal. Do not fail only because inputs are incomplete.
- Add an "Assumptions" section with confidence/risk notes for each filled gap.
- Add an "Open Questions" section for unresolved points that may affect later quality.

Output preferences:
- In outputs, include:
  - assumptions: array of strings
  - tasteSignals: array of strings
  - openQuestions: array of strings

${SHARED_OUTPUT_CONTRACT}
`,
  },
  {
    key: "implement",
    agentId: "developer",
    runtime: "codex-exec-json",
    model: "gpt-5.3-codex",
    maxRetries: 2,
    buildPrompt: (ctx) => `You are the Developer Agent.

Project path: ${ctx.project.rootPath}
Task: ${ctx.task}
${renderProjectContextSection(ctx)}
${renderGitHubFlowSection(ctx)}
${renderTechProfileSection(ctx)}
${renderGovernanceSection(ctx)}
${renderInvariantSection(ctx)}
${renderAgentSkillsSection(ctx, "developer")}
Issue context:
${JSON.stringify(ctx.stepOutputs.issue ?? {}, null, 2)}

Goals:
1. Implement required code changes.
2. Add or update tests.
3. Run build/typecheck/test commands when available.
4. Run invariant checks with: node .forgeops/tools/check-invariants.mjs --format json (if file exists).
5. Honor issue assumptions/taste signals unless they conflict with hard constraints.
6. Produce a concise change summary and test summary.

${SHARED_OUTPUT_CONTRACT}
`,
  },
  {
    key: "test",
    agentId: "tester",
    runtime: "codex-exec-json",
    model: "gpt-5.3-codex",
    maxRetries: 2,
    buildPrompt: (ctx) => `You are the Testing Agent.

Project path: ${ctx.project.rootPath}
Task: ${ctx.task}
${renderProjectContextSection(ctx)}
${renderGitHubFlowSection(ctx)}
${renderTechProfileSection(ctx)}
${renderGovernanceSection(ctx)}
${renderInvariantSection(ctx)}
${renderAgentSkillsSection(ctx, "tester")}
Developer outputs:
${JSON.stringify(ctx.stepOutputs.implement ?? {}, null, 2)}

Goals:
1. Run available tests and report pass/fail.
2. Identify regressions and high-risk gaps.
3. Verify platform runtime gate (not only unit/integration tests).
4. Run project platform preflight script when available:
   - node .forgeops/tools/platform-preflight.mjs --strict --json
5. Run project platform smoke script when available:
   - node .forgeops/tools/platform-smoke.mjs --strict --json
6. If smoke/health checks fail due local port conflict (EPERM/EADDRINUSE/port in use), rerun once with another free local port.
7. For rerun, set env explicitly: PORT, FORGEOPS_BACKEND_PORT, FORGEOPS_BACKEND_HEALTH_URL.
8. If productType=miniapp, include WeChat miniapp acceptance evidence (entry files/routes/devtools readiness).
9. If productType=web, include browser runtime evidence (DOM/network or equivalent smoke proof).
10. If productType=ios, include simulator/build evidence (xcodebuild/simctl outputs).
11. If productType=microservice, include Python dependency bootstrap evidence (uv/poetry/pip) and backend health endpoint evidence.
12. If productType=android, include Android build/runtime evidence (Gradle tasks, module/app manifest readiness, emulator/device probe if available).
13. If productType=serverless, include function trigger/runtime evidence (deploy toolchain + local invoke/smoke output).
14. Run invariant checks with: node .forgeops/tools/check-invariants.mjs --format json (if file exists).
15. In high-throughput mode, treat flaky/non-critical failures as follow-up unless they are high severity.
16. If a blocking issue is safely fixable with a small patch (suggested budget: files<=6, lines<=200), apply the fix directly in this branch.
17. After self-fix, rerun the relevant checks and report concrete before/after evidence.
18. Return status=retry only when another verification turn is needed after your self-fix.
19. Return status=failed only when blocking risk is not safely fixable in-budget, and provide explicit manual handoff.

${SHARED_OUTPUT_CONTRACT}
`,
  },
  {
    key: "platform-smoke",
    agentId: "tester",
    runtime: "codex-exec-json",
    model: "gpt-5.3-codex",
    maxRetries: 2,
    buildPrompt: (ctx) => `You are the Platform Smoke Agent.

Project path: ${ctx.project.rootPath}
Product type: ${ctx.project.productType}
Task: ${ctx.task}
${renderProjectContextSection(ctx)}
${renderGitHubFlowSection(ctx)}
${renderTechProfileSection(ctx)}
${renderGovernanceSection(ctx)}
${renderInvariantSection(ctx)}
${renderAgentSkillsSection(ctx, "tester")}
Test outputs:
${JSON.stringify(ctx.stepOutputs.test ?? {}, null, 2)}

Goals:
1. Verify platform runtime gate (not only unit/integration tests).
2. Run project platform preflight script when available:
   - node .forgeops/tools/platform-preflight.mjs --strict --json
3. Run project platform smoke script when available:
   - node .forgeops/tools/platform-smoke.mjs --strict --json
4. If smoke fails due local port binding conflict (EPERM/EADDRINUSE/port in use), select another free local port and rerun once.
5. For rerun, set env explicitly: PORT, FORGEOPS_BACKEND_PORT, FORGEOPS_BACKEND_HEALTH_URL.
6. If productType=miniapp, include WeChat miniapp acceptance evidence (entry files/routes/devtools readiness).
7. If productType=web, include browser runtime evidence (DOM/network or equivalent smoke proof).
8. If productType=ios, include simulator/build evidence (xcodebuild/simctl outputs).
9. If productType=microservice, include Python dependency bootstrap evidence (uv/poetry/pip) and backend health endpoint evidence.
10. If productType=android, include Android build/runtime evidence (Gradle tasks, module/app manifest readiness, emulator/device probe if available).
11. If productType=serverless, include function trigger/runtime evidence (deploy toolchain + local invoke/smoke output).
12. If a blocking platform risk is safely fixable with a small patch (suggested budget: files<=6, lines<=200), apply fix directly and rerun smoke.
13. Return status=retry only when another turn is required after your self-fix.
14. Return status=failed only when blocking risk cannot be safely fixed in-budget, with explicit manual handoff.
15. Output one artifact summarizing platform gate result and key command outputs.

${SHARED_OUTPUT_CONTRACT}
`,
  },
  {
    key: "review",
    agentId: "reviewer",
    runtime: "codex-exec-json",
    model: "gpt-5.3-codex",
    maxRetries: DEFAULT_REVIEW_AUTO_FIX_POLICY.maxTurns,
    reviewAutoFixPolicy: DEFAULT_REVIEW_AUTO_FIX_POLICY,
    buildPrompt: (ctx, promptMeta = {}) => `You are the Review Agent.

Project path: ${ctx.project.rootPath}
Product type: ${ctx.project.productType}
Task: ${ctx.task}
${renderProjectContextSection(ctx)}
${renderGitHubFlowSection(ctx)}
${renderTechProfileSection(ctx)}
${renderGovernanceSection(ctx)}
${renderInvariantSection(ctx)}
${renderAgentSkillsSection(ctx, "reviewer")}
${renderReviewAutoFixSection(promptMeta)}
Pipeline outputs:
${JSON.stringify(ctx.stepOutputs, null, 2)}

Goals:
1. Review implementation quality and delivery readiness.
2. Verify invariant check output and only block merge on high-severity risks (correctness/security/data loss/reproducibility).
3. Enforce platform evidence gate from test outputs:
   - platform-preflight/platform-smoke command evidence
   - productType-specific runtime evidence (miniapp/web/ios/microservice/android/serverless)
4. If platform evidence is missing or contradictory, return status=retry with explicit evidence gaps.
5. Convert low-severity findings into follow-up tasks instead of long blocking.
6. If blocking issue is fixable under Review Auto-Fix policy, apply minimal patch and return status=retry.
7. If blocking issue is not safely fixable in policy budget, return status=failed with explicit manual action items.
8. Output release notes artifact.

${SHARED_OUTPUT_CONTRACT}
`,
  },
  {
    key: "cleanup",
    agentId: "garbage-collector",
    runtime: "codex-exec-json",
    model: "gpt-5.3-codex",
    maxRetries: 1,
    buildPrompt: (ctx) => `You are the Garbage Collection Agent.

Project path: ${ctx.project.rootPath}
Task: ${ctx.task}
${renderProjectContextSection(ctx)}
${renderGitHubFlowSection(ctx)}
${renderTechProfileSection(ctx)}
${renderGovernanceSection(ctx)}
${renderInvariantSection(ctx)}
${renderAgentSkillsSection(ctx, "garbage-collector")}
Pipeline outputs:
${JSON.stringify(ctx.stepOutputs, null, 2)}

Golden principles (must enforce mechanically where possible):
1. Prefer shared utility packages over hand-rolled duplicated helpers.
2. Do not probe data YOLO-style. Validate boundaries or use typed SDK/contracts.
3. Keep refactors small and reviewable (target: < 1 minute review each PR-sized change).
4. Capture human taste once as rules/docs/scripts, then enforce continuously.

Goals:
1. Scan for entropy signals and drift against golden principles.
2. Propose or apply small targeted cleanups that reduce future agent errors.
3. Update quality grading and verification notes when drift patterns are found.
4. Promote repeated review feedback into mechanical checks (lints/tests/scripts), not only docs.
5. Run docs checks when available:
   - node scripts/check-doc-freshness.js
   - node scripts/check-doc-structure.js
6. Keep docs maps/indexes synchronized with changes.
7. Distill reusable delivery methods into project-local skill candidates.
8. Output cleanup artifacts (report + actionable refactor checklist + skill candidates).

Skill candidate policy:
- When repeated/valuable patterns are observed, output candidate artifacts with kind=skill-candidate.
- Candidate should include: problem, reusable approach, evidence, adoption scope.
- Prefer small, concrete, executable guidance over broad principles.

Output policy:
- If high-risk drift exists and cannot be fixed safely in this run, return status=retry with concrete notes.
- Otherwise return status=done and include incremental cleanup artifacts.

${SHARED_OUTPUT_CONTRACT}
`,
  },
];

const STEP_BY_KEY = new Map(WORKFLOW_STEPS.map((step) => [step.key, step]));

export function getWorkflowSteps() {
  return WORKFLOW_STEPS;
}

export function getStepByKey(stepKey) {
  return STEP_BY_KEY.get(stepKey) ?? null;
}

function parseScalar(rawValue) {
  const value = String(rawValue ?? "").replace(/\s+#.*$/, "").trim();
  if (!value) return "";
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineArray(rawValue) {
  const value = parseScalar(rawValue);
  if (!value) return [];
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => parseScalar(item))
      .filter(Boolean);
  }
  return [value];
}

function parseKeyValue(rawLine) {
  const idx = rawLine.indexOf(":");
  if (idx === -1) return null;
  return {
    key: rawLine.slice(0, idx).trim(),
    value: rawLine.slice(idx + 1).trim(),
  };
}

function applyStepProperty(target, key, rawValue) {
  if (key === "depends_on" || key === "dependsOn") {
    target.__hasDependsOn = true;
    if (!rawValue) {
      target.depends_on = [];
      target.__dependsListMode = true;
      return;
    }
    target.depends_on = parseInlineArray(rawValue);
    target.__dependsListMode = false;
    return;
  }
  target[key] = parseScalar(rawValue);
}

function parseWorkflowYaml(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  let id = "";
  let name = "";
  let autoMerge = "";
  let mergeMethod = "";
  let autoCloseIssueOnMerge = "";
  const stepsRaw = [];
  let inSteps = false;
  let stepsIndent = 0;
  let currentStepObj = null;
  let currentStepIndent = 0;
  let dependsListIndent = -1;

  const flushCurrentStepObj = () => {
    if (!currentStepObj) return;
    const out = {};
    for (const [k, v] of Object.entries(currentStepObj)) {
      if (!k.startsWith("__")) {
        out[k] = v;
      }
    }
    stepsRaw.push(out);
    currentStepObj = null;
    currentStepIndent = 0;
    dependsListIndent = -1;
  };

  for (const rawLine of lines) {
    const line = String(rawLine ?? "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (inSteps && indent <= stepsIndent && !trimmed.startsWith("-")) {
      flushCurrentStepObj();
      inSteps = false;
    }

    if (!inSteps) {
      if (trimmed.startsWith("id:")) {
        id = parseScalar(trimmed.slice("id:".length));
        continue;
      }

      if (trimmed.startsWith("name:")) {
        name = parseScalar(trimmed.slice("name:".length));
        continue;
      }

      if (trimmed.startsWith("auto_merge:")) {
        autoMerge = parseScalar(trimmed.slice("auto_merge:".length));
        continue;
      }
      if (trimmed.startsWith("autoMerge:")) {
        autoMerge = parseScalar(trimmed.slice("autoMerge:".length));
        continue;
      }

      if (trimmed.startsWith("merge_method:")) {
        mergeMethod = parseScalar(trimmed.slice("merge_method:".length));
        continue;
      }
      if (trimmed.startsWith("mergeMethod:")) {
        mergeMethod = parseScalar(trimmed.slice("mergeMethod:".length));
        continue;
      }

      if (trimmed.startsWith("auto_close_issue_on_merge:")) {
        autoCloseIssueOnMerge = parseScalar(trimmed.slice("auto_close_issue_on_merge:".length));
        continue;
      }
      if (trimmed.startsWith("autoCloseIssueOnMerge:")) {
        autoCloseIssueOnMerge = parseScalar(trimmed.slice("autoCloseIssueOnMerge:".length));
        continue;
      }

      if (trimmed.startsWith("steps:")) {
        inSteps = true;
        stepsIndent = indent;
        continue;
      }
      continue;
    }

    if (currentStepObj && dependsListIndent >= 0) {
      if (indent > dependsListIndent && trimmed.startsWith("-")) {
        const dep = parseScalar(trimmed.slice(1));
        if (dep) {
          currentStepObj.depends_on.push(dep);
        }
        continue;
      }
      if (indent <= dependsListIndent) {
        currentStepObj.__dependsListMode = false;
        dependsListIndent = -1;
      }
    }

    if (trimmed.startsWith("-")) {
      flushCurrentStepObj();
      const afterDash = trimmed.slice(1).trim();
      if (!afterDash) {
        currentStepObj = {};
        currentStepIndent = indent;
        continue;
      }

      const inlineKv = parseKeyValue(afterDash);
      if (!inlineKv) {
        const stepKey = parseScalar(afterDash);
        if (stepKey) {
          stepsRaw.push(stepKey);
        }
        continue;
      }
      currentStepObj = {};
      currentStepIndent = indent;
      applyStepProperty(currentStepObj, inlineKv.key, inlineKv.value);
      if (currentStepObj.__dependsListMode) {
        dependsListIndent = indent;
      }
      continue;
    }

    if (currentStepObj && indent > currentStepIndent) {
      const kv = parseKeyValue(trimmed);
      if (!kv) continue;
      applyStepProperty(currentStepObj, kv.key, kv.value);
      if (currentStepObj.__dependsListMode) {
        dependsListIndent = indent;
      }
      continue;
    }
  }

  if (inSteps) {
    flushCurrentStepObj();
  }

  return { id, name, autoMerge, mergeMethod, autoCloseIssueOnMerge, stepsRaw };
}

function parseOptionalStepMaxRetries(rawValue, configPath, stepKey) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }
  const parsed = parseNonNegativeInt(rawValue, Number.NaN);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid workflow config: step '${stepKey}' max_retries must be a non-negative integer in ${configPath}`
    );
  }
  return parsed;
}

function extractReviewAutoFixOverrides(rawStepObj) {
  if (!rawStepObj || typeof rawStepObj !== "object") return null;

  const enabled = rawStepObj.auto_fix_enabled ?? rawStepObj.review_auto_fix_enabled;
  const maxTurns = rawStepObj.auto_fix_max_turns ?? rawStepObj.review_auto_fix_max_turns;
  const maxFiles = rawStepObj.auto_fix_max_files ?? rawStepObj.review_auto_fix_max_files;
  const maxLines = rawStepObj.auto_fix_max_lines ?? rawStepObj.review_auto_fix_max_lines;
  const allowlist = rawStepObj.auto_fix_allowlist ?? rawStepObj.review_auto_fix_allowlist;

  const hasAny = enabled !== undefined
    || maxTurns !== undefined
    || maxFiles !== undefined
    || maxLines !== undefined
    || allowlist !== undefined;

  if (!hasAny) return null;

  return {
    enabled,
    maxTurns,
    maxFiles,
    maxLines,
    allowlist,
  };
}

function createWorkflowNode(template, key, dependsOn, options = {}) {
  const reviewPolicy = template.key === "review"
    ? normalizeReviewAutoFixPolicy(
        {
          ...(template.reviewAutoFixPolicy ?? DEFAULT_REVIEW_AUTO_FIX_POLICY),
          ...(options.reviewAutoFixPolicy ?? {}),
        },
        options.configPath ?? "<workflow>",
        key,
      )
    : null;

  const resolvedMaxRetries = options.maxRetries !== null && options.maxRetries !== undefined
    ? Number(options.maxRetries)
    : template.key === "review"
      ? (reviewPolicy?.enabled ? Number(reviewPolicy.maxTurns) : 0)
      : Number(template.maxRetries ?? 0);

  return {
    key,
    templateKey: template.key,
    agentId: template.agentId,
    runtime: template.runtime,
    model: template.model,
    maxRetries: resolvedMaxRetries,
    reviewAutoFixPolicy: reviewPolicy,
    buildPrompt: template.buildPrompt,
    dependsOn,
  };
}

function validateDag(nodes, configPath) {
  if (nodes.length === 0) {
    throw new Error(`Invalid workflow config: no nodes resolved in ${configPath}`);
  }

  const ids = nodes.map((node) => node.key);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const out = new Map(ids.map((id) => [id, []]));

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      incoming.set(node.key, (incoming.get(node.key) ?? 0) + 1);
      out.get(dep)?.push(node.key);
    }
  }

  const roots = ids.filter((id) => (incoming.get(id) ?? 0) === 0);
  if (roots.length === 0) {
    throw new Error(`Invalid workflow config: no entry step (all steps have dependencies) in ${configPath}`);
  }

  const queue = [...roots];
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    const nextList = out.get(id) ?? [];
    for (const next of nextList) {
      const nextIn = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, nextIn);
      if (nextIn === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== nodes.length) {
    throw new Error(`Invalid workflow config: cycle detected in ${configPath}`);
  }
}

function normalizeWorkflowSteps(stepsRaw, configPath) {
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error(`Invalid workflow config: no steps defined in ${configPath}`);
  }

  const allStrings = stepsRaw.every((item) => typeof item === "string");
  if (allStrings) {
    const unknown = [];
    const duplicated = [];
    const seen = new Set();
    const nodes = [];
    for (let i = 0; i < stepsRaw.length; i += 1) {
      const key = String(stepsRaw[i]);
      if (seen.has(key)) {
        duplicated.push(key);
        continue;
      }
      seen.add(key);
      const template = STEP_BY_KEY.get(key);
      if (!template) {
        unknown.push(key);
        continue;
      }
      const dependsOn = i === 0 ? [] : [String(stepsRaw[i - 1])];
      nodes.push(createWorkflowNode(template, key, dependsOn, { configPath }));
    }
    if (duplicated.length > 0) {
      throw new Error(`Invalid workflow config: duplicated steps [${duplicated.join(", ")}] in ${configPath}`);
    }
    if (unknown.length > 0) {
      throw new Error(
        `Invalid workflow config: unknown steps [${unknown.join(", ")}] in ${configPath}. Available: ${Array.from(STEP_BY_KEY.keys()).join(", ")}`
      );
    }
    validateDag(nodes, configPath);
    return nodes;
  }

  const rawNodes = [];
  const duplicated = [];
  const unknownTemplates = [];
  const seenIds = new Set();

  for (let i = 0; i < stepsRaw.length; i += 1) {
    const raw = stepsRaw[i];
    const obj = typeof raw === "string" ? { key: raw } : raw;
    if (!obj || typeof obj !== "object") {
      throw new Error(`Invalid workflow config: step #${i + 1} is not valid in ${configPath}`);
    }

    const templateKey = String(obj.use ?? obj.template ?? obj.key ?? "").trim();
    if (!templateKey) {
      throw new Error(`Invalid workflow config: step #${i + 1} missing key/use/template in ${configPath}`);
    }
    const template = STEP_BY_KEY.get(templateKey);
    if (!template) {
      unknownTemplates.push(templateKey);
      continue;
    }

    const nodeId = String(obj.id ?? templateKey).trim();
    if (!nodeId) {
      throw new Error(`Invalid workflow config: step #${i + 1} has empty id in ${configPath}`);
    }
    if (seenIds.has(nodeId)) {
      duplicated.push(nodeId);
      continue;
    }
    seenIds.add(nodeId);

    let dependsOnRaw;
    if (Array.isArray(obj.depends_on)) {
      dependsOnRaw = obj.depends_on.map((item) => String(item).trim()).filter(Boolean);
    } else if (obj.depends_on !== undefined) {
      dependsOnRaw = parseInlineArray(String(obj.depends_on));
    } else {
      dependsOnRaw = undefined;
    }

    rawNodes.push({
      id: nodeId,
      template,
      dependsOnRaw,
      maxRetries: parseOptionalStepMaxRetries(
        obj.max_retries ?? obj.maxRetries,
        configPath,
        nodeId,
      ),
      reviewAutoFixPolicy: template.key === "review" ? extractReviewAutoFixOverrides(obj) : null,
    });
  }

  if (duplicated.length > 0) {
    throw new Error(`Invalid workflow config: duplicated step ids [${duplicated.join(", ")}] in ${configPath}`);
  }
  if (unknownTemplates.length > 0) {
    throw new Error(
      `Invalid workflow config: unknown steps [${unknownTemplates.join(", ")}] in ${configPath}. Available: ${Array.from(STEP_BY_KEY.keys()).join(", ")}`
    );
  }

  const knownIds = new Set(rawNodes.map((node) => node.id));
  const nodes = [];
  for (let i = 0; i < rawNodes.length; i += 1) {
    const node = rawNodes[i];
    const dependsOn = node.dependsOnRaw === undefined
      ? (i === 0 ? [] : [rawNodes[i - 1].id])
      : node.dependsOnRaw;

    for (const dep of dependsOn) {
      if (!knownIds.has(dep)) {
        throw new Error(`Invalid workflow config: step '${node.id}' depends on unknown step '${dep}' in ${configPath}`);
      }
      if (dep === node.id) {
        throw new Error(`Invalid workflow config: step '${node.id}' cannot depend on itself in ${configPath}`);
      }
    }

    nodes.push(createWorkflowNode(node.template, node.id, dependsOn, {
      configPath,
      maxRetries: node.maxRetries,
      reviewAutoFixPolicy: node.reviewAutoFixPolicy,
    }));
  }

  validateDag(nodes, configPath);
  return nodes;
}

export function resolveWorkflowFromContent(content, sourceLabel = "<inline-workflow>") {
  const parsed = parseWorkflowYaml(String(content ?? ""));
  const resolvedSteps = normalizeWorkflowSteps(parsed.stepsRaw, sourceLabel);
  const workflowControls = {
    autoMerge: parseBooleanLike(parsed.autoMerge, DEFAULT_WORKFLOW_CONTROLS.autoMerge),
    mergeMethod: normalizeWorkflowMergeMethod(
      parsed.mergeMethod,
      DEFAULT_WORKFLOW_CONTROLS.mergeMethod,
      sourceLabel,
    ),
    autoCloseIssueOnMerge: parseBooleanLike(
      parsed.autoCloseIssueOnMerge,
      DEFAULT_WORKFLOW_CONTROLS.autoCloseIssueOnMerge,
    ),
  };

  return {
    id: parsed.id || WORKFLOW_ID,
    name: parsed.name || WORKFLOW_NAME,
    workflowControls,
    steps: resolvedSteps,
    source: sourceLabel,
  };
}

export function getWorkflowConfigPath(projectRootPath) {
  return path.join(projectRootPath, ".forgeops", "workflow.yaml");
}

export function resolveWorkflow(projectRootPath) {
  const defaultNodes = DEFAULT_WORKFLOW_FALLBACK_STEP_KEYS.map((key, index) => {
    const template = STEP_BY_KEY.get(key);
    if (!template) {
      throw new Error(`Default workflow template missing: ${key}`);
    }
    const dependsOn = index === 0 ? [] : [DEFAULT_WORKFLOW_FALLBACK_STEP_KEYS[index - 1]];
    return createWorkflowNode(template, key, dependsOn);
  });

  const fallback = {
    id: WORKFLOW_ID,
    name: WORKFLOW_NAME,
    workflowControls: {
      ...DEFAULT_WORKFLOW_CONTROLS,
    },
    steps: defaultNodes,
    source: "default",
  };

  if (!projectRootPath) {
    return fallback;
  }

  const configPath = getWorkflowConfigPath(projectRootPath);
  if (!fs.existsSync(configPath)) {
    return fallback;
  }

  return resolveWorkflowFromContent(fs.readFileSync(configPath, "utf8"), configPath);
}
