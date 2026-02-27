import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildGitHubTokenEnv, requireGitHubPatToken, validateGitHubPat } from "./github-auth.js";
import { slugify } from "./utils.js";

function commandExists(name) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [name], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function runCommandProbe(command, args, options = {}) {
  const timeoutMsRaw = Number(options.timeoutMs ?? 120_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? timeoutMsRaw
    : 120_000;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeout: timeoutMs,
  });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const errorMessage = result.error ? String(result.error.message ?? result.error) : "";
  const errorCode = String(result.error?.code ?? "").trim();
  const status = Number.isFinite(result.status) ? Number(result.status) : null;
  const timedOut = Boolean(
    errorCode === "ETIMEDOUT"
    || errorMessage.toLowerCase().includes("timed out")
    || errorMessage.toLowerCase().includes("timeout")
  );

  return {
    ok: !result.error && status === 0,
    status,
    stdout,
    stderr,
    errorMessage,
    errorCode,
    timedOut,
  };
}

function formatProbeFailure(probe) {
  const detail = String(probe?.errorMessage ?? "").trim()
    || String(probe?.stderr ?? "").trim()
    || String(probe?.stdout ?? "").trim();
  if (detail) return detail;
  const status = Number.isFinite(probe?.status) ? Number(probe.status) : null;
  if (status === null) {
    return "unknown failure";
  }
  return `exit code ${status}`;
}

function sleepMs(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, Math.floor(duration));
}

function classifyGitHubFailure(message) {
  const lower = String(message ?? "").toLowerCase();
  if (!lower) return "unknown";
  if (
    lower.includes("etimedout")
    || lower.includes("timed out")
    || lower.includes("timeout")
    || lower.includes("econnreset")
    || lower.includes("connection reset")
    || lower.includes("connection refused")
    || lower.includes("tls handshake timeout")
    || lower.includes("temporary failure")
    || lower.includes("network")
  ) {
    return "network_timeout";
  }
  if (
    lower.includes("bad credentials")
    || lower.includes("authentication failed")
    || lower.includes("requires authentication")
    || lower.includes("http 401")
    || lower.includes("http 403")
    || lower.includes("permission denied")
    || (lower.includes("token") && lower.includes("invalid"))
  ) {
    return "auth";
  }
  if (
    lower.includes("unknown revision")
    || lower.includes("bad revision")
    || lower.includes("not a valid object name")
    || lower.includes("ambiguous argument")
    || lower.includes("unknown ref")
    || lower.includes("base ref")
  ) {
    return "base_ref_missing";
  }
  if (
    lower.includes("no commits between")
    || lower.includes("must have commits")
    || lower.includes("no changes")
    || lower.includes("no commits")
  ) {
    return "no_commits_ahead_true";
  }
  return "unknown";
}

function runCommand(command, args, options = {}) {
  const probe = runCommandProbe(command, args, options);
  if (!probe.ok) {
    const detail = formatProbeFailure(probe);
    throw new Error(`${options.errorPrefix ?? "Command failed"}: ${detail}`);
  }
  return probe.stdout;
}

function runCommandSafe(command, args, options = {}) {
  try {
    return runCommand(command, args, options);
  } catch {
    return null;
  }
}

function emitProgress(params, stage, detail) {
  if (typeof params?.onProgress !== "function") {
    return;
  }
  params.onProgress({
    stage: String(stage),
    detail: String(detail ?? ""),
    at: new Date().toISOString(),
  });
}

function parseGitHubRemote(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;

  const https = raw.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (https) {
    return {
      owner: https[1],
      repo: https[2],
      slug: `${https[1]}/${https[2]}`,
    };
  }

  const ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) {
    return {
      owner: ssh[1],
      repo: ssh[2],
      slug: `${ssh[1]}/${ssh[2]}`,
    };
  }

  return null;
}

function assertTooling() {
  if (!commandExists("git")) {
    throw new Error("GitHub flow precheck failed: 未找到 git 命令");
  }
  if (!commandExists("gh")) {
    throw new Error("GitHub flow precheck failed: 未找到 gh 命令");
  }
}

function getRepoRoot(rootPath) {
  return runCommand("git", ["-C", rootPath, "rev-parse", "--show-toplevel"], {
    errorPrefix: "GitHub flow precheck failed: 目录不是 git 仓库",
  });
}

function ensureGitHubPatAvailable(cwd) {
  requireGitHubPatToken();
  const validation = validateGitHubPat();
  if (!validation.valid) {
    throw new Error(`GitHub flow precheck failed: ${validation.detail}`);
  }
  if (!validation.scopesOk) {
    throw new Error(
      `GitHub flow precheck failed: PAT scope 不满足要求，缺失 ${validation.missingScopes.join(", ")}`
    );
  }
  const tokenEnv = buildGitHubTokenEnv();
  if (!tokenEnv) {
    throw new Error("GitHub flow precheck failed: 必须先在系统配置中设置 GitHub PAT (classic)");
  }
  runCommand("gh", ["api", "user", "-q", ".login"], {
    cwd,
    env: tokenEnv,
    timeoutMs: 10_000,
    errorPrefix: "GitHub flow precheck failed: GitHub PAT 无效或权限不足",
  });
}

function getGitHubTokenEnvRequired() {
  const tokenEnv = buildGitHubTokenEnv();
  if (!tokenEnv) {
    throw new Error("GitHub flow precheck failed: 必须先在系统配置中设置 GitHub PAT (classic)");
  }
  return tokenEnv;
}

function ensureGlobalGitIdentity() {
  const globalUserName = runCommandSafe("git", ["config", "--global", "--get", "user.name"]);
  const globalUserEmail = runCommandSafe("git", ["config", "--global", "--get", "user.email"]);
  const userName = String(globalUserName || "").trim();
  const userEmail = String(globalUserEmail || "").trim();
  if (!userName || !userEmail) {
    throw new Error(
      "GitHub flow precheck failed: 缺少全局 git 身份配置，请先执行 git config --global user.name \"<name>\" && git config --global user.email \"<email>\""
    );
  }
}

function ensureGitIdentity(repoRoot) {
  const localUserName = runCommandSafe("git", ["-C", repoRoot, "config", "--get", "user.name"]);
  const localUserEmail = runCommandSafe("git", ["-C", repoRoot, "config", "--get", "user.email"]);
  const globalUserName = runCommandSafe("git", ["config", "--global", "--get", "user.name"]);
  const globalUserEmail = runCommandSafe("git", ["config", "--global", "--get", "user.email"]);

  const userName = String(localUserName || globalUserName || "").trim();
  const userEmail = String(localUserEmail || globalUserEmail || "").trim();
  if (!userName || !userEmail) {
    throw new Error(
      "GitHub flow precheck failed: 缺少 git 身份配置，请先执行 git config --global user.name \"<name>\" && git config --global user.email \"<email>\""
    );
  }
}

export function ensureGlobalGitHubDeveloperAccess() {
  assertTooling();
  ensureGlobalGitIdentity();
  ensureGitHubPatAvailable(process.cwd());
}

export function getGlobalGitIdentity() {
  if (!commandExists("git")) {
    return {
      userName: "",
      userEmail: "",
      configured: false,
      available: false,
    };
  }

  const userName = String(runCommandSafe("git", ["config", "--global", "--get", "user.name"]) || "").trim();
  const userEmail = String(runCommandSafe("git", ["config", "--global", "--get", "user.email"]) || "").trim();
  return {
    userName,
    userEmail,
    configured: Boolean(userName && userEmail),
    available: true,
  };
}

export function setGlobalGitIdentity(params) {
  if (!commandExists("git")) {
    throw new Error("系统配置失败: 未找到 git 命令");
  }

  const userName = String(params?.userName ?? "").trim();
  const userEmail = String(params?.userEmail ?? "").trim();
  if (!userName || !userEmail) {
    throw new Error("系统配置失败: userName 和 userEmail 不能为空");
  }

  runCommand("git", ["config", "--global", "user.name", userName], {
    errorPrefix: "系统配置失败: 设置 git user.name 失败",
  });
  runCommand("git", ["config", "--global", "user.email", userEmail], {
    errorPrefix: "系统配置失败: 设置 git user.email 失败",
  });

  return getGlobalGitIdentity();
}

function getOriginUrl(repoRoot) {
  return runCommand("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
    errorPrefix: "GitHub flow precheck failed: 缺少 origin 远程",
  });
}

function ensureGitHubOrigin(repoRoot) {
  const originUrl = getOriginUrl(repoRoot);
  const remote = parseGitHubRemote(originUrl);
  if (!remote) {
    throw new Error("GitHub flow precheck failed: origin 必须指向 github.com 仓库");
  }
  return {
    originUrl,
    remote,
  };
}

function readGitHubSearchCount(repoSlug, type, qualifiers, cwd) {
  const extra = Array.isArray(qualifiers) ? qualifiers.filter(Boolean).join(" ") : "";
  const query = `repo:${repoSlug} type:${type}${extra ? ` ${extra}` : ""}`;
  const tokenEnv = getGitHubTokenEnvRequired();
  const output = runCommand(
    "gh",
    ["api", "-X", "GET", "/search/issues", "-f", `q=${query}`, "-q", ".total_count"],
    {
      cwd,
      env: tokenEnv,
      errorPrefix: "读取 GitHub 指标失败",
    },
  );
  const count = Number(String(output ?? "").trim());
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(`读取 GitHub 指标失败: 无效计数 ${output}`);
  }
  return Math.floor(count);
}

function ensureDefaultBranch(repoRoot, defaultBranch = "main") {
  const current = runCommandSafe("git", ["-C", repoRoot, "branch", "--show-current"]);
  if (current && current.trim()) {
    return current.trim();
  }

  const verifyMain = runCommandSafe("git", ["-C", repoRoot, "show-ref", "--verify", `refs/heads/${defaultBranch}`]);
  if (verifyMain) {
    runCommand("git", ["-C", repoRoot, "checkout", defaultBranch], {
      errorPrefix: `Git 初始化失败: 无法切换到 ${defaultBranch}`,
    });
    return defaultBranch;
  }

  runCommand("git", ["-C", repoRoot, "checkout", "-b", defaultBranch], {
    errorPrefix: `Git 初始化失败: 无法创建分支 ${defaultBranch}`,
  });
  return defaultBranch;
}

function ensureInitialCommit(repoRoot, message = "chore: bootstrap ForgeOps project") {
  const hasHead = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"]);
  if (hasHead) {
    return false;
  }

  runCommand("git", ["-C", repoRoot, "add", "-A"], {
    errorPrefix: "Git 初始化失败: git add 执行失败",
  });

  const pending = runCommand("git", ["-C", repoRoot, "status", "--porcelain"]);
  if (!pending.trim()) {
    return false;
  }

  runCommand("git", ["-C", repoRoot, "commit", "-m", message], {
    errorPrefix: "Git 初始化失败: 首次提交失败，请检查 git 用户配置",
  });
  return true;
}

function detectDefaultRemoteRef(repoRoot) {
  const remoteHead = runCommandSafe("git", ["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (remoteHead && remoteHead.startsWith("refs/remotes/origin/")) {
    return remoteHead.replace("refs/remotes/", "");
  }

  const candidates = ["origin/main", "origin/master"];
  for (const candidate of candidates) {
    const ok = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--verify", candidate]);
    if (ok) {
      return candidate;
    }
  }

  const localBranch = runCommandSafe("git", ["-C", repoRoot, "branch", "--show-current"]);
  if (localBranch && localBranch.trim()) {
    const remoteRef = `origin/${localBranch.trim()}`;
    const remoteOk = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--verify", remoteRef]);
    if (remoteOk) {
      return remoteRef;
    }
    return localBranch.trim();
  }

  return "main";
}

function ensureWorktreeIgnore(repoRoot) {
  const ignorePath = path.join(repoRoot, ".gitignore");
  const marker = ".forgeops/worktrees/";

  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, `${marker}\n`, "utf8");
    return true;
  }

  const current = fs.readFileSync(ignorePath, "utf8");
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(marker)) {
    return false;
  }

  const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  fs.writeFileSync(ignorePath, `${current}${suffix}${marker}\n`, "utf8");
  return true;
}

function normalizeRepoSlug(repository, owner, fallbackName) {
  const input = String(repository ?? "").trim();
  if (input.includes("/")) {
    return input;
  }

  const repoName = input || slugify(fallbackName) || "forgeops-project";
  return `${owner}/${repoName}`;
}

function getGhLogin(cwd) {
  const tokenEnv = getGitHubTokenEnvRequired();
  return runCommand("gh", ["api", "user", "-q", ".login"], {
    cwd,
    env: tokenEnv,
    timeoutMs: 10_000,
    errorPrefix: "GitHub flow precheck failed: 无法读取 gh 账号",
  });
}

function normalizeGitHubIssueRef(issueRef) {
  const raw = String(issueRef ?? "").trim();
  if (!raw) {
    throw new Error("GitHub issue ref is required");
  }
  const matched = raw.match(/#?(\d+)$/);
  if (!matched) {
    throw new Error(`Invalid GitHub issue ref: ${raw}`);
  }
  const num = Number(matched[1]);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid GitHub issue ref: ${raw}`);
  }
  return num;
}

function mapGitHubIssueToRecord(projectId, issue) {
  const number = Number(issue?.number ?? 0);
  const title = String(issue?.title ?? "").trim();
  const body = String(issue?.body ?? "");
  const state = String(issue?.state ?? "open").toLowerCase();
  const createdAt = String(issue?.createdAt ?? issue?.created_at ?? new Date().toISOString());
  const updatedAt = String(issue?.updatedAt ?? issue?.updated_at ?? createdAt);
  const url = String(issue?.url ?? "");
  const labels = Array.isArray(issue?.labels)
    ? issue.labels
      .map((item) => String(item?.name ?? item ?? "").trim())
      .filter(Boolean)
    : [];
  return {
    id: String(number),
    project_id: String(projectId),
    title,
    description: body,
    status: state === "closed" ? "closed" : "open",
    created_at: createdAt,
    updated_at: updatedAt,
    github_number: number,
    github_url: url,
    labels,
  };
}

function readGitHubIssueView(repoRoot, repoSlug, issueNumber) {
  const tokenEnv = getGitHubTokenEnvRequired();
  const raw = runCommand(
    "gh",
    [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repoSlug,
      "--json",
      "number,title,body,state,createdAt,updatedAt,url,labels",
    ],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `GitHub issue 查询失败 (#${issueNumber})`,
    }
  );
  return JSON.parse(raw);
}

function normalizeIssueLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return Array.from(
    new Set(
      labels
        .map((label) => String(label ?? "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeBaseBranchName(baseRef) {
  const raw = String(baseRef ?? "").trim();
  if (!raw) return "main";
  if (raw.startsWith("origin/")) {
    return raw.slice("origin/".length);
  }
  if (raw.startsWith("refs/remotes/origin/")) {
    return raw.slice("refs/remotes/origin/".length);
  }
  if (raw.startsWith("refs/heads/")) {
    return raw.slice("refs/heads/".length);
  }
  return raw;
}

function normalizeCommitMessage(message, runId) {
  const text = String(message ?? "").trim();
  if (text) return text;
  const rid = String(runId ?? "").trim();
  return rid
    ? `feat: forgeops updates for ${rid}`
    : "feat: forgeops automated updates";
}

function normalizePrTitle(params) {
  const input = String(params?.prTitle ?? "").trim();
  if (input) return input;

  const issueRef = String(params?.issueRef ?? "").trim().replace(/^#/, "");
  const task = String(params?.task ?? "").trim();
  if (issueRef && task) {
    return `[Issue #${issueRef}] ${task}`.slice(0, 240);
  }
  if (task) {
    return task.slice(0, 240);
  }
  if (issueRef) {
    return `[Issue #${issueRef}] ForgeOps automated update`;
  }
  const rid = String(params?.runId ?? "").trim();
  return rid
    ? `ForgeOps automated update (${rid})`
    : "ForgeOps automated update";
}

function normalizePrBody(params) {
  const input = String(params?.prBody ?? "").trim();
  if (input) return input;

  const runId = String(params?.runId ?? "").trim();
  const issueRef = String(params?.issueRef ?? "").trim();
  const branch = String(params?.branchName ?? "").trim();
  const base = normalizeBaseBranchName(params?.baseRef ?? "main");
  const task = String(params?.task ?? "").trim();

  return [
    "## ForgeOps Automated Pull Request",
    runId ? `- run: \`${runId}\`` : "- run: -",
    issueRef ? `- issue: #${issueRef.replace(/^#/, "")}` : "- issue: -",
    branch ? `- head: \`${branch}\`` : "- head: -",
    base ? `- base: \`${base}\`` : "- base: -",
    task ? `- task: ${task}` : "- task: -",
  ].join("\n");
}

function parsePrUrlAndNumber(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      url: "",
      number: 0,
    };
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const url = lines.find((line) => /^https?:\/\//.test(line)) ?? "";
  if (!url) {
    return {
      url: "",
      number: 0,
    };
  }
  const matched = url.match(/\/pull\/(\d+)(?:$|[?#])/);
  return {
    url,
    number: matched ? Number(matched[1]) : 0,
  };
}

function normalizePullRequestRecord(input, extra = {}) {
  const number = Number(input?.number ?? extra.number ?? 0);
  const attemptsRaw = Number(extra.prCreateAttempts ?? 0);
  return {
    repo: String(input?.repo ?? extra.repo ?? ""),
    number: Number.isFinite(number) && number > 0 ? number : 0,
    url: String(input?.url ?? extra.url ?? ""),
    title: String(input?.title ?? extra.title ?? ""),
    headRefName: String(input?.headRefName ?? extra.headRefName ?? ""),
    baseRefName: String(input?.baseRefName ?? extra.baseRefName ?? ""),
    state: String(input?.state ?? extra.state ?? ""),
    isDraft: Boolean(input?.isDraft ?? extra.isDraft),
    mergedAt: String(input?.mergedAt ?? extra.mergedAt ?? ""),
    mergeStateStatus: String(input?.mergeStateStatus ?? extra.mergeStateStatus ?? ""),
    reviewDecision: String(input?.reviewDecision ?? extra.reviewDecision ?? ""),
    created: Boolean(extra.created),
    existing: Boolean(extra.existing),
    commitCreated: Boolean(extra.commitCreated),
    pushed: Boolean(extra.pushed),
    skippedReason: String(extra.skippedReason ?? ""),
    skippedReasonCategory: String(extra.skippedReasonCategory ?? ""),
    skippedDetail: String(extra.skippedDetail ?? ""),
    skippedDiagnostics:
      extra.skippedDiagnostics && typeof extra.skippedDiagnostics === "object"
        ? extra.skippedDiagnostics
        : null,
    prCreateAttempts: Number.isFinite(attemptsRaw) && attemptsRaw > 0
      ? Math.floor(attemptsRaw)
      : 0,
  };
}

function buildAheadBaseRefCandidates(baseRefInput) {
  const raw = String(baseRefInput ?? "").trim();
  const baseBranch = normalizeBaseBranchName(raw || "origin/main");
  const candidates = [
    raw,
    baseBranch,
    baseBranch ? `origin/${baseBranch}` : "",
    baseBranch ? `refs/remotes/origin/${baseBranch}` : "",
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(candidates));
}

function resolveGitAheadState(params) {
  const worktreePath = path.resolve(params.worktreePath);
  const baseRefInput = String(params.baseRef ?? "origin/main").trim() || "origin/main";
  const candidates = buildAheadBaseRefCandidates(baseRefInput);
  const attempts = [];
  const head = String(runCommandSafe("git", ["-C", worktreePath, "rev-parse", "HEAD"]) || "").trim();
  let lastProbeError = "";
  let sawNonBaseRefError = false;

  for (const candidate of candidates) {
    const verifyProbe = runCommandProbe("git", ["-C", worktreePath, "rev-parse", "--verify", candidate], {
      env: process.env,
    });
    const verifyError = verifyProbe.ok ? "" : formatProbeFailure(verifyProbe);
    attempts.push({
      candidate,
      verifyOk: verifyProbe.ok,
      verifyError,
      revListOk: false,
      revListError: "",
      revListRaw: "",
      mergeBaseOk: null,
      mergeBaseStatus: null,
      mergeBaseError: "",
    });
    const attemptRef = attempts[attempts.length - 1];
    if (!verifyProbe.ok) {
      continue;
    }

    const revListProbe = runCommandProbe(
      "git",
      ["-C", worktreePath, "rev-list", "--count", `${candidate}..HEAD`],
      { env: process.env },
    );
    attemptRef.revListOk = revListProbe.ok;
    attemptRef.revListRaw = revListProbe.stdout;
    attemptRef.revListError = revListProbe.ok ? "" : formatProbeFailure(revListProbe);

    if (!revListProbe.ok) {
      lastProbeError = attemptRef.revListError;
      sawNonBaseRefError = true;
      continue;
    }

    const aheadCount = Number(String(revListProbe.stdout ?? "").trim());
    if (!Number.isFinite(aheadCount) || aheadCount < 0) {
      const detail = `invalid rev-list output: ${String(revListProbe.stdout ?? "").trim() || "(empty)"}`;
      attemptRef.revListError = detail;
      lastProbeError = detail;
      sawNonBaseRefError = true;
      continue;
    }
    if (aheadCount > 0) {
      return {
        ok: true,
        aheadCount,
        baseRefUsed: candidate,
        reasonCategory: "",
        detail: "",
        diagnostics: {
          baseRefInput,
          baseRefUsed: candidate,
          head,
          attempts,
        },
      };
    }

    const mergeBaseProbe = runCommandProbe(
      "git",
      ["-C", worktreePath, "merge-base", "--is-ancestor", candidate, "HEAD"],
      { env: process.env },
    );
    attemptRef.mergeBaseOk = mergeBaseProbe.ok;
    attemptRef.mergeBaseStatus = mergeBaseProbe.status;
    attemptRef.mergeBaseError = mergeBaseProbe.ok ? "" : formatProbeFailure(mergeBaseProbe);
    if (mergeBaseProbe.ok || mergeBaseProbe.status === 1) {
      return {
        ok: true,
        aheadCount: 0,
        baseRefUsed: candidate,
        reasonCategory: "no_commits_ahead_true",
        detail: "HEAD has no commits ahead of base ref",
        diagnostics: {
          baseRefInput,
          baseRefUsed: candidate,
          head,
          attempts,
        },
      };
    }
    lastProbeError = attemptRef.mergeBaseError;
    sawNonBaseRefError = true;
  }

  const hasVerifiedBase = attempts.some((item) => item.verifyOk);
  const reasonCategory = hasVerifiedBase
    ? classifyGitHubFailure(lastProbeError || "unknown ahead probe failure")
    : "base_ref_missing";
  return {
    ok: false,
    aheadCount: 0,
    baseRefUsed: "",
    reasonCategory,
    detail: hasVerifiedBase
      ? (lastProbeError || "ahead check failed")
      : `base ref not found for candidates: ${candidates.join(", ")}`,
    diagnostics: {
      baseRefInput,
      baseRefUsed: "",
      head,
      attempts,
    },
    skippedReason: hasVerifiedBase
      ? (reasonCategory === "network_timeout" ? "network_timeout" : "ahead_probe_failed")
      : "base_ref_missing",
    hadProbeError: sawNonBaseRefError,
  };
}

function ensureGitHubIssueLabel(repoRoot, repoSlug, labelName, tokenEnv) {
  const label = String(labelName ?? "").trim();
  if (!label) return;

  const current = runCommandSafe(
    "gh",
    ["api", `/repos/${repoSlug}/labels/${encodeURIComponent(label)}`, "-q", ".name"],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: "GitHub issue 标签检查失败",
    }
  );
  if (current) return;

  const presets = {
    "forgeops:ready": {
      color: "0969da",
      description: "Issue is ready for ForgeOps automation",
    },
    "forgeops:running": {
      color: "1a7f37",
      description: "ForgeOps run is currently executing",
    },
    "forgeops:done": {
      color: "1f883d",
      description: "ForgeOps run completed successfully",
    },
    "forgeops:failed": {
      color: "cf222e",
      description: "ForgeOps run failed and needs attention",
    },
  };
  const preset = presets[label] ?? {
    color: "6e7781",
    description: "Managed by ForgeOps",
  };

  try {
    runCommand(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `/repos/${repoSlug}/labels`,
        "-f",
        `name=${label}`,
        "-f",
        `color=${preset.color}`,
        "-f",
        `description=${preset.description}`,
      ],
      {
        cwd: repoRoot,
        env: tokenEnv,
        errorPrefix: `GitHub issue 标签创建失败 (${label})`,
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (
      lower.includes("already_exists")
      || lower.includes("already exists")
      || lower.includes("unprocessable")
      || lower.includes("422")
    ) {
      return;
    }
    throw err;
  }
}

function ensureGitHubBranchProtection(repoRoot, repoSlug, branchName, tokenEnv) {
  const branch = String(branchName ?? "").trim();
  if (!branch) {
    throw new Error("Git 初始化失败: 分支保护失败，branch 不能为空");
  }
  const route = `/repos/${repoSlug}/branches/${encodeURIComponent(branch)}/protection`;
  const commonArgs = [
    "api",
    "-X",
    "PUT",
    route,
    "-H",
    "Accept: application/vnd.github+json",
  ];
  const strictArgs = [
    ...commonArgs,
    "-f",
    "required_status_checks=null",
    "-F",
    "enforce_admins=true",
    "-f",
    "required_pull_request_reviews.dismiss_stale_reviews=true",
    "-f",
    "required_pull_request_reviews.require_code_owner_reviews=false",
    "-f",
    "required_pull_request_reviews.required_approving_review_count=1",
    "-f",
    "required_pull_request_reviews.require_last_push_approval=false",
    "-f",
    "restrictions=null",
    "-f",
    "required_linear_history=true",
    "-f",
    "allow_force_pushes=false",
    "-f",
    "allow_deletions=false",
    "-f",
    "required_conversation_resolution=true",
  ];

  try {
    runCommand("gh", strictArgs, {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `Git 初始化失败: 保护分支 ${branch} 失败`,
    });
    return {
      branch,
      applied: true,
      fallbackUsed: false,
    };
  } catch {
    const fallbackArgs = [
      ...commonArgs,
      "-f",
      "required_status_checks=null",
      "-F",
      "enforce_admins=true",
      "-f",
      "required_pull_request_reviews=null",
      "-f",
      "restrictions=null",
    ];
    runCommand("gh", fallbackArgs, {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `Git 初始化失败: 保护分支 ${branch} 失败`,
    });
    return {
      branch,
      applied: true,
      fallbackUsed: true,
    };
  }
}

export function listGitHubIssues(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const projectId = String(params.projectId ?? "");
  const state = String(params.state ?? "all").trim() || "all";
  const limitRaw = Number(params.limit ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 100;

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();
  const raw = runCommand(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      remote.slug,
      "--state",
      state,
      "--limit",
      String(limit),
      "--json",
      "number,title,body,state,createdAt,updatedAt,url,labels",
    ],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: "GitHub issue 列表读取失败",
    }
  );
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item) => mapGitHubIssueToRecord(projectId, item));
}

export function getGitHubIssue(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const projectId = String(params.projectId ?? "");
  const issueNumber = normalizeGitHubIssueRef(params.issueRef);

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);

  try {
    const issue = readGitHubIssueView(repoRoot, remote.slug, issueNumber);
    return mapGitHubIssueToRecord(projectId, issue);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (lower.includes("not found") || lower.includes("could not resolve") || lower.includes("404")) {
      return null;
    }
    throw err;
  }
}

export function updateGitHubIssueLabels(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const projectId = String(params.projectId ?? "");
  const issueNumber = normalizeGitHubIssueRef(params.issueRef);
  const addLabels = normalizeIssueLabels(params.addLabels);
  const removeLabels = normalizeIssueLabels(params.removeLabels)
    .filter((label) => !addLabels.includes(label));

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  for (const label of addLabels) {
    ensureGitHubIssueLabel(repoRoot, remote.slug, label, tokenEnv);
  }

  if (addLabels.length > 0) {
    runCommand(
      "gh",
      [
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        remote.slug,
        "--add-label",
        addLabels.join(","),
      ],
      {
        cwd: repoRoot,
        env: tokenEnv,
        errorPrefix: `GitHub issue 标签更新失败 (#${issueNumber})`,
      }
    );
  }

  const latestIssue = readGitHubIssueView(repoRoot, remote.slug, issueNumber);
  const removable = removeLabels.filter((label) =>
    normalizeIssueLabels(
      Array.isArray(latestIssue?.labels)
        ? latestIssue.labels.map((item) => String(item?.name ?? item ?? "").trim())
        : []
    ).includes(label)
  );

  if (removable.length > 0) {
    runCommand(
      "gh",
      [
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        remote.slug,
        "--remove-label",
        removable.join(","),
      ],
      {
        cwd: repoRoot,
        env: tokenEnv,
        errorPrefix: `GitHub issue 标签更新失败 (#${issueNumber})`,
      }
    );
  }

  const refreshed = readGitHubIssueView(repoRoot, remote.slug, issueNumber);
  return mapGitHubIssueToRecord(projectId, refreshed);
}

export function closeGitHubIssue(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const projectId = String(params.projectId ?? "");
  const issueNumber = normalizeGitHubIssueRef(params.issueRef);

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const currentIssue = readGitHubIssueView(repoRoot, remote.slug, issueNumber);
  const alreadyClosed = String(currentIssue?.state ?? "").toLowerCase() === "closed";
  if (!alreadyClosed) {
    runCommand(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        `/repos/${remote.slug}/issues/${issueNumber}`,
        "-f",
        "state=closed",
      ],
      {
        cwd: repoRoot,
        env: tokenEnv,
        errorPrefix: `GitHub issue 关闭失败 (#${issueNumber})`,
      }
    );
  }

  const refreshed = readGitHubIssueView(repoRoot, remote.slug, issueNumber);
  return {
    repo: remote.slug,
    issueNumber,
    closed: String(refreshed?.state ?? "").toLowerCase() === "closed",
    alreadyClosed,
    issue: mapGitHubIssueToRecord(projectId, refreshed),
  };
}

export function createGitHubIssueComment(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const issueNumber = normalizeGitHubIssueRef(params.issueRef);
  const body = String(params.body ?? "").trim();
  if (!body) {
    throw new Error("GitHub issue comment body is required");
  }

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const url = runCommand(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `/repos/${remote.slug}/issues/${issueNumber}/comments`,
      "-f",
      `body=${body}`,
      "-q",
      ".html_url",
    ],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `GitHub issue 评论失败 (#${issueNumber})`,
    }
  );
  return {
    repo: remote.slug,
    issueNumber,
    url: String(url ?? "").trim(),
  };
}

export function findGitHubPullRequestForBranch(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const branchName = String(params.branchName ?? "").trim();
  if (!branchName) return null;

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const output = runCommand(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      remote.slug,
      "--head",
      branchName,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,url,title,headRefName,baseRefName,state,isDraft,mergedAt",
    ],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `GitHub PR 查询失败 (${branchName})`,
    }
  );
  const list = JSON.parse(output);
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  const pr = list[0];
  return normalizePullRequestRecord(pr, {
    repo: remote.slug,
  });
}

export function getGitHubPullRequest(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const prNumber = Number(params.prNumber ?? 0);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid GitHub pull request ref: ${params.prNumber}`);
  }

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const output = runCommand(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      remote.slug,
      "--json",
      "number,url,title,headRefName,baseRefName,state,isDraft,mergedAt,mergeStateStatus,reviewDecision",
    ],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `GitHub PR 查询失败 (#${prNumber})`,
    }
  );
  const parsed = JSON.parse(output);
  return normalizePullRequestRecord(parsed, {
    repo: remote.slug,
  });
}

export function markGitHubPullRequestReadyForReview(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const prNumber = Number(params.prNumber ?? 0);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid GitHub pull request ref: ${params.prNumber}`);
  }

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const before = getGitHubPullRequest({
    repoRootPath: repoRoot,
    prNumber,
  });
  if (!before.isDraft) {
    return {
      repo: remote.slug,
      prNumber,
      changed: false,
      alreadyReady: true,
      pr: before,
    };
  }

  runCommand(
    "gh",
    ["pr", "ready", String(prNumber), "--repo", remote.slug],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `GitHub PR ready-for-review 失败 (#${prNumber})`,
    }
  );

  const after = getGitHubPullRequest({
    repoRootPath: repoRoot,
    prNumber,
  });
  return {
    repo: remote.slug,
    prNumber,
    changed: before.isDraft && !after.isDraft,
    alreadyReady: !before.isDraft,
    pr: after,
  };
}

export function getGitHubBranchProtection(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const branchName = String(params.branchName ?? "").trim();
  if (!branchName) {
    throw new Error("Invalid GitHub branch ref: branchName is required");
  }

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();
  const route = `/repos/${remote.slug}/branches/${encodeURIComponent(branchName)}/protection`;

  try {
    const output = runCommand(
      "gh",
      [
        "api",
        route,
        "-H",
        "Accept: application/vnd.github+json",
      ],
      {
        cwd: repoRoot,
        env: tokenEnv,
        errorPrefix: `GitHub 分支保护查询失败 (${branchName})`,
      }
    );
    const parsed = JSON.parse(output);
    return {
      repo: remote.slug,
      branch: branchName,
      available: true,
      protected: true,
      requiredLinearHistory: Boolean(parsed?.required_linear_history?.enabled),
      reason: "",
      error: "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/404|not found|Branch not protected/i.test(message)) {
      return {
        repo: remote.slug,
        branch: branchName,
        available: true,
        protected: false,
        requiredLinearHistory: false,
        reason: "not_protected",
        error: "",
      };
    }
    return {
      repo: remote.slug,
      branch: branchName,
      available: false,
      protected: false,
      requiredLinearHistory: false,
      reason: "query_failed",
      error: message,
    };
  }
}

export function mergeGitHubPullRequest(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const prNumber = Number(params.prNumber ?? 0);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid GitHub pull request ref: ${params.prNumber}`);
  }
  const methodRaw = String(params.method ?? "squash").trim().toLowerCase();
  const method = methodRaw === "rebase" || methodRaw === "merge" ? methodRaw : "squash";
  const deleteBranch = params.deleteBranch !== false;

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const before = getGitHubPullRequest({
    repoRootPath: repoRoot,
    prNumber,
  });
  const alreadyMerged = Boolean(String(before.mergedAt ?? "").trim())
    || String(before.state ?? "").trim().toUpperCase() === "MERGED";
  if (alreadyMerged) {
    return {
      repo: remote.slug,
      prNumber,
      method,
      merged: true,
      alreadyMerged: true,
      pr: before,
    };
  }

  const args = [
    "pr",
    "merge",
    String(prNumber),
    "--repo",
    remote.slug,
    `--${method}`,
  ];
  if (deleteBranch) {
    args.push("--delete-branch");
  }
  runCommand("gh", args, {
    cwd: repoRoot,
    env: tokenEnv,
    errorPrefix: `GitHub PR 合并失败 (#${prNumber})`,
  });

  const after = getGitHubPullRequest({
    repoRootPath: repoRoot,
    prNumber,
  });
  const merged = Boolean(String(after.mergedAt ?? "").trim())
    || String(after.state ?? "").trim().toUpperCase() === "MERGED";

  return {
    repo: remote.slug,
    prNumber,
    method,
    merged,
    alreadyMerged: false,
    pr: after,
  };
}

export function syncDefaultBranchFromRemote(params) {
  const checked = ensureGitHubFlowPrerequisites(params.rootPath);
  const repoRoot = checked.repoRoot;

  runCommand("git", ["-C", repoRoot, "fetch", "origin", "--prune"], {
    errorPrefix: "主分支同步失败: 无法同步 origin",
  });

  const baseRef = String(params.baseRef ?? detectDefaultRemoteRef(repoRoot)).trim();
  const baseBranch = normalizeBaseBranchName(baseRef);
  if (!baseRef || !baseBranch) {
    return {
      repoRoot,
      baseRef,
      baseBranch,
      synced: false,
      changed: false,
      switchedFrom: "",
      skippedReason: "base_ref_missing",
    };
  }

  const baseVerified = runCommandSafe("git", ["-C", repoRoot, "rev-parse", "--verify", baseRef]);
  if (!baseVerified) {
    return {
      repoRoot,
      baseRef,
      baseBranch,
      synced: false,
      changed: false,
      switchedFrom: "",
      skippedReason: "base_ref_not_found",
    };
  }

  const dirty = runCommand("git", ["-C", repoRoot, "status", "--porcelain"], {
    errorPrefix: "主分支同步失败: 无法读取工作区状态",
  });
  if (dirty.trim()) {
    return {
      repoRoot,
      baseRef,
      baseBranch,
      synced: false,
      changed: false,
      switchedFrom: "",
      skippedReason: "workspace_dirty",
    };
  }

  const currentBranch = String(runCommandSafe("git", ["-C", repoRoot, "branch", "--show-current"]) || "").trim();
  const localExists = Boolean(
    runCommandSafe("git", ["-C", repoRoot, "show-ref", "--verify", `refs/heads/${baseBranch}`])
  );
  const switchedFrom = currentBranch && currentBranch !== baseBranch ? currentBranch : "";

  try {
    if (switchedFrom) {
      if (localExists) {
        runCommand("git", ["-C", repoRoot, "checkout", baseBranch], {
          errorPrefix: `主分支同步失败: 无法切换到 ${baseBranch}`,
        });
      } else {
        runCommand("git", ["-C", repoRoot, "checkout", "-b", baseBranch, baseRef], {
          errorPrefix: `主分支同步失败: 无法创建并切换到 ${baseBranch}`,
        });
      }
    }

    let canFastForward = false;
    try {
      runCommand("git", ["-C", repoRoot, "merge-base", "--is-ancestor", "HEAD", baseRef], {
        errorPrefix: `主分支同步失败: 无法校验 fast-forward 基线 ${baseRef}`,
      });
      canFastForward = true;
    } catch {
      canFastForward = false;
    }
    if (!canFastForward) {
      return {
        repoRoot,
        baseRef,
        baseBranch,
        synced: false,
        changed: false,
        switchedFrom,
        skippedReason: "local_branch_diverged",
      };
    }

    const before = runCommand("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      errorPrefix: "主分支同步失败: 无法读取同步前 HEAD",
    });
    runCommand("git", ["-C", repoRoot, "merge", "--ff-only", baseRef], {
      errorPrefix: `主分支同步失败: 无法 fast-forward 到 ${baseRef}`,
    });
    const after = runCommand("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      errorPrefix: "主分支同步失败: 无法读取同步后 HEAD",
    });

    return {
      repoRoot,
      baseRef,
      baseBranch,
      synced: true,
      changed: before !== after,
      switchedFrom,
      skippedReason: "",
    };
  } finally {
    if (switchedFrom) {
      runCommandSafe("git", ["-C", repoRoot, "checkout", switchedFrom], {
        errorPrefix: `主分支同步失败: 无法恢复分支 ${switchedFrom}`,
      });
    }
  }
}

export function ensureGitHubPullRequestForRun(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const worktreePath = path.resolve(params.worktreePath ?? repoRoot);
  const branchName = String(params.branchName ?? "").trim();
  if (!branchName) {
    throw new Error("GitHub PR 创建失败: branchName 不能为空");
  }
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`GitHub PR 创建失败: worktree 不存在 ${worktreePath}`);
  }

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const existing = findGitHubPullRequestForBranch({
    repoRootPath: repoRoot,
    branchName,
  });
  if (existing?.number) {
    return normalizePullRequestRecord(existing, {
      repo: remote.slug,
      existing: true,
      created: false,
      commitCreated: false,
      pushed: false,
      skippedReason: "already_exists",
    });
  }

  runCommand("git", ["-C", worktreePath, "add", "-A"], {
    errorPrefix: `GitHub PR 创建失败 (${branchName})`,
  });
  const pending = runCommand("git", ["-C", worktreePath, "status", "--porcelain"], {
    errorPrefix: `GitHub PR 创建失败 (${branchName})`,
  });

  let commitCreated = false;
  if (pending.trim()) {
    const commitMessage = normalizeCommitMessage(params.commitMessage, params.runId);
    runCommand("git", ["-C", worktreePath, "commit", "-m", commitMessage], {
      errorPrefix: `GitHub PR 创建失败 (${branchName}): 提交变更失败`,
    });
    commitCreated = true;
  }

  runCommand("git", ["-C", worktreePath, "push", "-u", "origin", branchName], {
    errorPrefix: `GitHub PR 创建失败 (${branchName}): 推送分支失败`,
  });

  const baseRef = String(params.baseRef ?? `origin/${normalizeBaseBranchName("main")}`).trim();
  const aheadProbe = resolveGitAheadState({
    worktreePath,
    baseRef,
  });
  if (!aheadProbe.ok) {
    return normalizePullRequestRecord({
      repo: remote.slug,
      number: 0,
      url: "",
      title: "",
      headRefName: branchName,
      baseRefName: normalizeBaseBranchName(baseRef),
    }, {
      existing: false,
      created: false,
      commitCreated,
      pushed: true,
      skippedReason: String(aheadProbe.skippedReason ?? "ahead_probe_failed"),
      skippedReasonCategory: aheadProbe.reasonCategory,
      skippedDetail: aheadProbe.detail,
      skippedDiagnostics: aheadProbe.diagnostics,
    });
  }
  if (aheadProbe.aheadCount <= 0) {
    return normalizePullRequestRecord({
      repo: remote.slug,
      number: 0,
      url: "",
      title: "",
      headRefName: branchName,
      baseRefName: normalizeBaseBranchName(aheadProbe.baseRefUsed || baseRef),
    }, {
      existing: false,
      created: false,
      commitCreated,
      pushed: true,
      skippedReason: "no_commits_ahead_true",
      skippedReasonCategory: "no_commits_ahead_true",
      skippedDetail: aheadProbe.detail,
      skippedDiagnostics: aheadProbe.diagnostics,
    });
  }

  const baseBranch = normalizeBaseBranchName(aheadProbe.baseRefUsed || baseRef);
  const title = normalizePrTitle(params);
  const body = normalizePrBody({
    ...params,
    branchName,
    baseRef,
  });
  const args = [
    "pr",
    "create",
    "--repo",
    remote.slug,
    "--head",
    branchName,
    "--base",
    baseBranch,
    "--title",
    title,
    "--body",
    body,
  ];
  if (params.draft !== false) {
    args.push("--draft");
  }

  const maxCreateAttempts = 3;
  let lastCreateError = null;
  for (let attempt = 1; attempt <= maxCreateAttempts; attempt += 1) {
    try {
      const raw = runCommand("gh", args, {
        cwd: worktreePath,
        env: tokenEnv,
        errorPrefix: `GitHub PR 创建失败 (${branchName})`,
      });
      const parsed = parsePrUrlAndNumber(raw);
      if (parsed.number > 0) {
        return normalizePullRequestRecord({
          repo: remote.slug,
          number: parsed.number,
          url: parsed.url,
          title,
          headRefName: branchName,
          baseRefName: baseBranch,
        }, {
          existing: false,
          created: true,
          commitCreated,
          pushed: true,
          prCreateAttempts: attempt,
        });
      }

      const linked = findGitHubPullRequestForBranch({
        repoRootPath: repoRoot,
        branchName,
      });
      if (linked?.number) {
        return normalizePullRequestRecord(linked, {
          repo: remote.slug,
          existing: true,
          created: false,
          commitCreated,
          pushed: true,
          skippedReason: "already_exists",
          prCreateAttempts: attempt,
        });
      }

      throw new Error("GitHub PR 创建失败: 未返回可解析的 PR 链接");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      const reasonCategory = classifyGitHubFailure(message);

      if (lower.includes("already exists")) {
        const linked = findGitHubPullRequestForBranch({
          repoRootPath: repoRoot,
          branchName,
        });
        if (linked?.number) {
          return normalizePullRequestRecord(linked, {
            repo: remote.slug,
            existing: true,
            created: false,
            commitCreated,
            pushed: true,
            skippedReason: "already_exists",
            prCreateAttempts: attempt,
          });
        }
      }

      if (
        lower.includes("no commits between")
        || lower.includes("no commits")
        || lower.includes("must have commits")
        || lower.includes("no changes")
      ) {
        return normalizePullRequestRecord({
          repo: remote.slug,
          number: 0,
          url: "",
          title,
          headRefName: branchName,
          baseRefName: baseBranch,
        }, {
          existing: false,
          created: false,
          commitCreated,
          pushed: true,
          skippedReason: "no_commits_ahead_true",
          skippedReasonCategory: "no_commits_ahead_true",
          skippedDetail: "GitHub rejected PR due no commits between base and head",
          skippedDiagnostics: {
            baseRefInput: baseRef,
            baseRefUsed: aheadProbe.baseRefUsed || baseRef,
            head: branchName,
            error: message,
          },
          prCreateAttempts: attempt,
        });
      }

      if (reasonCategory === "network_timeout" && attempt < maxCreateAttempts) {
        sleepMs(250 * (2 ** (attempt - 1)));
        continue;
      }

      lastCreateError = new Error(
        `${message} (classification=${reasonCategory}, attempt=${attempt}/${maxCreateAttempts})`
      );
      break;
    }
  }
  throw lastCreateError ?? new Error("GitHub PR 创建失败: 未知错误");
}

export function createGitHubPullRequestComment(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const prNumber = Number(params.prNumber ?? 0);
  const body = String(params.body ?? "").trim();
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid GitHub pull request ref: ${params.prNumber}`);
  }
  if (!body) {
    throw new Error("GitHub pull request comment body is required");
  }

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();

  const url = runCommand(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `/repos/${remote.slug}/issues/${prNumber}/comments`,
      "-f",
      `body=${body}`,
      "-q",
      ".html_url",
    ],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: `GitHub PR 评论失败 (#${prNumber})`,
    }
  );
  return {
    repo: remote.slug,
    prNumber,
    url: String(url ?? "").trim(),
  };
}

export function createProjectGitHubIssue(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const projectId = String(params.projectId ?? "");
  const title = String(params.title ?? "").trim();
  const body = String(params.body ?? "");
  const automationReadyLabel = "forgeops:ready";
  if (!title) {
    throw new Error("title is required");
  }

  assertTooling();
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { remote } = ensureGitHubOrigin(repoRoot);
  const tokenEnv = getGitHubTokenEnvRequired();
  ensureGitHubIssueLabel(repoRoot, remote.slug, automationReadyLabel, tokenEnv);
  const output = runCommand(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      remote.slug,
      "--title",
      title,
      "--body",
      body,
      "--label",
      automationReadyLabel,
    ],
    {
      cwd: repoRoot,
      env: tokenEnv,
      errorPrefix: "创建 GitHub issue 失败",
    }
  );

  const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const issueUrl = lines.find((line) => line.startsWith("http")) ?? "";
  const match = issueUrl.match(/\/issues\/(\d+)(?:$|[?#])/);
  if (!match) {
    throw new Error("创建 GitHub issue 失败: 返回结果中未找到 issue 编号");
  }
  const issueNumber = Number(match[1]);
  const issue = readGitHubIssueView(repoRoot, remote.slug, issueNumber);
  return mapGitHubIssueToRecord(projectId, issue);
}

function ensureGitRepo(rootPath, defaultBranch = "main") {
  const resolved = path.resolve(rootPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Git 初始化失败: 目录不存在 ${resolved}`);
  }

  const isRepo = runCommandSafe("git", ["-C", resolved, "rev-parse", "--is-inside-work-tree"]);
  if (isRepo) {
    const repoRoot = getRepoRoot(resolved);
    const branch = ensureDefaultBranch(repoRoot, defaultBranch);
    return {
      repoRoot,
      initializedGit: false,
      branch,
    };
  }

  const initWithBranch = runCommandSafe("git", ["-C", resolved, "init", "-b", defaultBranch], {
    errorPrefix: "Git 初始化失败",
  });
  if (!initWithBranch) {
    runCommand("git", ["-C", resolved, "init"], {
      errorPrefix: "Git 初始化失败",
    });
  }

  const repoRoot = getRepoRoot(resolved);
  const branch = ensureDefaultBranch(repoRoot, defaultBranch);
  return {
    repoRoot,
    initializedGit: true,
    branch,
  };
}

export function ensureGitHubFlowPrerequisites(rootPath) {
  assertTooling();

  const repoRoot = getRepoRoot(rootPath);
  ensureGitIdentity(repoRoot);
  ensureGitHubPatAvailable(repoRoot);
  const { originUrl, remote } = ensureGitHubOrigin(repoRoot);

  runCommand("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"], {
    errorPrefix: "GitHub flow precheck failed: 仓库没有可执行的提交",
  });

  return {
    repoRoot,
    originUrl,
    remote,
  };
}

export function readGitHubRepoBinding(rootPath) {
  try {
    assertTooling();
    const repoRoot = getRepoRoot(path.resolve(rootPath));
    const { originUrl, remote } = ensureGitHubOrigin(repoRoot);
    return {
      available: true,
      repoRoot,
      originUrl,
      owner: remote.owner,
      repo: remote.repo,
      slug: remote.slug,
      warning: "",
    };
  } catch (err) {
    return {
      available: false,
      repoRoot: null,
      originUrl: "",
      owner: "",
      repo: "",
      slug: "",
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readGitHubIssuePrMetrics(rootPath) {
  const binding = readGitHubRepoBinding(rootPath);
  if (!binding.available || !binding.slug || !binding.repoRoot) {
    return {
      available: false,
      source: "none",
      repo: binding.slug || "",
      issueCounts: { all: 0, open: 0, closed: 0 },
      prCounts: { all: 0, open: 0, closed: 0 },
      fetchedAt: new Date().toISOString(),
      warning: binding.warning || "项目未绑定可访问的 GitHub origin。",
    };
  }

  try {
    ensureGitHubPatAvailable(binding.repoRoot);
    const issueCounts = {
      all: readGitHubSearchCount(binding.slug, "issue", [], binding.repoRoot),
      open: readGitHubSearchCount(binding.slug, "issue", ["state:open"], binding.repoRoot),
      closed: readGitHubSearchCount(binding.slug, "issue", ["state:closed"], binding.repoRoot),
    };
    const prCounts = {
      all: readGitHubSearchCount(binding.slug, "pr", [], binding.repoRoot),
      open: readGitHubSearchCount(binding.slug, "pr", ["state:open"], binding.repoRoot),
      closed: readGitHubSearchCount(binding.slug, "pr", ["state:closed"], binding.repoRoot),
    };
    return {
      available: true,
      source: "github_api",
      repo: binding.slug,
      issueCounts,
      prCounts,
      fetchedAt: new Date().toISOString(),
      warning: "",
    };
  } catch (err) {
    return {
      available: false,
      source: "none",
      repo: binding.slug,
      issueCounts: { all: 0, open: 0, closed: 0 },
      prCounts: { all: 0, open: 0, closed: 0 },
      fetchedAt: new Date().toISOString(),
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

export function provisionProjectGitHubRemote(params) {
  const rootPath = path.resolve(params.rootPath);
  const projectName = String(params.projectName ?? path.basename(rootPath));
  const visibility = params.visibility === "public" ? "public" : "private";
  const defaultBranch = String(params.defaultBranch ?? "main");
  const branchProtectionEnabled = params.branchProtection !== false;

  emitProgress(params, "git.precheck", "检查 git/gh 工具可用性");
  assertTooling();

  emitProgress(params, "git.repo.ensure", "初始化或校验本地 Git 仓库");
  const repo = ensureGitRepo(rootPath, defaultBranch);
  const ignoreUpdated = ensureWorktreeIgnore(repo.repoRoot);
  const branch = ensureDefaultBranch(repo.repoRoot, defaultBranch);
  ensureGitIdentity(repo.repoRoot);

  emitProgress(params, "git.remote.detect", "检测 origin 远程绑定状态");
  const originExisting = runCommandSafe("git", ["-C", repo.repoRoot, "remote", "get-url", "origin"]);
  if (originExisting) {
    const parsed = parseGitHubRemote(originExisting);
    if (!parsed) {
      throw new Error("Git 初始化失败: 现有 origin 不是 github.com，请手动修正远程地址");
    }

    emitProgress(params, "git.remote.exists", `检测到已绑定 origin: ${parsed.slug}`);
    ensureGitHubPatAvailable(repo.repoRoot);
    let protection = {
      branch: defaultBranch,
      applied: false,
      fallbackUsed: false,
      skipped: false,
      skippedReason: "",
    };
    if (branchProtectionEnabled) {
      const tokenEnv = getGitHubTokenEnvRequired();
      emitProgress(params, "git.branch_protection.ensure", `保护分支: ${defaultBranch}`);
      const ensured = ensureGitHubBranchProtection(
        repo.repoRoot,
        parsed.slug,
        defaultBranch,
        tokenEnv
      );
      protection = {
        branch: ensured.branch,
        applied: ensured.applied,
        fallbackUsed: ensured.fallbackUsed,
        skipped: false,
        skippedReason: "",
      };
      emitProgress(
        params,
        "git.branch_protection.done",
        `分支保护已生效: ${protection.branch}${protection.fallbackUsed ? " (fallback)" : ""}`
      );
    } else {
      protection = {
        branch: defaultBranch,
        applied: false,
        fallbackUsed: false,
        skipped: true,
        skippedReason: "disabled_by_flag",
      };
      emitProgress(
        params,
        "git.branch_protection.skipped",
        `已跳过分支保护: ${defaultBranch}（branchProtection=false）`
      );
    }
    return {
      repoRoot: repo.repoRoot,
      originUrl: originExisting,
      remoteSlug: parsed.slug,
      branch,
      initializedGit: repo.initializedGit,
      createdRemote: false,
      pushedInitialCommit: false,
      ignoreUpdated,
      protectedBranch: protection.branch,
      branchProtectionApplied: protection.applied,
      branchProtectionFallback: protection.fallbackUsed,
      branchProtectionSkipped: protection.skipped,
      branchProtectionSkipReason: protection.skippedReason,
    };
  }

  emitProgress(params, "git.remote.create.prepare", "准备创建/绑定 GitHub 远程仓库");
  ensureGitHubPatAvailable(repo.repoRoot);
  const login = getGhLogin(repo.repoRoot);
  const targetSlug = normalizeRepoSlug(params.githubRepo, login, projectName || path.basename(repo.repoRoot));

  emitProgress(params, "git.remote.commit.ensure", "检查并准备初始提交");
  const pushedInitialCommit = ensureInitialCommit(repo.repoRoot);

  const tokenEnv = getGitHubTokenEnvRequired();
  emitProgress(params, "git.remote.check", `检查远程仓库是否已存在: ${targetSlug}`);
  const repoExists = runCommandSafe("gh", ["repo", "view", targetSlug], {
    cwd: repo.repoRoot,
    env: tokenEnv,
  });

  if (repoExists) {
    emitProgress(params, "git.remote.bind", "绑定现有 GitHub 仓库并推送分支");
    runCommand("git", ["-C", repo.repoRoot, "remote", "add", "origin", `https://github.com/${targetSlug}.git`], {
      errorPrefix: "Git 初始化失败: 绑定 origin 失败",
    });
    runCommand("git", ["-C", repo.repoRoot, "push", "-u", "origin", branch], {
      errorPrefix: "Git 初始化失败: 推送到已有 GitHub 仓库失败",
    });
  } else {
    emitProgress(params, "git.remote.create", `创建 GitHub 仓库: ${targetSlug}`);
    const createArgs = [
      "repo",
      "create",
      targetSlug,
      visibility === "public" ? "--public" : "--private",
      "--source",
      repo.repoRoot,
      "--remote",
      "origin",
      "--push",
    ];
    const description = String(params.description ?? "").trim();
    if (description) {
      createArgs.push("--description", description);
    }

    runCommand("gh", createArgs, {
      cwd: repo.repoRoot,
      env: tokenEnv,
      errorPrefix: "Git 初始化失败: 创建 GitHub 仓库失败",
    });
  }

  emitProgress(params, "git.remote.verify", "校验远程仓库绑定结果");
  const originUrl = getOriginUrl(repo.repoRoot);
  const parsed = parseGitHubRemote(originUrl);
  if (!parsed) {
    throw new Error("Git 初始化失败: 创建后未获得有效 GitHub origin");
  }
  let protection = {
    branch: defaultBranch,
    applied: false,
    fallbackUsed: false,
    skipped: false,
    skippedReason: "",
  };
  if (branchProtectionEnabled) {
    emitProgress(params, "git.branch_protection.ensure", `保护分支: ${defaultBranch}`);
    const ensured = ensureGitHubBranchProtection(
      repo.repoRoot,
      parsed.slug,
      defaultBranch,
      tokenEnv
    );
    protection = {
      branch: ensured.branch,
      applied: ensured.applied,
      fallbackUsed: ensured.fallbackUsed,
      skipped: false,
      skippedReason: "",
    };
    emitProgress(
      params,
      "git.branch_protection.done",
      `分支保护已生效: ${protection.branch}${protection.fallbackUsed ? " (fallback)" : ""}`
    );
  } else {
    protection = {
      branch: defaultBranch,
      applied: false,
      fallbackUsed: false,
      skipped: true,
      skippedReason: "disabled_by_flag",
    };
    emitProgress(
      params,
      "git.branch_protection.skipped",
      `已跳过分支保护: ${defaultBranch}（branchProtection=false）`
    );
  }

  emitProgress(params, "git.done", `GitHub 绑定完成: ${parsed.slug}`);

  return {
    repoRoot: repo.repoRoot,
    originUrl,
    remoteSlug: parsed.slug,
    branch,
    initializedGit: repo.initializedGit,
    createdRemote: true,
    pushedInitialCommit,
    ignoreUpdated,
    protectedBranch: protection.branch,
    branchProtectionApplied: protection.applied,
    branchProtectionFallback: protection.fallbackUsed,
    branchProtectionSkipped: protection.skipped,
    branchProtectionSkipReason: protection.skippedReason,
  };
}

export function createRunWorktree(params) {
  const checked = ensureGitHubFlowPrerequisites(params.rootPath);
  const runId = String(params.runId);
  const branch = String(params.branchName ?? `forgeops/${runId}`);

  runCommand("git", ["-C", checked.repoRoot, "fetch", "origin", "--prune"], {
    errorPrefix: "创建 worktree 失败: 无法同步 origin",
  });

  const baseRef = String(params.baseRef ?? detectDefaultRemoteRef(checked.repoRoot));
  const worktreePath = path.join(checked.repoRoot, ".forgeops", "worktrees", runId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  if (fs.existsSync(worktreePath)) {
    throw new Error(`创建 worktree 失败: 路径已存在 ${worktreePath}`);
  }

  runCommand("git", ["-C", checked.repoRoot, "worktree", "add", "-b", branch, worktreePath, baseRef], {
    errorPrefix: "创建 worktree 失败",
  });

  return {
    repoRoot: checked.repoRoot,
    worktreePath,
    worktreeBranch: branch,
    baseRef,
    originUrl: checked.originUrl,
  };
}

export function cleanupRunWorktree(params) {
  const rootPath = path.resolve(String(params?.rootPath ?? ""));
  const repoRoot = getRepoRoot(rootPath);
  const runId = String(params?.runId ?? "").trim();
  const worktreeRoot = path.join(repoRoot, ".forgeops", "worktrees");
  const fallbackPath = runId ? path.join(worktreeRoot, runId) : worktreeRoot;
  const resolvedWorktreePath = path.resolve(String(params?.worktreePath ?? fallbackPath));
  const safePrefix = `${worktreeRoot}${path.sep}`;
  if (!resolvedWorktreePath.startsWith(safePrefix)) {
    return {
      cleaned: false,
      worktreePath: resolvedWorktreePath,
      branchName: String(params?.branchName ?? "").trim(),
      localBranchDeleted: false,
      skippedReason: "unsafe_worktree_path",
    };
  }

  if (!fs.existsSync(resolvedWorktreePath)) {
    return {
      cleaned: false,
      worktreePath: resolvedWorktreePath,
      branchName: String(params?.branchName ?? "").trim(),
      localBranchDeleted: false,
      skippedReason: "worktree_not_found",
    };
  }

  runCommand("git", ["-C", repoRoot, "worktree", "remove", "--force", resolvedWorktreePath], {
    errorPrefix: `worktree 清理失败: 无法移除 ${resolvedWorktreePath}`,
  });
  runCommandSafe("git", ["-C", repoRoot, "worktree", "prune"]);

  const branchName = String(params?.branchName ?? "").trim();
  const localBranchDeleted = branchName
    ? Boolean(runCommandSafe("git", ["-C", repoRoot, "branch", "-D", branchName]))
    : false;

  return {
    cleaned: true,
    worktreePath: resolvedWorktreePath,
    branchName,
    localBranchDeleted,
    skippedReason: "",
  };
}

export function createGitHubIssue(params) {
  const repoRoot = path.resolve(params.repoRootPath);
  const title = String(params.title ?? "").trim();
  const body = String(params.body ?? "").trim();
  if (!title || !body) {
    return {
      created: false,
      error: "title/body required",
      url: null,
      repo: null,
    };
  }

  try {
    assertTooling();
    ensureGitIdentity(repoRoot);
    ensureGitHubPatAvailable(repoRoot);
    const { remote } = ensureGitHubOrigin(repoRoot);
    const tokenEnv = getGitHubTokenEnvRequired();
    const output = runCommand(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        remote.slug,
        "--title",
        title,
        "--body",
        body,
      ],
      {
        cwd: repoRoot,
        env: tokenEnv,
        errorPrefix: "创建 follow-up issue 失败",
      },
    );

    const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const url = lines.find((line) => line.startsWith("http")) ?? null;
    return {
      created: true,
      error: null,
      url,
      repo: remote.slug,
    };
  } catch (err) {
    return {
      created: false,
      error: err instanceof Error ? err.message : String(err),
      url: null,
      repo: null,
    };
  }
}
