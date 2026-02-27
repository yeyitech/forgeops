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
  ensureGitHubPullRequestForRun,
  findGitHubPullRequestForBranch,
  getGitHubBranchProtection,
  getGitHubIssue,
  listGitHubIssues,
  markGitHubPullRequestReadyForReview,
  mergeGitHubPullRequest,
  readGitHubRepoBinding,
  readGitHubIssuePrMetrics,
  syncDefaultBranchFromRemote,
  updateGitHubIssueLabels,
} from "./git.js";
import { loadProjectTechProfile, resolveAgentSkills } from "./skills.js";
import { newId, nowIso, safeJsonParse, slugify } from "./utils.js";

const DB_DIR = process.env.FORGEOPS_HOME
  ? path.resolve(process.env.FORGEOPS_HOME)
  : path.join(os.homedir(), ".forgeops");
const DB_PATH = path.join(DB_DIR, "forgeops.db");
const USER_GLOBAL_SKILLS_ROOT = path.join(DB_DIR, "skills-global");
const LOC_CACHE_TTL_MS = 30_000;
const GITHUB_METRICS_CACHE_TTL_MS = 30_000;
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
const RUN_COMPLETION_PR_GATE_STEP_KEYS = new Set(["implement", "test", "platform-smoke", "review"]);

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

function parseBoolLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
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

function isRunningIssueUniqueConstraintError(err) {
  const message = String(err?.message ?? err ?? "").toLowerCase();
  return message.includes("unique constraint failed: runs.project_id, runs.github_issue_id")
    || message.includes("idx_runs_project_issue_running");
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
const PLATFORM_GATE_TEMPLATE_KEYS = new Set(["platform-smoke", "test"]);

function clipText(value, maxChars = 240) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(16, maxChars - 3))}...`;
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
    "# 执行准则",
    "",
    "1. 本技能由项目实战候选晋升生成，使用前先核对当前任务边界。",
    "2. 优先复用已验证步骤，避免引入无法复现的隐式假设。",
    "3. 交付时必须附带可审计证据（命令、日志、产物路径）。",
    "",
    "## 来源",
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
    "# 执行准则",
    "",
    "1. 本技能来源于项目实战晋升，优先保证可执行与可复现。",
    "2. 如与项目本地技能冲突，以项目本地约束优先。",
    "3. 使用时必须输出命令、结果与证据路径。",
    "",
    "## 来源",
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
    "",
    "**Reviewer checks**",
    "- [ ] 方法是否可执行、可复现、可验证",
    "- [ ] 证据链是否可追溯（run/issue/artifacts）",
    "- [ ] 与现有技能是否冲突或重复",
    "- [ ] 失败回滚与适用边界是否清晰",
    "",
    "> 说明：分支前缀（如 `codex/`）仅表示自动化来源，不代表运行时或技能归属。",
  ].join("\n");
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

function detectMainlineRef(rootPath) {
  const repoRoot = String(rootPath ?? "").trim();
  if (!repoRoot) return "";
  const inRepo = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
  if (!inRepo) return "";

  // Keep remote refs fresh so "mainline" reflects GitHub repo state.
  runCommandSafe("git", ["-C", repoRoot, "fetch", "--quiet", "--no-tags", "origin"]);

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

      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_project_issue_running
        ON runs(project_id, github_issue_id)
        WHERE status = 'running'
          AND github_issue_id IS NOT NULL
          AND TRIM(github_issue_id) != '';
      CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, step_index);
      CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
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

    const worktree = createRunWorktree({
      rootPath: project.root_path,
      runId: promotionId,
      branchName: requestedBranch,
      baseRef: baseRef || undefined,
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
        const rolesMap = next.roles && typeof next.roles === "object" ? { ...next.roles } : {};
        for (const role of roles) {
          const current = Array.isArray(rolesMap[role])
            ? rolesMap[role].map((item) => String(item ?? "").trim()).filter(Boolean)
            : [];
          if (!current.includes(skillName)) {
            current.push(skillName);
          }
          rolesMap[role] = current;
        }
        if (!Number.isFinite(Number(next.version))) {
          next.version = 1;
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
      });

      if (Number(pullRequest?.number ?? 0) > 0) {
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

    let worktree;
    try {
      worktree = createRunWorktree({
        rootPath: globalRoot,
        runId: promotionId,
        branchName: requestedBranch,
        baseRef: baseRef || undefined,
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
      });

      if (Number(pullRequest?.number ?? 0) > 0) {
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
      ];
    } else if (state === "running") {
      addLabels = [ISSUE_AUTOMATION_LABELS.RUNNING];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.READY,
        ISSUE_AUTOMATION_LABELS.QUEUED,
        ISSUE_AUTOMATION_LABELS.DONE,
        ISSUE_AUTOMATION_LABELS.FAILED,
      ];
    } else if (state === "completed") {
      addLabels = [ISSUE_AUTOMATION_LABELS.DONE];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.QUEUED,
        ISSUE_AUTOMATION_LABELS.RUNNING,
        ISSUE_AUTOMATION_LABELS.FAILED,
      ];
    } else if (state === "failed") {
      addLabels = [ISSUE_AUTOMATION_LABELS.FAILED];
      removeLabels = [
        ISSUE_AUTOMATION_LABELS.QUEUED,
        ISSUE_AUTOMATION_LABELS.RUNNING,
        ISSUE_AUTOMATION_LABELS.DONE,
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

    try {
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

      this.emitEvent(run.id, stepId, "github.pr.automerge.completed", {
        runId: run.id,
        branch: run.worktree_branch,
        prNumber: Number(merged.pr?.number ?? pr.number),
        prUrl: String(merged.pr?.url ?? pr.url ?? ""),
        method: String(merged.method ?? "squash"),
        alreadyMerged: Boolean(merged.alreadyMerged),
        mergedAt: String(merged.pr?.mergedAt ?? ""),
      });

      if (!controls.autoCloseIssueOnMerge) {
        this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
          runId: run.id,
          issueId: String(run.github_issue_id ?? ""),
          prNumber: Number(merged.pr?.number ?? pr.number),
          prUrl: String(merged.pr?.url ?? pr.url ?? ""),
          reason: "disabled_by_workflow_config",
        });
      } else if (!String(run.github_issue_id ?? "").trim()) {
        this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
          runId: run.id,
          issueId: "",
          prNumber: Number(merged.pr?.number ?? pr.number),
          prUrl: String(merged.pr?.url ?? pr.url ?? ""),
          reason: "no_issue_bound",
        });
      } else {
        try {
          const closed = closeGitHubIssue({
            repoRootPath: project.root_path,
            projectId: project.id,
            issueRef: run.github_issue_id,
          });
          if (closed.closed) {
            this.emitEvent(run.id, stepId, "github.issue.autoclose.completed", {
              runId: run.id,
              issueId: String(run.github_issue_id ?? ""),
              issueNumber: Number(closed.issueNumber ?? 0),
              issueUrl: String(closed.issue?.github_url ?? ""),
              alreadyClosed: Boolean(closed.alreadyClosed),
              prNumber: Number(merged.pr?.number ?? pr.number),
              prUrl: String(merged.pr?.url ?? pr.url ?? ""),
            });
          } else {
            this.emitEvent(run.id, stepId, "github.issue.autoclose.skipped", {
              runId: run.id,
              issueId: String(run.github_issue_id ?? ""),
              issueNumber: Number(closed.issueNumber ?? 0),
              issueUrl: String(closed.issue?.github_url ?? ""),
              reason: "issue_state_not_closed_after_update",
              prNumber: Number(merged.pr?.number ?? pr.number),
              prUrl: String(merged.pr?.url ?? pr.url ?? ""),
            });
          }
        } catch (issueErr) {
          this.emitEvent(run.id, stepId, "github.issue.autoclose.failed", {
            runId: run.id,
            issueId: String(run.github_issue_id ?? ""),
            prNumber: Number(merged.pr?.number ?? pr.number),
            prUrl: String(merged.pr?.url ?? pr.url ?? ""),
            error: issueErr instanceof Error ? issueErr.message : String(issueErr),
          });
        }
      }

      return {
        status: "completed",
        pr: merged.pr ?? pr,
      };
    } catch (err) {
      this.emitEvent(run.id, stepId, "github.pr.automerge.failed", {
        runId: run.id,
        branch: run.worktree_branch,
        prNumber: Number(pr.number),
        prUrl: String(pr.url ?? ""),
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        pr,
      };
    }
  }

  syncRunMainlineAfterPrMerge(params) {
    const run = params?.run ?? this.getRun(params?.runId);
    if (!run?.id || !run?.worktree_branch) return null;
    if (!String(run.github_issue_id ?? "").trim()) return null;
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

    const stepId = params?.stepId ?? null;
    const emitDeferred = params?.emitDeferred === true;
    const emitSkipped = params?.emitSkipped === true;
    const emitFailure = params?.emitFailure === true;

    const project = params?.project ?? this.getProject(run.project_id);
    if (!project) return null;

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
  }

  syncProjectMainlineAfterMergedPr(params) {
    const projectId = String(params?.projectId ?? "").trim();
    if (!projectId) return 0;
    const project = this.getProject(projectId);
    if (!project) return 0;

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
      const alreadyMainline = this.hasRunEvent(run.id, "github.mainline.sync.completed");
      const alreadyArchived = this.hasRunEvent(run.id, "github.worktree.archive.completed");
      if (alreadyMainline && alreadyArchived) {
        continue;
      }
      const result = this.syncRunMainlineAfterPrMerge({
        run,
        project,
        emitDeferred: false,
        emitSkipped: false,
        emitFailure: false,
      });
      if (result?.status === "completed") {
        syncedCount += 1;
      }
    }
    return syncedCount;
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
      agentSkills: this.loadProjectSkills({
        rootPath: project.root_path,
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
      },
      stepPolicies: {},
      stepOutputs: {},
    };

    const workflow = params.workflowOverride && typeof params.workflowOverride === "object"
      ? params.workflowOverride
      : resolveWorkflow(project.root_path);
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
      };
    }
    context.stepPolicies = buildStepPolicies(steps);
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

    const next = {
      process_pid: patch.processPid ?? current.process_pid,
      thread_id: patch.threadId ?? current.thread_id,
      turn_id: patch.turnId ?? current.turn_id,
      effective_model: patch.effectiveModel ?? current.effective_model,
      model_provider: patch.modelProvider ?? current.model_provider,
      token_input: Number.isFinite(Number(patch.tokenInput))
        ? Number(patch.tokenInput)
        : Number(current.token_input ?? 0),
      token_cached_input: Number.isFinite(Number(patch.tokenCachedInput))
        ? Number(patch.tokenCachedInput)
        : Number(current.token_cached_input ?? 0),
      token_output: Number.isFinite(Number(patch.tokenOutput))
        ? Number(patch.tokenOutput)
        : Number(current.token_output ?? 0),
      token_reasoning_output: Number.isFinite(Number(patch.tokenReasoningOutput))
        ? Number(patch.tokenReasoningOutput)
        : Number(current.token_reasoning_output ?? 0),
      status: patch.status ?? current.status,
      error: patch.error ?? current.error,
      ended_at: patch.endedAt ?? current.ended_at,
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
        || step.step_key === "platform-smoke"
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
    if (!run || run.status !== "failed") return false;

    const failedStep = this.db
      .prepare(
        "SELECT * FROM steps WHERE run_id = ? AND status = 'failed' ORDER BY step_index ASC LIMIT 1"
      )
      .get(runId);

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

    this.db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").run(now, runId);
    this.db.prepare("UPDATE steps SET status = 'pending', error = NULL, input_text = ?, updated_at = ? WHERE id = ?").run(nextInput, now, failedStep.id);

    this.emitEvent(runId, failedStep.id, "run.resumed", {
      runId,
      stepId: failedStep.id,
      stepKey: failedStep.step_key,
    });
    if (run.github_issue_id) {
      this.syncGitHubIssueAutomationStamp({
        projectId: run.project_id,
        runId,
        issueId: run.github_issue_id,
        state: "queued",
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
    const candidates = [...structuredCandidates, ...artifactCandidates];
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

    this.emitEvent(run.id, step.id, "skills.candidate.summary", {
      runId: run.id,
      stepId: step.id,
      count: persisted.length,
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

  renderStepInput(stepKey, context, templateKey = null, promptMeta = {}) {
    const def = getStepByKey(templateKey ?? stepKey);
    if (!def) {
      return `Task:\n${context.task}\n\nProceed with ${stepKey}.`;
    }
    return def.buildPrompt(context, {
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
