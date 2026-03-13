import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { getStepByKey, resolveWorkflow } from "./workflow.js";
import {
  createGitHubIssueComment,
  createGitHubPullRequestComment,
  createProjectGitHubIssue,
  closeGitHubIssue,
  cleanupRunWorktree,
  createRunWorktree,
  autoResolvePullRequestMergeConflict,
  ensureGitHubPullRequestForRun,
  findGitHubPullRequestForBranch,
  getGitHubBranchProtection,
  getGitHubIssue,
  listGitHubIssues,
  markGitHubPullRequestReadyForReview,
  mergeGitHubPullRequest,
  provisionProjectGitHubRemote,
  readGitHubRepoBinding,
  readGitHubIssuePrMetrics,
  syncDefaultBranchFromRemote,
  updateGitHubIssueLabels,
  updateGitHubPullRequestLabels,
} from "./git.js";
import { DEFAULT_STEP_KEYS_BY_AGENT, loadProjectTechProfile, resolveAgentSkills } from "./skills.js";
import { buildEffectiveAgentSkillsForStep } from "./skill-selection.js";
import { newId, nowIso, safeJsonParse, slugify } from "./utils.js";

const DB_DIR = process.env.FORGEOPS_HOME
  ? path.resolve(process.env.FORGEOPS_HOME)
  : path.join(os.homedir(), ".forgeops");
const DB_PATH = path.join(DB_DIR, "forgeops.db");
const USER_GLOBAL_SKILLS_ROOT = path.join(DB_DIR, "skills-global");
const LOC_CACHE_TTL_MS = 30_000;
const GITHUB_METRICS_CACHE_TTL_MS = 30_000;
const MAINLINE_REF_FETCH_INTERVAL_MS = 5 * 60_000;
const MAINLINE_REF_FETCH_RETRY_INTERVAL_MS = 60_000;
const MAX_CODE_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_DOC_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const CODE_FILE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".rb", ".php", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp",
  ".m", ".mm", ".vue", ".svelte",
  ".css", ".scss", ".less", ".html",
  ".json", ".yaml", ".yml", ".sql", ".sh", ".bash", ".zsh",
]);
const DOC_FILE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".adoc",
]);
const CODE_LANGUAGE_BY_EXTENSION = {
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".c": "C",
  ".h": "C/C++ Header",
  ".hpp": "C/C++ Header",
  ".m": "Objective-C",
  ".mm": "Objective-C++",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".css": "CSS",
  ".scss": "SCSS",
  ".less": "Less",
  ".html": "HTML",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
};
const CODE_IGNORED_DIRS = new Set([
  ".git",
  ".forgeops-runtime",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  "Pods",
  "__pycache__",
]);
const RUN_COMPLETION_PR_GATE_STEP_KEYS = new Set(["implement", "test", "review"]);
const RUN_FINALIZE_LOCK_TTL_MS = 15 * 60 * 1000;
const PROJECT_MAINLINE_SYNC_LOCK_TTL_MS = 5 * 60 * 1000;
const PROJECT_MERGE_QUEUE_LOCK_TTL_MS = 20 * 60 * 1000;
const DEFAULT_AUTO_MERGE_CONFLICT_MAX_ATTEMPTS = 2;
const MAINLINE_REF_FETCH_STATE = new Map();
const RUN_MODE_STANDARD = "standard";
const RUN_MODE_QUICK = "quick";
const RUN_MODE_DEFAULT = RUN_MODE_QUICK;
const RUN_MODE_QUICK_STEP_KEYS = new Set(["implement", "test", "cleanup"]);
const SKILL_DELIVERY_LEGACY = "legacy";
const SKILL_DELIVERY_CODEX_NATIVE = "codex-native";
const CLEANUP_CONTEXT_DEFAULT_LOOKBACK_DAYS = 7;
const CLEANUP_EVENT_SEED_MAX_CANDIDATES = 3;
const SKILL_FEEDBACK_WINDOW_DAYS = 14;
const SKILL_FEEDBACK_MIN_SAMPLE_RUNS = 2;

function ensureUserGlobalSkillsBootstrapFiles(rootPath) {
  const resolved = path.resolve(rootPath);
  fs.mkdirSync(resolved, { recursive: true });
  fs.mkdirSync(path.join(resolved, "skills"), { recursive: true });
  fs.mkdirSync(path.join(resolved, "catalog"), { recursive: true });

  const readmePath = path.join(resolved, "README.md");
  if (!fs.existsSync(readmePath)) {
    const content = [
      "# ForgeOps User-Global Skills",
      "",
      "This repository stores user-global skills for ForgeOps.",
      "",
      "- Canonical skills path: `skills/<skill-name>/SKILL.md`",
      "- Skill index: `catalog/skills-index.json`",
      "- Audit log: `audit.ndjson`",
      "",
      "> Managed by ForgeOps CLI.",
      "",
    ].join("\n");
    fs.writeFileSync(readmePath, content, "utf8");
  }

  const roleIndexPath = path.join(resolved, "catalog", "roles.json");
  if (!fs.existsSync(roleIndexPath)) {
    fs.writeFileSync(roleIndexPath, `${JSON.stringify({ roles: {} }, null, 2)}\n`, "utf8");
  }

  const skillsIndexPath = path.join(resolved, "catalog", "skills-index.json");
  if (!fs.existsSync(skillsIndexPath)) {
    fs.writeFileSync(skillsIndexPath, `${JSON.stringify({ version: 1, skills: [] }, null, 2)}\n`, "utf8");
  }

  const auditPath = path.join(resolved, "audit.ndjson");
  if (!fs.existsSync(auditPath)) {
    fs.writeFileSync(auditPath, "", "utf8");
  }

  const gitkeepPath = path.join(resolved, "skills", ".gitkeep");
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, "", "utf8");
  }
}

function countTextLines(text) {
  const source = String(text ?? "");
  if (!source) return 0;
  const normalized = source.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  // Avoid counting EOF trailing newline as an extra line.
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.length;
}

function shouldCountCodeFile(fileName) {
  const ext = path.extname(String(fileName ?? "")).toLowerCase();
  return CODE_FILE_EXTENSIONS.has(ext);
}

function shouldCountDocFile(fileName) {
  const ext = path.extname(String(fileName ?? "")).toLowerCase();
  return DOC_FILE_EXTENSIONS.has(ext);
}

function countDocumentWords(text) {
  const source = String(text ?? "");
  if (!source) return 0;
  const latinWords = source.match(/[A-Za-z0-9_]+(?:['-][A-Za-z0-9_]+)*/g) ?? [];
  const cjkChars = source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];
  return latinWords.length + cjkChars.length;
}

function isDocsScopedPath(relPath) {
  const normalized = String(relPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith("docs/");
}

function hasIgnoredPathSegment(relPath) {
  const segments = String(relPath ?? "").split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => CODE_IGNORED_DIRS.has(segment));
}

function resolveCodeLanguage(fileName) {
  const ext = path.extname(String(fileName ?? "")).toLowerCase();
  if (!ext) return "Other";
  return CODE_LANGUAGE_BY_EXTENSION[ext] ?? ext.slice(1).toUpperCase();
}

function createEmptyCodeTrend7d(warning = "", source = "none") {
  return {
    available: false,
    source,
    commit_count: 0,
    added_lines: 0,
    deleted_lines: 0,
    net_lines: 0,
    days: [],
    warning: String(warning ?? ""),
  };
}

function createRecentUtcDateKeys(days = 7) {
  const count = Math.max(1, Math.floor(Number(days) || 7));
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const stamp = todayUtc - (index * 24 * 60 * 60 * 1000);
    out.push(new Date(stamp).toISOString().slice(0, 10));
  }
  return out;
}

function normalizeRuntimeMetricName(value) {
  const raw = String(value ?? "").trim();
  return raw || "unknown";
}

function normalizeMetricDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

function parseBoolLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMergeMethodLike(value, fallback = "squash") {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === "squash" || text === "merge" || text === "rebase") {
    return text;
  }
  return fallback;
}

function normalizeBaseBranchLike(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.startsWith("origin/")) {
    return text.slice("origin/".length);
  }
  return text;
}

function toNonNegativeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const out = Math.floor(num);
  return out >= 0 ? out : fallback;
}

function toPositiveInt(value, fallback = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const out = Math.floor(num);
  return out >= 1 ? out : fallback;
}

function normalizeAutoMergeConflictMaxAttempts(value, fallback = DEFAULT_AUTO_MERGE_CONFLICT_MAX_ATTEMPTS) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const out = Math.floor(num);
  if (out < 0) return fallback;
  if (out > 8) return 8;
  return out;
}

function isRunningIssueUniqueConstraintError(err) {
  const message = String(err?.message ?? err ?? "").toLowerCase();
  return message.includes("unique constraint failed: runs.project_id, runs.github_issue_id")
    || message.includes("idx_runs_project_issue_running");
}

function isUniqueConstraintError(err) {
  const message = String(err?.message ?? err ?? "").toLowerCase();
  return message.includes("unique constraint failed")
    || message.includes("constraint unique");
}

function formatErrorMessage(err) {
  return err instanceof Error ? err.message : String(err ?? "");
}

function isLikelyMergeConflictError(err) {
  const message = formatErrorMessage(err).toLowerCase();
  if (!message) return false;
  return message.includes("conflict")
    || message.includes("not mergeable")
    || message.includes("merge failed")
    || message.includes("cannot be merged")
    || message.includes("merge conflict")
    || message.includes("automatic merge failed");
}

function normalizeReviewAutoFixPolicy(rawPolicy) {
  const raw = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
  const enabled = parseBoolLike(raw.enabled, true);
  const maxTurns = toNonNegativeInt(raw.maxTurns, 0);
  return {
    enabled,
    maxTurns: enabled ? Math.max(1, maxTurns || 1) : 0,
    maxFiles: toPositiveInt(raw.maxFiles, 6),
    maxLines: toPositiveInt(raw.maxLines, 200),
    allowlist: Array.isArray(raw.allowlist)
      ? raw.allowlist.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [],
  };
}

function buildStepPolicies(steps) {
  const out = {};
  for (const step of steps) {
    const key = String(step?.key ?? "").trim();
    if (!key) continue;
    const policy = {
      maxRetries: toNonNegativeInt(step.maxRetries, 0),
    };
    if (step.reviewAutoFixPolicy && typeof step.reviewAutoFixPolicy === "object") {
      policy.reviewAutoFix = normalizeReviewAutoFixPolicy(step.reviewAutoFixPolicy);
    }
    out[key] = policy;
  }
  return out;
}

function normalizeRunMode(value, fallback = RUN_MODE_DEFAULT) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === RUN_MODE_STANDARD || text === RUN_MODE_QUICK) {
    return text;
  }
  return fallback;
}

function parseRunModeLike(value, fallback = RUN_MODE_DEFAULT) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === RUN_MODE_STANDARD || text === RUN_MODE_QUICK) {
    return text;
  }
  throw new Error(`Invalid run mode: ${text}`);
}

function normalizeSkillDeliveryMode(value, fallback = SKILL_DELIVERY_CODEX_NATIVE) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === SKILL_DELIVERY_LEGACY || text === SKILL_DELIVERY_CODEX_NATIVE) {
    return text;
  }
  return fallback;
}

function resolveRunWorkflowByMode(workflow, requestedRunMode) {
  const mode = normalizeRunMode(requestedRunMode, RUN_MODE_DEFAULT);
  const fallback = {
    workflow,
    resolvedRunMode: mode,
    quickApplied: false,
    quickFallbackReason: "",
  };
  if (mode !== RUN_MODE_QUICK) {
    return fallback;
  }

  const sourceSteps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const quickSteps = sourceSteps.filter((step) => RUN_MODE_QUICK_STEP_KEYS.has(String(step?.key ?? "").trim()));
  if (quickSteps.length === 0) {
    return {
      ...fallback,
      resolvedRunMode: RUN_MODE_STANDARD,
      quickFallbackReason: "quick_steps_not_found",
    };
  }

  const normalizedSteps = quickSteps.map((step, index) => ({
    ...step,
    dependsOn: index === 0 ? [] : [String(quickSteps[index - 1]?.key ?? "").trim()],
  }));
  const workflowId = String(workflow?.id ?? "").trim();
  const workflowName = String(workflow?.name ?? "").trim();
  return {
    workflow: {
      ...workflow,
      id: workflowId ? `${workflowId}-quick` : "forgeops-quick-v1",
      name: workflowName ? `${workflowName} (quick)` : "ForgeOps Quick Workflow",
      steps: normalizedSteps,
    },
    resolvedRunMode: RUN_MODE_QUICK,
    quickApplied: true,
    quickFallbackReason: "",
  };
}

function getStepPolicyFromContext(context, stepKey) {
  if (!context || typeof context !== "object") return {};
  const rawPolicies = context.stepPolicies;
  if (!rawPolicies || typeof rawPolicies !== "object") return {};
  const rawPolicy = rawPolicies[stepKey];
  if (!rawPolicy || typeof rawPolicy !== "object") return {};
  return rawPolicy;
}

function runRequiresPullRequestGate(run, runSteps) {
  if (!run?.github_issue_id) return false;
  const steps = Array.isArray(runSteps) ? runSteps : [];
  return steps.some((row) => RUN_COMPLETION_PR_GATE_STEP_KEYS.has(String(row?.step_key ?? "")));
}

function getWorkflowControlsFromContext(context) {
  const rawControls = context && typeof context === "object" && context.workflowControls
    && typeof context.workflowControls === "object"
    ? context.workflowControls
    : {};
  return {
    autoMerge: parseBoolLike(
      rawControls.autoMerge ?? rawControls.auto_merge,
      true
    ),
    mergeMethod: normalizeMergeMethodLike(
      rawControls.mergeMethod ?? rawControls.merge_method,
      "squash"
    ),
    autoCloseIssueOnMerge: parseBoolLike(
      rawControls.autoCloseIssueOnMerge ?? rawControls.auto_close_issue_on_merge,
      true
    ),
    autoMergeConflictMaxAttempts: normalizeAutoMergeConflictMaxAttempts(
      rawControls.autoMergeConflictMaxAttempts ?? rawControls.auto_merge_conflict_max_attempts,
      DEFAULT_AUTO_MERGE_CONFLICT_MAX_ATTEMPTS,
    ),
  };
}

function buildAutoIssueRunTask(issue) {
  const issueId = String(issue?.id ?? "").trim();
  const issueTitle = String(issue?.title ?? "").trim();
  const normalizedTitle = issueTitle || "未命名需求";
  return `[AUTO-ISSUE] 处理 GitHub Issue #${issueId}: ${normalizedTitle}`;
}

const ISSUE_AUTOMATION_LABELS = {
  READY: "forgeops:ready",
  QUEUED: "forgeops:queued",
  RUNNING: "forgeops:running",
  DONE: "forgeops:done",
  FAILED: "forgeops:failed",
  PAUSED_LEGACY: "forgeops:paused",
};
const SKILL_CANDIDATE_ARTIFACT_KINDS = new Set([
  "skill-candidate",
  "skill_candidate",
  "method-candidate",
  "method_candidate",
]);
const SKILL_PROMOTION_ROLE_IDS = new Set([
  "architect",
  "issue-manager",
  "developer",
  "tester",
  "reviewer",
  "garbage-collector",
]);
const CI_GATE_TEMPLATE_KEYS = new Set(["test"]);
const PLATFORM_GATE_TEMPLATE_KEYS = new Set(["test"]);
const CONTEXT_INDEX_RELATIVE_PATH = "docs/context/index.md";
const CONTEXT_REGISTRY_START = "<!-- context-registry:start -->";
const CONTEXT_REGISTRY_END = "<!-- context-registry:end -->";
const CONTEXT_STEP_KEYS = new Set([
  "architect",
  "issue",
  "implement",
  "test",
  "review",
  "cleanup",
]);
const CONTEXT_PRIORITY_RANK = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};
const STEP_SCOPED_CONTEXT_MAX_TOTAL_CHARS = 9000;
const STEP_SCOPED_CONTEXT_PER_DOC_CHARS = 2800;
const STEP_PROMPT_CONTEXT_MAX_CHARS = 16000;

function clipText(value, maxChars = 240) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(16, maxChars - 3))}...`;
}

function clipMultilineText(value, maxChars) {
  const source = String(value ?? "").trim();
  const limit = Number(maxChars);
  if (!source) return "";
  if (!Number.isFinite(limit) || limit <= 0 || source.length <= limit) {
    return source;
  }
  return `${source.slice(0, Math.max(16, Math.floor(limit) - 15))}\n...[truncated]`;
}

function normalizeContextStepKey(value) {
  const step = String(value ?? "").trim().toLowerCase();
  if (!step) return "";
  if (step === "platform-smoke") return "test";
  return CONTEXT_STEP_KEYS.has(step) ? step : "";
}

function normalizeContextPriority(value) {
  const priority = String(value ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONTEXT_PRIORITY_RANK, priority) ? priority : "p3";
}

function extractContextRegistryJsonBlock(block) {
  const source = String(block ?? "").trim();
  if (!source) return "";

  const fenced = source.match(/^```(?:json)?[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) {
    return String(fenced[1] ?? "").trim();
  }

  const firstBracket = source.indexOf("[");
  const lastBracket = source.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return source.slice(firstBracket, lastBracket + 1).trim();
  }

  return "";
}

function parseContextRegistryEntries(indexText) {
  const text = String(indexText ?? "");
  if (!text) return [];

  const start = text.indexOf(CONTEXT_REGISTRY_START);
  const end = text.indexOf(CONTEXT_REGISTRY_END);
  if (start === -1 || end === -1 || end <= start) return [];

  const block = text.slice(start + CONTEXT_REGISTRY_START.length, end).trim();
  const rawJson = extractContextRegistryJsonBlock(block);
  if (!rawJson) return [];

  let parsed = [];
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const docPath = String(item.path ?? "").trim().replace(/\\/g, "/");
    if (!docPath.startsWith("docs/context/") || !docPath.endsWith(".md") || docPath === CONTEXT_INDEX_RELATIVE_PATH) {
      continue;
    }
    const owner = String(item.owner ?? "").trim();
    const priority = normalizeContextPriority(item.priority);
    const steps = Array.isArray(item.use_for_steps)
      ? item.use_for_steps
        .map((step) => normalizeContextStepKey(step))
        .filter(Boolean)
      : [];
    if (steps.length === 0) continue;
    out.push({
      path: docPath,
      owner,
      priority,
      useForSteps: Array.from(new Set(steps)),
    });
  }

  out.sort((left, right) => {
    const leftRank = CONTEXT_PRIORITY_RANK[left.priority] ?? 99;
    const rightRank = CONTEXT_PRIORITY_RANK[right.priority] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.path.localeCompare(right.path);
  });
  return out;
}

function signalProcess(pid, signal) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return {
      ok: false,
      error: "invalid_pid",
    };
  }
  try {
    process.kill(numericPid, signal);
    return {
      ok: true,
      error: "",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeGateStatusFromStepStatus(stepStatus) {
  const key = String(stepStatus ?? "").trim().toLowerCase();
  if (key === "done" || key === "completed") return "passed";
  if (key === "failed" || key === "error") return "failed";
  if (key === "running") return "running";
  if (key === "pending" || key === "waiting" || key === "queued" || key === "retry") return "pending";
  if (key === "skipped") return "skipped";
  return "pending";
}

function pickGateStep(steps, templateMatcher) {
  const rows = Array.isArray(steps) ? steps : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const templateKey = String(row?.template_key ?? row?.step_key ?? "").trim();
    if (!templateMatcher(templateKey)) continue;
    return row;
  }
  return null;
}

function buildGateSummary(step) {
  if (!step) {
    return {
      status: "not_configured",
      stepKey: null,
      templateKey: null,
      summary: "",
      error: "",
      updatedAt: null,
    };
  }
  const status = normalizeGateStatusFromStepStatus(step.status);
  return {
    status,
    stepKey: String(step.step_key ?? ""),
    templateKey: String(step.template_key ?? step.step_key ?? ""),
    summary: String(step.summary ?? ""),
    error: String(step.error ?? ""),
    updatedAt: String(step.updated_at ?? step.ended_at ?? step.started_at ?? ""),
  };
}

function resolveOverallGateStatus(ciStatus, platformStatus) {
  const ci = String(ciStatus ?? "not_configured");
  const platform = String(platformStatus ?? "not_configured");
  if (ci === "failed" || platform === "failed") return "failed";
  if (ci === "running" || platform === "running") return "running";
  if (ci === "pending" || platform === "pending") return "pending";
  if (ci === "passed" && (platform === "passed" || platform === "not_configured" || platform === "skipped")) {
    return "passed";
  }
  if (ci === "not_configured" && platform === "not_configured") return "not_configured";
  if (ci === "skipped" && (platform === "not_configured" || platform === "skipped")) return "not_configured";
  return "pending";
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }
  const text = String(value ?? "").trim();
  return text ? [text] : [];
}

function toMarkdownLines(title, values) {
  const lines = toStringList(values);
  if (lines.length === 0) return "";
  return [`## ${title}`, ...lines.map((line) => `- ${line}`), ""].join("\n");
}

function normalizeSkillCandidateFromOutput(raw, index) {
  const fallbackTitle = `Skill Candidate ${index + 1}`;
  if (typeof raw === "string") {
    const text = String(raw).trim();
    if (!text) return null;
    return {
      title: fallbackTitle,
      content: text,
      source: "outputs",
    };
  }
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? raw.name ?? fallbackTitle).trim() || fallbackTitle;
  const problem = toMarkdownLines("Problem", raw.problem ?? raw.trigger ?? raw.signals);
  const approach = toMarkdownLines("Reusable Approach", raw.approach ?? raw.recipe ?? raw.steps);
  const evidence = toMarkdownLines("Evidence", raw.evidence ?? raw.proof);
  const adoption = toMarkdownLines("Adoption Scope", raw.adoption ?? raw.scope ?? raw.adoptionScope);
  const notes = toMarkdownLines("Notes", raw.notes ?? raw.risks);
  const inlineContent = String(raw.content ?? raw.markdown ?? "").trim();
  const content = inlineContent || [problem, approach, evidence, adoption, notes]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!content) return null;
  return {
    title,
    content,
    source: "outputs",
  };
}

function collectStructuredSkillCandidates(structured) {
  if (!structured || typeof structured !== "object") return [];
  const outputs = structured.outputs && typeof structured.outputs === "object"
    ? structured.outputs
    : {};
  const rawCandidates = outputs.skillCandidates
    ?? outputs.skill_candidates
    ?? outputs.methodCandidates
    ?? outputs.method_candidates
    ?? [];
  const list = Array.isArray(rawCandidates) ? rawCandidates : [rawCandidates];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const normalized = normalizeSkillCandidateFromOutput(list[i], i);
    if (normalized) out.push(normalized);
  }
  return out;
}

function collectArtifactSkillCandidates(artifacts) {
  const rows = Array.isArray(artifacts) ? artifacts : [];
  const out = [];
  for (const row of rows) {
    const kind = String(row?.kind ?? "").trim().toLowerCase();
    if (!SKILL_CANDIDATE_ARTIFACT_KINDS.has(kind)) continue;
    const title = String(row?.title ?? "Skill Candidate").trim() || "Skill Candidate";
    const content = String(row?.content ?? "").trim();
    if (!content) continue;
    out.push({
      title,
      content,
      source: "artifacts",
    });
  }
  return out;
}

function toCandidateFileTimestamp(isoText) {
  const text = String(isoText ?? "").trim();
  if (!text) return "unknown-time";
  return text.replace(/[^\dTZ]/g, "").replace("T", "-").replace("Z", "").slice(0, 15);
}

function yamlQuotedText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function normalizeSkillPromotionRoles(input) {
  const rawList = Array.isArray(input) ? input : [input];
  const out = [];
  for (const row of rawList) {
    if (row === null || row === undefined) continue;
    const parts = String(row)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (!SKILL_PROMOTION_ROLE_IDS.has(part)) continue;
      if (out.includes(part)) continue;
      out.push(part);
    }
  }
  return out;
}

function listMarkdownFilesRecursively(rootPath) {
  const out = [];
  if (!fs.existsSync(rootPath)) return out;
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (!stat.isDirectory()) continue;
    const rows = fs.readdirSync(current, { withFileTypes: true });
    for (const row of rows) {
      const nextPath = path.join(current, row.name);
      if (row.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (!row.isFile()) continue;
      if (!row.name.toLowerCase().endsWith(".md")) continue;
      out.push(nextPath);
    }
  }
  return out;
}

function extractSkillCandidateMarkdown(text, fallbackTitle = "Skill Candidate") {
  const source = String(text ?? "");
  const contentHeading = source.match(/^##\s+Content\s*$/m);
  const splitIndex = contentHeading?.index ?? -1;
  const splitEnd = splitIndex >= 0
    ? splitIndex + String(contentHeading?.[0] ?? "").length
    : -1;
  const head = splitIndex >= 0 ? source.slice(0, splitIndex) : source;
  const body = splitEnd >= 0
    ? source.slice(splitEnd).replace(/^\s*\r?\n/, "").trim()
    : source.trim();

  const meta = {};
  const headLines = head.split(/\r?\n/);
  for (const line of headLines) {
    const matched = line.match(/^\s*-\s*([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!matched) continue;
    const key = String(matched[1] ?? "").trim();
    const value = String(matched[2] ?? "").trim();
    if (!key) continue;
    meta[key] = value;
  }

  let title = String(meta.title ?? "").trim();
  if (!title) {
    const titleLine = headLines.find((line) => /^#\s+/.test(line.trim()));
    if (titleLine) {
      title = titleLine.trim().replace(/^#\s+/, "").trim();
    }
  }
  if (!title) {
    title = fallbackTitle;
  }

  return {
    title,
    content: body,
    metadata: meta,
  };
}

function toAbsoluteSkillCandidatePath(projectRootPath, candidateRef) {
  const projectRoot = path.resolve(String(projectRootPath ?? ""));
  const candidateRoot = path.join(projectRoot, ".forgeops", "skills", "candidates");
  const safePrefix = `${path.resolve(candidateRoot)}${path.sep}`;

  const rawRef = String(candidateRef ?? "").trim();
  if (!rawRef) {
    throw new Error("candidate is required");
  }

  const refs = [];
  if (path.isAbsolute(rawRef)) {
    refs.push(path.resolve(rawRef));
  } else {
    refs.push(path.resolve(projectRoot, rawRef));
    refs.push(path.resolve(candidateRoot, rawRef));
    if (!rawRef.toLowerCase().endsWith(".md")) {
      refs.push(path.resolve(candidateRoot, `${rawRef}.md`));
    }
  }

  const picked = refs.find((item) => fs.existsSync(item) && fs.statSync(item).isFile());
  if (!picked) {
    throw new Error(`Skill candidate not found: ${rawRef}`);
  }

  const absolute = path.resolve(picked);
  if (!absolute.startsWith(safePrefix)) {
    throw new Error("Skill candidate path must be under .forgeops/skills/candidates/");
  }
  return absolute;
}

function buildSkillCandidateRecord(projectRootPath, absolutePath) {
  const absPath = path.resolve(absolutePath);
  const projectRoot = path.resolve(projectRootPath);
  const relativePath = path.relative(projectRoot, absPath);
  const text = fs.readFileSync(absPath, "utf8");
  const parsed = extractSkillCandidateMarkdown(text, path.basename(absPath, ".md"));
  const stat = fs.statSync(absPath);

  return {
    id: relativePath,
    path: relativePath,
    title: parsed.title,
    source: String(parsed.metadata.source ?? "").trim(),
    runId: String(parsed.metadata.run ?? "").trim(),
    issueId: String(parsed.metadata.issue ?? "").trim(),
    generatedAt: String(parsed.metadata.generated_at ?? stat.mtime.toISOString()),
    summary: clipText(parsed.content, 220),
    content: parsed.content,
    metadata: parsed.metadata,
  };
}

function parseTimeMs(rawValue) {
  const ts = Number(new Date(String(rawValue ?? "")).getTime());
  return Number.isFinite(ts) ? ts : 0;
}

function toIsoFromMs(rawMs) {
  const ms = Number(rawMs);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

function normalizeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function normalizeRate01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return Number(n.toFixed(3));
}

function computeRate(numerator, denominator) {
  const den = normalizeCount(denominator);
  if (den <= 0) return 0;
  const num = normalizeCount(numerator);
  return normalizeRate01(num / den);
}

function normalizeSkillFeedbackKey(rawValue) {
  const normalized = slugify(String(rawValue ?? "").trim());
  return String(normalized ?? "").trim();
}

function normalizeCandidateMetadata(rawMetadata) {
  if (!rawMetadata || typeof rawMetadata !== "object") {
    return {};
  }
  const reserved = new Set([
    "title",
    "source",
    "project",
    "run",
    "step",
    "issue",
    "generated_at",
  ]);
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(rawMetadata)) {
    const key = String(rawKey ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!key || reserved.has(key)) continue;
    const value = String(rawValue ?? "").trim().replace(/\r?\n+/g, " ");
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

function normalizeCandidateTitleKey(rawTitle) {
  const slug = normalizeSkillFeedbackKey(rawTitle);
  if (slug) return slug;
  return String(rawTitle ?? "").trim().toLowerCase();
}

function toCounterRows(counterMap, matcher = () => true, limit = 5) {
  const out = [];
  const map = counterMap && typeof counterMap === "object" ? counterMap : {};
  for (const [eventType, rawCount] of Object.entries(map)) {
    const count = normalizeCount(rawCount);
    if (!eventType || count <= 0) continue;
    if (!matcher(eventType)) continue;
    out.push({
      eventType,
      count,
    });
  }
  out.sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return String(left.eventType).localeCompare(String(right.eventType));
  });
  return out.slice(0, Math.max(1, normalizeCount(limit) || 5));
}

function normalizeSkillNameCandidate(rawValue) {
  const source = String(rawValue ?? "").trim();
  if (!source) return "";
  const cleaned = source
    .replace(/^skill\s*candidate\s*[:：-]?\s*/i, "")
    .replace(/^candidate\s*[:：-]?\s*/i, "")
    .replace(/^候选技能\s*[:：-]?\s*/i, "")
    .replace(/^技能候选\s*[:：-]?\s*/i, "")
    .replace(/^skill-candidate\s*[:：-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function isGenericSkillCandidateTitle(rawTitle) {
  const title = String(rawTitle ?? "").trim().toLowerCase();
  if (!title) return true;
  if (title === "skill candidate") return true;
  if (/^skill candidate \d+$/.test(title)) return true;
  if (/^candidate \d+$/.test(title)) return true;
  if (/^候选技能\d*$/.test(title)) return true;
  return false;
}

function deriveSkillNameFromCandidate(candidate) {
  const normalizedTitle = normalizeSkillNameCandidate(candidate?.title);
  if (normalizedTitle && !isGenericSkillCandidateTitle(normalizedTitle)) {
    const fromTitle = slugify(normalizedTitle);
    if (fromTitle) return fromTitle;
  }

  const content = String(candidate?.content ?? "");
  const firstLine = content.split(/\r?\n/).find((line) => String(line ?? "").trim()) ?? "";
  const fromFirstLine = slugify(
    normalizeSkillNameCandidate(
      String(firstLine ?? "")
        .replace(/^[-*#\s]+/, "")
        .replace(/^problem\s*[:：-]?\s*/i, "")
        .replace(/^问题\s*[:：-]?\s*/i, "")
        .trim()
    )
  );
  if (fromFirstLine) return fromFirstLine;
  return "";
}

function hasEvidenceSignal(candidate) {
  const text = String(candidate?.content ?? "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("evidence")
    || text.includes("proof")
    || text.includes("证据")
    || text.includes("验证")
    || text.includes("测试")
    || text.includes("test")
    || text.includes("命令")
    || text.includes("日志")
  );
}

function hasProblemAndApproachSignal(candidate) {
  const text = String(candidate?.content ?? "").toLowerCase();
  if (!text) return false;
  const hasProblem = text.includes("problem") || text.includes("问题");
  const hasApproach = text.includes("approach") || text.includes("方案") || text.includes("做法");
  return hasProblem && hasApproach;
}

function normalizeScore(value, fallback = 0.6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return Number(n.toFixed(3));
}

function evaluateSkillCandidatesForAutoPromotion(candidates, options = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length === 0) {
    return {
      totalCandidates: 0,
      groupedSkills: 0,
      eligible: [],
      rejected: [],
    };
  }

  const minOccurrences = Math.max(1, Number(options.minCandidateOccurrences ?? 2));
  const lookbackDays = Math.max(1, Number(options.lookbackDays ?? 14));
  const minScore = normalizeScore(options.minScore, 0.6);
  const feedbackBySkill = options.feedbackBySkill && typeof options.feedbackBySkill === "object"
    ? options.feedbackBySkill
    : {};
  const cutoffMs = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);

  const groupMap = new Map();
  for (const candidate of rows) {
    const generatedAtMs = parseTimeMs(candidate?.generatedAt);
    if (generatedAtMs > 0 && generatedAtMs < cutoffMs) continue;
    const skillName = deriveSkillNameFromCandidate(candidate);
    if (!skillName) continue;
    if (!groupMap.has(skillName)) {
      groupMap.set(skillName, []);
    }
    groupMap.get(skillName).push({
      ...candidate,
      generatedAtMs,
    });
  }

  const eligible = [];
  const rejected = [];
  for (const [skillName, grouped] of groupMap.entries()) {
    grouped.sort((left, right) => {
      const la = Number(left.generatedAtMs ?? 0);
      const ra = Number(right.generatedAtMs ?? 0);
      if (la !== ra) return ra - la;
      return String(left.path ?? "").localeCompare(String(right.path ?? ""));
    });
    const latest = grouped[0];
    const uniqueIssueSet = new Set(
      grouped.map((item) => String(item.issueId ?? "").trim()).filter(Boolean)
    );
    const uniqueRunSet = new Set(
      grouped.map((item) => String(item.runId ?? "").trim()).filter(Boolean)
    );
    const occurrenceCount = grouped.length;
    const recurrenceScore = Math.min(1, occurrenceCount / minOccurrences);
    const issueDiversityScore = uniqueIssueSet.size >= 2 ? 1 : (uniqueIssueSet.size === 1 ? 0.5 : 0);
    const runDiversityScore = uniqueRunSet.size >= 2 ? 1 : (uniqueRunSet.size === 1 ? 0.5 : 0);
    const evidenceScore = hasEvidenceSignal(latest) ? 1 : 0;
    const structureScore = hasProblemAndApproachSignal(latest) ? 1 : 0.4;
    const feedback = feedbackBySkill[skillName] && typeof feedbackBySkill[skillName] === "object"
      ? feedbackBySkill[skillName]
      : null;
    const feedbackScore = normalizeScore(
      feedback ? Number(feedback.effectivenessScore ?? 0.5) : 0.5,
      0.5
    );
    const score = normalizeScore(
      (recurrenceScore * 0.40)
      + (evidenceScore * 0.20)
      + (issueDiversityScore * 0.10)
      + (runDiversityScore * 0.05)
      + (structureScore * 0.10)
      + (feedbackScore * 0.15),
      0
    );

    const summary = {
      skillName,
      candidatePath: String(latest.path ?? ""),
      candidateTitle: String(latest.title ?? ""),
      generatedAt: String(latest.generatedAt ?? ""),
      occurrenceCount,
      uniqueIssues: uniqueIssueSet.size,
      uniqueRuns: uniqueRunSet.size,
      feedbackScore,
      feedback,
      score,
    };

    if (occurrenceCount < minOccurrences || score < minScore) {
      rejected.push({
        ...summary,
        reason: occurrenceCount < minOccurrences ? "occurrences_below_threshold" : "score_below_threshold",
      });
      continue;
    }

    eligible.push({
      ...summary,
      candidate: latest,
      description: `Auto promoted from ${occurrenceCount} candidates (score=${score})`,
    });
  }

  eligible.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const la = parseTimeMs(left.generatedAt);
    const ra = parseTimeMs(right.generatedAt);
    if (la !== ra) return ra - la;
    return String(left.skillName).localeCompare(String(right.skillName));
  });

  rejected.sort((left, right) => {
    const la = parseTimeMs(left.generatedAt);
    const ra = parseTimeMs(right.generatedAt);
    if (la !== ra) return ra - la;
    return String(left.skillName).localeCompare(String(right.skillName));
  });

  return {
    totalCandidates: rows.length,
    groupedSkills: groupMap.size,
    eligible,
    rejected,
    policy: {
      minOccurrences,
      lookbackDays,
      minScore,
      feedbackWeighted: true,
    },
  };
}

function buildPromotedSkillMarkdown(params) {
  const skillName = String(params?.skillName ?? "").trim();
  const description = String(params?.description ?? "").trim();
  const candidate = params?.candidate && typeof params.candidate === "object"
    ? params.candidate
    : {};
  const generatedAt = String(params?.generatedAt ?? nowIso());

  return [
    "---",
    `name: ${skillName}`,
    `description: "${yamlQuotedText(description)}"`,
    "---",
    "",
    "# Skill Intent",
    "",
    "本技能由项目实战候选自动晋升生成，合并前可由 Codex `skill-creator` 进一步收敛表达，但目标路径必须保持不变。",
    "",
    "# Usage Policy",
    "",
    "1. 使用前先核对当前任务边界与上下文约束。",
    "2. 优先复用已验证步骤，避免引入无法复现的隐式假设。",
    "3. 交付时必须附带可审计证据（命令、日志、产物路径）。",
    "4. 若需重写本技能，优先使用 `skill-creator` 并保持标准 frontmatter（name/description）。",
    "",
    "## Canonical Location",
    "",
    `- .forgeops/skills/${skillName}/SKILL.md`,
    "",
    "## Source",
    "",
    `- candidate: ${String(candidate.path ?? "-") || "-"}`,
    `- run: ${String(candidate.runId ?? "-") || "-"}`,
    `- issue: ${String(candidate.issueId ?? "-") || "-"}`,
    `- promoted_at: ${generatedAt}`,
    "",
    "## Reusable Approach",
    "",
    String(candidate.content ?? "").trim() || "-",
    "",
  ].join("\n");
}

function buildSkillPromotionPullRequestBody(params) {
  const project = params?.project && typeof params.project === "object" ? params.project : {};
  const candidate = params?.candidate && typeof params.candidate === "object" ? params.candidate : {};
  const skillName = String(params?.skillName ?? "").trim();
  const roles = Array.isArray(params?.roles) ? params.roles : [];
  const files = Array.isArray(params?.files) ? params.files : [];
  const issueRef = String(candidate.issueId ?? "").trim().replace(/^#/, "");

  const lines = [
    "## ForgeOps Skill Promotion",
    "",
    `- project: \`${String(project.id ?? "-") || "-"}\``,
    `- candidate: \`${String(candidate.path ?? "-") || "-"}\``,
    `- skill: \`${skillName || "-"}\``,
    `- source run: \`${String(candidate.runId ?? "-") || "-"}\``,
    `- source issue: ${issueRef ? `#${issueRef}` : "-"}`,
    `- target roles: ${roles.length > 0 ? roles.join(", ") : "-"}`,
    "",
    "## Authoring Contract",
    "- [ ] keep canonical path: `.forgeops/skills/<skill-name>/SKILL.md`",
    "- [ ] keep standard SKILL frontmatter: `name` + `description`",
    "- [ ] if content needs refinement, use runtime system skill `skill-creator`",
    "",
    "## Changed Files",
    ...files.map((filePath) => `- \`${String(filePath)}\``),
    "",
    "## Review Checklist",
    "- [ ] problem/approach/evidence/adoption 是否完整且可复现",
    "- [ ] 是否与现有技能重复或冲突",
    "- [ ] 是否符合当前项目约束与风格",
  ];
  return lines.join("\n");
}

function appendSkillPromotionLog(worktreeRoot, payload) {
  const logPath = path.join(worktreeRoot, ".forgeops", "skills", "promotion-log.ndjson");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf8");
  return path.relative(worktreeRoot, logPath);
}

function buildGlobalPromotedSkillMarkdown(params) {
  const skillName = String(params?.skillName ?? "").trim();
  const description = String(params?.description ?? "").trim();
  const candidate = params?.candidate && typeof params.candidate === "object"
    ? params.candidate
    : {};
  const sourceProject = params?.sourceProject && typeof params.sourceProject === "object"
    ? params.sourceProject
    : {};
  const generatedAt = String(params?.generatedAt ?? nowIso());

  return [
    "---",
    `name: ${skillName}`,
    `description: "${yamlQuotedText(description)}"`,
    "---",
    "",
    "# Skill Intent",
    "",
    "本技能来源于项目实战晋升，合并前可由 Codex `skill-creator` 进一步整理，但目标路径必须保持不变。",
    "",
    "# Usage Policy",
    "",
    "1. 优先保证可执行与可复现。",
    "2. 如与项目本地技能冲突，以项目本地约束优先。",
    "3. 使用时必须输出命令、结果与证据路径。",
    "4. 若需重写本技能，优先使用 `skill-creator` 并保持标准 frontmatter（name/description）。",
    "",
    "## Canonical Location",
    "",
    `- skills/${skillName}/SKILL.md`,
    "",
    "## Source",
    "",
    `- source_project_id: ${String(sourceProject.id ?? "-") || "-"}`,
    `- source_project_name: ${String(sourceProject.name ?? "-") || "-"}`,
    `- source_candidate: ${String(candidate.path ?? "-") || "-"}`,
    `- source_run: ${String(candidate.runId ?? "-") || "-"}`,
    `- source_issue: ${String(candidate.issueId ?? "-") || "-"}`,
    `- promoted_at: ${generatedAt}`,
    "",
    "## Reusable Approach",
    "",
    String(candidate.content ?? "").trim() || "-",
    "",
  ].join("\n");
}

function buildGlobalSkillPromotionPullRequestBody(params) {
  const sourceProject = params?.sourceProject && typeof params.sourceProject === "object"
    ? params.sourceProject
    : {};
  const candidate = params?.candidate && typeof params.candidate === "object"
    ? params.candidate
    : {};
  const skillName = String(params?.skillName ?? "").trim();
  const files = Array.isArray(params?.files) ? params.files : [];
  const globalRoot = String(params?.globalRoot ?? "").trim();

  const lines = [
    "## ForgeOps User-Global Skill Promotion",
    "",
    `- global_root: \`${globalRoot || "-"}\``,
    `- source project: \`${String(sourceProject.id ?? "-") || "-"}\` (${String(sourceProject.name ?? "-") || "-"})`,
    `- source candidate: \`${String(candidate.path ?? "-") || "-"}\``,
    `- source run: \`${String(candidate.runId ?? "-") || "-"}\``,
    `- source issue: ${String(candidate.issueId ?? "-") || "-"}`,
    `- target skill: \`${skillName || "-"}\``,
    "",
    "## Authoring Contract",
    "- [ ] keep canonical path: `skills/<skill-name>/SKILL.md` in user-global repo",
    "- [ ] keep standard SKILL frontmatter: `name` + `description`",
    "- [ ] if content needs refinement, use runtime system skill `skill-creator`",
    "",
    "## Changed Files",
    ...files.map((filePath) => `- \`${String(filePath)}\``),
    "",
    "## Review Checklist",
    "- [ ] 是否保留了来源证据与可执行性",
    "- [ ] 是否适合作为 user-global 可复用技能",
    "- [ ] 是否与已有 global skill 冲突",
  ];
  return lines.join("\n");
}

function buildSkillPromotionReviewChecklistComment(params) {
  const marker = "<!-- forgeops:skill-promotion-checklist:v1 -->";
  const scope = String(params?.scope ?? "project").trim();
  const skillName = String(params?.skillName ?? "").trim();
  const candidatePath = String(params?.candidatePath ?? "").trim();
  const sourceRun = String(params?.sourceRun ?? "").trim();
  const sourceIssue = String(params?.sourceIssue ?? "").trim();
  const sourceProject = String(params?.sourceProject ?? "").trim();
  const targetRoles = Array.isArray(params?.targetRoles) ? params.targetRoles : [];
  const canonicalPath = scope === "user-global"
    ? `skills/${skillName || "<skill-name>"}/SKILL.md`
    : `.forgeops/skills/${skillName || "<skill-name>"}/SKILL.md`;

  return [
    marker,
    "### Skill Promotion Review Checklist",
    `- scope: \`${scope}\``,
    `- skill: \`${skillName || "-"}\``,
    `- candidate: \`${candidatePath || "-"}\``,
    `- source run: \`${sourceRun || "-"}\``,
    `- source issue: ${sourceIssue || "-"}`,
    sourceProject ? `- source project: \`${sourceProject}\`` : "- source project: -",
    `- target roles: ${targetRoles.length > 0 ? targetRoles.join(", ") : "-"}`,
    `- canonical path: \`${canonicalPath}\``,
    "",
    "**Reviewer checks**",
    "- [ ] 是否保持标准 SKILL frontmatter（name + description）",
    "- [ ] 如需重写，是否基于运行时 `skill-creator` 完成",
    "- [ ] 方法是否可执行、可复现、可验证",
    "- [ ] 证据链是否可追溯（run/issue/artifacts）",
    "- [ ] 与现有技能是否冲突或重复",
    "- [ ] 失败回滚与适用边界是否清晰",
    "",
    "> 说明：分支前缀（如 `codex/`）仅表示自动化来源，不代表运行时或技能归属。",
  ].join("\n");
}

function buildSkillPromotionPrLabels(params) {
  const scope = String(params?.scope ?? "project").trim();
  const auto = params?.auto === true;
  const labels = [
    "forgeops:skill-promotion",
    scope === "user-global" ? "forgeops:skill-global" : "forgeops:skill-project",
    auto ? "forgeops:auto" : "forgeops:manual",
  ];
  return Array.from(new Set(
    labels
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
  ));
}

function appendGlobalSkillAuditLog(worktreeRoot, payload) {
  const logPath = path.join(worktreeRoot, "audit.ndjson");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf8");
  return path.relative(worktreeRoot, logPath);
}

function updateGlobalSkillIndex(worktreeRoot, entry) {
  const indexPath = path.join(worktreeRoot, "catalog", "skills-index.json");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });

  let parsed = { version: 1, skills: [] };
  if (fs.existsSync(indexPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (raw && typeof raw === "object") {
        parsed = {
          version: Number(raw.version ?? 1) || 1,
          skills: Array.isArray(raw.skills) ? raw.skills : [],
        };
      }
    } catch {
      parsed = { version: 1, skills: [] };
    }
  }

  const skillName = String(entry?.skillName ?? "").trim();
  const keep = parsed.skills.filter((item) => String(item?.skillName ?? "") !== skillName);
  keep.push({
    skillName,
    description: String(entry?.description ?? "").trim(),
    updatedAt: String(entry?.updatedAt ?? nowIso()),
    sourceProjectId: String(entry?.sourceProjectId ?? "").trim(),
    sourceCandidatePath: String(entry?.sourceCandidatePath ?? "").trim(),
    sourceRunId: String(entry?.sourceRunId ?? "").trim(),
    sourceIssueId: String(entry?.sourceIssueId ?? "").trim(),
  });
  parsed.skills = keep.sort((left, right) =>
    String(left.skillName ?? "").localeCompare(String(right.skillName ?? ""))
  );
  fs.writeFileSync(indexPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path.relative(worktreeRoot, indexPath);
}

function buildRunQualityGates(steps) {
  const ciStep = pickGateStep(
    steps,
    (templateKey) => CI_GATE_TEMPLATE_KEYS.has(templateKey),
  );
  const platformStep = pickGateStep(
    steps,
    (templateKey) => PLATFORM_GATE_TEMPLATE_KEYS.has(templateKey),
  );
  const ci = buildGateSummary(ciStep);
  const platform = buildGateSummary(platformStep);
  return {
    ci,
    platform,
    overall: resolveOverallGateStatus(ci.status, platform.status),
  };
}

function buildRecentDaysSeed(dayCount = 7) {
  const formatLocalDate = (value) => {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  const days = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const ts = new Date(now);
    ts.setDate(now.getDate() - offset);
    days.push({
      date: formatLocalDate(ts),
      added_lines: 0,
      deleted_lines: 0,
      net_lines: 0,
      commit_count: 0,
    });
  }
  return days;
}

function buildCodeLanguageRows(languageMap) {
  return Array.from(languageMap.values())
    .map((row) => ({
      language: row.language,
      lines: Number(row.lines ?? 0),
      files: Number(row.files ?? 0),
    }))
    .sort((a, b) => {
      if (b.lines !== a.lines) return b.lines - a.lines;
      if (b.files !== a.files) return b.files - a.files;
      return a.language.localeCompare(b.language);
    });
}

function runCommandSafe(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2500,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "");
}

function parseGitHubRemoteSlug(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";

  const https = raw.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (https) {
    return `${https[1]}/${https[2]}`;
  }

  const ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) {
    return `${ssh[1]}/${ssh[2]}`;
  }

  return "";
}

function detectGitHubRepoFromOrigin(rootPath) {
  const repoRoot = String(rootPath ?? "").trim();
  if (!repoRoot) return "";
  const originUrl = runCommandSafe("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
  if (!originUrl) return "";
  return parseGitHubRemoteSlug(originUrl);
}

function refreshMainlineRefsIfNeeded(repoRoot) {
  const key = path.resolve(repoRoot);
  const nowMs = Date.now();
  const previous = MAINLINE_REF_FETCH_STATE.get(key);
  const hasSuccess = Number(previous?.lastSuccessAtMs ?? 0) > 0;
  const minIntervalMs = hasSuccess
    ? MAINLINE_REF_FETCH_INTERVAL_MS
    : MAINLINE_REF_FETCH_RETRY_INTERVAL_MS;
  if (previous && nowMs - Number(previous.lastAttemptAtMs ?? 0) < minIntervalMs) {
    return;
  }
  const refreshed = runCommandSafe("git", ["-C", repoRoot, "fetch", "--quiet", "--no-tags", "origin"]) !== null;
  MAINLINE_REF_FETCH_STATE.set(key, {
    lastAttemptAtMs: nowMs,
    lastSuccessAtMs: refreshed ? nowMs : Number(previous?.lastSuccessAtMs ?? 0),
  });
}

function detectMainlineRef(rootPath) {
  const repoRoot = String(rootPath ?? "").trim();
  if (!repoRoot) return "";
  const inRepo = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
  if (!inRepo) return "";

  // Keep remote refs reasonably fresh while avoiding frequent network fetches.
  refreshMainlineRefsIfNeeded(repoRoot);

  const remoteHead = runCommandSafe("git", ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    const normalized = String(remoteHead).trim();
    if (normalized.startsWith("refs/remotes/origin/")) {
      const candidate = normalized.replace("refs/remotes/", "");
      const ok = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--verify", candidate]);
      if (ok) return candidate;
    }
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master", "HEAD"]) {
    const ok = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--verify", candidate]);
    if (ok) return candidate;
  }
  return "";
}

function scanGitCodeTrend7d(rootPath, ref = "") {
  const trendRef = String(ref ?? "").trim();
  const logArgs = [
    "-C",
    rootPath,
    "log",
    "--since=7.days",
    "--date=short",
    "--numstat",
    "--pretty=format:@@COMMIT@@%H@@%ad",
  ];
  if (trendRef) {
    logArgs.push(trendRef);
  }
  const output = runCommandSafe("git", [
    ...logArgs,
  ]);
  if (output === null) {
    return createEmptyCodeTrend7d("Git numstat unavailable for this project.");
  }

  const seedDays = buildRecentDaysSeed(7);
  const dayRows = new Map(seedDays.map((row) => [row.date, { ...row }]));
  const dayCommitSets = new Map(seedDays.map((row) => [row.date, new Set()]));
  const commitHashes = new Set();

  let currentCommit = "";
  let currentDate = "";
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const text = String(line ?? "").trim();
    if (!text) continue;

    if (text.startsWith("@@COMMIT@@")) {
      const marker = text.slice("@@COMMIT@@".length);
      const [hash, date] = marker.split("@@");
      currentCommit = String(hash ?? "").trim();
      currentDate = String(date ?? "").trim();
      continue;
    }

    if (!currentCommit || !currentDate) continue;

    const cols = text.split("\t");
    if (cols.length < 3) continue;
    const relPath = cols.slice(2).join("\t").trim();
    if (!relPath) continue;
    if (hasIgnoredPathSegment(relPath)) continue;
    if (!shouldCountCodeFile(path.basename(relPath))) continue;

    const added = /^\d+$/.test(cols[0]) ? Number(cols[0]) : 0;
    const deleted = /^\d+$/.test(cols[1]) ? Number(cols[1]) : 0;
    const row = dayRows.get(currentDate);
    if (!row) continue;

    row.added_lines += added;
    row.deleted_lines += deleted;
    row.net_lines = row.added_lines - row.deleted_lines;
    commitHashes.add(currentCommit);
    dayCommitSets.get(currentDate)?.add(currentCommit);
  }

  const days = seedDays.map((item) => {
    const row = dayRows.get(item.date) ?? item;
    const commitCount = dayCommitSets.get(item.date)?.size ?? 0;
    return {
      ...row,
      commit_count: commitCount,
    };
  });
  const addedLines = days.reduce((sum, row) => sum + Number(row.added_lines ?? 0), 0);
  const deletedLines = days.reduce((sum, row) => sum + Number(row.deleted_lines ?? 0), 0);
  const netLines = addedLines - deletedLines;

  const normalizedRef = trendRef || "HEAD";
  return {
    available: true,
    source: normalizedRef.startsWith("origin/") ? "git_numstat_mainline" : "git_numstat",
    ref: normalizedRef,
    commit_count: commitHashes.size,
    added_lines: addedLines,
    deleted_lines: deletedLines,
    net_lines: netLines,
    days,
    warning: commitHashes.size === 0 ? "No code commits in the last 7 days." : "",
  };
}

function listGitTreeEntriesAtRef(rootPath, ref) {
  const normalizedRef = String(ref ?? "").trim();
  if (!normalizedRef) return null;
  const output = runCommandSafe("git", ["-C", rootPath, "ls-tree", "-r", "-z", "-l", normalizedRef]);
  if (output === null) return null;
  return output
    .split("\u0000")
    .filter(Boolean)
    .map((line) => {
      const matched = String(line).match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40})\s+(\d+|-)\t([\s\S]+)$/);
      if (!matched) return null;
      return {
        mode: matched[1],
        type: matched[2],
        objectId: matched[3],
        size: matched[4] === "-" ? -1 : Number(matched[4]),
        relPath: matched[5],
      };
    })
    .filter((item) => item && item.type === "blob");
}

function readGitBlobText(rootPath, objectId) {
  const id = String(objectId ?? "").trim();
  if (!id) return null;
  return runCommandSafe("git", ["-C", rootPath, "cat-file", "-p", id]);
}

function scanGitRefCodeSnapshot(rootPath, ref) {
  const normalizedRef = String(ref ?? "").trim();
  if (!normalizedRef) return null;
  const entries = listGitTreeEntriesAtRef(rootPath, normalizedRef);
  if (!entries) return null;

  let codeLines = 0;
  let codeFiles = 0;
  let docWords = 0;
  let docFiles = 0;
  let docsDocWords = 0;
  let docsDocFiles = 0;
  const languageMap = new Map();

  for (const entry of entries) {
    const relPath = String(entry.relPath ?? "").trim();
    if (!relPath) continue;
    if (hasIgnoredPathSegment(relPath)) continue;
    const baseName = path.basename(relPath);
    const isCodeFile = shouldCountCodeFile(baseName);
    const isDocFile = shouldCountDocFile(baseName);
    if (!isCodeFile && !isDocFile) continue;

    const size = Number(entry.size ?? -1);
    if (
      (isCodeFile && Number.isFinite(size) && size > MAX_CODE_FILE_SIZE_BYTES)
      || (isDocFile && Number.isFinite(size) && size > MAX_DOC_FILE_SIZE_BYTES)
    ) {
      continue;
    }

    const content = readGitBlobText(rootPath, entry.objectId);
    if (content === null) continue;

    if (isCodeFile) {
      const lineCount = countTextLines(content);
      codeLines += lineCount;
      codeFiles += 1;
      const language = resolveCodeLanguage(baseName);
      const current = languageMap.get(language) ?? { language, lines: 0, files: 0 };
      current.lines += lineCount;
      current.files += 1;
      languageMap.set(language, current);
    }
    if (isDocFile) {
      const wordCount = countDocumentWords(content);
      docWords += wordCount;
      docFiles += 1;
      if (isDocsScopedPath(relPath)) {
        docsDocWords += wordCount;
        docsDocFiles += 1;
      }
    }
  }

  return {
    code_lines: codeLines,
    code_files: codeFiles,
    doc_words: docWords,
    doc_files: docFiles,
    docs_doc_words: docsDocWords,
    docs_doc_files: docsDocFiles,
    loc_source: "git_mainline_tree",
    code_languages: buildCodeLanguageRows(languageMap),
    code_trend_7d: scanGitCodeTrend7d(rootPath, normalizedRef),
  };
}

function scanGitTrackedCodeSnapshot(rootPath) {
  const output = runCommandSafe("git", ["-C", rootPath, "ls-files", "-z"]);
  if (output === null) return null;
  const relFiles = output.split("\u0000").filter(Boolean);
  let codeLines = 0;
  let codeFiles = 0;
  let docWords = 0;
  let docFiles = 0;
  let docsDocWords = 0;
  let docsDocFiles = 0;
  const languageMap = new Map();

  for (const relPath of relFiles) {
    if (hasIgnoredPathSegment(relPath)) continue;
    const baseName = path.basename(relPath);
    const isCodeFile = shouldCountCodeFile(baseName);
    const isDocFile = shouldCountDocFile(baseName);
    if (!isCodeFile && !isDocFile) continue;
    const fullPath = path.join(rootPath, relPath);
    let stat = null;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat?.isFile()) continue;
    if ((isCodeFile && stat.size > MAX_CODE_FILE_SIZE_BYTES) || (isDocFile && stat.size > MAX_DOC_FILE_SIZE_BYTES)) {
      continue;
    }
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      if (isCodeFile) {
        const lineCount = countTextLines(content);
        codeLines += lineCount;
        codeFiles += 1;
        const language = resolveCodeLanguage(baseName);
        const current = languageMap.get(language) ?? { language, lines: 0, files: 0 };
        current.lines += lineCount;
        current.files += 1;
        languageMap.set(language, current);
      }
      if (isDocFile) {
        const wordCount = countDocumentWords(content);
        docWords += wordCount;
        docFiles += 1;
        if (isDocsScopedPath(relPath)) {
          docsDocWords += wordCount;
          docsDocFiles += 1;
        }
      }
    } catch {
      continue;
    }
  }

  return {
    code_lines: codeLines,
    code_files: codeFiles,
    doc_words: docWords,
    doc_files: docFiles,
    docs_doc_words: docsDocWords,
    docs_doc_files: docsDocFiles,
    loc_source: "git_tracked_files_workspace",
    code_languages: buildCodeLanguageRows(languageMap),
    code_trend_7d: scanGitCodeTrend7d(rootPath),
  };
}

function scanProjectCodeSnapshot(rootPath) {
  const mainlineRef = detectMainlineRef(rootPath);
  if (mainlineRef) {
    const fromMainline = scanGitRefCodeSnapshot(rootPath, mainlineRef);
    if (fromMainline) {
      return fromMainline;
    }
  }

  const tracked = scanGitTrackedCodeSnapshot(rootPath);
  if (tracked) {
    return tracked;
  }

  const stack = [rootPath];
  let codeLines = 0;
  let codeFiles = 0;
  let docWords = 0;
  let docFiles = 0;
  let docsDocWords = 0;
  let docsDocFiles = 0;
  const languageMap = new Map();

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = entry.name;
      const fullPath = path.join(dir, name);

      if (entry.isDirectory()) {
        if (CODE_IGNORED_DIRS.has(name)) continue;
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const isCodeFile = shouldCountCodeFile(name);
      const isDocFile = shouldCountDocFile(name);
      if (!isCodeFile && !isDocFile) continue;

      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat?.isFile()) continue;
      if ((isCodeFile && stat.size > MAX_CODE_FILE_SIZE_BYTES) || (isDocFile && stat.size > MAX_DOC_FILE_SIZE_BYTES)) {
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, "utf8");
        const relPath = path.relative(rootPath, fullPath);
        if (isCodeFile) {
          const lineCount = countTextLines(content);
          codeLines += lineCount;
          codeFiles += 1;
          const language = resolveCodeLanguage(name);
          const current = languageMap.get(language) ?? { language, lines: 0, files: 0 };
          current.lines += lineCount;
          current.files += 1;
          languageMap.set(language, current);
        }
        if (isDocFile) {
          const wordCount = countDocumentWords(content);
          docWords += wordCount;
          docFiles += 1;
          if (isDocsScopedPath(relPath)) {
            docsDocWords += wordCount;
            docsDocFiles += 1;
          }
        }
      } catch {
        continue;
      }
    }
  }

  return {
    code_lines: codeLines,
    code_files: codeFiles,
    doc_words: docWords,
    doc_files: docFiles,
    docs_doc_words: docsDocWords,
    docs_doc_files: docsDocFiles,
    loc_source: "filesystem_scan",
    code_languages: buildCodeLanguageRows(languageMap),
    code_trend_7d: scanGitCodeTrend7d(rootPath),
  };
}

export class ForgeOpsStore {
  constructor() {
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_PATH);
    this.lockOwnerBase = `forgeops:${process.pid}:${newId("lockowner")}`;
    this.lockSequence = 0;
    this.events = new EventEmitter();
    this.projectLocCache = new Map();
    this.projectGitHubMetricsCache = new Map();
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        product_type TEXT NOT NULL,
        github_repo TEXT NOT NULL DEFAULT '',
        problem_statement TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        github_issue_id TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        workflow_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        worktree_path TEXT,
        worktree_branch TEXT,
        base_ref TEXT,
        current_step_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        step_key TEXT NOT NULL,
        template_key TEXT,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        input_text TEXT NOT NULL,
        output_text TEXT,
        output_json TEXT,
        summary TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        runtime TEXT NOT NULL DEFAULT 'codex-exec-json',
        runtime_session_id TEXT,
        requested_model TEXT,
        effective_model TEXT,
        model_provider TEXT,
        token_input INTEGER NOT NULL DEFAULT 0,
        token_cached_input INTEGER NOT NULL DEFAULT 0,
        token_output INTEGER NOT NULL DEFAULT 0,
        token_reasoning_output INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        step_id TEXT NOT NULL REFERENCES steps(id),
        runtime TEXT NOT NULL,
        process_pid INTEGER,
        thread_id TEXT,
        turn_id TEXT,
        requested_model TEXT,
        effective_model TEXT,
        model_provider TEXT,
        token_input INTEGER NOT NULL DEFAULT 0,
        token_cached_input INTEGER NOT NULL DEFAULT 0,
        token_output INTEGER NOT NULL DEFAULT 0,
        token_reasoning_output INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        step_id TEXT,
        ts TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        step_id TEXT NOT NULL REFERENCES steps(id),
        kind TEXT NOT NULL,
        title TEXT,
        content TEXT,
        path TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS locks (
        lock_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_project_issue_running
        ON runs(project_id, github_issue_id)
        WHERE status = 'running'
          AND github_issue_id IS NOT NULL
          AND TRIM(github_issue_id) != '';
      CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, step_index);
      CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
      CREATE INDEX IF NOT EXISTS idx_locks_expires_at ON locks(expires_at);
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_project_issue_running
        ON runs(project_id, github_issue_id)
        WHERE status = 'running'
          AND github_issue_id IS NOT NULL
          AND TRIM(github_issue_id) != '';
    `);

    const stepColumns = new Set(
      this.db.prepare("PRAGMA table_info(steps)").all().map((row) => row.name)
    );
    if (!stepColumns.has("template_key")) {
      this.db.exec("ALTER TABLE steps ADD COLUMN template_key TEXT");
    }
    if (!stepColumns.has("depends_on_json")) {
      this.db.exec("ALTER TABLE steps ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'");
    }

    const runColumns = new Set(
      this.db.prepare("PRAGMA table_info(runs)").all().map((row) => row.name)
    );
    if (!runColumns.has("worktree_path")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN worktree_path TEXT");
    }
    if (!runColumns.has("worktree_branch")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN worktree_branch TEXT");
    }
    if (!runColumns.has("base_ref")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN base_ref TEXT");
    }
    if (!runColumns.has("github_issue_id")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN github_issue_id TEXT");
    }

    const projectColumns = new Set(
      this.db.prepare("PRAGMA table_info(projects)").all().map((row) => row.name)
    );
    if (!projectColumns.has("github_repo")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN github_repo TEXT NOT NULL DEFAULT ''");
    }

    const sessionColumns = new Set(
      this.db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name)
    );
    if (!sessionColumns.has("token_input")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN token_input INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionColumns.has("token_cached_input")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN token_cached_input INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionColumns.has("token_output")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN token_output INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionColumns.has("token_reasoning_output")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN token_reasoning_output INTEGER NOT NULL DEFAULT 0");
    }

    const missingRepoRows = this.db
      .prepare(
        "SELECT id, root_path FROM projects WHERE github_repo IS NULL OR TRIM(github_repo) = ''"
      )
      .all();
    if (missingRepoRows.length > 0) {
      const updateRepo = this.db.prepare(
        "UPDATE projects SET github_repo = ?, updated_at = ? WHERE id = ?"
      );
      for (const row of missingRepoRows) {
        const slug = detectGitHubRepoFromOrigin(row.root_path);
        if (!slug) continue;
        updateRepo.run(slug, nowIso(), row.id);
      }
    }
  }

  nextLockOwner(scope = "lock") {
    const normalizedScope = String(scope ?? "lock").trim() || "lock";
    this.lockSequence += 1;
    return `${this.lockOwnerBase}:${normalizedScope}:${this.lockSequence}`;
  }

  tryAcquireLock(params) {
    const lockKey = String(params?.lockKey ?? "").trim();
    if (!lockKey) {
      return {
        acquired: false,
        reason: "lock_key_missing",
        lockKey: "",
        owner: "",
      };
    }

    const owner = String(params?.owner ?? this.nextLockOwner(params?.scope ?? "lock")).trim();
    if (!owner) {
      return {
        acquired: false,
        reason: "owner_missing",
        lockKey,
        owner: "",
      };
    }

    const ttlRaw = Number(params?.ttlMs ?? 120_000);
    const ttlMs = Number.isFinite(ttlRaw)
      ? Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Math.floor(ttlRaw)))
      : 120_000;
    const acquiredAt = nowIso();
    const expiresAt = new Date(Date.parse(acquiredAt) + ttlMs).toISOString();
    const meta = params?.meta && typeof params.meta === "object" ? params.meta : {};

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM locks WHERE lock_key = ? AND expires_at <= ?")
        .run(lockKey, acquiredAt);
      try {
        this.db
          .prepare(
            "INSERT INTO locks (lock_key, owner, acquired_at, expires_at, meta_json) VALUES (?, ?, ?, ?, ?)"
          )
          .run(lockKey, owner, acquiredAt, expiresAt, JSON.stringify(meta));
      } catch (insertErr) {
        if (!isUniqueConstraintError(insertErr)) {
          throw insertErr;
        }
        const held = this.db
          .prepare("SELECT lock_key, owner, acquired_at, expires_at FROM locks WHERE lock_key = ? LIMIT 1")
          .get(lockKey);
        this.db.exec("COMMIT");
        return {
          acquired: false,
          reason: "locked",
          lockKey,
          owner,
          heldBy: String(held?.owner ?? ""),
          acquiredAt: String(held?.acquired_at ?? ""),
          expiresAt: String(held?.expires_at ?? ""),
        };
      }
      this.db.exec("COMMIT");
      return {
        acquired: true,
        reason: "",
        lockKey,
        owner,
        acquiredAt,
        expiresAt,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  releaseLock(params) {
    const lockKey = String(params?.lockKey ?? "").trim();
    const owner = String(params?.owner ?? "").trim();
    if (!lockKey || !owner) return false;
    const deleted = this.db
      .prepare("DELETE FROM locks WHERE lock_key = ? AND owner = ?")
      .run(lockKey, owner);
    return Number(deleted?.changes ?? 0) > 0;
  }

  getDbPath() {
    return DB_PATH;
  }

  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
  }

  getProject(projectId) {
    return this.db.prepare("SELECT * FROM projects WHERE id = ? LIMIT 1").get(projectId);
  }

  getProjectByRootPath(rootPath) {
    return this.db
      .prepare("SELECT * FROM projects WHERE root_path = ? LIMIT 1")
      .get(rootPath);
  }

  loadProjectContext(rootPath) {
    const contextPath = path.join(rootPath, ".forgeops", "context.md");
    if (!fs.existsSync(contextPath)) {
      return "";
    }
    const raw = fs.readFileSync(contextPath, "utf8");
    const text = String(raw ?? "").trim();
    if (!text) {
      return "";
    }
    const maxChars = 12000;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
  }

  loadStepScopedContextDocs(rootPath, stepKey) {
    const step = normalizeContextStepKey(stepKey);
    const projectRoot = String(rootPath ?? "").trim();
    if (!step || !projectRoot) return "";

    const indexPath = path.join(projectRoot, CONTEXT_INDEX_RELATIVE_PATH);
    if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) {
      return "";
    }

    const entries = parseContextRegistryEntries(fs.readFileSync(indexPath, "utf8"))
      .filter((entry) => entry.useForSteps.includes(step));
    if (entries.length === 0) return "";

    let budget = STEP_SCOPED_CONTEXT_MAX_TOTAL_CHARS;
    const chunks = [];
    for (const entry of entries) {
      if (budget <= 0) break;
      const absPath = path.join(projectRoot, entry.path);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        continue;
      }
      const raw = fs.readFileSync(absPath, "utf8");
      const text = clipMultilineText(raw, STEP_SCOPED_CONTEXT_PER_DOC_CHARS);
      if (!text) continue;

      const title = `### ${entry.path} (owner=${entry.owner || "-"}, priority=${entry.priority})`;
      const remainingForDoc = Math.max(0, budget - title.length - 4);
      const body = clipMultilineText(text, remainingForDoc);
      if (!body) continue;

      chunks.push(`${title}\n${body}`);
      budget -= (title.length + body.length + 2);
    }

    if (chunks.length === 0) return "";
    return `Step-scoped context docs (selected from ${CONTEXT_INDEX_RELATIVE_PATH} for step=${step}):\n\n${chunks.join("\n\n")}`;
  }

  buildStepProjectContext(context, stepKey) {
    const base = String(context?.projectContext ?? "").trim();
    const step = normalizeContextStepKey(stepKey);
    const stepContextRoot = String(
      context?.project?.rootPath
      || context?.project?.repoRootPath
      || ""
    ).trim();

    const stepScopedDocs = step && stepContextRoot
      ? this.loadStepScopedContextDocs(stepContextRoot, step)
      : "";

    const merged = [base, stepScopedDocs].filter(Boolean).join("\n\n");
    if (!merged) return "";
    return clipMultilineText(merged, STEP_PROMPT_CONTEXT_MAX_CHARS);
  }

  loadProjectGovernance(rootPath) {
    const governancePath = path.join(rootPath, ".forgeops", "governance.md");
    if (!fs.existsSync(governancePath)) {
      return "";
    }
    const raw = fs.readFileSync(governancePath, "utf8");
    const text = String(raw ?? "").trim();
    if (!text) {
      return "";
    }
    const maxChars = 8000;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
  }

  loadProjectInvariants(rootPath) {
    const invariantPath = path.join(rootPath, ".forgeops", "invariants.json");
    if (!fs.existsSync(invariantPath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(invariantPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  loadProjectSkills(params) {
    const rootPath = typeof params === "string"
      ? params
      : params?.rootPath;
    const productType = typeof params === "string"
      ? ""
      : String(params?.productType ?? "").trim();
    const techProfile = typeof params === "string"
      ? null
      : params?.techProfile ?? null;
    return resolveAgentSkills({
      projectRootPath: rootPath,
      productType: productType || undefined,
      techProfile: techProfile && typeof techProfile === "object" ? techProfile : undefined,
    }).agentSkills;
  }

  loadProjectTechProfile(rootPath) {
    return loadProjectTechProfile(rootPath);
  }

  resolveProjectSkills(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return resolveAgentSkills({
      projectRootPath: project.root_path,
      productType: project.product_type,
      techProfile: this.loadProjectTechProfile(project.root_path) ?? undefined,
    });
  }

  createProject(params) {
    const now = nowIso();
    const id = params.id ?? newId("proj");
    const githubRepo = String(params.githubRepo ?? "").trim();
    this.db.prepare(
      "INSERT INTO projects (id, name, root_path, product_type, github_repo, problem_statement, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)"
    ).run(
      id,
      params.name,
      params.rootPath,
      params.productType,
      githubRepo,
      params.problemStatement ?? "",
      now,
      now
    );
    return this.getProject(id);
  }

  setProjectGitHubRepo(projectId, githubRepo) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const nextRepo = String(githubRepo ?? "").trim();
    if (!nextRepo) return project;
    const prevRepo = String(project.github_repo ?? "").trim();
    if (nextRepo === prevRepo) return project;

    this.db.prepare(
      "UPDATE projects SET github_repo = ?, updated_at = ? WHERE id = ?"
    ).run(nextRepo, nowIso(), projectId);
    return this.getProject(projectId);
  }

  createIssue(params) {
    const project = this.getProject(params.projectId);
    if (!project) {
      throw new Error(`Project not found: ${params.projectId}`);
    }
    const issue = createProjectGitHubIssue({
      repoRootPath: project.root_path,
      projectId: project.id,
      title: params.title,
      body: params.description ?? "",
      labels: Array.isArray(params.labels) ? params.labels : [],
    });
    return issue;
  }

  createIssueWithAutoRun(params) {
    const issue = this.createIssue(params);
    const autoRunEnabled = params.autoRun !== false;
    if (!autoRunEnabled) {
      return {
        issue,
        run: null,
        auto_run_enabled: false,
        auto_run_error: "",
      };
    }

    try {
      const run = this.createRun({
        projectId: params.projectId,
        issueId: issue.id,
        task: buildAutoIssueRunTask(issue),
        runMode: parseRunModeLike(params.runMode, RUN_MODE_DEFAULT),
      });
      return {
        issue,
        run,
        auto_run_enabled: true,
        auto_run_error: "",
      };
    } catch (err) {
      const existingRun = this.getRunningRunForGitHubIssue(params.projectId, issue.id);
      if (existingRun) {
        return {
          issue,
          run: existingRun,
          auto_run_enabled: true,
          auto_run_error: "",
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        issue,
        run: null,
        auto_run_enabled: true,
        auto_run_error: message,
      };
    }
  }

  listIssues(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return listGitHubIssues({
      repoRootPath: project.root_path,
      projectId: project.id,
      state: "all",
      limit: 200,
    });
  }

  listSkillCandidates(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const candidateRoot = path.join(project.root_path, ".forgeops", "skills", "candidates");
    const files = listMarkdownFilesRecursively(candidateRoot);
    const records = [];
    for (const filePath of files) {
      try {
        records.push(buildSkillCandidateRecord(project.root_path, filePath));
      } catch {
        continue;
      }
    }
    records.sort((left, right) => {
      const la = Number(new Date(String(left.generatedAt ?? "")).getTime() || 0);
      const ra = Number(new Date(String(right.generatedAt ?? "")).getTime() || 0);
      if (la !== ra) return ra - la;
      return String(left.path ?? "").localeCompare(String(right.path ?? ""));
    });
    return records;
  }

  promoteSkillCandidate(params) {
    const projectId = String(params?.projectId ?? "").trim();
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const candidateRef = String(params?.candidate ?? params?.candidatePath ?? "").trim();
    if (!candidateRef) {
      throw new Error("candidate is required");
    }

    const candidateAbsolutePath = toAbsoluteSkillCandidatePath(project.root_path, candidateRef);
    const candidate = buildSkillCandidateRecord(project.root_path, candidateAbsolutePath);
    const skillNameInput = String(params?.skillName ?? params?.name ?? candidate.title ?? "").trim();
    const skillName = slugify(skillNameInput);
    if (!skillName) {
      throw new Error("skillName is required");
    }
    const description = clipText(
      String(params?.description ?? `Promoted from ${candidate.title}`).trim(),
      200
    ) || `Promoted from ${candidate.title}`;
    const roles = normalizeSkillPromotionRoles(params?.roles);
    const promotionId = newId("skillpromo");
    const branchSuffix = toCandidateFileTimestamp(nowIso()).toLowerCase().replace(/[^a-z0-9-]/g, "");
    const requestedBranch = String(
      params?.branchName ?? `forgeops/skill-promote/${skillName}-${branchSuffix}`
    ).trim();
    const draft = params?.draft !== false;
    const baseRef = String(params?.baseRef ?? "").trim();
    const allowUpdateExistingPr = params?.allowUpdateExistingPr === true;
    let existingPrForBranch = null;
    try {
      existingPrForBranch = findGitHubPullRequestForBranch({
        repoRootPath: project.root_path,
        branchName: requestedBranch,
      });
    } catch {
      existingPrForBranch = null;
    }
    const effectiveBaseRef = baseRef || (existingPrForBranch?.number ? `origin/${requestedBranch}` : "");

    const worktree = createRunWorktree({
      rootPath: project.root_path,
      runId: promotionId,
      branchName: requestedBranch,
      baseRef: effectiveBaseRef || undefined,
    });

    try {
      const candidateRelativePath = String(candidate.path ?? "").replace(/\\/g, "/");
      const skillRelativePath = path.join(".forgeops", "skills", skillName, "SKILL.md");
      const skillAbsolutePath = path.join(worktree.worktreePath, skillRelativePath);
      fs.mkdirSync(path.dirname(skillAbsolutePath), { recursive: true });
      fs.writeFileSync(
        skillAbsolutePath,
        buildPromotedSkillMarkdown({
          skillName,
          description,
          candidate,
          generatedAt: nowIso(),
        }),
        "utf8",
      );

      const changedFiles = [skillRelativePath.replace(/\\/g, "/")];
      if (roles.length > 0) {
        const roleMapPath = path.join(worktree.worktreePath, ".forgeops", "agent-skills.json");
        let parsed = {};
        if (fs.existsSync(roleMapPath)) {
          try {
            parsed = JSON.parse(fs.readFileSync(roleMapPath, "utf8"));
          } catch {
            parsed = {};
          }
        }
        const next = parsed && typeof parsed === "object" ? { ...parsed } : {};
        next.version = 3;
        if (!Array.isArray(next.roleLayers)) {
          next.roleLayers = ["official", "user-global", "project-local"];
        }
        if (!next.selection || typeof next.selection !== "object") {
          next.selection = { mode: "step", includeUnscoped: true };
        }
        next.selection.mode = "step";
        if (typeof next.selection.includeUnscoped !== "boolean") {
          next.selection.includeUnscoped = true;
        }

        const rolesMap = next.roles && typeof next.roles === "object" ? { ...next.roles } : {};

        const normalizeTags = (value) => {
          const list = Array.isArray(value) ? value : [];
          const out = [];
          for (const item of list) {
            const tag = String(item ?? "").trim();
            if (!tag) continue;
            if (out.includes(tag)) continue;
            out.push(tag);
          }
          return out.length > 0 ? out : null;
        };

        const normalizeWhenSteps = (value) => {
          const list = Array.isArray(value) ? value : [];
          const out = [];
          for (const item of list) {
            const step = String(item ?? "").trim();
            if (!step) continue;
            if (out.includes(step)) continue;
            out.push(step);
          }
          return out.length > 0 ? out : null;
        };

        const normalizeRoleEntries = (role, rawItems) => {
          const list = Array.isArray(rawItems) ? rawItems : [];
          const defaultSteps = Array.isArray(DEFAULT_STEP_KEYS_BY_AGENT?.[role])
            ? DEFAULT_STEP_KEYS_BY_AGENT[role]
            : [];
          const byName = new Map();

          for (const item of list) {
            if (!item) continue;

            if (typeof item === "string") {
              const name = String(item).trim();
              if (!name) continue;
              if (!byName.has(name)) {
                byName.set(name, {
                  name,
                  whenSteps: defaultSteps.length > 0 ? [...defaultSteps] : null,
                  priority: 50,
                  tags: ["legacy"],
                });
              }
              continue;
            }

            if (typeof item === "object") {
              const name = String(item?.name ?? item?.skill ?? item?.id ?? "").trim();
              if (!name) continue;
              const whenSteps = normalizeWhenSteps(item?.whenSteps ?? item?.when_steps ?? item?.steps)
                ?? (defaultSteps.length > 0 ? [...defaultSteps] : null);
              const priorityRaw = Number(item?.priority);
              const priority = Number.isFinite(priorityRaw) ? priorityRaw : null;
              const tags = normalizeTags(item?.tags) ?? null;
              if (!byName.has(name)) {
                byName.set(name, { name, whenSteps, priority, tags });
              }
              continue;
            }
          }

          return Array.from(byName.values());
        };

        for (const role of roles) {
          const current = normalizeRoleEntries(role, rolesMap[role]);
          const has = current.some((entry) => String(entry?.name ?? "").trim() === skillName);
          if (!has) {
            const defaultSteps = Array.isArray(DEFAULT_STEP_KEYS_BY_AGENT?.[role])
              ? DEFAULT_STEP_KEYS_BY_AGENT[role]
              : [];
            current.push({
              name: skillName,
              whenSteps: defaultSteps.length > 0 ? [...defaultSteps] : null,
              priority: 50,
              tags: ["promoted"],
            });
          }
          rolesMap[role] = current;
        }

        next.roles = rolesMap;
        fs.writeFileSync(roleMapPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        changedFiles.push(".forgeops/agent-skills.json");
      }

      const logPath = appendSkillPromotionLog(worktree.worktreePath, {
        projectId: project.id,
        candidate: candidateRelativePath,
        skillName,
        roles,
        branchName: worktree.worktreeBranch,
        issueId: candidate.issueId,
        runId: candidate.runId,
        promotedAt: nowIso(),
      });
      changedFiles.push(logPath.replace(/\\/g, "/"));

      const pullRequest = ensureGitHubPullRequestForRun({
        repoRootPath: project.root_path,
        worktreePath: worktree.worktreePath,
        branchName: worktree.worktreeBranch,
        baseRef: worktree.baseRef,
        runId: promotionId,
        issueRef: candidate.issueId || "",
        task: `Promote skill candidate ${candidate.title}`,
        commitMessage: `chore(skill): promote ${skillName} from candidate`,
        prTitle: `skill: promote ${skillName}`,
        prBody: buildSkillPromotionPullRequestBody({
          project,
          candidate,
          skillName,
          roles,
          files: changedFiles,
        }),
        draft,
        allowUpdateExistingPr,
      });

      if (Number(pullRequest?.number ?? 0) > 0) {
        try {
          const labelResult = updateGitHubPullRequestLabels({
            repoRootPath: project.root_path,
            prNumber: Number(pullRequest.number),
            addLabels: buildSkillPromotionPrLabels({
              scope: "project",
              auto: params?.auto === true,
            }),
          });
          this.emitEvent(null, null, "skills.promotion.pr.labels.synced", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            labels: Array.isArray(labelResult?.labels) ? labelResult.labels : [],
          });
        } catch (err) {
          this.emitEvent(null, null, "skills.promotion.pr.labels.failed", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          const prComment = createGitHubPullRequestComment({
            repoRootPath: project.root_path,
            prNumber: Number(pullRequest.number),
            body: buildSkillPromotionReviewChecklistComment({
              scope: "project",
              skillName,
              candidatePath: candidateRelativePath,
              sourceRun: candidate.runId,
              sourceIssue: candidate.issueId ? `#${String(candidate.issueId).replace(/^#/, "")}` : "-",
              sourceProject: project.id,
              targetRoles: roles,
            }),
          });
          this.emitEvent(null, null, "skills.promotion.pr.checklist.sent", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            prUrl: String(pullRequest?.url ?? ""),
            commentUrl: String(prComment?.url ?? ""),
          });
        } catch (err) {
          this.emitEvent(null, null, "skills.promotion.pr.checklist.failed", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.emitEvent(null, null, "skills.promotion.created", {
        projectId: project.id,
        candidatePath: candidateRelativePath,
        skillName,
        branchName: worktree.worktreeBranch,
        prNumber: Number(pullRequest?.number ?? 0) || 0,
        prUrl: String(pullRequest?.url ?? ""),
        draft,
        auto: params?.auto === true,
        updatedExisting: String(pullRequest?.skippedReason ?? "") === "updated_existing",
      });

      return {
        projectId: project.id,
        promotionId,
        skillName,
        description,
        roles,
        candidate: {
          path: candidateRelativePath,
          title: candidate.title,
          runId: candidate.runId,
          issueId: candidate.issueId,
        },
        branchName: worktree.worktreeBranch,
        baseRef: worktree.baseRef,
        existingPrForBranch: existingPrForBranch && existingPrForBranch.number
          ? {
              number: Number(existingPrForBranch.number),
              state: String(existingPrForBranch.state ?? ""),
              url: String(existingPrForBranch.url ?? ""),
            }
          : null,
        changedFiles,
        pullRequest,
      };
    } finally {
      cleanupRunWorktree({
        rootPath: project.root_path,
        runId: promotionId,
        worktreePath: worktree.worktreePath,
        branchName: worktree.worktreeBranch,
      });
    }
  }

  getUserGlobalSkillsStatus() {
    const rootPath = USER_GLOBAL_SKILLS_ROOT;
    fs.mkdirSync(rootPath, { recursive: true });
    const binding = readGitHubRepoBinding(rootPath);
    return {
      rootPath,
      exists: fs.existsSync(rootPath),
      git: {
        available: Boolean(binding?.available),
        repoRoot: String(binding?.repoRoot ?? ""),
        originUrl: String(binding?.originUrl ?? ""),
        slug: String(binding?.slug ?? ""),
        warning: String(binding?.warning ?? ""),
      },
      expectedPaths: {
        skillsDir: path.join(rootPath, "skills"),
        auditLog: path.join(rootPath, "audit.ndjson"),
        catalogIndex: path.join(rootPath, "catalog", "skills-index.json"),
      },
    };
  }

  initializeUserGlobalSkillsRepo(params = {}) {
    const rootPath = path.resolve(String(params?.globalRoot ?? USER_GLOBAL_SKILLS_ROOT));
    const visibility = params?.visibility === "public" ? "public" : "private";
    const githubRepo = String(params?.githubRepo ?? "").trim();
    const defaultRepoName = String(params?.repoName ?? "forgeops-user-global-skills").trim() || "forgeops-user-global-skills";
    const branchProtection = params?.branchProtection === true;

    ensureUserGlobalSkillsBootstrapFiles(rootPath);
    const git = provisionProjectGitHubRemote({
      rootPath,
      projectName: defaultRepoName,
      githubRepo: githubRepo || undefined,
      visibility,
      defaultBranch: "main",
      branchProtection,
      description: "ForgeOps user-global skill library",
      onProgress: typeof params?.onProgress === "function"
        ? (item) => params.onProgress(item)
        : undefined,
    });

    return {
      rootPath,
      visibility,
      githubRepo: git.remoteSlug,
      originUrl: git.originUrl,
      branch: git.branch,
      createdRemote: git.createdRemote === true,
      pushedInitialCommit: git.pushedInitialCommit === true,
      branchProtectionApplied: git.branchProtectionApplied === true,
      branchProtectionFallback: git.branchProtectionFallback === true,
      branchProtectionSkipped: git.branchProtectionSkipped === true,
      branchProtectionSkipReason: String(git.branchProtectionSkipReason ?? ""),
    };
  }

  promoteSkillCandidateToUserGlobal(params) {
    const projectId = String(params?.projectId ?? "").trim();
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const candidateRef = String(params?.candidate ?? params?.candidatePath ?? "").trim();
    if (!candidateRef) {
      throw new Error("candidate is required");
    }
    const candidateAbsolutePath = toAbsoluteSkillCandidatePath(project.root_path, candidateRef);
    const candidate = buildSkillCandidateRecord(project.root_path, candidateAbsolutePath);
    const skillNameInput = String(params?.skillName ?? params?.name ?? candidate.title ?? "").trim();
    const skillName = slugify(skillNameInput);
    if (!skillName) {
      throw new Error("skillName is required");
    }

    const globalRoot = path.resolve(String(params?.globalRoot ?? USER_GLOBAL_SKILLS_ROOT));
    fs.mkdirSync(globalRoot, { recursive: true });
    const description = clipText(
      String(params?.description ?? `Global skill promoted from ${candidate.title}`).trim(),
      220
    ) || `Global skill promoted from ${candidate.title}`;
    const promotionId = newId("skillglobal");
    const branchSuffix = toCandidateFileTimestamp(nowIso()).toLowerCase().replace(/[^a-z0-9-]/g, "");
    const requestedBranch = String(
      params?.branchName ?? `forgeops/skill-global/${skillName}-${branchSuffix}`
    ).trim();
    const draft = params?.draft !== false;
    const baseRef = String(params?.baseRef ?? "").trim();
    const allowUpdateExistingPr = params?.allowUpdateExistingPr === true;
    let existingPrForBranch = null;
    try {
      existingPrForBranch = findGitHubPullRequestForBranch({
        repoRootPath: globalRoot,
        branchName: requestedBranch,
      });
    } catch {
      existingPrForBranch = null;
    }
    const effectiveBaseRef = baseRef || (existingPrForBranch?.number ? `origin/${requestedBranch}` : "");

    let worktree;
    try {
      worktree = createRunWorktree({
        rootPath: globalRoot,
        runId: promotionId,
        branchName: requestedBranch,
        baseRef: effectiveBaseRef || undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("目录不是 git 仓库")) {
        throw new Error(`User-global skills repo is not initialized: ${globalRoot}`);
      }
      throw err;
    }

    try {
      const generatedAt = nowIso();
      const skillRelativePath = path.join("skills", skillName, "SKILL.md");
      const skillAbsolutePath = path.join(worktree.worktreePath, skillRelativePath);
      fs.mkdirSync(path.dirname(skillAbsolutePath), { recursive: true });
      fs.writeFileSync(
        skillAbsolutePath,
        buildGlobalPromotedSkillMarkdown({
          skillName,
          description,
          candidate,
          sourceProject: project,
          generatedAt,
        }),
        "utf8",
      );

      const changedFiles = [skillRelativePath.replace(/\\/g, "/")];
      const indexPath = updateGlobalSkillIndex(worktree.worktreePath, {
        skillName,
        description,
        updatedAt: generatedAt,
        sourceProjectId: project.id,
        sourceCandidatePath: candidate.path,
        sourceRunId: candidate.runId,
        sourceIssueId: candidate.issueId,
      });
      changedFiles.push(indexPath.replace(/\\/g, "/"));

      const auditPath = appendGlobalSkillAuditLog(worktree.worktreePath, {
        event: "promote_global_skill",
        created_at: generatedAt,
        global_root: globalRoot,
        branch: worktree.worktreeBranch,
        project_id: project.id,
        project_name: project.name,
        candidate_path: candidate.path,
        skill_name: skillName,
        source_run: candidate.runId,
        source_issue: candidate.issueId,
      });
      changedFiles.push(auditPath.replace(/\\/g, "/"));

      const pullRequest = ensureGitHubPullRequestForRun({
        repoRootPath: globalRoot,
        worktreePath: worktree.worktreePath,
        branchName: worktree.worktreeBranch,
        baseRef: worktree.baseRef,
        runId: promotionId,
        issueRef: "",
        task: `Promote global skill ${skillName}`,
        commitMessage: `chore(skill-global): promote ${skillName}`,
        prTitle: `skill-global: promote ${skillName}`,
        prBody: buildGlobalSkillPromotionPullRequestBody({
          globalRoot,
          sourceProject: project,
          candidate,
          skillName,
          files: changedFiles,
        }),
        draft,
        allowUpdateExistingPr,
      });

      if (Number(pullRequest?.number ?? 0) > 0) {
        try {
          const labelResult = updateGitHubPullRequestLabels({
            repoRootPath: globalRoot,
            prNumber: Number(pullRequest.number),
            addLabels: buildSkillPromotionPrLabels({
              scope: "user-global",
              auto: params?.auto === true,
            }),
          });
          this.emitEvent(null, null, "skills.global.pr.labels.synced", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            labels: Array.isArray(labelResult?.labels) ? labelResult.labels : [],
          });
        } catch (err) {
          this.emitEvent(null, null, "skills.global.pr.labels.failed", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          const prComment = createGitHubPullRequestComment({
            repoRootPath: globalRoot,
            prNumber: Number(pullRequest.number),
            body: buildSkillPromotionReviewChecklistComment({
              scope: "user-global",
              skillName,
              candidatePath: candidate.path,
              sourceRun: candidate.runId,
              sourceIssue: candidate.issueId ? `#${String(candidate.issueId).replace(/^#/, "")}` : "-",
              sourceProject: project.id,
              targetRoles: [],
            }),
          });
          this.emitEvent(null, null, "skills.global.pr.checklist.sent", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            prUrl: String(pullRequest?.url ?? ""),
            commentUrl: String(prComment?.url ?? ""),
          });
        } catch (err) {
          this.emitEvent(null, null, "skills.global.pr.checklist.failed", {
            projectId: project.id,
            skillName,
            prNumber: Number(pullRequest.number),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.emitEvent(null, null, "skills.global.promoted", {
        projectId: project.id,
        candidatePath: candidate.path,
        skillName,
        globalRoot,
        branchName: worktree.worktreeBranch,
        prNumber: Number(pullRequest?.number ?? 0) || 0,
        prUrl: String(pullRequest?.url ?? ""),
        auto: params?.auto === true,
        updatedExisting: String(pullRequest?.skippedReason ?? "") === "updated_existing",
      });

      return {
        globalRoot,
        promotionId,
        skillName,
        description,
        candidate: {
          path: candidate.path,
          title: candidate.title,
          runId: candidate.runId,
          issueId: candidate.issueId,
          sourceProjectId: project.id,
        },
        branchName: worktree.worktreeBranch,
        baseRef: worktree.baseRef,
        existingPrForBranch: existingPrForBranch && existingPrForBranch.number
          ? {
              number: Number(existingPrForBranch.number),
              state: String(existingPrForBranch.state ?? ""),
              url: String(existingPrForBranch.url ?? ""),
            }
          : null,
        changedFiles,
        pullRequest,
      };
    } finally {
      cleanupRunWorktree({
        rootPath: globalRoot,
        runId: promotionId,
        worktreePath: worktree.worktreePath,
        branchName: worktree.worktreeBranch,
      });
    }
  }

  autoPromoteProjectSkillCandidates(params) {
    const projectId = String(params?.projectId ?? "").trim();
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const maxPromotionsPerTick = Math.max(1, Number(params?.maxPromotionsPerTick ?? 1));
    const draft = params?.draft !== false;
    const roles = normalizeSkillPromotionRoles(params?.roles);
    const candidates = this.listSkillCandidates(projectId);
    const feedbackBySkill = this.buildProjectSkillEffectivenessMap({
      projectId,
      candidates,
    });
    const evaluation = evaluateSkillCandidatesForAutoPromotion(
      candidates,
      {
        minCandidateOccurrences: params?.minCandidateOccurrences,
        lookbackDays: params?.lookbackDays,
        minScore: params?.minScore,
        feedbackBySkill,
      }
    );

    const promoted = [];
    const skipped = [];
    const failed = [];
    for (const item of evaluation.eligible) {
      if (promoted.length >= maxPromotionsPerTick) {
        skipped.push({
          skillName: item.skillName,
          candidatePath: item.candidatePath,
          reason: "tick_limit_reached",
        });
        continue;
      }
      try {
        const result = this.promoteSkillCandidate({
          projectId,
          candidate: item.candidatePath,
          skillName: item.skillName,
          description: item.description,
          roles,
          draft,
          auto: true,
          branchName: `forgeops/skill-auto/project/${item.skillName}`,
          allowUpdateExistingPr: true,
        });
        const skippedReason = String(result?.pullRequest?.skippedReason ?? "");
        if (skippedReason === "existing_open_no_new_commit") {
          skipped.push({
            skillName: item.skillName,
            candidatePath: item.candidatePath,
            reason: "existing_open_no_new_commit",
            prNumber: Number(result?.pullRequest?.number ?? 0) || 0,
            prUrl: String(result?.pullRequest?.url ?? ""),
          });
          continue;
        }
        promoted.push({
          skillName: item.skillName,
          candidatePath: item.candidatePath,
          score: item.score,
          occurrenceCount: item.occurrenceCount,
          prNumber: Number(result?.pullRequest?.number ?? 0) || 0,
          prUrl: String(result?.pullRequest?.url ?? ""),
          updatedExisting: skippedReason === "updated_existing",
        });
      } catch (err) {
        failed.push({
          skillName: item.skillName,
          candidatePath: item.candidatePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.emitEvent(null, null, "skills.auto.project.summary", {
      projectId,
      totalCandidates: evaluation.totalCandidates,
      groupedSkills: evaluation.groupedSkills,
      eligibleCount: evaluation.eligible.length,
      rejectedCount: evaluation.rejected.length,
      promotedCount: promoted.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      feedbackSkills: Object.keys(feedbackBySkill).length,
      policy: evaluation.policy,
    });

    return {
      projectId,
      totalCandidates: evaluation.totalCandidates,
      groupedSkills: evaluation.groupedSkills,
      eligibleCount: evaluation.eligible.length,
      rejected: evaluation.rejected,
      promoted,
      skipped,
      failed,
      feedbackBySkill,
      policy: evaluation.policy,
    };
  }

  autoPromoteGlobalSkillCandidates(params) {
    const projectId = String(params?.projectId ?? "").trim();
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const maxPromotionsPerTick = Math.max(1, Number(params?.maxPromotionsPerTick ?? 1));
    const requireProjectSkill = params?.requireProjectSkill !== false;
    const draft = params?.draft !== false;
    const candidates = this.listSkillCandidates(projectId);
    const feedbackBySkill = this.buildProjectSkillEffectivenessMap({
      projectId,
      candidates,
    });
    const evaluation = evaluateSkillCandidatesForAutoPromotion(
      candidates,
      {
        minCandidateOccurrences: params?.minCandidateOccurrences,
        lookbackDays: params?.lookbackDays,
        minScore: params?.minScore,
        feedbackBySkill,
      }
    );

    const promoted = [];
    const skipped = [];
    const failed = [];

    for (const item of evaluation.eligible) {
      if (promoted.length >= maxPromotionsPerTick) {
        skipped.push({
          skillName: item.skillName,
          candidatePath: item.candidatePath,
          reason: "tick_limit_reached",
        });
        continue;
      }

      if (requireProjectSkill) {
        const localSkillPath = path.join(project.root_path, ".forgeops", "skills", item.skillName, "SKILL.md");
        if (!fs.existsSync(localSkillPath)) {
          skipped.push({
            skillName: item.skillName,
            candidatePath: item.candidatePath,
            reason: "project_skill_missing",
          });
          continue;
        }
      }

      try {
        const result = this.promoteSkillCandidateToUserGlobal({
          projectId,
          candidate: item.candidatePath,
          skillName: item.skillName,
          description: `Global auto promoted from ${item.occurrenceCount} candidates (score=${item.score})`,
          draft,
          auto: true,
          branchName: `forgeops/skill-auto/global/${item.skillName}`,
          allowUpdateExistingPr: true,
        });
        const skippedReason = String(result?.pullRequest?.skippedReason ?? "");
        if (skippedReason === "existing_open_no_new_commit") {
          skipped.push({
            skillName: item.skillName,
            candidatePath: item.candidatePath,
            reason: "existing_open_no_new_commit",
            prNumber: Number(result?.pullRequest?.number ?? 0) || 0,
            prUrl: String(result?.pullRequest?.url ?? ""),
          });
          continue;
        }
        promoted.push({
          skillName: item.skillName,
          candidatePath: item.candidatePath,
          score: item.score,
          occurrenceCount: item.occurrenceCount,
          prNumber: Number(result?.pullRequest?.number ?? 0) || 0,
          prUrl: String(result?.pullRequest?.url ?? ""),
          updatedExisting: skippedReason === "updated_existing",
        });
      } catch (err) {
        failed.push({
          skillName: item.skillName,
          candidatePath: item.candidatePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.emitEvent(null, null, "skills.auto.global.summary", {
      projectId,
      totalCandidates: evaluation.totalCandidates,
      groupedSkills: evaluation.groupedSkills,
      eligibleCount: evaluation.eligible.length,
      rejectedCount: evaluation.rejected.length,
      promotedCount: promoted.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      requireProjectSkill,
      feedbackSkills: Object.keys(feedbackBySkill).length,
      policy: evaluation.policy,
    });

    return {
      projectId,
      totalCandidates: evaluation.totalCandidates,
      groupedSkills: evaluation.groupedSkills,
      eligibleCount: evaluation.eligible.length,
      rejected: evaluation.rejected,
      promoted,
      skipped,
      failed,
      requireProjectSkill,
      feedbackBySkill,
      policy: evaluation.policy,
    };
  }

  hasRunForGitHubIssue(projectId, issueRef) {
    const issueId = String(issueRef ?? "").trim();
    if (!issueId) return false;
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runs WHERE project_id = ? AND github_issue_id = ?")
      .get(projectId, issueId);
    return Number(row?.count ?? 0) > 0;
  }

  getRunningRunForGitHubIssue(projectId, issueRef) {
    const issueId = String(issueRef ?? "").trim();
    if (!issueId) return null;
    return this.db
      .prepare(
        `SELECT *
         FROM runs
         WHERE project_id = ?
           AND github_issue_id = ?
           AND status = 'running'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(projectId, issueId);
  }

  syncGitHubIssueAutomationStamp(params) {
    const issueId = String(params?.issueId ?? "").trim();
    if (!issueId) return;

    const state = String(params?.state ?? "").trim().toLowerCase();
    const project = params?.project ?? this.getProject(params?.projectId);
    if (!project) return;

    let addLabels = [];
    let removeLabels = [];
    if (state === "queued") {
      addLabels = [ISSUE_AUTOMATION_LABELS.QUEUED];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.READY,
        ISSUE_AUTOMATION_LABELS.RUNNING,
        ISSUE_AUTOMATION_LABELS.DONE,
        ISSUE_AUTOMATION_LABELS.FAILED,
        ISSUE_AUTOMATION_LABELS.PAUSED_LEGACY,
      ];
    } else if (state === "running") {
      addLabels = [ISSUE_AUTOMATION_LABELS.RUNNING];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.READY,
        ISSUE_AUTOMATION_LABELS.QUEUED,
        ISSUE_AUTOMATION_LABELS.DONE,
        ISSUE_AUTOMATION_LABELS.FAILED,
        ISSUE_AUTOMATION_LABELS.PAUSED_LEGACY,
      ];
    } else if (state === "paused") {
      addLabels = [ISSUE_AUTOMATION_LABELS.QUEUED];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.READY,
        ISSUE_AUTOMATION_LABELS.RUNNING,
        ISSUE_AUTOMATION_LABELS.DONE,
        ISSUE_AUTOMATION_LABELS.FAILED,
        ISSUE_AUTOMATION_LABELS.PAUSED_LEGACY,
      ];
    } else if (state === "completed") {
      addLabels = [ISSUE_AUTOMATION_LABELS.DONE];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.QUEUED,
        ISSUE_AUTOMATION_LABELS.RUNNING,
        ISSUE_AUTOMATION_LABELS.FAILED,
        ISSUE_AUTOMATION_LABELS.PAUSED_LEGACY,
      ];
    } else if (state === "failed") {
      addLabels = [ISSUE_AUTOMATION_LABELS.FAILED];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.QUEUED,
        ISSUE_AUTOMATION_LABELS.RUNNING,
        ISSUE_AUTOMATION_LABELS.DONE,
        ISSUE_AUTOMATION_LABELS.PAUSED_LEGACY,
      ];
    } else {
      return;
    }

    try {
      const updated = updateGitHubIssueLabels({
        repoRootPath: project.root_path,
        projectId: project.id,
        issueRef: issueId,
        addLabels,
        removeLabels,
      });
      this.emitEvent(params?.runId ?? null, null, "github.issue.labels.synced", {
        projectId: project.id,
        issueId,
        state,
        labels: Array.isArray(updated?.labels) ? updated.labels : [],
      });
    } catch (err) {
      this.emitEvent(params?.runId ?? null, null, "github.issue.labels.sync_failed", {
        projectId: project.id,
        issueId,
        state,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  findRunPullRequest(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    if (!run?.worktree_branch) return null;

    const project = params?.project ?? this.getProject(run.project_id);
    if (!project) return null;

    try {
      return findGitHubPullRequestForBranch({
        repoRootPath: project.root_path,
        branchName: run.worktree_branch,
      });
    } catch (err) {
      this.emitEvent(run.id, params?.step?.id ?? null, "github.pr.lookup.failed", {
        runId: run.id,
        branch: run.worktree_branch,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  ensureRunPullRequest(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    if (!run?.worktree_branch || !run?.worktree_path) return null;

    const step = params?.step ?? null;
    const project = params?.project ?? this.getProject(run.project_id);
    if (!project) return null;

    try {
      let ensured = params?.pr ?? this.findRunPullRequest({ run, project, step });
      if (!ensured?.number) {
        ensured = ensureGitHubPullRequestForRun({
          repoRootPath: project.root_path,
          worktreePath: run.worktree_path,
          branchName: run.worktree_branch,
          baseRef: run.base_ref,
          issueRef: run.github_issue_id,
          runId: run.id,
          task: run.task,
          draft: false,
        });
      }

      if (!ensured?.number) {
        this.emitEvent(run.id, step?.id ?? null, "github.pr.ensure.skipped", {
          runId: run.id,
          branch: run.worktree_branch,
          reason: String(ensured?.skippedReason ?? "unknown"),
          reasonCategory: String(ensured?.skippedReasonCategory ?? ""),
          detail: String(ensured?.skippedDetail ?? ""),
          diagnostics: ensured?.skippedDiagnostics ?? null,
          baseRef: String(ensured?.baseRefName ?? run.base_ref ?? ""),
          headRef: String(ensured?.headRefName ?? run.worktree_branch ?? ""),
          prCreateAttempts: Number(ensured?.prCreateAttempts ?? 0),
          commitCreated: Boolean(ensured?.commitCreated),
          pushed: Boolean(ensured?.pushed),
        });
        return null;
      }

      const currentRun = this.getRun(run.id);
      const contextSource = params?.context && typeof params.context === "object"
        ? params.context
        : safeJsonParse(currentRun?.context_json ?? run.context_json, {});
      const context = contextSource && typeof contextSource === "object" ? contextSource : {};
      context.pullRequest = {
        number: Number(ensured.number),
        url: String(ensured.url ?? ""),
        title: String(ensured.title ?? ""),
        headRefName: String(ensured.headRefName ?? run.worktree_branch),
        baseRefName: String(ensured.baseRefName ?? run.base_ref ?? ""),
        branch: String(run.worktree_branch),
        baseRef: String(run.base_ref ?? ""),
        syncedAt: nowIso(),
      };

      if (!(params?.context && typeof params.context === "object")) {
        this.db
          .prepare("UPDATE runs SET context_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(context), nowIso(), run.id);
      }

      this.emitEvent(run.id, step?.id ?? null, "github.pr.ready", {
        runId: run.id,
        branch: run.worktree_branch,
        prNumber: Number(ensured.number),
        prUrl: String(ensured.url ?? ""),
        created: Boolean(ensured.created),
        existing: Boolean(ensured.existing),
      });

      if (run.github_issue_id) {
        this.syncGitHubRunProgressComments({
          phase: "pr_linked",
          run: {
            ...run,
            context_json: JSON.stringify(context),
          },
          project,
          step,
          pr: ensured,
          source: ensured.created ? "created" : "existing",
        });
      }

      return ensured;
    } catch (err) {
      this.emitEvent(run.id, step?.id ?? null, "github.pr.ensure.failed", {
        runId: run.id,
        branch: run.worktree_branch,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  runAutoMergeFinalGate(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    if (!run) {
      return {
        ok: false,
        checks: [],
        failedCheck: {
          key: "run",
          reason: "run_not_found",
          detail: "run not found",
        },
      };
    }
    const project = params?.project ?? this.getProject(run.project_id);
    if (!project) {
      return {
        ok: false,
        checks: [],
        failedCheck: {
          key: "project",
          reason: "project_not_found",
          detail: "project not found",
        },
      };
    }

    const cwd = String(run.worktree_path ?? project.root_path ?? "").trim();
    if (!cwd || !fs.existsSync(cwd)) {
      return {
        ok: false,
        checks: [],
        failedCheck: {
          key: "workspace",
          reason: "worktree_missing",
          detail: `worktree path not found: ${cwd || "-"}`,
        },
      };
    }

    const checks = [
      {
        key: "invariants",
        command: "node",
        args: [path.join(cwd, ".forgeops", "tools", "check-invariants.mjs"), "--format", "json"],
      },
      {
        key: "docs.freshness",
        command: "node",
        args: [path.join(cwd, "scripts", "check-doc-freshness.js")],
      },
      {
        key: "docs.structure",
        command: "node",
        args: [path.join(cwd, "scripts", "check-doc-structure.js")],
      },
    ];

    const results = [];
    for (const check of checks) {
      const entryPath = String(check.args?.[0] ?? "");
      if (!entryPath || !fs.existsSync(entryPath)) {
        results.push({
          key: check.key,
          status: "skipped",
          reason: "script_not_found",
          detail: entryPath,
        });
        continue;
      }

      const output = spawnSync(check.command, check.args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = String(output.stdout ?? "").trim();
      const stderr = String(output.stderr ?? "").trim();
      if (output.status !== 0) {
        const detail = stdout || stderr || `${check.key} failed`;
        const failedCheck = {
          key: check.key,
          status: "failed",
          reason: "check_failed",
          detail,
        };
        results.push(failedCheck);
        return {
          ok: false,
          checks: results,
          failedCheck,
        };
      }

      results.push({
        key: check.key,
        status: "passed",
        reason: "",
        detail: stdout || "ok",
      });
    }

    return {
      ok: true,
      checks: results,
      failedCheck: null,
    };
  }

  finalizeMergedPullRequest(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    const project = params?.project ?? this.getProject(run?.project_id);
    const stepId = params?.stepId ?? null;
    const controls = params?.controls ?? getWorkflowControlsFromContext(
      safeJsonParse(run?.context_json ?? "{}", {})
    );
    const pr = params?.pr ?? null;
    const mergeMethod = String(params?.method ?? "squash");
    const alreadyMerged = Boolean(params?.alreadyMerged);

    if (!run?.id || !project || !pr?.number) {
      return {
        ok: false,
        reason: "invalid_finalize_context",
      };
    }

    this.emitEvent(run.id, stepId, "github.pr.automerge.completed", {
      runId: run.id,
      branch: run.worktree_branch,
      prNumber: Number(pr.number),
      prUrl: String(pr.url ?? ""),
      method: mergeMethod,
      alreadyMerged,
      mergedAt: String(pr.mergedAt ?? ""),
    });

    if (!controls.autoCloseIssueOnMerge) {
      this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
        runId: run.id,
        issueId: String(run.github_issue_id ?? ""),
        prNumber: Number(pr.number),
        prUrl: String(pr.url ?? ""),
        reason: "disabled_by_workflow_config",
      });
      return { ok: true };
    }

    const issueId = String(run.github_issue_id ?? "").trim();
    if (!issueId) {
      this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
        runId: run.id,
        issueId: "",
        prNumber: Number(pr.number),
        prUrl: String(pr.url ?? ""),
        reason: "no_issue_bound",
      });
      return { ok: true };
    }

    try {
      const closed = closeGitHubIssue({
        repoRootPath: project.root_path,
        projectId: project.id,
        issueRef: issueId,
      });
      if (closed.closed) {
        this.emitEvent(run.id, stepId, "github.issue.autoclose.completed", {
          runId: run.id,
          issueId,
          issueNumber: Number(closed.issueNumber ?? 0),
          issueUrl: String(closed.issue?.github_url ?? ""),
          alreadyClosed: Boolean(closed.alreadyClosed),
          prNumber: Number(pr.number),
          prUrl: String(pr.url ?? ""),
        });
      } else {
        this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
          runId: run.id,
          issueId,
          issueNumber: Number(closed.issueNumber ?? 0),
          issueUrl: String(closed.issue?.github_url ?? ""),
          reason: "issue_state_not_closed_after_update",
          prNumber: Number(pr.number),
          prUrl: String(pr.url ?? ""),
        });
      }
    } catch (issueErr) {
      this.emitEvent(run.id, stepId, "github.issue.autoclose.failed", {
        runId: run.id,
        issueId,
        prNumber: Number(pr.number),
        prUrl: String(pr.url ?? ""),
        error: formatErrorMessage(issueErr),
      });
    }

    return { ok: true };
  }

  tryAutoMergeRunAfterCompletion(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    if (!run?.id || !String(run.github_issue_id ?? "").trim()) {
      return {
        status: "skipped",
        reason: "no_issue_bound",
      };
    }
    const stepId = params?.stepId ?? null;
    const project = params?.project ?? this.getProject(run.project_id);
    if (!project) {
      return {
        status: "failed",
        reason: "project_not_found",
      };
    }
    const context = params?.context && typeof params.context === "object"
      ? params.context
      : safeJsonParse(run.context_json, {});
    const controls = getWorkflowControlsFromContext(context);
    if (!controls.autoMerge) {
      this.emitEvent(run.id, stepId, "github.pr.automerge.skipped", {
        runId: run.id,
        branch: run.worktree_branch,
        reason: "disabled_by_workflow_config",
      });
      return {
        status: "skipped",
        reason: "disabled_by_workflow_config",
      };
    }

    const mergeLockKey = `project:${project.id}:merge-queue`;
    const mergeLockOwner = this.nextLockOwner(`project-merge:${project.id}`);
    const mergeLock = this.tryAcquireLock({
      lockKey: mergeLockKey,
      owner: mergeLockOwner,
      ttlMs: PROJECT_MERGE_QUEUE_LOCK_TTL_MS,
      scope: "project_merge_queue",
      meta: {
        projectId: project.id,
        runId: run.id,
        stepId,
      },
    });
    if (!mergeLock.acquired) {
      this.emitEvent(run.id, stepId, "github.pr.automerge.deferred", {
        runId: run.id,
        branch: run.worktree_branch,
        reason: "merge_queue_busy",
        lockKey: mergeLockKey,
      });
      return {
        status: "deferred",
        reason: "merge_queue_busy",
      };
    }

    try {
      let pr = params?.pr?.number
        ? params.pr
        : this.findRunPullRequest({ run, project });
      if (!pr?.number) {
        this.emitEvent(run.id, stepId, "github.pr.automerge.skipped", {
          runId: run.id,
          branch: run.worktree_branch,
          reason: "no_pr_for_branch",
        });
        return {
          status: "skipped",
          reason: "no_pr_for_branch",
        };
      }
      if (Boolean(pr.isDraft)) {
        try {
          const ready = markGitHubPullRequestReadyForReview({
            repoRootPath: project.root_path,
            prNumber: Number(pr.number),
          });
          pr = ready?.pr ?? pr;
          this.emitEvent(run.id, stepId, "github.pr.ready_for_review.completed", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            changed: Boolean(ready?.changed),
            alreadyReady: Boolean(ready?.alreadyReady),
          });
        } catch (draftErr) {
          this.emitEvent(run.id, stepId, "github.pr.ready_for_review.failed", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            error: draftErr instanceof Error ? draftErr.message : String(draftErr),
          });
        }

        if (Boolean(pr.isDraft)) {
          this.emitEvent(run.id, stepId, "github.pr.automerge.skipped", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            reason: "pr_is_draft",
          });
          return {
            status: "skipped",
            reason: "pr_is_draft",
            pr,
          };
        }
      }

      if (controls.mergeMethod === "merge") {
        const baseBranch = normalizeBaseBranchLike(pr.baseRefName ?? run.base_ref) || "main";
        try {
          const protection = getGitHubBranchProtection({
            repoRootPath: project.root_path,
            branchName: baseBranch,
          });
          if (!protection.available) {
            this.emitEvent(run.id, stepId, "github.pr.automerge.warning", {
              runId: run.id,
              branch: run.worktree_branch,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              reason: "branch_protection_query_failed",
              mergeMethod: controls.mergeMethod,
              baseBranch,
              error: String(protection.error ?? ""),
            });
          } else if (protection.protected && protection.requiredLinearHistory) {
            this.emitEvent(run.id, stepId, "github.pr.automerge.warning", {
              runId: run.id,
              branch: run.worktree_branch,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              reason: "merge_method_conflicts_linear_history",
              mergeMethod: controls.mergeMethod,
              baseBranch,
              requiredLinearHistory: true,
            });
            this.emitEvent(run.id, stepId, "github.pr.automerge.skipped", {
              runId: run.id,
              branch: run.worktree_branch,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              reason: "merge_method_conflicts_linear_history",
              mergeMethod: controls.mergeMethod,
              baseBranch,
            });
            return {
              status: "skipped",
              reason: "merge_method_conflicts_linear_history",
              pr,
            };
          }
        } catch (err) {
          this.emitEvent(run.id, stepId, "github.pr.automerge.warning", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            reason: "branch_protection_query_error",
            mergeMethod: controls.mergeMethod,
            baseBranch,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const gate = this.runAutoMergeFinalGate({
        run,
        project,
      });
      for (const check of gate.checks) {
        const eventType = check.status === "failed"
          ? "github.pr.automerge.gate.failed"
          : check.status === "passed"
            ? "github.pr.automerge.gate.passed"
            : "github.pr.automerge.gate.skipped";
        this.emitEvent(run.id, stepId, eventType, {
          runId: run.id,
          prNumber: Number(pr.number),
          prUrl: String(pr.url ?? ""),
          key: check.key,
          reason: check.reason,
          detail: check.detail,
        });
      }
      if (!gate.ok) {
        this.emitEvent(run.id, stepId, "github.pr.automerge.skipped", {
          runId: run.id,
          branch: run.worktree_branch,
          prNumber: Number(pr.number),
          prUrl: String(pr.url ?? ""),
          reason: "final_gate_failed",
          failedCheck: gate.failedCheck?.key ?? "",
        });
        return {
          status: "skipped",
          reason: "final_gate_failed",
          pr,
        };
      }

      const tryMergeOnce = () => {
        const merged = mergeGitHubPullRequest({
          repoRootPath: project.root_path,
          prNumber: Number(pr.number),
          method: controls.mergeMethod,
          deleteBranch: true,
        });
        if (!merged.merged) {
          this.emitEvent(run.id, stepId, "github.pr.automerge.skipped", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            reason: "merge_not_completed",
            state: String(merged.pr?.state ?? ""),
            mergeStateStatus: String(merged.pr?.mergeStateStatus ?? ""),
          });
          return {
            status: "skipped",
            reason: "merge_not_completed",
            pr: merged.pr ?? pr,
          };
        }

        const mergedPr = merged.pr ?? pr;
        this.finalizeMergedPullRequest({
          run,
          project,
          stepId,
          controls,
          pr: mergedPr,
          method: String(merged.method ?? controls.mergeMethod ?? "squash"),
          alreadyMerged: Boolean(merged.alreadyMerged),
        });
        return {
          status: "completed",
          pr: mergedPr,
        };
      };

      try {
        return tryMergeOnce();
      } catch (err) {
        if (!isLikelyMergeConflictError(err)) {
          this.emitEvent(run.id, stepId, "github.pr.automerge.failed", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            error: formatErrorMessage(err),
          });
          return {
            status: "failed",
            reason: formatErrorMessage(err),
            pr,
          };
        }

        const maxConflictAttempts = normalizeAutoMergeConflictMaxAttempts(
          controls.autoMergeConflictMaxAttempts,
          DEFAULT_AUTO_MERGE_CONFLICT_MAX_ATTEMPTS,
        );
        if (maxConflictAttempts <= 0) {
          const disabledReason = "merge_conflict_auto_fix_disabled";
          this.emitEvent(run.id, stepId, "github.pr.automerge.failed", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            error: disabledReason,
          });
          this.emitEvent(run.id, stepId, "run.merge.blocked_manual", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            reason: disabledReason,
          });
          return {
            status: "failed",
            reason: disabledReason,
            pr,
          };
        }

        for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
          this.emitEvent(run.id, stepId, "github.pr.automerge.conflict.retry_started", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            attempt,
            maxAttempts: maxConflictAttempts,
            error: formatErrorMessage(err),
          });

          const resolved = autoResolvePullRequestMergeConflict({
            repoRootPath: project.root_path,
            worktreePath: run.worktree_path,
            branchName: run.worktree_branch,
            baseRef: run.base_ref,
            runId: run.id,
            prNumber: Number(pr.number),
          });
          if (!resolved.resolved) {
            this.emitEvent(run.id, stepId, "github.pr.automerge.conflict.retry_failed", {
              runId: run.id,
              branch: run.worktree_branch,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              attempt,
              maxAttempts: maxConflictAttempts,
              reason: String(resolved.reason ?? "unknown"),
              detail: String(resolved.detail ?? ""),
              conflictFiles: Array.isArray(resolved.conflictFiles) ? resolved.conflictFiles : [],
            });
            if (resolved.reason === "codex_not_found") {
              break;
            }
            continue;
          }

          this.emitEvent(run.id, stepId, "github.pr.automerge.conflict.retry_resolved", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            attempt,
            maxAttempts: maxConflictAttempts,
            headSha: String(resolved.headSha ?? ""),
          });

          try {
            return tryMergeOnce();
          } catch (retryErr) {
            this.emitEvent(run.id, stepId, "github.pr.automerge.conflict.retry_merge_failed", {
              runId: run.id,
              branch: run.worktree_branch,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              attempt,
              maxAttempts: maxConflictAttempts,
              error: formatErrorMessage(retryErr),
            });
            if (!isLikelyMergeConflictError(retryErr)) {
              return {
                status: "failed",
                reason: formatErrorMessage(retryErr),
                pr,
              };
            }
          }
        }

        const exhaustedReason = `merge_conflict_unresolved_after_${maxConflictAttempts}_attempts`;
        this.emitEvent(run.id, stepId, "github.pr.automerge.failed", {
          runId: run.id,
          branch: run.worktree_branch,
          prNumber: Number(pr.number),
          prUrl: String(pr.url ?? ""),
          error: exhaustedReason,
        });
        this.emitEvent(run.id, stepId, "run.merge.blocked_manual", {
          runId: run.id,
          branch: run.worktree_branch,
          prNumber: Number(pr.number),
          prUrl: String(pr.url ?? ""),
          reason: exhaustedReason,
        });
        return {
          status: "failed",
          reason: exhaustedReason,
          pr,
        };
      }
    } finally {
      this.releaseLock({
        lockKey: mergeLockKey,
        owner: mergeLockOwner,
      });
    }
  }

  syncRunMainlineAfterPrMerge(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    if (!run?.id || !run?.worktree_branch) return null;
    if (!String(run.github_issue_id ?? "").trim()) return null;
    const stepId = params?.stepId ?? null;
    const emitDeferred = params?.emitDeferred === true;
    const emitSkipped = params?.emitSkipped === true;
    const emitFailure = params?.emitFailure === true;
    const project = params?.project ?? this.getProject(run.project_id);
    if (!project) return null;
    const finalizeLockKey = `run:${run.id}:finalize`;
    const finalizeLockOwner = this.nextLockOwner(`run-finalize:${run.id}`);
    const finalizeLock = this.tryAcquireLock({
      lockKey: finalizeLockKey,
      owner: finalizeLockOwner,
      ttlMs: RUN_FINALIZE_LOCK_TTL_MS,
      scope: "run_finalize",
      meta: {
        projectId: project.id,
        runId: run.id,
        stepId,
      },
    });
    if (!finalizeLock.acquired) {
      if (emitDeferred) {
        this.emitEvent(run.id, stepId, "github.mainline.sync.deferred", {
          runId: run.id,
          branch: run.worktree_branch,
          reason: "finalize_locked",
          lockKey: finalizeLockKey,
        });
      }
      return {
        status: "deferred",
        reason: "finalize_locked",
      };
    }

    try {
      const context = params?.context && typeof params.context === "object"
        ? params.context
        : safeJsonParse(run.context_json, {});
      const controls = getWorkflowControlsFromContext(context);
      const mainlineSynced = this.hasRunEvent(run.id, "github.mainline.sync.completed");
      const worktreeArchived = this.hasRunEvent(run.id, "github.worktree.archive.completed");
      const issueAutoClosed = this.hasRunEvent(run.id, "github.issue.autoclose.completed");
      if (mainlineSynced && worktreeArchived && (issueAutoClosed || !controls.autoCloseIssueOnMerge)) {
        return {
          status: "already_completed",
        };
      }

      const pr = params?.pr ?? this.findRunPullRequest({
        run,
        project,
      });
      if (!pr?.number) {
        if (emitDeferred) {
          this.emitEvent(run.id, stepId, "github.mainline.sync.deferred", {
            runId: run.id,
            branch: run.worktree_branch,
            reason: "no_pr_for_branch",
          });
        }
        return {
          status: "deferred",
          reason: "no_pr_for_branch",
        };
      }

      const prState = String(pr.state ?? "").trim().toUpperCase();
      const mergedAt = String(pr.mergedAt ?? "").trim();
      const merged = Boolean(mergedAt) || prState === "MERGED";
      if (!merged) {
        if (emitDeferred) {
          this.emitEvent(run.id, stepId, "github.mainline.sync.deferred", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            prState: prState || "UNKNOWN",
            reason: "pr_not_merged",
          });
        }
        return {
          status: "deferred",
          reason: "pr_not_merged",
        };
      }

      let mainlineStatus = mainlineSynced ? "already_synced" : "pending";
      let mainlineChanged = false;
      try {
        if (!mainlineSynced) {
          const synced = syncDefaultBranchFromRemote({
            rootPath: project.root_path,
            baseRef: run.base_ref,
            autoStashDirty: true,
          });
          if (!synced.synced) {
            if (emitSkipped) {
              this.emitEvent(run.id, stepId, "github.mainline.sync.skipped", {
                runId: run.id,
                branch: run.worktree_branch,
                prNumber: Number(pr.number),
                prUrl: String(pr.url ?? ""),
                mergedAt: mergedAt || null,
                baseRef: synced.baseRef || String(run.base_ref ?? ""),
                baseBranch: synced.baseBranch || "",
                reason: String(synced.skippedReason ?? "unknown"),
                stashedWorkspace: Boolean(synced.stashedWorkspace),
                stashRestored: Boolean(synced.stashRestored),
              });
            }
            mainlineStatus = "skipped";
          } else {
            mainlineChanged = Boolean(synced.changed);
            this.emitEvent(run.id, stepId, "github.mainline.sync.completed", {
              runId: run.id,
              branch: run.worktree_branch,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              mergedAt: mergedAt || null,
              baseRef: synced.baseRef || String(run.base_ref ?? ""),
              baseBranch: synced.baseBranch || "",
              changed: Boolean(synced.changed),
              stashedWorkspace: Boolean(synced.stashedWorkspace),
              stashRestored: Boolean(synced.stashRestored),
            });
            mainlineStatus = "completed";
          }
        }
      } catch (err) {
        if (emitFailure) {
          this.emitEvent(run.id, stepId, "github.mainline.sync.failed", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            mergedAt: mergedAt || null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        mainlineStatus = "failed";
      }

      let archiveStatus = worktreeArchived ? "already_archived" : "pending";
      try {
        if (!worktreeArchived) {
          const archived = cleanupRunWorktree({
            rootPath: project.root_path,
            runId: run.id,
            worktreePath: run.worktree_path,
            branchName: run.worktree_branch,
          });
          if (!archived.cleaned) {
            if (emitSkipped) {
              this.emitEvent(run.id, stepId, "github.worktree.archive.skipped", {
                runId: run.id,
                branch: run.worktree_branch,
                prNumber: Number(pr.number),
                prUrl: String(pr.url ?? ""),
                mergedAt: mergedAt || null,
                worktreePath: archived.worktreePath || String(run.worktree_path ?? ""),
                reason: String(archived.skippedReason ?? "unknown"),
              });
            }
            archiveStatus = "skipped";
          } else {
            this.emitEvent(run.id, stepId, "github.worktree.archive.completed", {
              runId: run.id,
              branch: run.worktree_branch,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              mergedAt: mergedAt || null,
              worktreePath: archived.worktreePath || String(run.worktree_path ?? ""),
              localBranchDeleted: Boolean(archived.localBranchDeleted),
            });
            archiveStatus = "completed";
          }
        }
      } catch (err) {
        if (emitFailure) {
          this.emitEvent(run.id, stepId, "github.worktree.archive.failed", {
            runId: run.id,
            branch: run.worktree_branch,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            mergedAt: mergedAt || null,
            worktreePath: String(run.worktree_path ?? ""),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        archiveStatus = "failed";
      }

      let issueCloseStatus = issueAutoClosed ? "already_closed" : "pending";
      const issueId = String(run.github_issue_id ?? "").trim();
      if (!issueId) {
        issueCloseStatus = "skipped";
      } else if (!controls.autoCloseIssueOnMerge) {
        issueCloseStatus = "skipped";
        if (emitSkipped && !this.hasRunEvent(run.id, "github.issue.autoclose.skipped")) {
          this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
            runId: run.id,
            issueId,
            prNumber: Number(pr.number),
            prUrl: String(pr.url ?? ""),
            reason: "disabled_by_workflow_config",
          });
        }
      } else if (!issueAutoClosed) {
        try {
          const closed = closeGitHubIssue({
            repoRootPath: project.root_path,
            projectId: project.id,
            issueRef: issueId,
          });
          if (closed.closed) {
            this.emitEvent(run.id, stepId, "github.issue.autoclose.completed", {
              runId: run.id,
              issueId,
              issueNumber: Number(closed.issueNumber ?? 0),
              issueUrl: String(closed.issue?.github_url ?? ""),
              alreadyClosed: Boolean(closed.alreadyClosed),
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
            });
            issueCloseStatus = "completed";
          } else {
            this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
              runId: run.id,
              issueId,
              issueNumber: Number(closed.issueNumber ?? 0),
              issueUrl: String(closed.issue?.github_url ?? ""),
              reason: "issue_state_not_closed_after_update",
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
            });
            issueCloseStatus = "skipped";
          }
        } catch (issueErr) {
          if (emitFailure) {
            this.emitEvent(run.id, stepId, "github.issue.autoclose.failed", {
              runId: run.id,
              issueId,
              prNumber: Number(pr.number),
              prUrl: String(pr.url ?? ""),
              error: issueErr instanceof Error ? issueErr.message : String(issueErr),
            });
          }
          issueCloseStatus = "failed";
        }
      }

      const completed = (mainlineStatus === "completed" || mainlineStatus === "already_synced")
        && (archiveStatus === "completed" || archiveStatus === "already_archived")
        && (
          issueCloseStatus === "completed"
          || issueCloseStatus === "already_closed"
          || issueCloseStatus === "skipped"
        );
      if (completed) {
        return {
          status: "completed",
          changed: mainlineChanged,
        };
      }
      if (mainlineStatus === "failed" || archiveStatus === "failed" || issueCloseStatus === "failed") {
        return {
          status: "failed",
        };
      }
      if (mainlineStatus === "skipped" || archiveStatus === "skipped") {
        return {
          status: "skipped",
        };
      }
      return {
        status: "deferred",
      };
    } finally {
      this.releaseLock({
        lockKey: finalizeLockKey,
        owner: finalizeLockOwner,
      });
    }
  }

  syncProjectMainlineAfterMergedPr(params) {
    const projectId = String(params?.projectId ?? "").trim();
    if (!projectId) return 0;
    const project = this.getProject(projectId);
    if (!project) return 0;

    const lockKey = `project:${project.id}:mainline-sync`;
    const lockOwner = this.nextLockOwner(`project-mainline:${project.id}`);
    const syncLock = this.tryAcquireLock({
      lockKey,
      owner: lockOwner,
      ttlMs: PROJECT_MAINLINE_SYNC_LOCK_TTL_MS,
      scope: "project_mainline_sync",
      meta: {
        projectId: project.id,
      },
    });
    if (!syncLock.acquired) {
      this.emitEvent(null, null, "scheduler.mainline_sync.skipped_locked", {
        projectId: project.id,
        projectName: project.name,
        lockKey,
      });
      return 0;
    }

    try {
      const limitRaw = Number(params?.limit ?? 8);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(50, Math.floor(limitRaw)))
        : 8;
      const runs = this.db
        .prepare(
          `SELECT *
           FROM runs
           WHERE project_id = ?
             AND status = 'completed'
             AND COALESCE(TRIM(github_issue_id), '') != ''
             AND COALESCE(TRIM(worktree_branch), '') != ''
           ORDER BY updated_at DESC
           LIMIT ?`
        )
        .all(projectId, limit);

      let syncedCount = 0;
      for (const run of runs) {
        const context = safeJsonParse(run.context_json, {});
        const controls = getWorkflowControlsFromContext(context);
        const alreadyMainline = this.hasRunEvent(run.id, "github.mainline.sync.completed");
        const alreadyArchived = this.hasRunEvent(run.id, "github.worktree.archive.completed");
        const issueAutoClosed = this.hasRunEvent(run.id, "github.issue.autoclose.completed");
        if (alreadyMainline && alreadyArchived && (issueAutoClosed || !controls.autoCloseIssueOnMerge)) {
          continue;
        }

        let mergePr = null;
        const alreadyAutoMerged = this.hasRunEvent(run.id, "github.pr.automerge.completed");
        if (!alreadyAutoMerged && controls.autoMerge) {
          const autoMerge = this.tryAutoMergeRunAfterCompletion({
            run,
            project,
            context,
            stepId: null,
          });
          if (autoMerge?.pr?.number) {
            mergePr = autoMerge.pr;
          }
        }

        const result = this.syncRunMainlineAfterPrMerge({
          run,
          project,
          context,
          pr: mergePr,
          emitDeferred: false,
          emitSkipped: false,
          emitFailure: false,
        });
        if (result?.status === "completed") {
          syncedCount += 1;
        }
      }
      return syncedCount;
    } finally {
      this.releaseLock({
        lockKey,
        owner: lockOwner,
      });
    }
  }

  buildGitHubRunProgressCommentBody(params) {
    const phase = String(params?.phase ?? "").trim();
    const run = params?.run;
    if (!run) return "";

    const runId = String(run.id ?? "");
    const issueId = String(run.github_issue_id ?? "");
    const branch = String(run.worktree_branch ?? "");
    const projectName = String(params?.project?.name ?? "");
    const task = clipText(run.task, 240);
    const now = nowIso();
    const project = params?.project ?? null;
    const inlinePr = params?.pr ?? null;
    const pr = inlinePr?.number
      ? inlinePr
      : (project && branch ? this.findRunPullRequest({ run, project }) : null);
    const prNumber = Number(pr?.number ?? 0);
    const prUrl = String(pr?.url ?? "").trim();
    const prLine = prUrl
      ? `- pr: ${prUrl}`
      : (prNumber > 0 ? `- pr: #${prNumber}` : "- pr: -");

    if (phase === "run_started") {
      return [
        "### ForgeOps Run Started",
        `- run: \`${runId}\``,
        issueId ? `- issue: #${issueId}` : "- issue: -",
        prLine,
        projectName ? `- project: \`${projectName}\`` : "- project: -",
        branch ? `- branch: \`${branch}\`` : "- branch: -",
        task ? `- task: ${task}` : "- task: -",
        `- at: ${now}`,
      ].join("\n");
    }

    if (phase === "step_done") {
      const step = params?.step ?? null;
      if (!step) return "";
      const stepKey = String(step.step_key ?? "");
      const agentId = String(step.agent_id ?? "");
      const sessionId = String(step.runtime_session_id ?? "").trim();
      const summary = clipText(params?.summary ?? "", 500);
      const status = String(params?.status ?? "done");
      return [
        "### ForgeOps Step Completed",
        `- run: \`${runId}\``,
        issueId ? `- issue: #${issueId}` : "- issue: -",
        prLine,
        `- step: \`${stepKey}\` (${agentId || "-"})`,
        `- runtime_session_id: \`${sessionId || "-"}\``,
        `- status: \`${status}\``,
        summary ? `- summary: ${summary}` : "- summary: -",
        `- at: ${now}`,
      ].join("\n");
    }

    if (phase === "pr_linked") {
      const step = params?.step ?? null;
      const stepKey = String(step?.step_key ?? "-");
      const agentId = String(step?.agent_id ?? "-");
      const sessionId = String(step?.runtime_session_id ?? "").trim() || "-";
      const source = String(params?.source ?? "").trim();
      return [
        "### ForgeOps PR Linked",
        `- run: \`${runId}\``,
        issueId ? `- issue: #${issueId}` : "- issue: -",
        prLine,
        branch ? `- branch: \`${branch}\`` : "- branch: -",
        `- linked_by_step: \`${stepKey}\` (${agentId})`,
        `- runtime_session_id: \`${sessionId}\``,
        source ? `- source: \`${source}\`` : "- source: -",
        `- at: ${now}`,
      ].join("\n");
    }

    if (phase === "run_completed") {
      const steps = Array.isArray(params?.steps) ? params.steps : [];
      const stepLines = steps.map((step) => {
        const stepKey = String(step?.step_key ?? "-");
        const agentId = String(step?.agent_id ?? "-");
        const sessionId = String(step?.runtime_session_id ?? "").trim() || "-";
        const status = String(step?.status ?? "-");
        return `  - \`${stepKey}\` (${agentId}) · status=\`${status}\` · session=\`${sessionId}\``;
      });
      const preview = stepLines.slice(0, 12);
      const hasMore = stepLines.length > preview.length;
      return [
        "### ForgeOps Run Completed",
        `- run: \`${runId}\``,
        issueId ? `- issue: #${issueId}` : "- issue: -",
        prLine,
        branch ? `- branch: \`${branch}\`` : "- branch: -",
        task ? `- task: ${task}` : "- task: -",
        `- steps: ${steps.length}`,
        "- step session trace:",
        ...(preview.length > 0 ? preview : ["  - -"]),
        ...(hasMore ? [`  - ... (${stepLines.length - preview.length} more)`] : []),
        `- at: ${now}`,
      ].join("\n");
    }

    if (phase === "run_failed") {
      const step = params?.step ?? null;
      const stepKey = String(step?.step_key ?? "-");
      const agentId = String(step?.agent_id ?? "-");
      const sessionId = String(step?.runtime_session_id ?? "").trim() || "-";
      const error = clipText(params?.error ?? "", 600);
      return [
        "### ForgeOps Run Failed",
        `- run: \`${runId}\``,
        issueId ? `- issue: #${issueId}` : "- issue: -",
        prLine,
        branch ? `- branch: \`${branch}\`` : "- branch: -",
        `- failed_step: \`${stepKey}\` (${agentId})`,
        `- runtime_session_id: \`${sessionId}\``,
        error ? `- error: ${error}` : "- error: -",
        `- at: ${now}`,
      ].join("\n");
    }

    return "";
  }

  syncGitHubRunProgressComments(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    if (!run || !run.github_issue_id) return;
    const phase = String(params?.phase ?? "").trim();
    if (!phase) return;

    const step = params?.step ?? null;
    const runLevelPhase = phase === "pr_linked";
    const stepId = runLevelPhase ? null : (step?.id ?? null);
    const project = params?.project ?? this.getProject(run.project_id);
    if (!project) return;

    const body = this.buildGitHubRunProgressCommentBody({
      ...params,
      run,
      project,
      step,
    });
    if (!body) return;

    const issueSentEvent = `github.issue.comment.${phase}.sent`;
    const issueFailedEvent = `github.issue.comment.${phase}.failed`;
    if (!this.hasRunEvent(run.id, issueSentEvent, stepId)) {
      try {
        const issueComment = createGitHubIssueComment({
          repoRootPath: project.root_path,
          issueRef: run.github_issue_id,
          body,
        });
        this.emitEvent(run.id, stepId, issueSentEvent, {
          runId: run.id,
          issueId: run.github_issue_id,
          phase,
          url: issueComment.url,
        });
      } catch (err) {
        this.emitEvent(run.id, stepId, issueFailedEvent, {
          runId: run.id,
          issueId: run.github_issue_id,
          phase,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!run.worktree_branch) return;
    const prSentEvent = `github.pr.comment.${phase}.sent`;
    const prFailedEvent = `github.pr.comment.${phase}.failed`;
    if (this.hasRunEvent(run.id, prSentEvent, stepId)) return;

    try {
      const pr = findGitHubPullRequestForBranch({
        repoRootPath: project.root_path,
        branchName: run.worktree_branch,
      });
      if (!pr || !pr.number) {
        this.emitEvent(run.id, stepId, `github.pr.comment.${phase}.skipped`, {
          runId: run.id,
          phase,
          reason: "no_pr_for_branch",
          branch: run.worktree_branch,
        });
        return;
      }
      const prComment = createGitHubPullRequestComment({
        repoRootPath: project.root_path,
        prNumber: pr.number,
        body,
      });
      this.emitEvent(run.id, stepId, prSentEvent, {
        runId: run.id,
        phase,
        prNumber: pr.number,
        prUrl: pr.url,
        url: prComment.url,
      });
    } catch (err) {
      this.emitEvent(run.id, stepId, prFailedEvent, {
        runId: run.id,
        phase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getProjectLocSnapshot(project) {
    if (!project) {
      return {
        code_lines: 0,
        code_files: 0,
        doc_words: 0,
        doc_files: 0,
        docs_doc_words: 0,
        docs_doc_files: 0,
        loc_scanned_at: nowIso(),
        loc_source: "none",
        code_languages: [],
        code_trend_7d: createEmptyCodeTrend7d("Project not found."),
      };
    }
    const cacheKey = String(project.id);
    const nowMs = Date.now();
    const cached = this.projectLocCache.get(cacheKey);
    if (cached && nowMs - cached.cachedAtMs < LOC_CACHE_TTL_MS) {
      return cached.snapshot;
    }

    const scanned = scanProjectCodeSnapshot(project.root_path);
    const snapshot = {
      ...scanned,
      loc_scanned_at: nowIso(),
    };
    this.projectLocCache.set(cacheKey, {
      cachedAtMs: nowMs,
      snapshot,
    });
    return snapshot;
  }

  getProjectGitHubMetrics(project) {
    if (!project) {
      return {
        github_available: false,
        github_source: "none",
        github_repo: "",
        github_warning: "Project not found.",
        github_fetched_at: nowIso(),
        issue_count_all: 0,
        issue_count_open: 0,
        issue_count_closed: 0,
        pr_count_all: 0,
        pr_count_open: 0,
        pr_count_closed: 0,
      };
    }
    const cacheKey = String(project.id);
    const nowMs = Date.now();
    const cached = this.projectGitHubMetricsCache.get(cacheKey);
    if (cached && nowMs - cached.cachedAtMs < GITHUB_METRICS_CACHE_TTL_MS) {
      return cached.snapshot;
    }

    const remote = readGitHubIssuePrMetrics(project.root_path);
    const snapshot = {
      github_available: Boolean(remote.available),
      github_source: String(remote.source ?? "none"),
      github_repo: String(remote.repo ?? ""),
      github_warning: String(remote.warning ?? ""),
      github_fetched_at: String(remote.fetchedAt ?? nowIso()),
      issue_count_all: Number(remote.issueCounts?.all ?? 0),
      issue_count_open: Number(remote.issueCounts?.open ?? 0),
      issue_count_closed: Number(remote.issueCounts?.closed ?? 0),
      pr_count_all: Number(remote.prCounts?.all ?? 0),
      pr_count_open: Number(remote.prCounts?.open ?? 0),
      pr_count_closed: Number(remote.prCounts?.closed ?? 0),
    };
    this.projectGitHubMetricsCache.set(cacheKey, {
      cachedAtMs: nowMs,
      snapshot,
    });
    return snapshot;
  }

  getProjectMetrics(projectId) {
    const project = this.getProject(projectId);
    if (!project) return null;

    const runStatusRows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM runs WHERE project_id = ? GROUP BY status")
      .all(projectId);
    let runCount = 0;
    let runRunningCount = 0;
    let runCompletedCount = 0;
    let runFailedCount = 0;
    for (const row of runStatusRows) {
      const status = String(row.status ?? "");
      const count = Number(row.count ?? 0);
      runCount += count;
      if (status === "running") runRunningCount += count;
      if (status === "completed") runCompletedCount += count;
      if (status === "failed") runFailedCount += count;
    }
    const tokenRow = this.db.prepare(
      `SELECT
         COALESCE(SUM(s.token_input), 0) AS token_input_total,
         COALESCE(SUM(s.token_cached_input), 0) AS token_cached_input_total,
         COALESCE(SUM(s.token_output), 0) AS token_output_total
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       WHERE r.project_id = ?`
    ).get(projectId) ?? {};
    const tokenInputTotal = Number(tokenRow.token_input_total ?? 0);
    const tokenCachedInputTotal = Number(tokenRow.token_cached_input_total ?? 0);
    const tokenOutputTotal = Number(tokenRow.token_output_total ?? 0);
    const tokenTotal = tokenInputTotal + tokenCachedInputTotal + tokenOutputTotal;
    const tokenPromptTotal = tokenInputTotal + tokenCachedInputTotal;
    const tokenCacheHitRate = tokenPromptTotal > 0
      ? (tokenCachedInputTotal / tokenPromptTotal) * 100
      : 0;
    const github = this.getProjectGitHubMetrics(project);

    const loc = this.getProjectLocSnapshot(project);
    const createdTs = Date.parse(String(project.created_at ?? ""));
    const elapsedSec = Number.isFinite(createdTs)
      ? Math.max(0, Math.floor((Date.now() - createdTs) / 1000))
      : 0;

    return {
      project_id: project.id,
      issue_count_all: github.issue_count_all,
      issue_count_open: github.issue_count_open,
      issue_count_closed: github.issue_count_closed,
      pr_count_all: github.pr_count_all,
      pr_count_open: github.pr_count_open,
      pr_count_closed: github.pr_count_closed,
      run_count: runCount,
      run_running_count: runRunningCount,
      run_completed_count: runCompletedCount,
      run_failed_count: runFailedCount,
      token_total: tokenTotal,
      token_input_total: tokenInputTotal,
      token_cached_input_total: tokenCachedInputTotal,
      token_output_total: tokenOutputTotal,
      token_cache_hit_rate: tokenCacheHitRate,
      code_lines: Number(loc.code_lines ?? 0),
      code_files: Number(loc.code_files ?? 0),
      doc_words: Number(loc.doc_words ?? 0),
      doc_files: Number(loc.doc_files ?? 0),
      docs_doc_words: Number(loc.docs_doc_words ?? 0),
      docs_doc_files: Number(loc.docs_doc_files ?? 0),
      code_languages: Array.isArray(loc.code_languages) ? loc.code_languages : [],
      code_trend_7d: loc.code_trend_7d ?? createEmptyCodeTrend7d("Code trend not available."),
      elapsed_sec: elapsedSec,
      created_at: project.created_at,
      updated_at: project.updated_at,
      loc_scanned_at: loc.loc_scanned_at,
      loc_source: loc.loc_source,
      github_available: github.github_available,
      github_source: github.github_source,
      github_repo: github.github_repo,
      github_warning: github.github_warning,
      github_fetched_at: github.github_fetched_at,
    };
  }

  getGlobalTokenUsageMetrics(options = {}) {
    const trendDays = Math.max(1, Math.min(30, Math.floor(Number(options.trendDays ?? 7) || 7)));
    const dayKeys = createRecentUtcDateKeys(trendDays);
    const rangeStart = dayKeys[0];
    const rangeEnd = dayKeys[dayKeys.length - 1];

    const runtimeRows = this.db.prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(runtime), ''), 'unknown') AS runtime,
         COALESCE(SUM(token_input), 0) AS token_input_total,
         COALESCE(SUM(token_cached_input), 0) AS token_cached_input_total,
         COALESCE(SUM(token_output), 0) AS token_output_total
       FROM steps
       GROUP BY runtime
       ORDER BY (token_input_total + token_cached_input_total + token_output_total) DESC, runtime ASC`
    ).all();

    const runtimeTotals = [];
    let tokenInputTotal = 0;
    let tokenCachedInputTotal = 0;
    let tokenOutputTotal = 0;

    for (const row of runtimeRows) {
      const runtime = normalizeRuntimeMetricName(row.runtime);
      const tokenInput = Number(row.token_input_total ?? 0);
      const tokenCachedInput = Number(row.token_cached_input_total ?? 0);
      const tokenOutput = Number(row.token_output_total ?? 0);
      const runtimeTotal = tokenInput + tokenCachedInput + tokenOutput;
      if (runtimeTotal <= 0) continue;
      tokenInputTotal += tokenInput;
      tokenCachedInputTotal += tokenCachedInput;
      tokenOutputTotal += tokenOutput;
      runtimeTotals.push({
        runtime,
        token_input_total: tokenInput,
        token_cached_input_total: tokenCachedInput,
        token_output_total: tokenOutput,
        total_tokens: runtimeTotal,
      });
    }

    const tokenTotal = tokenInputTotal + tokenCachedInputTotal + tokenOutputTotal;
    const tokenPromptTotal = tokenInputTotal + tokenCachedInputTotal;
    const tokenCacheHitRate = tokenPromptTotal > 0
      ? (tokenCachedInputTotal / tokenPromptTotal) * 100
      : 0;

    const runtimeTotalsWithRates = runtimeTotals.map((row) => {
      const runtimePromptTotal = row.token_input_total + row.token_cached_input_total;
      return {
        ...row,
        token_cache_hit_rate: runtimePromptTotal > 0
          ? (row.token_cached_input_total / runtimePromptTotal) * 100
          : 0,
        share_rate: tokenTotal > 0 ? (row.total_tokens / tokenTotal) * 100 : 0,
      };
    });

    const projectRows = this.db.prepare(
      `SELECT
         p.id AS project_id,
         p.name AS project_name,
         COALESCE(SUM(s.token_input), 0) AS token_input_total,
         COALESCE(SUM(s.token_cached_input), 0) AS token_cached_input_total,
         COALESCE(SUM(s.token_output), 0) AS token_output_total
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       JOIN projects p ON p.id = r.project_id
       GROUP BY p.id, p.name
       ORDER BY (token_input_total + token_cached_input_total + token_output_total) DESC, p.name ASC`
    ).all();
    const projectTotalsWithRates = [];
    for (const row of projectRows) {
      const tokenInput = Number(row.token_input_total ?? 0);
      const tokenCachedInput = Number(row.token_cached_input_total ?? 0);
      const tokenOutput = Number(row.token_output_total ?? 0);
      const projectTotal = tokenInput + tokenCachedInput + tokenOutput;
      if (projectTotal <= 0) continue;
      const promptTotal = tokenInput + tokenCachedInput;
      projectTotalsWithRates.push({
        project_id: String(row.project_id ?? ""),
        project_name: String(row.project_name ?? ""),
        token_input_total: tokenInput,
        token_cached_input_total: tokenCachedInput,
        token_output_total: tokenOutput,
        total_tokens: projectTotal,
        token_cache_hit_rate: promptTotal > 0 ? (tokenCachedInput / promptTotal) * 100 : 0,
        share_rate: tokenTotal > 0 ? (projectTotal / tokenTotal) * 100 : 0,
      });
    }

    const runtimeOrder = new Map();
    runtimeTotalsWithRates.forEach((row, index) => {
      runtimeOrder.set(row.runtime, index);
    });

    const trendDateExpr = "substr(COALESCE(NULLIF(TRIM(ended_at), ''), NULLIF(TRIM(updated_at), ''), NULLIF(TRIM(created_at), '')), 1, 10)";
    const trendRows = this.db.prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(runtime), ''), 'unknown') AS runtime,
         ${trendDateExpr} AS date_key,
         COALESCE(SUM(token_input), 0) AS token_input_total,
         COALESCE(SUM(token_cached_input), 0) AS token_cached_input_total,
         COALESCE(SUM(token_output), 0) AS token_output_total
       FROM steps
       WHERE ${trendDateExpr} BETWEEN ? AND ?
       GROUP BY date_key, runtime
       ORDER BY date_key ASC, runtime ASC`
    ).all(rangeStart, rangeEnd);

    const trendDayMap = new Map(
      dayKeys.map((date) => [
        date,
        {
          date,
          totalTokens: 0,
          runtimeMap: new Map(),
        },
      ]),
    );

    for (const row of trendRows) {
      const dateKey = normalizeMetricDate(row.date_key);
      if (!trendDayMap.has(dateKey)) continue;
      const runtime = normalizeRuntimeMetricName(row.runtime);
      const tokenInput = Number(row.token_input_total ?? 0);
      const tokenCachedInput = Number(row.token_cached_input_total ?? 0);
      const tokenOutput = Number(row.token_output_total ?? 0);
      const runtimeTotal = tokenInput + tokenCachedInput + tokenOutput;
      if (runtimeTotal <= 0) continue;
      const bucket = trendDayMap.get(dateKey);
      if (!bucket) continue;
      bucket.totalTokens += runtimeTotal;
      const existing = bucket.runtimeMap.get(runtime) ?? {
        runtime,
        token_input_total: 0,
        token_cached_input_total: 0,
        token_output_total: 0,
        total_tokens: 0,
      };
      existing.token_input_total += tokenInput;
      existing.token_cached_input_total += tokenCachedInput;
      existing.token_output_total += tokenOutput;
      existing.total_tokens += runtimeTotal;
      bucket.runtimeMap.set(runtime, existing);
    }

    const trendDaysRows = dayKeys.map((date) => {
      const bucket = trendDayMap.get(date);
      const runtimeTotalsForDay = bucket
        ? Array.from(bucket.runtimeMap.values()).sort((a, b) => {
          const rankA = runtimeOrder.has(a.runtime) ? Number(runtimeOrder.get(a.runtime)) : Number.MAX_SAFE_INTEGER;
          const rankB = runtimeOrder.has(b.runtime) ? Number(runtimeOrder.get(b.runtime)) : Number.MAX_SAFE_INTEGER;
          if (rankA !== rankB) return rankA - rankB;
          return String(a.runtime).localeCompare(String(b.runtime));
        })
        : [];
      return {
        date,
        total_tokens: Number(bucket?.totalTokens ?? 0),
        runtime_totals: runtimeTotalsForDay,
      };
    });

    const trendAvailable = trendDaysRows.some((row) => Number(row.total_tokens ?? 0) > 0);

    return {
      total_tokens: tokenTotal,
      token_input_total: tokenInputTotal,
      token_cached_input_total: tokenCachedInputTotal,
      token_output_total: tokenOutputTotal,
      token_cache_hit_rate: tokenCacheHitRate,
      project_totals: projectTotalsWithRates,
      runtime_totals: runtimeTotalsWithRates,
      trend_7d: {
        available: trendAvailable,
        source: "steps",
        days: trendDaysRows,
        warning: trendAvailable ? "" : `最近 ${trendDays} 天暂无 Token 消耗记录。`,
      },
      collected_at: nowIso(),
    };
  }

  createRun(params) {
    const project = this.getProject(params.projectId);
    if (!project) {
      throw new Error(`Project not found: ${params.projectId}`);
    }

    const issueRef = String(params.issueId ?? "").trim();
    if (!issueRef) {
      throw new Error("GitHub issue is required to create run");
    }

    const issue = getGitHubIssue({
      repoRootPath: project.root_path,
      projectId: project.id,
      issueRef,
    });
    if (!issue) {
      throw new Error(`GitHub issue not found in project: ${params.issueId}`);
    }

    const task = String(params.task ?? "").trim() || buildAutoIssueRunTask(issue);
    const existingRunningRun = this.getRunningRunForGitHubIssue(project.id, issue.id);
    if (existingRunningRun) {
      throw new Error(`Run already running for GitHub issue #${issue.id}: ${existingRunningRun.id}`);
    }

    const runId = newId("run");
    const now = nowIso();
    const worktree = createRunWorktree({
      rootPath: project.root_path,
      runId,
    });
    const executionRoot = worktree.worktreePath;
    const context = {
      task,
      project: {
        id: project.id,
        name: project.name,
        rootPath: executionRoot,
        repoRootPath: project.root_path,
        worktreePath: worktree.worktreePath,
        worktreeBranch: worktree.worktreeBranch,
        baseRef: worktree.baseRef,
        productType: project.product_type,
        problemStatement: project.problem_statement,
      },
      projectTechProfile: this.loadProjectTechProfile(project.root_path),
      projectContext: this.loadProjectContext(project.root_path),
      projectGovernance: this.loadProjectGovernance(project.root_path),
      projectInvariants: this.loadProjectInvariants(project.root_path),
      skillDeliveryMode: normalizeSkillDeliveryMode(
        params.skillDeliveryMode ?? process.env.FORGEOPS_SKILL_DELIVERY_MODE,
        SKILL_DELIVERY_CODEX_NATIVE,
      ),
      agentSkills: this.loadProjectSkills({
        // Resolve project-local skills from the run worktree so any in-flight
        // skill evolution in the branch is visible to the running agent.
        rootPath: executionRoot,
        productType: project.product_type,
      }),
      issue: issue
        ? {
            id: issue.id,
            number: issue.github_number ?? Number(issue.id),
            title: issue.title,
            description: issue.description,
            url: issue.github_url ?? "",
          }
        : null,
      pullRequest: null,
      workflowControls: {
        autoMerge: true,
        mergeMethod: "squash",
        autoCloseIssueOnMerge: true,
        autoMergeConflictMaxAttempts: DEFAULT_AUTO_MERGE_CONFLICT_MAX_ATTEMPTS,
      },
      stepPolicies: {},
      stepOutputs: {},
    };
    if (isObjectRecord(params?.cleanupContext)) {
      context.cleanupContext = params.cleanupContext;
    }
    if (isObjectRecord(params?.contextOverrides)) {
      for (const [key, value] of Object.entries(params.contextOverrides)) {
        if (!key) continue;
        if (isObjectRecord(context[key]) && isObjectRecord(value)) {
          context[key] = {
            ...context[key],
            ...value,
          };
          continue;
        }
        context[key] = value;
      }
    }

    const requestedRunMode = parseRunModeLike(params.runMode, RUN_MODE_DEFAULT);
    const baseWorkflow = params.workflowOverride && typeof params.workflowOverride === "object"
      ? params.workflowOverride
      : resolveWorkflow(project.root_path);
    const workflowResolution = resolveRunWorkflowByMode(baseWorkflow, requestedRunMode);
    const workflow = workflowResolution.workflow;
    const resolvedRunMode = workflowResolution.resolvedRunMode;
    const steps = workflow.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("Invalid workflow config: no steps defined");
    }
    if (workflow.workflowControls && typeof workflow.workflowControls === "object") {
      context.workflowControls = {
        autoMerge: parseBoolLike(
          workflow.workflowControls.autoMerge ?? workflow.workflowControls.auto_merge,
          true
        ),
        mergeMethod: normalizeMergeMethodLike(
          workflow.workflowControls.mergeMethod ?? workflow.workflowControls.merge_method,
          "squash"
        ),
        autoCloseIssueOnMerge: parseBoolLike(
          workflow.workflowControls.autoCloseIssueOnMerge
            ?? workflow.workflowControls.auto_close_issue_on_merge,
          true
        ),
        autoMergeConflictMaxAttempts: normalizeAutoMergeConflictMaxAttempts(
          workflow.workflowControls.autoMergeConflictMaxAttempts
            ?? workflow.workflowControls.auto_merge_conflict_max_attempts,
          DEFAULT_AUTO_MERGE_CONFLICT_MAX_ATTEMPTS,
        ),
      };
    }
    context.stepPolicies = buildStepPolicies(steps);
    context.runMode = resolvedRunMode;
    context.runModeRequested = requestedRunMode;
    context.quickModeApplied = workflowResolution.quickApplied;
    context.quickModeFallbackReason = workflowResolution.quickFallbackReason;
    const workflowId = String(workflow.id ?? "").trim() || "forgeops-custom-v1";

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        "INSERT INTO runs (id, project_id, github_issue_id, task, status, workflow_id, context_json, worktree_path, worktree_branch, base_ref, current_step_index, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 0, ?, ?)"
      ).run(
        runId,
        params.projectId,
        issue.id,
        task,
        workflowId,
        JSON.stringify(context),
        worktree.worktreePath,
        worktree.worktreeBranch,
        worktree.baseRef,
        now,
        now,
      );

      const insertStep = this.db.prepare(
        "INSERT INTO steps (id, run_id, step_key, template_key, depends_on_json, agent_id, step_index, status, input_text, max_retries, runtime, requested_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i];
        const stepId = newId("step");
        const dependencies = Array.isArray(step.dependsOn) ? step.dependsOn : [];
        const status = dependencies.length === 0 ? "pending" : "waiting";
        const templateKey = step.templateKey ?? step.key;
        const inputText = this.renderStepInput(step.key, context, templateKey, {
          attempt: 1,
          maxAttempts: Number(step.maxRetries ?? 0) + 1,
          stepPolicy: getStepPolicyFromContext(context, step.key),
        });
        insertStep.run(
          stepId,
          runId,
          step.key,
          templateKey,
          JSON.stringify(dependencies),
          step.agentId,
          i,
          status,
          inputText,
          step.maxRetries,
          step.runtime ?? "codex-exec-json",
          step.model,
          now,
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      if (worktree?.worktreePath && worktree?.worktreeBranch) {
        try {
          cleanupRunWorktree({
            rootPath: project.root_path,
            runId,
            worktreePath: worktree.worktreePath,
            branchName: worktree.worktreeBranch,
          });
        } catch {
          // ignore cleanup failure on create-run rollback
        }
      }
      if (isRunningIssueUniqueConstraintError(err)) {
        const racedRun = this.getRunningRunForGitHubIssue(project.id, issue.id);
        if (racedRun) {
          throw new Error(`Run already running for GitHub issue #${issue.id}: ${racedRun.id}`);
        }
      }
      throw err;
    }

    this.emitEvent(runId, null, "run.started", {
      runId,
      projectId: params.projectId,
      issueId: issue.id,
      task,
      runMode: resolvedRunMode,
      runModeRequested: requestedRunMode,
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
      baseRef: worktree.baseRef,
    });
    const createdRun = this.getRun(runId);
    if (issue?.id && createdRun) {
      this.syncGitHubIssueAutomationStamp({
        project,
        runId,
        issueId: issue.id,
        state: "queued",
      });
      this.syncGitHubRunProgressComments({
        phase: "run_started",
        run: createdRun,
        project,
      });
    }

    return createdRun;
  }

  getRun(runId) {
    return this.db.prepare("SELECT * FROM runs WHERE id = ? LIMIT 1").get(runId);
  }

  listRuns(projectId = null) {
    const sql = `
      SELECT
        r.*,
        p.name AS project_name,
        COALESCE(SUM(s.token_input + s.token_cached_input + s.token_output), 0) AS total_tokens,
        MAX(CASE WHEN s.status = 'running' THEN s.step_key ELSE NULL END) AS running_step
      FROM runs r
      JOIN projects p ON p.id = r.project_id
      LEFT JOIN steps s ON s.run_id = r.id
      ${projectId ? "WHERE r.project_id = ?" : ""}
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `;
    const rows = projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all();
    if (!Array.isArray(rows) || rows.length === 0) {
      return rows;
    }

    const runIds = rows.map((row) => String(row.id ?? "")).filter(Boolean);
    if (runIds.length === 0) {
      return rows;
    }
    const placeholders = runIds.map(() => "?").join(", ");
    const stepRows = this.db
      .prepare(
        `SELECT run_id, step_key, template_key, status, summary, error, started_at, ended_at, updated_at, step_index
         FROM steps
         WHERE run_id IN (${placeholders})
         ORDER BY step_index ASC`
      )
      .all(...runIds);
    const byRun = new Map();
    for (const step of stepRows) {
      const runId = String(step.run_id ?? "");
      if (!runId) continue;
      const bucket = byRun.get(runId) ?? [];
      bucket.push(step);
      byRun.set(runId, bucket);
    }
    return rows.map((row) => ({
      ...row,
      quality_gates: buildRunQualityGates(byRun.get(String(row.id ?? "")) ?? []),
    }));
  }

  getRunDetails(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    const steps = this.db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC")
      .all(runId);
    const sessions = this.db
      .prepare("SELECT * FROM sessions WHERE run_id = ? ORDER BY started_at ASC")
      .all(runId);
    const events = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id ASC")
      .all(runId)
      .map((evt) => ({ ...evt, payload: safeJsonParse(evt.payload_json, {}) }));
    const artifacts = this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId);
    const qualityGates = buildRunQualityGates(steps);

    return {
      run: {
        ...run,
        quality_gates: qualityGates,
      },
      context: safeJsonParse(run.context_json, {}),
      steps,
      sessions,
      events,
      artifacts,
      qualityGates,
    };
  }

  listRunSessions(runId, options = {}) {
    const rid = String(runId ?? "").trim();
    if (!rid) return [];
    const stepKey = String(options.stepKey ?? "").trim();
    const status = String(options.status ?? "").trim();

    const rows = this.db
      .prepare(
        `SELECT se.*,
                st.step_key AS step_key,
                st.agent_id AS agent_id,
                st.step_index AS step_index
         FROM sessions se
         JOIN steps st ON st.id = se.step_id
         WHERE se.run_id = ?
         ORDER BY se.started_at ASC`
      )
      .all(rid);

    return rows.filter((row) => {
      if (stepKey && String(row.step_key ?? "").trim() !== stepKey) return false;
      if (status && String(row.status ?? "").trim() !== status) return false;
      return true;
    });
  }

  getSessionDetails(sessionId) {
    const sid = String(sessionId ?? "").trim();
    if (!sid) return null;
    const row = this.db
      .prepare(
        `SELECT se.*,
                st.step_key AS step_key,
                st.agent_id AS agent_id,
                st.step_index AS step_index,
                r.project_id AS project_id,
                r.worktree_path AS worktree_path,
                r.worktree_branch AS worktree_branch,
                r.status AS run_status,
                p.root_path AS project_root_path,
                p.name AS project_name
         FROM sessions se
         JOIN steps st ON st.id = se.step_id
         JOIN runs r ON r.id = se.run_id
         JOIN projects p ON p.id = r.project_id
         WHERE se.id = ?
         LIMIT 1`
      )
      .get(sid);
    return row && typeof row === "object" ? row : null;
  }

  getSystemStatus(options = {}) {
    const windowMinutesRaw = Number(options.windowMinutes ?? options.windowMins ?? 60);
    const windowMinutes = Number.isFinite(windowMinutesRaw) && windowMinutesRaw > 0
      ? Math.min(24 * 60, Math.floor(windowMinutesRaw))
      : 60;
    const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

    const scalar = (sql, ...params) => {
      const row = this.db.prepare(sql).get(...params);
      return Number(row?.count ?? 0) || 0;
    };

    const group = (sql, ...params) => {
      const rows = this.db.prepare(sql).all(...params);
      const out = {};
      for (const row of rows) {
        const key = String(row?.key ?? "").trim() || "unknown";
        out[key] = Number(row?.count ?? 0) || 0;
      }
      return out;
    };

    const projects = {
      total: scalar("SELECT COUNT(*) AS count FROM projects"),
      active: scalar("SELECT COUNT(*) AS count FROM projects WHERE status = 'active'"),
      byProductType: group(
        "SELECT COALESCE(NULLIF(TRIM(product_type), ''), 'unknown') AS key, COUNT(*) AS count FROM projects GROUP BY key ORDER BY count DESC"
      ),
    };

    const runsByStatus = group(
      "SELECT COALESCE(NULLIF(TRIM(status), ''), 'unknown') AS key, COUNT(*) AS count FROM runs GROUP BY key ORDER BY count DESC"
    );
    const stepsByStatus = group(
      "SELECT COALESCE(NULLIF(TRIM(status), ''), 'unknown') AS key, COUNT(*) AS count FROM steps GROUP BY key ORDER BY count DESC"
    );
    const sessionsByStatus = group(
      "SELECT COALESCE(NULLIF(TRIM(status), ''), 'unknown') AS key, COUNT(*) AS count FROM sessions GROUP BY key ORDER BY count DESC"
    );

    const queue = {
      waiting: scalar("SELECT COUNT(*) AS count FROM steps WHERE status = 'waiting'"),
      pending: scalar("SELECT COUNT(*) AS count FROM steps WHERE status = 'pending'"),
      running: scalar("SELECT COUNT(*) AS count FROM steps WHERE status = 'running'"),
      failed: scalar("SELECT COUNT(*) AS count FROM steps WHERE status = 'failed'"),
    };

    const eventWindowTotal = scalar(
      "SELECT COUNT(*) AS count FROM events WHERE ts >= ?",
      sinceIso
    );
    const eventWindowByType = group(
      `SELECT event_type AS key, COUNT(*) AS count
       FROM events
       WHERE ts >= ?
       GROUP BY event_type
       ORDER BY count DESC
       LIMIT 16`,
      sinceIso
    );

    const tokenWindowRow = this.db.prepare(
      `SELECT
         COALESCE(SUM(token_input), 0) AS token_input,
         COALESCE(SUM(token_cached_input), 0) AS token_cached_input,
         COALESCE(SUM(token_output), 0) AS token_output,
         COALESCE(SUM(token_reasoning_output), 0) AS token_reasoning_output,
         COUNT(*) AS session_count
       FROM sessions
       WHERE started_at >= ?`
    ).get(sinceIso) ?? {};
    const tokenWindow = {
      windowMinutes,
      since: sinceIso,
      sessions: Number(tokenWindowRow.session_count ?? 0) || 0,
      input: Number(tokenWindowRow.token_input ?? 0) || 0,
      cachedInput: Number(tokenWindowRow.token_cached_input ?? 0) || 0,
      output: Number(tokenWindowRow.token_output ?? 0) || 0,
      reasoningOutput: Number(tokenWindowRow.token_reasoning_output ?? 0) || 0,
    };
    tokenWindow.total = tokenWindow.input + tokenWindow.cachedInput + tokenWindow.output + tokenWindow.reasoningOutput;

    return {
      now: nowIso(),
      windowMinutes,
      since: sinceIso,
      projects,
      runsByStatus,
      stepsByStatus,
      sessionsByStatus,
      queue,
      events: {
        windowMinutes,
        since: sinceIso,
        total: eventWindowTotal,
        byTypeTop: eventWindowByType,
      },
      tokens: tokenWindow,
    };
  }

  getProjectStatus(projectId, options = {}) {
    const pid = String(projectId ?? "").trim();
    if (!pid) {
      return this.getSystemStatus(options);
    }
    const project = this.getProject(pid);
    if (!project) {
      return {
        now: nowIso(),
        windowMinutes: 60,
        since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        projects: { total: 0, active: 0, byProductType: {} },
        runsByStatus: {},
        stepsByStatus: {},
        sessionsByStatus: {},
        queue: { waiting: 0, pending: 0, running: 0, failed: 0 },
        events: { windowMinutes: 60, since: new Date(Date.now() - 60 * 60 * 1000).toISOString(), total: 0, byTypeTop: {} },
        tokens: { windowMinutes: 60, since: new Date(Date.now() - 60 * 60 * 1000).toISOString(), sessions: 0, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 },
        error: `Project not found: ${pid}`,
      };
    }

    const windowMinutesRaw = Number(options.windowMinutes ?? options.windowMins ?? 60);
    const windowMinutes = Number.isFinite(windowMinutesRaw) && windowMinutesRaw > 0
      ? Math.min(24 * 60, Math.floor(windowMinutesRaw))
      : 60;
    const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

    const scalar = (sql, ...params) => {
      const row = this.db.prepare(sql).get(...params);
      return Number(row?.count ?? 0) || 0;
    };

    const group = (sql, ...params) => {
      const rows = this.db.prepare(sql).all(...params);
      const out = {};
      for (const row of rows) {
        const key = String(row?.key ?? "").trim() || "unknown";
        out[key] = Number(row?.count ?? 0) || 0;
      }
      return out;
    };

    const projects = {
      total: 1,
      active: project.status === "active" ? 1 : 0,
      byProductType: {
        [String(project.product_type ?? "").trim() || "unknown"]: 1,
      },
    };

    const runsByStatus = group(
      "SELECT COALESCE(NULLIF(TRIM(status), ''), 'unknown') AS key, COUNT(*) AS count FROM runs WHERE project_id = ? GROUP BY key ORDER BY count DESC",
      pid
    );

    const stepsByStatus = group(
      `SELECT COALESCE(NULLIF(TRIM(s.status), ''), 'unknown') AS key, COUNT(*) AS count
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       WHERE r.project_id = ?
       GROUP BY key
       ORDER BY count DESC`,
      pid
    );

    const sessionsByStatus = group(
      `SELECT COALESCE(NULLIF(TRIM(se.status), ''), 'unknown') AS key, COUNT(*) AS count
       FROM sessions se
       JOIN runs r ON r.id = se.run_id
       WHERE r.project_id = ?
       GROUP BY key
       ORDER BY count DESC`,
      pid
    );

    const queue = {
      waiting: scalar(
        `SELECT COUNT(*) AS count
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE r.project_id = ? AND s.status = 'waiting'`,
        pid
      ),
      pending: scalar(
        `SELECT COUNT(*) AS count
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE r.project_id = ? AND s.status = 'pending'`,
        pid
      ),
      running: scalar(
        `SELECT COUNT(*) AS count
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE r.project_id = ? AND s.status = 'running'`,
        pid
      ),
      failed: scalar(
        `SELECT COUNT(*) AS count
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE r.project_id = ? AND s.status = 'failed'`,
        pid
      ),
    };

    const eventWindowTotal = scalar(
      `SELECT COUNT(*) AS count
       FROM events e
       JOIN runs r ON r.id = e.run_id
       WHERE r.project_id = ? AND e.ts >= ?`,
      pid,
      sinceIso
    );
    const eventWindowByType = group(
      `SELECT e.event_type AS key, COUNT(*) AS count
       FROM events e
       JOIN runs r ON r.id = e.run_id
       WHERE r.project_id = ? AND e.ts >= ?
       GROUP BY e.event_type
       ORDER BY count DESC
       LIMIT 16`,
      pid,
      sinceIso
    );

    const tokenWindowRow = this.db.prepare(
      `SELECT
         COALESCE(SUM(se.token_input), 0) AS token_input,
         COALESCE(SUM(se.token_cached_input), 0) AS token_cached_input,
         COALESCE(SUM(se.token_output), 0) AS token_output,
         COALESCE(SUM(se.token_reasoning_output), 0) AS token_reasoning_output,
         COUNT(*) AS session_count
       FROM sessions se
       JOIN runs r ON r.id = se.run_id
       WHERE r.project_id = ? AND se.started_at >= ?`
    ).get(pid, sinceIso) ?? {};
    const tokens = {
      windowMinutes,
      since: sinceIso,
      sessions: Number(tokenWindowRow.session_count ?? 0) || 0,
      input: Number(tokenWindowRow.token_input ?? 0) || 0,
      cachedInput: Number(tokenWindowRow.token_cached_input ?? 0) || 0,
      output: Number(tokenWindowRow.token_output ?? 0) || 0,
      reasoningOutput: Number(tokenWindowRow.token_reasoning_output ?? 0) || 0,
    };
    tokens.total = tokens.input + tokens.cachedInput + tokens.output + tokens.reasoningOutput;

    return {
      now: nowIso(),
      windowMinutes,
      since: sinceIso,
      project: {
        id: project.id,
        name: project.name,
        rootPath: project.root_path,
        productType: project.product_type,
      },
      projects,
      runsByStatus,
      stepsByStatus,
      sessionsByStatus,
      queue,
      events: {
        windowMinutes,
        since: sinceIso,
        total: eventWindowTotal,
        byTypeTop: eventWindowByType,
      },
      tokens,
    };
  }

  claimNextPendingStep() {
    const candidate = this.db
      .prepare(
        `SELECT s.id
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE s.status = 'pending' AND r.status = 'running'
         ORDER BY r.created_at ASC, s.step_index ASC
         LIMIT 1`
      )
      .get();

    if (!candidate) return null;

    const now = nowIso();
    const update = this.db
      .prepare("UPDATE steps SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, now, candidate.id);
    if (update.changes === 0) return null;

    const step = this.db
      .prepare(
        `SELECT s.*, r.task, r.context_json, r.project_id, r.github_issue_id, p.name AS project_name, COALESCE(r.worktree_path, p.root_path) AS root_path, p.root_path AS repo_root_path, r.worktree_path, r.worktree_branch, r.base_ref, p.product_type, p.problem_statement
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         JOIN projects p ON p.id = r.project_id
         WHERE s.id = ?`
      )
      .get(candidate.id);

    this.emitEvent(step.run_id, step.id, "step.running", {
      stepId: step.id,
      stepKey: step.step_key,
      agentId: step.agent_id,
      runId: step.run_id,
    });
    if (step.github_issue_id) {
      this.syncGitHubIssueAutomationStamp({
        projectId: step.project_id,
        runId: step.run_id,
        issueId: step.github_issue_id,
        state: "running",
      });
    }

    return {
      ...step,
      context: safeJsonParse(step.context_json, {}),
    };
  }

  recoverOrphanedRunningSteps() {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.run_id, s.step_key, s.runtime_session_id
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE r.status = 'running' AND s.status = 'running'`
      )
      .all();

    if (rows.length === 0) {
      return 0;
    }

    const now = nowIso();
    const markStepPending = this.db.prepare(
      "UPDATE steps SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?"
    );
    const markSessionEnded = this.db.prepare(
      "UPDATE sessions SET status = 'failed', error = ?, ended_at = ? WHERE id = ? AND status = 'running'"
    );

    for (const row of rows) {
      markStepPending.run(now, row.id);
      if (row.runtime_session_id) {
        markSessionEnded.run("Recovered orphaned step after engine restart", now, row.runtime_session_id);
      }
      this.emitEvent(row.run_id, row.id, "step.recovered", {
        stepId: row.id,
        stepKey: row.step_key,
        reason: "engine_restart",
      });
    }

    return rows.length;
  }

  startSession(params) {
    const sessionId = newId("sess");
    const now = nowIso();
    this.db.prepare(
      "INSERT INTO sessions (id, run_id, step_id, runtime, process_pid, thread_id, turn_id, requested_model, effective_model, model_provider, token_input, token_cached_input, token_output, token_reasoning_output, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'running', ?)"
    ).run(
      sessionId,
      params.runId,
      params.stepId,
      params.runtime,
      params.processPid ?? null,
      params.threadId ?? null,
      params.turnId ?? null,
      params.requestedModel ?? null,
      params.effectiveModel ?? null,
      params.modelProvider ?? null,
      now,
    );

    this.db
      .prepare("UPDATE steps SET runtime_session_id = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, now, params.stepId);

    return sessionId;
  }

  updateSession(sessionId, patch) {
    const current = this.db
      .prepare("SELECT * FROM sessions WHERE id = ? LIMIT 1")
      .get(sessionId);
    if (!current) return;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch ?? {}, key);

    const next = {
      process_pid: has("processPid") ? patch.processPid : current.process_pid,
      thread_id: has("threadId") ? patch.threadId : current.thread_id,
      turn_id: has("turnId") ? patch.turnId : current.turn_id,
      effective_model: has("effectiveModel") ? patch.effectiveModel : current.effective_model,
      model_provider: has("modelProvider") ? patch.modelProvider : current.model_provider,
      token_input: has("tokenInput") && Number.isFinite(Number(patch.tokenInput))
        ? Number(patch.tokenInput)
        : Number(current.token_input ?? 0),
      token_cached_input: has("tokenCachedInput") && Number.isFinite(Number(patch.tokenCachedInput))
        ? Number(patch.tokenCachedInput)
        : Number(current.token_cached_input ?? 0),
      token_output: has("tokenOutput") && Number.isFinite(Number(patch.tokenOutput))
        ? Number(patch.tokenOutput)
        : Number(current.token_output ?? 0),
      token_reasoning_output: has("tokenReasoningOutput") && Number.isFinite(Number(patch.tokenReasoningOutput))
        ? Number(patch.tokenReasoningOutput)
        : Number(current.token_reasoning_output ?? 0),
      status: has("status") ? patch.status : current.status,
      error: has("error") ? patch.error : current.error,
      ended_at: has("endedAt") ? patch.endedAt : current.ended_at,
    };

    this.db.prepare(
      "UPDATE sessions SET process_pid = ?, thread_id = ?, turn_id = ?, effective_model = ?, model_provider = ?, token_input = ?, token_cached_input = ?, token_output = ?, token_reasoning_output = ?, status = ?, error = ?, ended_at = ? WHERE id = ?"
    ).run(
      next.process_pid,
      next.thread_id,
      next.turn_id,
      next.effective_model,
      next.model_provider,
      next.token_input,
      next.token_cached_input,
      next.token_output,
      next.token_reasoning_output,
      next.status,
      next.error,
      next.ended_at,
      sessionId,
    );
  }

  getStepResumeSession(stepId, runtimeName = null) {
    const sid = String(stepId ?? "").trim();
    if (!sid) return null;
    const runtime = String(runtimeName ?? "").trim();
    const row = runtime
      ? this.db
          .prepare(
            `SELECT id, runtime, thread_id, turn_id, status, error, started_at
             FROM sessions
             WHERE step_id = ?
               AND runtime = ?
               AND COALESCE(TRIM(thread_id), '') != ''
             ORDER BY started_at DESC
             LIMIT 1`
          )
          .get(sid, runtime)
      : this.db
          .prepare(
            `SELECT id, runtime, thread_id, turn_id, status, error, started_at
             FROM sessions
             WHERE step_id = ?
               AND COALESCE(TRIM(thread_id), '') != ''
             ORDER BY started_at DESC
             LIMIT 1`
          )
          .get(sid);
    if (!row) return null;

    const errorText = String(row.error ?? "").toLowerCase();
    const reason = errorText.includes("recovered orphaned step after engine restart")
      ? "engine_restart_recovered"
      : "latest_thread";

    return {
      sessionId: String(row.id),
      runtime: String(row.runtime ?? runtime ?? ""),
      threadId: String(row.thread_id ?? ""),
      turnId: String(row.turn_id ?? ""),
      status: String(row.status ?? ""),
      reason,
      startedAt: String(row.started_at ?? ""),
    };
  }

  completeStep(params) {
    const step = this.db
      .prepare("SELECT * FROM steps WHERE id = ? LIMIT 1")
      .get(params.stepId);
    if (!step) return;

    const run = this.getRun(step.run_id);
    if (!run || run.status !== "running") return;

    const now = nowIso();
    const structured = params.structured ?? {};
    const summary = structured.summary ?? params.outputText?.slice(0, 500) ?? "";
    const tokens = params.tokens ?? {};

    this.db.prepare(
      `UPDATE steps
       SET status = 'done',
           output_text = ?,
           output_json = ?,
           summary = ?,
           requested_model = COALESCE(?, requested_model),
           effective_model = COALESCE(?, effective_model),
           model_provider = COALESCE(?, model_provider),
           token_input = ?,
           token_cached_input = ?,
           token_output = ?,
           token_reasoning_output = ?,
           ended_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      params.outputText ?? null,
      JSON.stringify(structured),
      summary,
      params.requestedModel ?? null,
      params.effectiveModel ?? null,
      params.modelProvider ?? null,
      Number(tokens.inputTokens ?? 0),
      Number(tokens.cachedInputTokens ?? 0),
      Number(tokens.outputTokens ?? 0),
      Number(tokens.reasoningOutputTokens ?? 0),
      now,
      now,
      step.id,
    );

    const context = safeJsonParse(run.context_json, {
      task: run.task,
      stepOutputs: {},
    });
    if (!context.stepOutputs) context.stepOutputs = {};

    context.stepOutputs[step.step_key] = {
      status: structured.status ?? "done",
      summary,
      outputs:
        typeof structured.outputs === "string"
          ? { text: structured.outputs }
          : (structured.outputs ?? {}),
      notes: structured.notes ?? [],
    };

    let runPr = null;
    const project = this.getProject(run.project_id);
    if (
      run.github_issue_id
      && project
      && (
        step.step_key === "implement"
        || step.step_key === "test"
        || step.step_key === "review"
      )
    ) {
      runPr = this.ensureRunPullRequest({
        run,
        step,
        project,
        context,
      });
    }

    this.db
      .prepare("UPDATE runs SET context_json = ?, current_step_index = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(context), step.step_index, now, run.id);

    const artifacts = Array.isArray(structured.artifacts) ? structured.artifacts : [];
    if (artifacts.length > 0) {
      const insertArtifact = this.db.prepare(
        "INSERT INTO artifacts (id, run_id, step_id, kind, title, content, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const art of artifacts) {
        insertArtifact.run(
          newId("artifact"),
          run.id,
          step.id,
          String(art.kind ?? "note"),
          String(art.title ?? "Untitled"),
          String(art.content ?? ""),
          null,
          now,
        );
      }
    }

    if (step.step_key === "cleanup" && project) {
      this.persistCleanupSkillCandidates({
        run,
        step,
        project,
        structured,
        artifacts,
        now,
      });
    }

    this.emitEvent(run.id, step.id, "step.done", {
      stepId: step.id,
      stepKey: step.step_key,
      summary,
      status: structured.status ?? "done",
    });
    if (run.github_issue_id) {
      this.syncGitHubRunProgressComments({
        phase: "step_done",
        run,
        step,
        project: project ?? undefined,
        pr: runPr,
        summary,
        status: structured.status ?? "done",
      });
    }

    const runSteps = this.db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC")
      .all(run.id);

    const doneKeys = new Set(
      runSteps
        .filter((row) => row.status === "done")
        .map((row) => row.step_key)
    );

    const waitingSteps = runSteps.filter((row) => row.status === "waiting");
    for (const waitingStep of waitingSteps) {
      const dependsOn = safeJsonParse(waitingStep.depends_on_json, []);
      const deps = Array.isArray(dependsOn) ? dependsOn : [];
      const ready = deps.every((depKey) => doneKeys.has(String(depKey)));
      if (!ready) continue;

      const nextInput = this.renderStepInput(
        waitingStep.step_key,
        context,
        waitingStep.template_key ?? waitingStep.step_key,
        {
          attempt: Number(waitingStep.retry_count ?? 0) + 1,
          maxAttempts: Number(waitingStep.max_retries ?? 0) + 1,
          stepPolicy: getStepPolicyFromContext(context, waitingStep.step_key),
        },
      );
      this.db.prepare(
        "UPDATE steps SET status = 'pending', input_text = ?, updated_at = ? WHERE id = ?"
      ).run(nextInput, now, waitingStep.id);

      this.emitEvent(run.id, waitingStep.id, "step.pending", {
        stepId: waitingStep.id,
        stepKey: waitingStep.step_key,
        agentId: waitingStep.agent_id,
      });
    }

    const openCount = Number(
      this.db
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ? AND status != 'done'")
        .get(run.id)?.count ?? 0
    );
    if (openCount === 0) {
      const requiresPullRequestGate = runRequiresPullRequestGate(run, runSteps);
      let completionPr = runPr?.number ? runPr : null;

      if (requiresPullRequestGate) {
        if (project) {
          completionPr = completionPr?.number
            ? completionPr
            : this.ensureRunPullRequest({
                run,
                step,
                project,
                context,
              });
          completionPr = completionPr?.number
            ? completionPr
            : this.findRunPullRequest({
                run,
                project,
                step,
              });
        }
        if (!completionPr?.number) {
          const completionError = "run completion blocked: missing pull request for issue-bound delivery run";
          this.db
            .prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?")
            .run(now, run.id);
          this.emitEvent(run.id, step.id, "run.completion.blocked", {
            runId: run.id,
            issueId: run.github_issue_id,
            branch: run.worktree_branch ?? "",
            reason: "no_pr_for_branch",
            detail: project
              ? "unable to resolve or create pull request for run branch"
              : "project context missing",
          });
          this.emitEvent(run.id, step.id, "run.failed", {
            runId: run.id,
            stepId: step.id,
            error: completionError,
          });
          if (run.github_issue_id) {
            this.syncGitHubIssueAutomationStamp({
              projectId: run.project_id,
              runId: run.id,
              issueId: run.github_issue_id,
              state: "failed",
            });
            this.syncGitHubRunProgressComments({
              phase: "run_failed",
              run: {
                ...run,
                status: "failed",
                updated_at: now,
              },
              step,
              error: completionError,
            });
          }
          return;
        }
      }

      this.db
        .prepare("UPDATE runs SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, run.id);
      const completedRun = {
        ...run,
        status: "completed",
        updated_at: now,
      };
      this.emitEvent(run.id, step.id, "run.completed", {
        runId: run.id,
      });
      if (run.github_issue_id) {
        this.syncGitHubIssueAutomationStamp({
          projectId: run.project_id,
          runId: run.id,
          issueId: run.github_issue_id,
          state: "completed",
        });
        const finalSteps = this.db
          .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC")
          .all(run.id);
        this.syncGitHubRunProgressComments({
          phase: "run_completed",
          run: completedRun,
          steps: finalSteps,
        });
        const latestPr = completionPr?.number
          ? completionPr
          : this.findRunPullRequest({
              run: completedRun,
              project: project ?? undefined,
              step,
            });
        const autoMerge = this.tryAutoMergeRunAfterCompletion({
          run: completedRun,
          project: project ?? undefined,
          context,
          stepId: step.id,
          pr: latestPr,
        });
        this.syncRunMainlineAfterPrMerge({
          run: completedRun,
          project: project ?? undefined,
          stepId: step.id,
          emitDeferred: true,
          emitSkipped: true,
          emitFailure: true,
          pr: autoMerge?.pr ?? latestPr ?? null,
        });
      }
    }
  }

  retryOrFailStep(params) {
    const step = this.db
      .prepare("SELECT * FROM steps WHERE id = ? LIMIT 1")
      .get(params.stepId);
    if (!step) return;

    const run = this.getRun(step.run_id);
    if (!run || run.status !== "running") return;

    const now = nowIso();
    const retryCount = Number(step.retry_count ?? 0) + 1;
    const maxRetries = Number(step.max_retries ?? 0);
    const context = safeJsonParse(run.context_json, {});
    const stepPolicy = getStepPolicyFromContext(context, step.step_key);
    const reviewAutoFix = stepPolicy.reviewAutoFix && typeof stepPolicy.reviewAutoFix === "object"
      ? normalizeReviewAutoFixPolicy(stepPolicy.reviewAutoFix)
      : null;

    if (retryCount <= maxRetries) {
      const nextInput = this.renderStepInput(
        step.step_key,
        context,
        step.template_key ?? step.step_key,
        {
          attempt: retryCount + 1,
          maxAttempts: maxRetries + 1,
          stepPolicy,
        },
      );
      this.db.prepare(
        "UPDATE steps SET status = 'pending', retry_count = ?, error = ?, input_text = ?, updated_at = ? WHERE id = ?"
      ).run(retryCount, params.error ?? "retry", nextInput, now, step.id);

      this.emitEvent(run.id, step.id, "step.retry", {
        stepId: step.id,
        stepKey: step.step_key,
        retryCount,
        maxRetries,
        error: params.error ?? "retry",
      });

      if (step.step_key === "review" && reviewAutoFix?.enabled) {
        this.emitEvent(run.id, step.id, "review.auto_fix.retry_scheduled", {
          stepId: step.id,
          stepKey: step.step_key,
          retryCount,
          maxRetries,
          nextAttempt: retryCount + 1,
          maxAttempts: maxRetries + 1,
          budget: {
            maxFiles: reviewAutoFix.maxFiles,
            maxLines: reviewAutoFix.maxLines,
            allowlist: reviewAutoFix.allowlist,
          },
          error: params.error ?? "retry",
        });
      }
      return;
    }

    this.db.prepare(
      "UPDATE steps SET status = 'failed', retry_count = ?, error = ?, ended_at = ?, updated_at = ? WHERE id = ?"
    ).run(retryCount, params.error ?? "failed", now, now, step.id);

    this.db
      .prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(now, run.id);

    this.emitEvent(run.id, step.id, "step.failed", {
      stepId: step.id,
      stepKey: step.step_key,
      error: params.error ?? "failed",
    });

    this.emitEvent(run.id, step.id, "run.failed", {
      runId: run.id,
      stepId: step.id,
      error: params.error ?? "failed",
    });
    if (step.step_key === "review" && reviewAutoFix?.enabled) {
      this.emitEvent(run.id, step.id, "review.auto_fix.exhausted", {
        stepId: step.id,
        stepKey: step.step_key,
        retryCount,
        maxRetries,
        attemptsUsed: retryCount,
        maxAttempts: maxRetries + 1,
        error: params.error ?? "failed",
      });
    }
    if (run.github_issue_id) {
      this.syncGitHubIssueAutomationStamp({
        projectId: run.project_id,
        runId: run.id,
        issueId: run.github_issue_id,
        state: "failed",
      });
      this.syncGitHubRunProgressComments({
        phase: "run_failed",
        run: {
          ...run,
          status: "failed",
          updated_at: now,
        },
        step,
        error: params.error ?? "failed",
      });
    }
  }

  resumeRun(runId) {
    const run = this.getRun(runId);
    if (!run) return false;
    if (run.status === "failed") {
      return this.resumeFailedRun(run);
    }
    if (run.status === "paused") {
      return this.resumePausedRun(run);
    }
    return false;
  }

  stopRuns(params = {}) {
    const projectId = String(params?.projectId ?? "").trim();
    const rows = projectId
      ? this.db
          .prepare(
            "SELECT id FROM runs WHERE status = 'running' AND project_id = ? ORDER BY created_at ASC"
          )
          .all(projectId)
      : this.db
          .prepare("SELECT id FROM runs WHERE status = 'running' ORDER BY created_at ASC")
          .all();

    let changed = 0;
    const failed = [];
    for (const row of rows) {
      const runId = String(row?.id ?? "").trim();
      if (!runId) continue;
      if (this.stopRun(runId)) {
        changed += 1;
      } else {
        failed.push(runId);
      }
    }
    return {
      total: rows.length,
      changed,
      failed,
      projectId: projectId || null,
    };
  }

  resumePausedRuns(params = {}) {
    const projectId = String(params?.projectId ?? "").trim();
    const rows = projectId
      ? this.db
          .prepare(
            "SELECT id FROM runs WHERE status = 'paused' AND project_id = ? ORDER BY created_at ASC"
          )
          .all(projectId)
      : this.db
          .prepare("SELECT id FROM runs WHERE status = 'paused' ORDER BY created_at ASC")
          .all();

    let changed = 0;
    const failed = [];
    for (const row of rows) {
      const runId = String(row?.id ?? "").trim();
      if (!runId) continue;
      if (this.resumeRun(runId)) {
        changed += 1;
      } else {
        failed.push(runId);
      }
    }
    return {
      total: rows.length,
      changed,
      failed,
      projectId: projectId || null,
    };
  }

  stopRun(runId) {
    const run = this.getRun(runId);
    if (!run || run.status !== "running") return false;

    const now = nowIso();
    const runningSteps = this.db
      .prepare(
        `SELECT s.id, s.step_key, s.runtime_session_id, se.id AS session_id, se.process_pid
         FROM steps s
         LEFT JOIN sessions se ON se.id = s.runtime_session_id
         WHERE s.run_id = ?
           AND s.status = 'running'
         ORDER BY s.step_index ASC`
      )
      .all(run.id);

    let signaledCount = 0;
    for (const row of runningSteps) {
      const result = signalProcess(row.process_pid, "SIGSTOP");
      if (result.ok) {
        signaledCount += 1;
      }
      if (row.session_id) {
        this.updateSession(row.session_id, {
          status: "paused",
          error: result.ok ? "Manually paused by operator" : `Pause signal failed: ${result.error}`,
        });
      }
      this.emitEvent(run.id, row.id, "run.stop.signal", {
        runId: run.id,
        stepId: row.id,
        stepKey: row.step_key,
        processPid: row.process_pid ?? null,
        signal: "SIGSTOP",
        ok: result.ok,
        error: result.error,
      });
    }

    this.db.prepare("UPDATE runs SET status = 'paused', updated_at = ? WHERE id = ?").run(now, run.id);
    this.emitEvent(run.id, null, "run.paused", {
      runId: run.id,
      runningStepCount: runningSteps.length,
      signaledCount,
    });
    if (run.github_issue_id) {
      this.syncGitHubIssueAutomationStamp({
        projectId: run.project_id,
        runId: run.id,
        issueId: run.github_issue_id,
        state: "paused",
      });
    }
    return true;
  }

  resumeFailedRun(run) {
    if (!run || run.status !== "failed") return false;

    const failedStep = this.db
      .prepare(
        "SELECT * FROM steps WHERE run_id = ? AND status = 'failed' ORDER BY step_index ASC LIMIT 1"
      )
      .get(run.id);

    if (!failedStep) return false;
    const now = nowIso();
    const context = safeJsonParse(run.context_json, {});
    const stepPolicy = getStepPolicyFromContext(context, failedStep.step_key);
    const nextInput = this.renderStepInput(
      failedStep.step_key,
      context,
      failedStep.template_key ?? failedStep.step_key,
      {
        attempt: Number(failedStep.retry_count ?? 0) + 1,
        maxAttempts: Number(failedStep.max_retries ?? 0) + 1,
        stepPolicy,
      },
    );

    this.db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").run(now, run.id);
    this.db.prepare("UPDATE steps SET status = 'pending', error = NULL, input_text = ?, updated_at = ? WHERE id = ?").run(nextInput, now, failedStep.id);

    this.emitEvent(run.id, failedStep.id, "run.resumed", {
      runId: run.id,
      stepId: failedStep.id,
      stepKey: failedStep.step_key,
      mode: "failed_retry",
    });
    if (run.github_issue_id) {
      this.syncGitHubIssueAutomationStamp({
        projectId: run.project_id,
        runId: run.id,
        issueId: run.github_issue_id,
        state: "queued",
      });
    }
    return true;
  }

  resumePausedRun(run) {
    if (!run || run.status !== "paused") return false;
    const now = nowIso();
    const runningSteps = this.db
      .prepare(
        `SELECT s.id, s.step_key, s.runtime_session_id, se.id AS session_id, se.process_pid
         FROM steps s
         LEFT JOIN sessions se ON se.id = s.runtime_session_id
         WHERE s.run_id = ?
           AND s.status = 'running'
         ORDER BY s.step_index ASC`
      )
      .all(run.id);

    let continuedCount = 0;
    for (const row of runningSteps) {
      const result = signalProcess(row.process_pid, "SIGCONT");
      if (result.ok) {
        continuedCount += 1;
      }
      this.emitEvent(run.id, row.id, "run.resume.signal", {
        runId: run.id,
        stepId: row.id,
        stepKey: row.step_key,
        processPid: row.process_pid ?? null,
        signal: "SIGCONT",
        ok: result.ok,
        error: result.error,
      });
    }

    if (continuedCount === 0 && runningSteps.length > 0) {
      for (const row of runningSteps) {
        const step = this.db.prepare("SELECT * FROM steps WHERE id = ? LIMIT 1").get(row.id);
        if (!step) continue;
        const context = safeJsonParse(run.context_json, {});
        const stepPolicy = getStepPolicyFromContext(context, step.step_key);
        const nextInput = this.renderStepInput(
          step.step_key,
          context,
          step.template_key ?? step.step_key,
          {
            attempt: Number(step.retry_count ?? 0) + 1,
            maxAttempts: Number(step.max_retries ?? 0) + 1,
            stepPolicy,
          },
        );
        this.db.prepare(
          "UPDATE steps SET status = 'pending', started_at = NULL, input_text = ?, updated_at = ? WHERE id = ?"
        ).run(nextInput, now, row.id);
        if (row.session_id) {
          this.updateSession(row.session_id, {
            status: "failed",
            error: "Pause-resume fallback: process missing, switching to thread resume",
            endedAt: now,
          });
        }
      }
      this.emitEvent(run.id, null, "run.resume.fallback", {
        runId: run.id,
        reason: "no_live_process",
      });
    } else {
      for (const row of runningSteps) {
        if (!row.session_id) continue;
        this.updateSession(row.session_id, {
          status: "running",
          error: null,
        });
      }
    }

    this.db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").run(now, run.id);
    this.emitEvent(run.id, null, "run.resumed", {
      runId: run.id,
      mode: continuedCount > 0 ? "process_continue" : "thread_resume",
      runningStepCount: runningSteps.length,
      continuedCount,
    });
    if (run.github_issue_id) {
      this.syncGitHubIssueAutomationStamp({
        projectId: run.project_id,
        runId: run.id,
        issueId: run.github_issue_id,
        state: continuedCount > 0 ? "running" : "queued",
      });
    }
    return true;
  }

  emitEvent(runId, stepId, eventType, payload) {
    const ts = nowIso();
    const inserted = this.db
      .prepare("INSERT INTO events (run_id, step_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(runId, stepId, ts, eventType, JSON.stringify(payload ?? {}));
    const id = Number(inserted.lastInsertRowid ?? 0);
    const info = {
      id,
      runId,
      stepId,
      ts,
      eventType,
      payload,
    };
    this.events.emit("event", info);
  }

  hasRunEvent(runId, eventType, stepId = null) {
    if (!runId || !eventType) return false;
    const row = stepId
      ? this.db
          .prepare(
            "SELECT id FROM events WHERE run_id = ? AND step_id = ? AND event_type = ? LIMIT 1"
          )
          .get(runId, stepId, eventType)
      : this.db
          .prepare("SELECT id FROM events WHERE run_id = ? AND event_type = ? LIMIT 1")
          .get(runId, eventType);
    return Boolean(row);
  }

  persistCleanupSkillCandidates(params) {
    const run = params?.run;
    const step = params?.step;
    const project = params?.project;
    if (!run?.id || !step?.id || !project?.root_path) {
      return [];
    }

    const structuredCandidates = collectStructuredSkillCandidates(params?.structured);
    const artifactCandidates = collectArtifactSkillCandidates(params?.artifacts);
    const runContext = safeJsonParse(run.context_json, {});
    const inferredCleanupMode = String(run.workflow_id ?? "").trim() === "forgeops-cleanup-deep-v1"
      ? "deep"
      : "lite";
    let cleanupContext = runContext?.cleanupContext && typeof runContext.cleanupContext === "object"
      ? runContext.cleanupContext
      : null;
    if (!cleanupContext) {
      try {
        cleanupContext = this.buildCleanupRunContext({
          projectId: project.id,
          mode: inferredCleanupMode,
          trigger: "inline-cleanup",
          task: run.task,
          now: params?.now ?? nowIso(),
          excludeRunId: run.id,
        });
      } catch {
        cleanupContext = null;
      }
    }
    const eventSeedCandidates = this.buildEventDerivedSkillCandidates({
      run,
      step,
      project,
      cleanupContext,
    });
    const candidates = [];
    const titleKeys = new Set();
    const pushCandidate = (candidate) => {
      if (!candidate || typeof candidate !== "object") return;
      const title = String(candidate.title ?? "").trim();
      const content = String(candidate.content ?? "").trim();
      if (!title || !content) return;
      const titleKey = normalizeCandidateTitleKey(title);
      if (titleKey && titleKeys.has(titleKey)) return;
      if (titleKey) titleKeys.add(titleKey);
      candidates.push({
        ...candidate,
        title,
        content,
      });
    };
    for (const candidate of structuredCandidates) pushCandidate(candidate);
    for (const candidate of artifactCandidates) pushCandidate(candidate);
    for (const candidate of eventSeedCandidates) pushCandidate(candidate);

    if (candidates.length === 0) {
      return [];
    }

    const outputDir = path.join(project.root_path, ".forgeops", "skills", "candidates");
    fs.mkdirSync(outputDir, { recursive: true });

    const timestamp = toCandidateFileTimestamp(params?.now ?? nowIso());
    const persisted = [];
    const usedNames = new Set();

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const title = String(candidate.title ?? "").trim() || `Skill Candidate ${index + 1}`;
      const slug = slugify(title) || `candidate-${index + 1}`;
      let fileName = `${timestamp}-${slug}.md`;
      let suffix = 1;
      while (usedNames.has(fileName) || fs.existsSync(path.join(outputDir, fileName))) {
        suffix += 1;
        fileName = `${timestamp}-${slug}-${suffix}.md`;
      }
      usedNames.add(fileName);

      const absolutePath = path.join(outputDir, fileName);
      const relativePath = path.relative(project.root_path, absolutePath);
      const extraMetadata = normalizeCandidateMetadata(candidate.metadata);
      const extraMetadataRows = Object.entries(extraMetadata).map(
        ([key, value]) => `- ${key}: ${value}`
      );
      const markdown = [
        "# Skill Candidate",
        "",
        `- title: ${title}`,
        `- source: ${String(candidate.source ?? "cleanup")}`,
        `- project: ${project.id}`,
        `- run: ${run.id}`,
        `- step: ${step.step_key}`,
        `- issue: ${String(run.github_issue_id ?? "-") || "-"}`,
        `- generated_at: ${String(params?.now ?? nowIso())}`,
        ...extraMetadataRows,
        "",
        "## Content",
        String(candidate.content ?? "").trim(),
        "",
      ].join("\n");
      fs.writeFileSync(absolutePath, markdown, "utf8");

      this.addArtifact({
        runId: run.id,
        stepId: step.id,
        kind: "skill-candidate-file",
        title,
        content: clipText(candidate.content, 320),
        path: relativePath,
      });
      this.emitEvent(run.id, step.id, "skills.candidate.persisted", {
        runId: run.id,
        stepId: step.id,
        issueId: String(run.github_issue_id ?? ""),
        title,
        path: relativePath,
      });
      persisted.push({
        title,
        path: relativePath,
      });
    }

    if (eventSeedCandidates.length > 0) {
      this.emitEvent(run.id, step.id, "skills.candidate.event_seeded", {
        runId: run.id,
        stepId: step.id,
        issueId: String(run.github_issue_id ?? ""),
        count: eventSeedCandidates.length,
        titles: eventSeedCandidates.map((row) => String(row.title ?? "").trim()).filter(Boolean),
      });
    }

    this.emitEvent(run.id, step.id, "skills.candidate.summary", {
      runId: run.id,
      stepId: step.id,
      count: persisted.length,
      structuredCount: structuredCandidates.length,
      artifactCount: artifactCandidates.length,
      eventSeedCount: eventSeedCandidates.length,
      paths: persisted.map((item) => item.path),
    });

    return persisted;
  }

  addArtifact(params) {
    const now = nowIso();
    this.db.prepare(
      "INSERT INTO artifacts (id, run_id, step_id, kind, title, content, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      newId("artifact"),
      params.runId,
      params.stepId,
      String(params.kind ?? "note"),
      params.title ? String(params.title) : null,
      params.content ? String(params.content) : null,
      params.path ? String(params.path) : null,
      now,
    );
  }

  listEvents(runId, sinceId = 0) {
    if (runId) {
      return this.db
        .prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC")
        .all(runId, sinceId)
        .map((row) => ({ ...row, payload: safeJsonParse(row.payload_json, {}) }));
    }

    return this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC")
      .all(sinceId)
      .map((row) => ({ ...row, payload: safeJsonParse(row.payload_json, {}) }));
  }

  collectProjectEventWindowStats(params = {}) {
    const projectId = String(params?.projectId ?? "").trim();
    if (!projectId) {
      return {
        projectId: "",
        since: "",
        until: "",
        eventCounts: {},
        retryByStep: [],
        failedByStep: [],
      };
    }

    const nowMs = parseTimeMs(params?.until ?? nowIso()) || Date.now();
    const lookbackDaysRaw = Number(params?.lookbackDays ?? CLEANUP_CONTEXT_DEFAULT_LOOKBACK_DAYS);
    const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0
      ? Math.floor(lookbackDaysRaw)
      : CLEANUP_CONTEXT_DEFAULT_LOOKBACK_DAYS;
    const sinceMsRaw = parseTimeMs(params?.since);
    const sinceMs = sinceMsRaw > 0
      ? sinceMsRaw
      : Math.max(0, nowMs - (lookbackDays * 24 * 60 * 60 * 1000));
    const since = toIsoFromMs(sinceMs);
    const until = toIsoFromMs(nowMs);
    const projectPayloadMatch = `%\"projectId\":\"${projectId}\"%`;

    const eventCounter = new Map();
    const addRows = (rows) => {
      for (const row of rows) {
        const eventType = String(row?.event_type ?? "").trim();
        if (!eventType) continue;
        const count = normalizeCount(row?.count);
        if (count <= 0) continue;
        eventCounter.set(eventType, normalizeCount(eventCounter.get(eventType)) + count);
      }
    };

    const runScopedRows = this.db
      .prepare(
        `SELECT e.event_type AS event_type, COUNT(1) AS count
         FROM events e
         JOIN runs r ON r.id = e.run_id
         WHERE r.project_id = ?
           AND e.ts >= ?
           AND e.ts < ?
         GROUP BY e.event_type`
      )
      .all(projectId, since, until);
    addRows(runScopedRows);

    const projectScopedRows = this.db
      .prepare(
        `SELECT event_type, COUNT(1) AS count
         FROM events
         WHERE run_id IS NULL
           AND ts >= ?
           AND ts < ?
           AND payload_json LIKE ?
         GROUP BY event_type`
      )
      .all(since, until, projectPayloadMatch);
    addRows(projectScopedRows);

    const retryByStep = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(s.step_key), ''), 'unknown') AS step_key, COUNT(1) AS count
         FROM events e
         JOIN steps s ON s.id = e.step_id
         JOIN runs r ON r.id = e.run_id
         WHERE r.project_id = ?
           AND e.event_type = 'step.retry'
           AND e.ts >= ?
           AND e.ts < ?
         GROUP BY s.step_key
         ORDER BY count DESC, s.step_key ASC`
      )
      .all(projectId, since, until)
      .map((row) => ({
        stepKey: String(row?.step_key ?? "unknown").trim() || "unknown",
        count: normalizeCount(row?.count),
      }))
      .filter((row) => row.count > 0);

    const failedByStep = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(s.step_key), ''), 'unknown') AS step_key, COUNT(1) AS count
         FROM events e
         JOIN steps s ON s.id = e.step_id
         JOIN runs r ON r.id = e.run_id
         WHERE r.project_id = ?
           AND e.event_type = 'step.failed'
           AND e.ts >= ?
           AND e.ts < ?
         GROUP BY s.step_key
         ORDER BY count DESC, s.step_key ASC`
      )
      .all(projectId, since, until)
      .map((row) => ({
        stepKey: String(row?.step_key ?? "unknown").trim() || "unknown",
        count: normalizeCount(row?.count),
      }))
      .filter((row) => row.count > 0);

    return {
      projectId,
      since,
      until,
      eventCounts: Object.fromEntries(eventCounter.entries()),
      retryByStep,
      failedByStep,
    };
  }

  buildCleanupRunContext(params = {}) {
    const projectId = String(params?.projectId ?? "").trim();
    if (!projectId) {
      throw new Error("projectId is required");
    }

    const mode = String(params?.mode ?? "deep").trim().toLowerCase() === "lite"
      ? "lite"
      : "deep";
    const trigger = String(params?.trigger ?? "").trim() || "manual";
    const task = String(params?.task ?? "").trim();
    const excludeRunId = String(params?.excludeRunId ?? "").trim();
    const nowMs = parseTimeMs(params?.now ?? nowIso()) || Date.now();
    const now = toIsoFromMs(nowMs);
    const lookbackDaysRaw = Number(params?.lookbackDays ?? CLEANUP_CONTEXT_DEFAULT_LOOKBACK_DAYS);
    const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0
      ? Math.floor(lookbackDaysRaw)
      : CLEANUP_CONTEXT_DEFAULT_LOOKBACK_DAYS;

    const baselineQueryBase = `SELECT
        r.id AS run_id,
        r.workflow_id AS workflow_id,
        r.updated_at AS run_updated_at,
        s.summary AS step_summary,
        s.ended_at AS step_ended_at
      FROM runs r
      JOIN steps s ON s.run_id = r.id
      WHERE r.project_id = ?
        AND s.step_key = 'cleanup'
        AND s.status = 'done'`;
    const baselineRow = excludeRunId
      ? this.db
          .prepare(
            `${baselineQueryBase}
             AND r.id != ?
             ORDER BY COALESCE(NULLIF(s.ended_at, ''), r.updated_at) DESC
             LIMIT 1`
          )
          .get(projectId, excludeRunId)
      : this.db
          .prepare(
            `${baselineQueryBase}
             ORDER BY COALESCE(NULLIF(s.ended_at, ''), r.updated_at) DESC
             LIMIT 1`
          )
          .get(projectId);

    const baselineAt = String(
      baselineRow?.step_ended_at
      ?? baselineRow?.run_updated_at
      ?? ""
    ).trim();
    const baselineAtMs = parseTimeMs(baselineAt);
    const defaultWindowStartMs = Math.max(0, nowMs - (lookbackDays * 24 * 60 * 60 * 1000));
    const windowStartMs = baselineAtMs > 0 ? baselineAtMs : defaultWindowStartMs;
    const windowStart = toIsoFromMs(windowStartMs);

    const eventStats = this.collectProjectEventWindowStats({
      projectId,
      since: windowStart,
      until: now,
      lookbackDays,
    });
    const eventCounts = eventStats.eventCounts && typeof eventStats.eventCounts === "object"
      ? eventStats.eventCounts
      : {};
    const sumByMatcher = (matcher) => Object.entries(eventCounts)
      .reduce((acc, [eventType, count]) => (matcher(eventType) ? acc + normalizeCount(count) : acc), 0);

    const runStatusRows = this.db
      .prepare(
        `SELECT status, COUNT(1) AS count
         FROM runs
         WHERE project_id = ?
           AND created_at >= ?
           AND created_at < ?
         GROUP BY status`
      )
      .all(projectId, windowStart, now);
    const runStatusCounter = {};
    let totalRuns = 0;
    for (const row of runStatusRows) {
      const status = String(row?.status ?? "").trim() || "unknown";
      const count = normalizeCount(row?.count);
      runStatusCounter[status] = count;
      totalRuns += count;
    }

    const stepRetryEvents = normalizeCount(eventCounts["step.retry"]);
    const stepFailedEvents = normalizeCount(eventCounts["step.failed"]);
    const docsCheckPassed = normalizeCount(eventCounts["docs.check.passed"]);
    const docsCheckFailed = normalizeCount(eventCounts["docs.check.failed"]);
    const schedulerMissedRecoveryStarted = sumByMatcher((eventType) => eventType.endsWith(".missed_recovery_started"));
    const schedulerMissedRecoveryFailed = sumByMatcher((eventType) => eventType.endsWith(".missed_recovery_failed"));
    const schedulerCleanupSkippedBusy = normalizeCount(eventCounts["scheduler.cleanup.skipped_busy"]);
    const schedulerCleanupSkippedInflight = normalizeCount(eventCounts["scheduler.cleanup.skipped_inflight"]);
    const projectPromoted = normalizeCount(eventCounts["skills.promotion.created"]);
    const globalPromoted = normalizeCount(eventCounts["skills.global.promoted"]);
    const projectPromotionTickFailed = normalizeCount(eventCounts["scheduler.skill_promotion.tick_failed"]);
    const globalPromotionTickFailed = normalizeCount(eventCounts["scheduler.global_skill_promotion.tick_failed"]);

    const failureEvents = toCounterRows(
      eventCounts,
      (eventType) => eventType.includes("failed") || eventType.includes("retry"),
      6
    );
    const successEvents = toCounterRows(
      eventCounts,
      (eventType) => eventType.endsWith(".completed") || eventType.endsWith(".done") || eventType === "run.completed",
      6
    );

    const baselineRunId = String(baselineRow?.run_id ?? "").trim();
    return {
      mode,
      trigger,
      task,
      generatedAt: now,
      baseline: {
        available: Boolean(baselineRunId),
        runId: baselineRunId || "",
        workflowId: String(baselineRow?.workflow_id ?? "").trim(),
        at: baselineAtMs > 0 ? toIsoFromMs(baselineAtMs) : "",
        summary: clipText(String(baselineRow?.step_summary ?? "").trim(), 320),
      },
      delta: {
        windowStart,
        windowEnd: now,
        windowDays: Number(((nowMs - windowStartMs) / (24 * 60 * 60 * 1000)).toFixed(2)),
        runs: {
          total: totalRuns,
          completed: normalizeCount(runStatusCounter.completed),
          failed: normalizeCount(runStatusCounter.failed),
          running: normalizeCount(runStatusCounter.running),
          paused: normalizeCount(runStatusCounter.paused),
          stepRetryEvents,
          stepFailedEvents,
        },
        docs: {
          passed: docsCheckPassed,
          failed: docsCheckFailed,
        },
        scheduler: {
          missedRecoveryStarted: schedulerMissedRecoveryStarted,
          missedRecoveryFailed: schedulerMissedRecoveryFailed,
          cleanupSkippedBusy: schedulerCleanupSkippedBusy,
          cleanupSkippedInflight: schedulerCleanupSkippedInflight,
        },
        promotions: {
          projectPromoted,
          globalPromoted,
          projectTickFailed: projectPromotionTickFailed,
          globalTickFailed: globalPromotionTickFailed,
        },
        hotspots: {
          retrySteps: eventStats.retryByStep.slice(0, 6),
          failedSteps: eventStats.failedByStep.slice(0, 6),
          failureEvents,
          successEvents,
        },
      },
    };
  }

  buildEventDerivedSkillCandidates(params = {}) {
    const cleanupContext = params?.cleanupContext && typeof params.cleanupContext === "object"
      ? params.cleanupContext
      : null;
    const delta = cleanupContext?.delta && typeof cleanupContext.delta === "object"
      ? cleanupContext.delta
      : null;
    if (!delta) return [];

    const windowStart = String(delta.windowStart ?? "").trim();
    const windowEnd = String(delta.windowEnd ?? "").trim();
    const runs = delta.runs && typeof delta.runs === "object" ? delta.runs : {};
    const docs = delta.docs && typeof delta.docs === "object" ? delta.docs : {};
    const scheduler = delta.scheduler && typeof delta.scheduler === "object" ? delta.scheduler : {};
    const promotions = delta.promotions && typeof delta.promotions === "object" ? delta.promotions : {};
    const hotspots = delta.hotspots && typeof delta.hotspots === "object" ? delta.hotspots : {};
    const retrySteps = Array.isArray(hotspots.retrySteps) ? hotspots.retrySteps : [];
    const failedSteps = Array.isArray(hotspots.failedSteps) ? hotspots.failedSteps : [];
    const failureEvents = Array.isArray(hotspots.failureEvents) ? hotspots.failureEvents : [];
    const successEvents = Array.isArray(hotspots.successEvents) ? hotspots.successEvents : [];

    const runFailed = normalizeCount(runs.failed);
    const runCompleted = normalizeCount(runs.completed);
    const stepRetryEvents = normalizeCount(runs.stepRetryEvents);
    const stepFailedEvents = normalizeCount(runs.stepFailedEvents);
    const docsFailed = normalizeCount(docs.failed);
    const missedRecoveryStarted = normalizeCount(scheduler.missedRecoveryStarted);
    const promotionTickFailed = normalizeCount(promotions.projectTickFailed) + normalizeCount(promotions.globalTickFailed);

    const candidates = [];
    const pushCandidate = (params2) => {
      const title = String(params2?.title ?? "").trim();
      const content = String(params2?.content ?? "").trim();
      if (!title || !content) return;
      candidates.push({
        title,
        content,
        source: "events",
        metadata: normalizeCandidateMetadata({
          category: String(params2?.category ?? "event-seed"),
          trigger: String(cleanupContext.trigger ?? "cleanup"),
          mode: String(cleanupContext.mode ?? "lite"),
          window_start: windowStart,
          window_end: windowEnd,
        }),
        __priority: normalizeCount(params2?.priority),
      });
    };

    const retryStepText = retrySteps.length > 0
      ? retrySteps.slice(0, 3).map((item) => `${item.stepKey}:${normalizeCount(item.count)}`).join(", ")
      : "-";
    const failedStepText = failedSteps.length > 0
      ? failedSteps.slice(0, 3).map((item) => `${item.stepKey}:${normalizeCount(item.count)}`).join(", ")
      : "-";
    const failureEventText = failureEvents.length > 0
      ? failureEvents.slice(0, 4).map((item) => `${item.eventType}:${normalizeCount(item.count)}`).join(", ")
      : "-";
    const successEventText = successEvents.length > 0
      ? successEvents.slice(0, 4).map((item) => `${item.eventType}:${normalizeCount(item.count)}`).join(", ")
      : "-";

    if (runFailed > 0 || stepFailedEvents > 0 || stepRetryEvents >= 3) {
      pushCandidate({
        title: "Failure Hotspot Hardening Playbook",
        category: "failure-hotspots",
        priority: 100 + runFailed + stepFailedEvents,
        content: [
          "## Problem",
          `- Repeated failure/retry signals appeared in cleanup window (${windowStart} -> ${windowEnd}).`,
          `- Run failed count: ${runFailed}; step failed events: ${stepFailedEvents}; step retry events: ${stepRetryEvents}.`,
          "",
          "## Approach",
          "- Convert recurring failure hotspots into mechanical checks (preflight/lint/test scripts) before risky steps.",
          "- Add deterministic guardrails for top failing steps and standardize remediation notes into reusable checklists.",
          "",
          "## Evidence",
          `- Failure events: ${failureEventText}`,
          `- Failed steps: ${failedStepText}`,
          `- Retry hotspots: ${retryStepText}`,
          "",
          "## Adoption Scope",
          "- Apply to implement/test/review entry checks and retry-heavy step templates first.",
        ].join("\n"),
      });
    }

    if (docsFailed > 0) {
      pushCandidate({
        title: "Docs Drift Guardrail Automation",
        category: "docs-drift",
        priority: 80 + docsFailed,
        content: [
          "## Problem",
          "- Documentation drift was detected repeatedly during cleanup.",
          `- docs.check.failed count: ${docsFailed}.`,
          "",
          "## Approach",
          "- Promote docs freshness/structure checks into mandatory guardrails in cleanup/test flows.",
          "- Standardize doc map update checklists when workflow/config/files are changed.",
          "",
          "## Evidence",
          `- docs.check.failed: ${docsFailed}`,
          `- Window: ${windowStart} -> ${windowEnd}`,
          "",
          "## Adoption Scope",
          "- Apply to all PRs touching docs/, workflow config, AGENTS.md, and architecture references.",
        ].join("\n"),
      });
    }

    if (missedRecoveryStarted > 0 || promotionTickFailed > 0) {
      pushCandidate({
        title: "Scheduler Recovery And Promotion Resilience",
        category: "scheduler-resilience",
        priority: 70 + missedRecoveryStarted + promotionTickFailed,
        content: [
          "## Problem",
          "- Scheduler recovery or promotion ticks showed instability signals.",
          `- missed_recovery_started: ${missedRecoveryStarted}; promotion tick failures: ${promotionTickFailed}.`,
          "",
          "## Approach",
          "- Add idempotent retry guards and explicit backoff envelopes for scheduler-triggered maintenance tasks.",
          "- Emit structured diagnostics for each failed tick to support deterministic remediation.",
          "",
          "## Evidence",
          `- Failure events: ${failureEventText}`,
          `- Success events: ${successEventText}`,
          "",
          "## Adoption Scope",
          "- Apply to cleanup/skillPromotion/globalSkillPromotion scheduler jobs and recovery handlers.",
        ].join("\n"),
      });
    }

    if (runCompleted >= 3 && runFailed === 0 && stepRetryEvents > 0) {
      pushCandidate({
        title: "Successful Retry Resolution Pattern",
        category: "success-playbook",
        priority: 60 + runCompleted,
        content: [
          "## Problem",
          "- Retries happened but converged to successful delivery; the successful strategy is not yet codified.",
          "",
          "## Approach",
          "- Extract the successful retry sequence into a reusable skill/checklist and reuse it before escalating to manual intervention.",
          "- Preserve commands, checks, and stop conditions as a mechanical retry playbook.",
          "",
          "## Evidence",
          `- run.completed: ${runCompleted}; run.failed: ${runFailed}; step.retry: ${stepRetryEvents}`,
          `- Success events: ${successEventText}`,
          "",
          "## Adoption Scope",
          "- Apply to steps with historical retries where final outcomes are mostly successful.",
        ].join("\n"),
      });
    }

    candidates.sort((left, right) => {
      const lp = normalizeCount(left.__priority);
      const rp = normalizeCount(right.__priority);
      if (rp !== lp) return rp - lp;
      return String(left.title).localeCompare(String(right.title));
    });
    return candidates
      .slice(0, CLEANUP_EVENT_SEED_MAX_CANDIDATES)
      .map((row) => {
        const { __priority, ...rest } = row;
        return rest;
      });
  }

  buildProjectSkillEffectivenessMap(params = {}) {
    const projectId = String(params?.projectId ?? "").trim();
    if (!projectId) return {};
    const candidates = Array.isArray(params?.candidates) ? params.candidates : [];
    const skillNames = new Set();
    for (const candidate of candidates) {
      const skillName = normalizeSkillFeedbackKey(deriveSkillNameFromCandidate(candidate));
      if (!skillName) continue;
      skillNames.add(skillName);
    }
    if (skillNames.size === 0) return {};

    let activeSkillKeys = new Set();
    try {
      const resolved = this.resolveProjectSkills(projectId);
      const out = new Set();
      const byRole = resolved?.agentSkills && typeof resolved.agentSkills === "object"
        ? resolved.agentSkills
        : {};
      for (const roleSkills of Object.values(byRole)) {
        const items = Array.isArray(roleSkills) ? roleSkills : [];
        for (const item of items) {
          const fromName = normalizeSkillFeedbackKey(item?.name);
          if (fromName) out.add(fromName);
          const absPath = String(item?.absolutePath ?? "").trim();
          if (absPath) {
            const fromPath = normalizeSkillFeedbackKey(path.basename(path.dirname(absPath)));
            if (fromPath) out.add(fromPath);
          }
          const relPath = String(item?.path ?? "").trim().replace(/\\/g, "/");
          if (relPath) {
            const fromRel = normalizeSkillFeedbackKey(path.basename(path.dirname(relPath)));
            if (fromRel) out.add(fromRel);
          }
        }
      }
      activeSkillKeys = out;
    } catch {
      activeSkillKeys = new Set();
    }

    const projectPayloadMatch = `%\"projectId\":\"${projectId}\"%`;
    const promotionRows = this.db
      .prepare(
        `SELECT ts, payload_json
         FROM events
         WHERE run_id IS NULL
           AND event_type IN ('skills.promotion.created', 'skills.global.promoted')
           AND payload_json LIKE ?
         ORDER BY ts DESC`
      )
      .all(projectPayloadMatch);
    const promotionBySkill = new Map();
    for (const row of promotionRows) {
      const payload = safeJsonParse(row?.payload_json, {});
      const skillName = normalizeSkillFeedbackKey(payload?.skillName ?? payload?.skill_name);
      if (!skillName) continue;
      const ts = String(row?.ts ?? "").trim();
      const tsMs = parseTimeMs(ts);
      const current = promotionBySkill.get(skillName) ?? {
        promotedCount: 0,
        latestPromotionAt: "",
        latestPromotionAtMs: 0,
      };
      current.promotedCount += 1;
      if (tsMs > current.latestPromotionAtMs) {
        current.latestPromotionAtMs = tsMs;
        current.latestPromotionAt = ts;
      }
      promotionBySkill.set(skillName, current);
    }

    const nowMs = Date.now();
    const windowDaysRaw = Number(params?.windowDays ?? SKILL_FEEDBACK_WINDOW_DAYS);
    const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0
      ? Math.floor(windowDaysRaw)
      : SKILL_FEEDBACK_WINDOW_DAYS;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const minSampleRunsRaw = Number(params?.minSampleRuns ?? SKILL_FEEDBACK_MIN_SAMPLE_RUNS);
    const minSampleRuns = Number.isFinite(minSampleRunsRaw) && minSampleRunsRaw > 0
      ? Math.floor(minSampleRunsRaw)
      : SKILL_FEEDBACK_MIN_SAMPLE_RUNS;

    const runStatusStmt = this.db.prepare(
      `SELECT status, COUNT(1) AS count
       FROM runs
       WHERE project_id = ?
         AND created_at >= ?
         AND created_at < ?
       GROUP BY status`
    );
    const retryCountStmt = this.db.prepare(
      `SELECT COUNT(1) AS total
       FROM events e
       JOIN runs r ON r.id = e.run_id
       WHERE r.project_id = ?
         AND e.event_type = 'step.retry'
         AND e.ts >= ?
         AND e.ts < ?`
    );
    const collectRunWindowStats = (startMs, endMs) => {
      const start = toIsoFromMs(startMs);
      const end = toIsoFromMs(endMs);
      if (!start || !end || start >= end) {
        return {
          runs: 0,
          completed: 0,
          failed: 0,
          successRate: 0,
          retryEvents: 0,
          retryPerRun: 0,
        };
      }
      const statusRows = runStatusStmt.all(projectId, start, end);
      const byStatus = {};
      let totalRuns = 0;
      for (const statusRow of statusRows) {
        const status = String(statusRow?.status ?? "").trim() || "unknown";
        const count = normalizeCount(statusRow?.count);
        byStatus[status] = count;
        totalRuns += count;
      }
      const retryEvents = normalizeCount(retryCountStmt.get(projectId, start, end)?.total);
      const completed = normalizeCount(byStatus.completed);
      const failed = normalizeCount(byStatus.failed);
      return {
        runs: totalRuns,
        completed,
        failed,
        successRate: computeRate(completed, totalRuns),
        retryEvents,
        retryPerRun: totalRuns > 0
          ? Number((retryEvents / totalRuns).toFixed(3))
          : 0,
      };
    };

    const feedback = {};
    for (const skillName of skillNames) {
      const promotion = promotionBySkill.get(skillName);
      const activeInRoleMap = activeSkillKeys.has(skillName);
      if (!promotion || promotion.latestPromotionAtMs <= 0) {
        feedback[skillName] = {
          source: "promotion-outcome",
          activeInRoleMap,
          promotedCount: 0,
          latestPromotionAt: "",
          sampleSufficient: false,
          effectivenessScore: 0.5,
          before: {
            runs: 0,
            successRate: 0,
            retryPerRun: 0,
          },
          after: {
            runs: 0,
            successRate: 0,
            retryPerRun: 0,
          },
          note: "no_promotion_history",
        };
        continue;
      }

      const promotionAtMs = promotion.latestPromotionAtMs;
      const beforeStartMs = Math.max(0, promotionAtMs - windowMs);
      const afterEndMs = Math.min(nowMs, promotionAtMs + windowMs);
      const beforeStats = collectRunWindowStats(beforeStartMs, promotionAtMs);
      const afterStats = collectRunWindowStats(promotionAtMs, afterEndMs);
      const sampleSufficient = beforeStats.runs >= minSampleRuns && afterStats.runs >= minSampleRuns;
      const successDelta = Number((afterStats.successRate - beforeStats.successRate).toFixed(3));
      const retryDelta = Number((beforeStats.retryPerRun - afterStats.retryPerRun).toFixed(3));
      const activeBias = activeInRoleMap ? 0.05 : -0.05;
      const rawEffectiveness = sampleSufficient
        ? 0.5 + (successDelta * 0.6) + (retryDelta * 0.25) + activeBias
        : 0.5 + (activeBias * 0.5);

      feedback[skillName] = {
        source: "promotion-outcome",
        activeInRoleMap,
        promotedCount: normalizeCount(promotion.promotedCount),
        latestPromotionAt: promotion.latestPromotionAt,
        sampleSufficient,
        effectivenessScore: normalizeScore(rawEffectiveness, 0.5),
        before: {
          runs: beforeStats.runs,
          successRate: beforeStats.successRate,
          retryPerRun: beforeStats.retryPerRun,
        },
        after: {
          runs: afterStats.runs,
          successRate: afterStats.successRate,
          retryPerRun: afterStats.retryPerRun,
        },
        deltas: {
          successRate: successDelta,
          retryPerRun: retryDelta,
        },
        note: sampleSufficient ? "window_compared" : "insufficient_samples",
      };
    }
    return feedback;
  }

  countRecentResumeFailures(stepId, windowMinutes = 30) {
    const sid = String(stepId ?? "").trim();
    if (!sid) return 0;
    const minutesRaw = Number(windowMinutes);
    const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0
      ? Math.floor(minutesRaw)
      : 30;
    const since = new Date(Date.now() - (minutes * 60 * 1000)).toISOString();
    const row = this.db.prepare(
      `SELECT COUNT(1) AS total
       FROM events
       WHERE step_id = ?
         AND event_type = 'step.resume.result'
         AND ts >= ?
         AND payload_json LIKE '%"succeeded":false%'`
    ).get(sid, since);
    return Number(row?.total ?? 0);
  }

  renderStepInput(stepKey, context, templateKey = null, promptMeta = {}) {
    const def = getStepByKey(templateKey ?? stepKey);
    if (!def) {
      return `Task:\n${context.task}\n\nProceed with ${stepKey}.`;
    }
    const promptContext = {
      ...(context && typeof context === "object" ? context : {}),
      projectContext: this.buildStepProjectContext(context, stepKey),
    };

    // Issue intent driven skills:
    // Keep `context.agentSkills` as the stable, init-defined role mapping,
    // but for this step's prompt we expose an "effective" role skill list
    // that includes dynamically selected skills based on issue intent.
    try {
      const agentId = String(def.agentId ?? "").trim();
      if (agentId) {
        const selection = buildEffectiveAgentSkillsForStep({
          context: promptContext,
          agentId,
          stepKey,
          projectRootPath: String(promptContext?.project?.rootPath ?? ""),
          productType: String(promptContext?.project?.productType ?? ""),
          techProfile: promptContext?.projectTechProfile ?? null,
        });
        const cloned = promptContext.agentSkills && typeof promptContext.agentSkills === "object"
          ? { ...promptContext.agentSkills }
          : {};
        cloned[agentId] = selection.merged;
        promptContext.agentSkills = cloned;
        promptContext.skillSelection = {
          mode: "issue-intent+step-scope",
          stepKey,
          agentId,
          intents: selection.intents,
          additionalSkillNames: selection.additionalSkillNames,
        };
      }
    } catch {
      // Do not block prompt rendering if selection logic fails.
    }
    return def.buildPrompt(promptContext, {
      stepKey,
      templateKey: templateKey ?? stepKey,
      attempt: Number(promptMeta?.attempt ?? 1),
      maxAttempts: Number(promptMeta?.maxAttempts ?? 1),
      stepPolicy: promptMeta?.stepPolicy && typeof promptMeta.stepPolicy === "object"
        ? promptMeta.stepPolicy
        : getStepPolicyFromContext(context, stepKey),
    });
  }
}

export function createStore() {
  return new ForgeOpsStore();
}
