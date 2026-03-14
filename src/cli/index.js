#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { runDoctor } from "../core/doctor.js";
import { ensureGlobalGitHubDeveloperAccess } from "../core/git.js";
import { normalizeProductType } from "../core/product-type.js";
import { initProjectScaffold } from "../core/project-init.js";
import { resolveRunAttachContext } from "../core/run-attach.js";
import { findCodexSessionJsonlForThread, readTailTextFile, resolveManagedCodexHome } from "../core/codex-session-log.js";
import { renderProjectStatusSvg, renderRunStatusSvg, renderSessionStatusSvg, renderSystemStatusSvg } from "../core/status-chart.js";
import { renderProjectStatusHtml, renderSystemStatusHtml } from "../core/status-card-html.js";
import { renderHtmlToPngWithChrome } from "../core/html-to-image.js";
import {
  getForgeOpsServiceInfo,
  installForgeOpsService,
  readForgeOpsServiceLogs,
  startForgeOpsService,
  stopForgeOpsService,
  uninstallForgeOpsService,
} from "../core/service-manager.js";
import { loadSchedulerConfig, updateSchedulerConfig } from "../core/scheduler-config.js";
import { DEFAULT_WORKFLOW_CONFIG, buildWorkflowYaml, loadWorkflowConfig, writeWorkflowConfigYaml } from "../core/workflow-config.js";
import { createRuntimeRegistry } from "../runtime/index.js";
import { ensureCodexRuntimeReady } from "../runtime/preflight.js";
import { ForgeOpsEngine } from "../worker/engine.js";
import { ForgeOpsScheduler } from "../worker/scheduler.js";
import { createServerApp } from "../server/app.js";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CLI_DIR, "../..");
const DEFAULT_META_SKILL_PATH = path.join(REPO_ROOT, "FORGEOPS_META_SKILL.md");
const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4173";
const CODEX_SESSION_REGISTRY_FILE = "codex-session-registry.json";

async function createStoreInstance() {
  const mod = await import("../core/store.js");
  return mod.createStore();
}

function printUsage() {
  process.stdout.write(
    [
      "ForgeOps CLI",
      "",
      "forgeops start [--port 4173] [--host 127.0.0.1] [--poll-ms 1500] [--concurrency 2]",
      "forgeops status [--window-minutes 60] [--json]  # control-plane status (runs/steps/sessions/events/tokens)",
      "forgeops status [--window-minutes 60] --chart svg [--out PATH | --stdout]  # generate chart (SVG)",
      "forgeops chart system [--window-minutes 60] [--format svg|html|png] [--width 1280] [--height 900] [--out PATH] [--json]  # writes under runtime charts dir by default",
      "forgeops chart project <projectId> [--window-minutes 60] [--format svg|html|png] [--width 1280] [--height 900] [--out PATH] [--json]",
      "forgeops chart run <runId> ... [--experimental]  # not enabled by default",
      "forgeops chart session <sessionId> ... [--experimental]  # not enabled by default",
      "forgeops env set system KEY=VALUE [--secret|--plain]",
      "forgeops env set project <projectId> KEY=VALUE [--secret|--plain]",
      "forgeops env set run <runId> KEY=VALUE [--secret|--plain]",
      "forgeops env set step <runId> <stepKey> KEY=VALUE [--secret|--plain]",
      "forgeops env ls system [--show] [--json]",
      "forgeops env ls project <projectId> [--show] [--json]",
      "forgeops env ls run <runId> [--show] [--json]",
      "forgeops env ls step <runId> <stepKey> [--show] [--json]",
      "forgeops env effective step <runId> <stepKey> [--show] [--json]",
      "forgeops env unset system KEY",
      "forgeops env unset project <projectId> KEY",
      "forgeops env unset run <runId> KEY",
      "forgeops env unset step <runId> <stepKey> KEY",
      "forgeops project init [--name NAME] [--type web|miniapp|ios|microservice|android|serverless|other] [--language LANG] [--frontend-stack STACK] [--backend-stack STACK] [--ci-provider NAME] [--problem TEXT] [--path DIR] [--github-repo OWNER/NAME] [--github-public|--github-private] [--branch-protection|--no-branch-protection] [--no-open-ui]  # default opens Dashboard",
      "forgeops project list",
      "forgeops project metrics <projectId> [--json]",
      "forgeops issue create <projectId> <title> [--description TEXT] [--no-auto-run] [--mode quick|standard] [--quick]    # create GitHub issue",
      "forgeops issue list <projectId>                                   # list GitHub issues",
      "forgeops skill candidates <projectId>                             # list skill candidates",
      "forgeops skill resolve <projectId>                                # resolve effective skills with priority",
      "forgeops skill promote <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--roles developer,tester] [--role reviewer] [--ready]",
      "forgeops skill global-status                                      # show user-global skill library status",
      "forgeops skill global-init [--github-repo OWNER/NAME] [--public|--private] [--branch-protection|--no-branch-protection]",
      "forgeops skill promote-global <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--ready]",
      "forgeops run create <projectId> [task] --issue GITHUB_ISSUE_NUMBER [--mode quick|standard]",
      "forgeops run list [--project PROJECT_ID]",
      "forgeops run show <runId>",
      "forgeops run stop <runId>",
      "forgeops run resume <runId>",
      "forgeops run stop-all [--project PROJECT_ID]",
      "forgeops run resume-all [--project PROJECT_ID]",
      "forgeops run attach <runId> [--step STEP_KEY] [--session SESSION_ID] [--thread THREAD_ID]  # open Codex thread",
      "forgeops doctor [--json]",
      "forgeops service install [--no-start] [--host 127.0.0.1] [--port 4173] [--poll-ms 1500] [--concurrency 2] [--runtime-home DIR]",
      "forgeops service start|stop|restart|status|uninstall [--runtime-home DIR]",
      "forgeops service logs [--lines 120] [--runtime-home DIR]",
      "forgeops scheduler show <projectId>",
      "forgeops scheduler set <projectId> [--enabled true|false] [--cleanup-enabled true|false] [--cron \"0 3 * * *\"] [--timezone UTC] [--task TEXT] [--only-when-idle true|false] [--issue-auto-enabled true|false] [--issue-auto-cron \"*/1 * * * *\"] [--issue-auto-label forgeops:ready|*] [--issue-auto-only-when-idle true|false] [--issue-auto-max-runs-per-tick 3] [--skill-auto-enabled true|false] [--skill-auto-cron \"15 */6 * * *\"] [--skill-auto-only-when-idle true|false] [--skill-auto-max-promotions-per-tick 1] [--skill-auto-min-occurrences 2] [--skill-auto-lookback-days 14] [--skill-auto-min-score 0.6] [--skill-auto-draft true|false] [--skill-auto-roles developer,tester] [--global-skill-auto-enabled true|false] [--global-skill-auto-cron \"45 */12 * * *\"] [--global-skill-auto-only-when-idle true|false] [--global-skill-auto-max-promotions-per-tick 1] [--global-skill-auto-min-occurrences 3] [--global-skill-auto-lookback-days 30] [--global-skill-auto-min-score 0.75] [--global-skill-auto-require-project-skill true|false] [--global-skill-auto-draft true|false]",
      "forgeops workflow show <projectId>",
      "forgeops workflow set <projectId> [--yaml-file PATH | --yaml TEXT | --reset-default | --auto-merge-conflict-max-attempts N]",
      "forgeops workflow set-conflict-retries <projectId> <0-8>",
      "forgeops workflow get-conflict-retries <projectId>",
      "forgeops codex session [--client auto|app|cli] [--session-key KEY] [--cwd DIR] [--prompt TEXT] [--model MODEL] [--meta-skill PATH] [--no-meta-skill] [--fresh]  # ForgeOps usage coach",
      "forgeops codex project [--project PROJECT_ID] [--cwd DIR] [--client auto|app|cli] [--session-key KEY] [--prompt TEXT] [--model MODEL] [--meta-skill PATH] [--no-meta-skill] [--local-only] [--fresh]  # managed project copilot",
      "forgeops help",
    ].join("\n") + "\n"
  );
}

function getFlag(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function getFlags(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (value === undefined) continue;
    out.push(value);
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

function parseBool(value, fallback = null) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function parseEnvAssignment(args, index) {
  const raw = String(args[index] ?? "").trim();
  if (!raw) return { key: "", value: "", consumed: 0 };
  const eqIdx = raw.indexOf("=");
  if (eqIdx !== -1) {
    return {
      key: raw.slice(0, eqIdx).trim(),
      value: raw.slice(eqIdx + 1),
      consumed: 1,
    };
  }
  const value = args[index + 1] === undefined ? "" : String(args[index + 1]);
  return { key: raw, value, consumed: 2 };
}

function normalizeRunModeFlag(value, fallback = "quick") {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === "standard" || text === "quick") {
    return text;
  }
  return "";
}

function toNonNegativeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const out = Math.floor(num);
  return out >= 0 ? out : fallback;
}

function getStepPolicyMapFromRunDetail(details) {
  const context = details?.context && typeof details.context === "object"
    ? details.context
    : {};
  const raw = context.stepPolicies;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

function formatStepRetryLabel(step, policyMap) {
  const base = `重试=${step.retry_count}/${step.max_retries}`;
  const raw = policyMap?.[step.step_key];
  if (!raw || typeof raw !== "object") return base;
  const autoFix = raw.reviewAutoFix;
  if (!autoFix || typeof autoFix !== "object") return base;
  const enabled = parseBool(autoFix.enabled, false) === true;
  if (!enabled) return `${base} · 自愈=off`;
  const maxTurns = toNonNegativeInt(autoFix.maxTurns, toNonNegativeInt(step.max_retries, 0));
  return `${base} · 自愈turn=${step.retry_count}/${maxTurns}`;
}

function formatWorkflowResolvedStep(step) {
  const deps = Array.isArray(step.dependsOn) && step.dependsOn.length > 0
    ? step.dependsOn.join(",")
    : "-";
  const retries = toNonNegativeInt(step.maxRetries, 0);
  const autoFix = step.reviewAutoFixPolicy && typeof step.reviewAutoFixPolicy === "object"
    ? step.reviewAutoFixPolicy
    : null;
  const autoFixText = autoFix
    ? ` auto_fix=${parseBool(autoFix.enabled, false) ? "on" : "off"} turns=${toNonNegativeInt(autoFix.maxTurns, retries)}`
    : "";
  return `${step.key} [agent=${step.agentId} retries=${retries} deps=${deps}${autoFixText}]`;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function ensureDashboardServiceReadyForInit() {
  try {
    const status = getForgeOpsServiceInfo();
    if (!status.installed) {
      return {
        ok: true,
        state: "installed-and-started",
        status: installForgeOpsService({ startNow: true }),
      };
    }
    if (!status.running) {
      return {
        ok: true,
        state: "started",
        status: startForgeOpsService(),
      };
    }
    return {
      ok: true,
      state: "already-running",
      status,
    };
  } catch (error) {
    return {
      ok: false,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function openUrlInBrowser(url) {
  const target = String(url ?? "").trim();
  if (!target) {
    return { ok: false, error: "empty url" };
  }

  let command = "";
  let commandArgs = [];
  if (process.platform === "darwin") {
    command = "open";
    commandArgs = [target];
  } else if (process.platform === "win32") {
    command = "cmd";
    commandArgs = ["/c", "start", "", target];
  } else if (process.platform === "linux") {
    command = "xdg-open";
    commandArgs = [target];
  } else {
    return { ok: false, error: `unsupported platform: ${process.platform}` };
  }

  const result = spawnSync(command, commandArgs, {
    stdio: "ignore",
    encoding: "utf8",
  });

  if (result.error) {
    return { ok: false, error: String(result.error.message || result.error) };
  }
  if (result.status !== 0) {
    return { ok: false, error: `exit code ${result.status}` };
  }
  return { ok: true };
}

async function commandProject(store, args) {
  const action = args[0];

  if (action === "list") {
    const rows = store.listProjects();
    if (rows.length === 0) {
      process.stdout.write("No projects found.\n");
      return;
    }
    for (const row of rows) {
      process.stdout.write(`${row.id}  ${row.name}  [${row.product_type}]  ${row.root_path}\n`);
    }
    return;
  }

  if (action === "metrics") {
    const projectId = args[1];
    if (!projectId) {
      fail("Usage: forgeops project metrics <projectId> [--json]");
    }
    const metrics = store.getProjectMetrics(projectId);
    if (!metrics) {
      fail(`Project not found: ${projectId}`);
    }
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Project Metrics: ${metrics.project_id}\n`);
    process.stdout.write(`- GitHub repo: ${metrics.github_repo || "-"}\n`);
    process.stdout.write(`- Metrics source: ${metrics.github_source}\n`);
    process.stdout.write(
      `- Issues (all/open/closed): ${metrics.issue_count_all}/${metrics.issue_count_open}/${metrics.issue_count_closed}\n`
    );
    process.stdout.write(
      `- PRs (all/open/closed): ${metrics.pr_count_all}/${metrics.pr_count_open}/${metrics.pr_count_closed}\n`
    );
    if (metrics.github_warning) {
      process.stdout.write(`- GitHub warning: ${metrics.github_warning}\n`);
    }
    process.stdout.write(`- Code lines: ${metrics.code_lines} (${metrics.code_files} files)\n`);
    process.stdout.write(`- Doc words (docs/): ${metrics.docs_doc_words} (${metrics.docs_doc_files} files)\n`);
    process.stdout.write(`- Doc words (repo): ${metrics.doc_words} (${metrics.doc_files} files)\n`);
    if (Array.isArray(metrics.code_languages) && metrics.code_languages.length > 0) {
      const langText = metrics.code_languages
        .slice(0, 6)
        .map((item) => `${item.language}:${item.lines}L/${item.files}F`)
        .join(" | ");
      process.stdout.write(`- Languages(top): ${langText}\n`);
    } else {
      process.stdout.write("- Languages(top): -\n");
    }
    if (metrics.code_trend_7d?.available) {
      process.stdout.write(
        `- 7d trend: commits=${metrics.code_trend_7d.commit_count} +${metrics.code_trend_7d.added_lines}/-${metrics.code_trend_7d.deleted_lines} net=${metrics.code_trend_7d.net_lines}\n`
      );
    } else {
      process.stdout.write(`- 7d trend: unavailable (${metrics.code_trend_7d?.warning || "none"})\n`);
    }
    process.stdout.write(`- Total tokens: ${metrics.token_total}\n`);
    process.stdout.write(
      `  input=${metrics.token_input_total} output=${metrics.token_output_total} cached=${metrics.token_cached_input_total} cache_hit=${metrics.token_cache_hit_rate.toFixed(1)}%\n`
    );
    process.stdout.write(`- Runs: total=${metrics.run_count} running=${metrics.run_running_count} completed=${metrics.run_completed_count} failed=${metrics.run_failed_count}\n`);
    process.stdout.write(`- Elapsed: ${metrics.elapsed_sec}s since ${metrics.created_at}\n`);
    process.stdout.write(`- LOC scanned at: ${metrics.loc_scanned_at} (${metrics.loc_source})\n`);
    process.stdout.write(`- GitHub fetched at: ${metrics.github_fetched_at}\n`);
    return;
  }

  if (action === "init") {
    process.stdout.write("[1/4] 运行时检查: Codex\n");
    ensureCodexRuntimeReady();
    process.stdout.write("[2/4] 系统检查: Git/GitHub 开发权限\n");
    ensureGlobalGitHubDeveloperAccess();

    const rootPath = path.resolve(getFlag(args, "--path", process.cwd()));
    const name = getFlag(args, "--name", path.basename(rootPath));
    const productTypeRaw = getFlag(args, "--type", "web");
    const productType = normalizeProductType(productTypeRaw);
    if (!productType) {
      fail("Invalid --type, must be one of: web, miniapp, ios, microservice, android, serverless, other");
    }
    const language = getFlag(args, "--language", "");
    const frontendStack = getFlag(args, "--frontend-stack", "");
    const backendStack = getFlag(args, "--backend-stack", "");
    const ciProvider = getFlag(args, "--ci-provider", "");
    const problemStatement = getFlag(args, "--problem", "");
    const githubRepo = getFlag(args, "--github-repo", null);
    const githubVisibility = args.includes("--github-public") ? "public" : "private";
    const forceBranchProtection = args.includes("--branch-protection");
    const disableBranchProtection = args.includes("--no-branch-protection");
    if (forceBranchProtection && disableBranchProtection) {
      fail("Cannot use both --branch-protection and --no-branch-protection");
    }
    const branchProtection = disableBranchProtection ? false : true;

    process.stdout.write("[3/4] 初始化项目脚手架（目录/文档/技能/GitHub）\n");
    const scaffold = initProjectScaffold({
      name,
      rootPath,
      productType,
      problemStatement,
      language,
      frontendStack,
      backendStack,
      ciProvider,
      githubRepo,
      githubVisibility,
      branchProtection,
      onProgress: (evt) => {
        const stage = String(evt?.stage ?? "progress");
        const detail = String(evt?.detail ?? "");
        process.stdout.write(`  - [${stage}] ${detail}\n`);
      },
    });

    process.stdout.write("[4/4] 注册项目到 ForgeOps Store\n");
    const resolvedGithubRepo = String(scaffold.git?.remoteSlug ?? githubRepo ?? "").trim();
    const existing = store.getProjectByRootPath(rootPath);
    const createdOrExisting = existing ?? store.createProject({
      name,
      rootPath,
      productType,
      githubRepo: resolvedGithubRepo,
      problemStatement,
    });
    const project = resolvedGithubRepo
      ? (store.setProjectGitHubRepo(createdOrExisting.id, resolvedGithubRepo) ?? createdOrExisting)
      : createdOrExisting;

    process.stdout.write(`Project ready: ${project.id} (${project.name})\n`);
    process.stdout.write(`Root: ${scaffold.rootPath}\n`);
    process.stdout.write(`GitHub: ${scaffold.git.remoteSlug} (${scaffold.git.originUrl})\n`);
    process.stdout.write(`Branch: ${scaffold.git.branch}\n`);
    if (scaffold.git.branchProtectionApplied) {
      process.stdout.write(
        `Protected branch: ${scaffold.git.protectedBranch}${scaffold.git.branchProtectionFallback ? " (fallback policy)" : ""}\n`
      );
    } else if (scaffold.git.branchProtectionSkipped) {
      process.stdout.write(
        `Protected branch: skipped (${scaffold.git.branchProtectionSkipReason || "disabled"})\n`
      );
    }
    process.stdout.write(`Tech: ${scaffold.tech.language} / ${scaffold.tech.frontendStack} / ${scaffold.tech.backendStack} / ${scaffold.tech.ciProvider}\n`);
    if (scaffold.git.createdRemote) {
      process.stdout.write("- created remote origin and pushed initial branch\n");
    }
    for (const item of scaffold.writes) {
      process.stdout.write(`- ${item.created ? "created" : "exists"} ${item.path}\n`);
    }

    const autoOpenDisabled = args.includes("--no-open-ui");
    const ciMode = parseBool(process.env.CI, false) === true;
    const interactive = Boolean(process.stdout.isTTY);
    if (autoOpenDisabled || !interactive || ciMode) {
      process.stdout.write(`Dashboard: ${DEFAULT_DASHBOARD_URL}\n`);
      if (!autoOpenDisabled && (!interactive || ciMode)) {
        process.stdout.write("Auto-open skipped (non-interactive mode).\n");
      }
      return;
    }

    const serviceStatus = ensureDashboardServiceReadyForInit();
    if (!serviceStatus.ok) {
      process.stdout.write(`UI service warning: ${serviceStatus.error}\n`);
    }

    const openResult = openUrlInBrowser(DEFAULT_DASHBOARD_URL);
    if (openResult.ok) {
      process.stdout.write(`Dashboard opened: ${DEFAULT_DASHBOARD_URL}\n`);
    } else {
      process.stdout.write(`Auto-open failed: ${openResult.error}\n`);
      process.stdout.write(`Open manually: ${DEFAULT_DASHBOARD_URL}\n`);
    }
    return;
  }

  fail("Unknown project command. Try: forgeops project init|list|metrics");
}

async function commandIssue(store, args) {
  const action = args[0];
  if (action === "create") {
    const projectId = args[1];
    const title = args[2];
    if (!projectId || !title) {
      fail("Usage: forgeops issue create <projectId> <title> [--description TEXT] [--no-auto-run] [--mode quick|standard] [--quick]");
    }
    const description = getFlag(args, "--description", "");
    const autoRun = !args.includes("--no-auto-run");
    const modeRaw = args.includes("--quick")
      ? "quick"
      : String(getFlag(args, "--mode", "quick") ?? "quick").trim().toLowerCase();
    const runMode = normalizeRunModeFlag(modeRaw, "quick");
    if (!runMode) {
      fail("--mode must be one of: quick, standard");
    }
    const labels = runMode === "standard"
      ? ["forgeops:standard"]
      : ["forgeops:quick"];
    const created = store.createIssueWithAutoRun({
      projectId,
      title,
      description,
      autoRun,
      runMode,
      labels,
    });
    const issue = created.issue;
    process.stdout.write(`Created GitHub issue: #${issue.id}${issue.github_url ? ` (${issue.github_url})` : ""}\n`);
    if (created.auto_run_enabled && created.run) {
      process.stdout.write(`Auto-created run: ${created.run.id} (mode=${runMode})\n`);
    } else if (created.auto_run_enabled && created.auto_run_error) {
      process.stdout.write(`Auto-run warning: ${created.auto_run_error}\n`);
    } else {
      process.stdout.write("Auto-run: disabled\n");
    }
    process.stdout.write(`Issue mode label: ${runMode === "quick" ? "forgeops:quick" : "forgeops:standard"}\n`);
    return;
  }

  if (action === "list") {
    const projectId = args[1];
    if (!projectId) {
      fail("Usage: forgeops issue list <projectId>");
    }
    const issues = store.listIssues(projectId);
    if (issues.length === 0) {
      process.stdout.write("No GitHub issues found.\n");
      return;
    }
    for (const issue of issues) {
      process.stdout.write(`#${issue.id}  [${issue.status}]  ${issue.title}\n`);
    }
    return;
  }

  fail("Unknown issue command. Try: forgeops issue create|list");
}

async function commandSkill(store, args) {
  const action = args[0];

  if (action === "global-status") {
    const status = store.getUserGlobalSkillsStatus();
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    process.stdout.write(`User-global root: ${status.rootPath}\n`);
    process.stdout.write(`- exists: ${status.exists ? "yes" : "no"}\n`);
    process.stdout.write(`- git available: ${status.git.available ? "yes" : "no"}\n`);
    process.stdout.write(`- git slug: ${status.git.slug || "-"}\n`);
    if (status.git.warning) {
      process.stdout.write(`- git warning: ${status.git.warning}\n`);
    }
    process.stdout.write(`- expected skills dir: ${status.expectedPaths.skillsDir}\n`);
    process.stdout.write(`- expected audit log: ${status.expectedPaths.auditLog}\n`);
    return;
  }

  if (action === "global-init") {
    const visibility = args.includes("--public") ? "public" : "private";
    const branchProtection = args.includes("--branch-protection");
    const progressLines = [];
    const result = store.initializeUserGlobalSkillsRepo({
      githubRepo: getFlag(args, "--github-repo", ""),
      visibility,
      branchProtection,
      onProgress: (item) => {
        const message = String(item?.message ?? "").trim();
        if (!message) return;
        progressLines.push(
          `- [${String(item?.stage ?? "git")}] ${message}`
        );
      },
    });
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ progress: progressLines, ...result }, null, 2)}\n`);
      return;
    }
    process.stdout.write("User-global skill repo initialized.\n");
    process.stdout.write(`- root: ${result.rootPath}\n`);
    process.stdout.write(`- repo: ${result.githubRepo}\n`);
    process.stdout.write(`- origin: ${result.originUrl}\n`);
    process.stdout.write(`- branch: ${result.branch}\n`);
    process.stdout.write(`- visibility: ${result.visibility}\n`);
    if (result.branchProtectionApplied) {
      process.stdout.write(`- branch protection: applied${result.branchProtectionFallback ? " (fallback)" : ""}\n`);
    } else if (result.branchProtectionSkipped) {
      process.stdout.write(`- branch protection: skipped (${result.branchProtectionSkipReason || "disabled"})\n`);
    }
    if (progressLines.length > 0) {
      process.stdout.write("Progress:\n");
      for (const line of progressLines) {
        process.stdout.write(`${line}\n`);
      }
    }
    return;
  }

  if (action === "candidates") {
    const projectId = args[1];
    if (!projectId) {
      fail("Usage: forgeops skill candidates <projectId> [--json]");
    }
    const list = store.listSkillCandidates(projectId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return;
    }
    if (list.length === 0) {
      process.stdout.write("No skill candidates found.\n");
      return;
    }
    for (const row of list) {
      process.stdout.write(`${row.path}\n`);
      process.stdout.write(`  - title: ${row.title}\n`);
      process.stdout.write(`  - run: ${row.runId || "-"}  issue: ${row.issueId || "-"}  at: ${row.generatedAt || "-"}\n`);
      process.stdout.write(`  - summary: ${row.summary || "-"}\n`);
    }
    return;
  }

  if (action === "resolve") {
    const projectId = args[1];
    if (!projectId) {
      fail("Usage: forgeops skill resolve <projectId> [--json]");
    }
    const resolved = store.resolveProjectSkills(projectId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
      return;
    }

    process.stdout.write(`Skill resolve: project=${projectId} productType=${resolved.productType}\n`);
    process.stdout.write(
      `Layers: project-local > user-global > official (officialProfile=${resolved.layerInfo?.officialProfile || "-"})\n`
    );
    for (const role of Object.keys(resolved.agentSkills ?? {})) {
      process.stdout.write(`- ${role}\n`);
      const items = Array.isArray(resolved.agentSkills[role]) ? resolved.agentSkills[role] : [];
      for (const item of items) {
        process.stdout.write(
          `  - ${item.name} [source=${item.source || "-"}] ${item.path ? `(${item.path})` : ""}\n`
        );
      }
    }
    return;
  }

  if (action === "promote") {
    const projectId = args[1];
    if (!projectId) {
      fail("Usage: forgeops skill promote <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--roles developer,tester] [--role reviewer] [--ready]");
    }
    const candidate = getFlag(args, "--candidate", "");
    if (!candidate) {
      fail("Usage: forgeops skill promote <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--roles developer,tester] [--role reviewer] [--ready]");
    }

    const rolesFromCsv = getFlags(args, "--roles");
    const rolesFromRepeat = getFlags(args, "--role");
    const roles = [...rolesFromCsv, ...rolesFromRepeat];
    const result = store.promoteSkillCandidate({
      projectId,
      candidate,
      skillName: getFlag(args, "--name", ""),
      description: getFlag(args, "--description", ""),
      roles,
      baseRef: getFlag(args, "--base", ""),
      draft: !args.includes("--ready"),
    });

    process.stdout.write(`Skill promoted to branch: ${result.branchName}\n`);
    process.stdout.write(`- candidate: ${result.candidate.path}\n`);
    process.stdout.write(`- skill: ${result.skillName}\n`);
    process.stdout.write(`- roles: ${result.roles.length > 0 ? result.roles.join(", ") : "-"}\n`);
    process.stdout.write(`- changed: ${result.changedFiles.join(", ")}\n`);
    if (result.pullRequest?.number) {
      process.stdout.write(`- pr: #${result.pullRequest.number} ${result.pullRequest.url || ""}\n`);
    } else {
      process.stdout.write(`- pr: not created (${result.pullRequest?.skippedReason || "unknown"})\n`);
    }
    return;
  }

  if (action === "promote-global") {
    const projectId = args[1];
    if (!projectId) {
      fail("Usage: forgeops skill promote-global <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--ready]");
    }
    const candidate = getFlag(args, "--candidate", "");
    if (!candidate) {
      fail("Usage: forgeops skill promote-global <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--ready]");
    }

    const result = store.promoteSkillCandidateToUserGlobal({
      projectId,
      candidate,
      skillName: getFlag(args, "--name", ""),
      description: getFlag(args, "--description", ""),
      baseRef: getFlag(args, "--base", ""),
      draft: !args.includes("--ready"),
    });

    process.stdout.write(`Promoted to user-global branch: ${result.branchName}\n`);
    process.stdout.write(`- global root: ${result.globalRoot}\n`);
    process.stdout.write(`- candidate: ${result.candidate.path}\n`);
    process.stdout.write(`- skill: ${result.skillName}\n`);
    process.stdout.write(`- changed: ${result.changedFiles.join(", ")}\n`);
    if (result.pullRequest?.number) {
      process.stdout.write(`- pr: #${result.pullRequest.number} ${result.pullRequest.url || ""}\n`);
    } else {
      process.stdout.write(`- pr: not created (${result.pullRequest?.skippedReason || "unknown"})\n`);
    }
    return;
  }

  fail("Unknown skill command. Try: forgeops skill global-status|global-init|candidates|resolve|promote|promote-global");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isoFileSafeNow() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveDefaultChartPath(scope, id = "") {
  const base = path.join(resolveForgeOpsRuntimeHome(), "charts", scope);
  ensureDir(base);
  const suffix = isoFileSafeNow();
  const safeId = String(id ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const ext = String(arguments[2] ?? "svg").trim().replace(/^\./, "") || "svg";
  const name = safeId ? `${scope}-${safeId}-${suffix}.${ext}` : `${scope}-${suffix}.${ext}`;
  return path.join(base, name);
}

function writeChartOutput(svg, outPath) {
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, svg, "utf8");
}

function writeTextOutput(text, outPath) {
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, String(text ?? ""), "utf8");
}

async function commandRun(store, args) {
  const action = args[0];

  if (action === "create") {
    const projectId = args[1];
    const task = args[2] ?? "";
    if (!projectId) {
      fail("Usage: forgeops run create <projectId> [task] --issue GITHUB_ISSUE_NUMBER [--mode quick|standard]");
    }

    const issueId = getFlag(args, "--issue", null);
    if (!issueId) {
      fail("Usage: forgeops run create <projectId> [task] --issue GITHUB_ISSUE_NUMBER [--mode quick|standard]");
    }
    const runMode = normalizeRunModeFlag(getFlag(args, "--mode", "quick"), "quick");
    if (!runMode) {
      fail("--mode must be one of: quick, standard");
    }
    const run = store.createRun({ projectId, issueId, task, runMode });
    process.stdout.write(`Created run: ${run.id} (mode=${runMode})\n`);
    return;
  }

  if (action === "list") {
    const projectId = getFlag(args, "--project", null);
    const runs = store.listRuns(projectId);
    if (runs.length === 0) {
      process.stdout.write("No runs found.\n");
      return;
    }
    for (const run of runs) {
      process.stdout.write(`${run.id}  [${run.status}]  ${run.workflow_id}  ${run.task}\n`);
    }
    return;
  }

  if (action === "show") {
    const runId = args[1];
    if (!runId) fail("Usage: forgeops run show <runId>");

    const details = store.getRunDetails(runId);
    if (!details) fail(`Run not found: ${runId}`);

    process.stdout.write(`${details.run.id}  [${details.run.status}]  ${details.run.task}\n`);
    process.stdout.write(`Worktree: ${details.run.worktree_path ?? "-"} (${details.run.worktree_branch ?? "-"})\n`);
    process.stdout.write("Steps:\n");
    const stepPolicyMap = getStepPolicyMapFromRunDetail(details);
    let totalTokens = 0;
    for (const step of details.steps) {
      const stepTokens = Number(step.token_input ?? 0)
        + Number(step.token_cached_input ?? 0)
        + Number(step.token_output ?? 0);
      totalTokens += stepTokens;
      process.stdout.write(`- ${step.step_key} (${step.agent_id}) [${step.status}] ${formatStepRetryLabel(step, stepPolicyMap)}\n`);
      process.stdout.write(`  runtime=${step.runtime} model=${step.effective_model ?? step.requested_model ?? "-"} tokens=${stepTokens}\n`);
    }
    process.stdout.write(`Total tokens: ${totalTokens}\n`);
    process.stdout.write("Sessions:\n");
    for (const session of details.sessions) {
      process.stdout.write(`- ${session.id} [${session.status}] step=${session.step_id} runtime=${session.runtime}\n`);
      process.stdout.write(`  thread=${session.thread_id ?? "-"} turn=${session.turn_id ?? "-"} pid=${session.process_pid ?? "-"}\n`);
      if (session.error) {
        process.stdout.write(`  error=${session.error}\n`);
      }
    }
    return;
  }

  if (action === "sessions") {
    const runId = args[1];
    if (!runId) {
      fail("Usage: forgeops run sessions <runId> [--step STEP_KEY] [--status running|completed|failed] [--with-thread]");
    }

    const stepKey = String(getFlag(args, "--step", "") ?? "").trim();
    const status = String(getFlag(args, "--status", "") ?? "").trim();
    const requireThread = args.includes("--with-thread");

    const run = store.getRun(runId);
    if (!run) fail(`Run not found: ${runId}`);

    const rows = store.listRunSessions(runId, { stepKey, status });
    const filtered = requireThread
      ? rows.filter((row) => String(row.thread_id ?? "").trim().length > 0)
      : rows;

    process.stdout.write(`Run: ${runId} [${run.status}] ${run.task}\n`);
    if (stepKey) process.stdout.write(`- step: ${stepKey}\n`);
    if (status) process.stdout.write(`- status: ${status}\n`);
    process.stdout.write(`Sessions: ${filtered.length}\n`);

    for (const row of filtered) {
      const thread = String(row.thread_id ?? "").trim() || "-";
      const turn = String(row.turn_id ?? "").trim() || "-";
      const stepLabel = `${row.step_key ?? row.step_id} (${row.agent_id ?? "-"})`;
      process.stdout.write(`- ${row.id} [${row.status}] ${stepLabel}\n`);
      process.stdout.write(`  thread=${thread} turn=${turn} pid=${row.process_pid ?? "-"}\n`);
      process.stdout.write(`  started=${row.started_at ?? "-"} ended=${row.ended_at ?? "-"}\n`);
      const tokenTotal = Number(row.token_input ?? 0)
        + Number(row.token_cached_input ?? 0)
        + Number(row.token_output ?? 0);
      process.stdout.write(`  tokens=${tokenTotal} (in=${row.token_input ?? 0} cached=${row.token_cached_input ?? 0} out=${row.token_output ?? 0})\n`);
      if (row.error) {
        process.stdout.write(`  error=${row.error}\n`);
      }
    }
    return;
  }

  if (action === "session") {
    const sub = String(args[1] ?? "").trim().toLowerCase();
    if (sub !== "export") {
      fail("Usage: forgeops run session export <sessionId> [--out PATH] [--lines N] [--max-bytes N]");
    }
    const sessionId = String(args[2] ?? "").trim();
    if (!sessionId) {
      fail("Usage: forgeops run session export <sessionId> [--out PATH] [--lines N] [--max-bytes N]");
    }

    const details = store.getSessionDetails(sessionId);
    if (!details) {
      fail(`Session not found: ${sessionId}`);
    }
    const threadId = String(details.thread_id ?? "").trim();
    if (!threadId) {
      fail(`Session has no thread_id yet: ${sessionId}`);
    }

    const worktreePath = String(details.worktree_path ?? "").trim();
    if (!worktreePath) {
      fail(`Session has no worktree_path (run may be legacy?): ${sessionId}`);
    }
    if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
      fail(`Worktree not found (run may be archived): ${worktreePath}`);
    }

    const codexHome = resolveManagedCodexHome(worktreePath);
    const located = findCodexSessionJsonlForThread({ codexHome, threadId });
    if (!located.ok) {
      fail(`Unable to locate Codex session log: ${located.error}`);
    }

    const outFlag = String(getFlag(args, "--out", "") ?? "").trim();
    const outPath = path.resolve(outFlag || path.join(process.cwd(), `forgeops-session-${sessionId}.jsonl`));

    const maxLines = Number(getFlag(args, "--lines", "0") ?? "0") || 0;
    const maxBytes = Number(getFlag(args, "--max-bytes", "0") ?? "0") || 0;

    if (maxLines > 0 || maxBytes > 0) {
      const tail = readTailTextFile({
        filePath: located.path,
        maxLines: maxLines > 0 ? maxLines : undefined,
        maxBytes: maxBytes > 0 ? maxBytes : undefined,
      });
      if (!tail.ok) {
        fail(`Failed to read tail: ${tail.error}`);
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, tail.content, "utf8");
      process.stdout.write(`Exported (tail) session log: ${outPath}\n`);
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(located.path, outPath);
      process.stdout.write(`Exported session log: ${outPath}\n`);
    }

    process.stdout.write(`- session: ${sessionId}\n`);
    process.stdout.write(`- thread: ${threadId}\n`);
    process.stdout.write(`- run: ${details.run_id}\n`);
    process.stdout.write(`- step: ${details.step_key} (${details.agent_id})\n`);
    process.stdout.write(`- worktree: ${worktreePath}\n`);
    process.stdout.write(`- codexHome: ${codexHome}\n`);
    process.stdout.write(`- source: ${located.path}\n`);
    return;
  }

  if (action === "resume") {
    const runId = args[1];
    if (!runId) fail("Usage: forgeops run resume <runId>");
    const ok = store.resumeRun(runId);
    if (!ok) fail("Run cannot be resumed", 2);
    process.stdout.write(`Resumed run: ${runId}\n`);
    return;
  }

  if (action === "stop") {
    const runId = args[1];
    if (!runId) fail("Usage: forgeops run stop <runId>");
    const ok = store.stopRun(runId);
    if (!ok) fail("Run cannot be stopped", 2);
    process.stdout.write(`Stopped run: ${runId}\n`);
    return;
  }

  if (action === "stop-all") {
    const projectId = String(getFlag(args, "--project", "") ?? "").trim();
    const result = store.stopRuns({
      projectId: projectId || null,
    });
    process.stdout.write(
      `Stopped runs: ${result.changed}/${result.total}${result.projectId ? ` (project=${result.projectId})` : " (all projects)"}\n`
    );
    if (result.failed.length > 0) {
      process.stdout.write(`Failed runs: ${result.failed.join(", ")}\n`);
    }
    return;
  }

  if (action === "resume-all") {
    const projectId = String(getFlag(args, "--project", "") ?? "").trim();
    const result = store.resumePausedRuns({
      projectId: projectId || null,
    });
    process.stdout.write(
      `Resumed runs: ${result.changed}/${result.total}${result.projectId ? ` (project=${result.projectId})` : " (all projects)"}\n`
    );
    if (result.failed.length > 0) {
      process.stdout.write(`Failed runs: ${result.failed.join(", ")}\n`);
    }
    return;
  }

  if (action === "attach") {
    const runId = args[1];
    if (!runId) {
      fail("Usage: forgeops run attach <runId> [--step STEP_KEY] [--session SESSION_ID] [--thread THREAD_ID]");
    }

    const resolved = resolveRunAttachContext(store, runId, {
      stepKey: getFlag(args, "--step", ""),
      sessionId: getFlag(args, "--session", ""),
      threadId: getFlag(args, "--thread", ""),
    });
    if (!resolved.ok) {
      fail(resolved.error);
    }

    const details = resolved.details;
    const selected = resolved.selected;
    const attachCwd = resolved.attachCwd;
    const codexBin = String(process.env.FORGEOPS_CODEX_BIN ?? "codex").trim() || "codex";
    const managedCodexHome = path.join(attachCwd, ".forgeops-runtime", "codex-home");
    const managedOsHome = path.join(attachCwd, ".forgeops-runtime", "home");
    const useManagedEnv = fs.existsSync(managedCodexHome) && fs.statSync(managedCodexHome).isDirectory();
    const resumeEnv = useManagedEnv
      ? {
          ...process.env,
          CODEX_HOME: managedCodexHome,
          CODEX_SQLITE_HOME: managedCodexHome,
          HOME: managedOsHome,
          USERPROFILE: managedOsHome,
          XDG_CONFIG_HOME: path.join(managedOsHome, ".config"),
          XDG_CACHE_HOME: path.join(managedOsHome, ".cache"),
          XDG_DATA_HOME: path.join(managedOsHome, ".local", "share"),
        }
      : process.env;

    process.stdout.write(`Attaching to run: ${runId}\n`);
    process.stdout.write(`- thread: ${selected.threadId}\n`);
    process.stdout.write(`- session: ${selected.session?.id ?? "-"}\n`);
    process.stdout.write(`- step: ${selected.step?.step_key ?? "-"} (${selected.step?.agent_id ?? "-"})\n`);
    process.stdout.write(`- cwd: ${attachCwd}\n`);
    if (resolved.attachNotice) {
      process.stdout.write(`Notice: ${resolved.attachNotice}\n`);
    }
    if (details.run.status === "running") {
      process.stdout.write("Notice: run is still running. Observe only; avoid sending new prompts in this thread.\n");
    }
    if (useManagedEnv) {
      process.stdout.write(`- managed CODEX_HOME: ${managedCodexHome}\n`);
      process.stdout.write(`- managed HOME: ${managedOsHome}\n`);
    }
    process.stdout.write(`Launching: ${codexBin} resume --all --cd ${attachCwd} ${selected.threadId}\n`);

    const launch = spawnSync(codexBin, ["resume", "--all", "--cd", attachCwd, selected.threadId], {
      stdio: "inherit",
      cwd: attachCwd,
      env: resumeEnv,
    });

    if (launch.error) {
      const msg = launch.error instanceof Error ? launch.error.message : String(launch.error);
      fail(`Failed to launch codex resume: ${msg}`);
    }
    if (typeof launch.status === "number" && launch.status !== 0) {
      process.exit(launch.status);
    }
    return;
  }

  fail("Unknown run command. Try: forgeops run create|list|show|sessions|session|stop|resume|stop-all|resume-all|attach");
}

async function commandScheduler(store, args) {
  const action = args[0];
  if (action !== "show" && action !== "set") {
    fail("Unknown scheduler command. Try: forgeops scheduler show|set");
  }

  const projectId = args[1];
  if (!projectId) {
    fail(`Usage: forgeops scheduler ${action} <projectId>`);
  }

  const project = store.getProject(projectId);
  if (!project) {
    fail(`Project not found: ${projectId}`);
  }

  if (action === "show") {
    const loaded = loadSchedulerConfig(project.root_path);
    process.stdout.write(`Project: ${project.id} (${project.name})\n`);
    process.stdout.write(`Path: ${loaded.path}\n`);
    process.stdout.write(`Source: ${loaded.source}\n`);
    process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
    return;
  }

  const patch = {};
  const enabledValue = getFlag(args, "--enabled", null);
  if (enabledValue !== null) {
    const parsed = parseBool(enabledValue, null);
    if (parsed === null) {
      fail("--enabled must be true/false");
    }
    patch.enabled = parsed;
  }

  const timezoneValue = getFlag(args, "--timezone", null);
  if (timezoneValue !== null) {
    patch.timezone = String(timezoneValue);
  }

  const cleanupPatch = {};
  const cleanupEnabledValue = getFlag(args, "--cleanup-enabled", null);
  if (cleanupEnabledValue !== null) {
    const parsed = parseBool(cleanupEnabledValue, null);
    if (parsed === null) {
      fail("--cleanup-enabled must be true/false");
    }
    cleanupPatch.enabled = parsed;
  }

  const cronValue = getFlag(args, "--cron", null);
  if (cronValue !== null) {
    cleanupPatch.cron = String(cronValue);
  }

  const cleanupModeValue = getFlag(args, "--cleanup-mode", null);
  if (cleanupModeValue !== null) {
    const mode = String(cleanupModeValue).trim().toLowerCase();
    if (mode !== "lite" && mode !== "deep") {
      fail("--cleanup-mode must be lite/deep");
    }
    cleanupPatch.mode = mode;
  }

  const taskValue = getFlag(args, "--task", null);
  if (taskValue !== null) {
    cleanupPatch.task = String(taskValue);
  }

  const onlyWhenIdleValue = getFlag(args, "--only-when-idle", null);
  if (onlyWhenIdleValue !== null) {
    const parsed = parseBool(onlyWhenIdleValue, null);
    if (parsed === null) {
      fail("--only-when-idle must be true/false");
    }
    cleanupPatch.onlyWhenIdle = parsed;
  }

  if (Object.keys(cleanupPatch).length > 0) {
    patch.cleanup = cleanupPatch;
  }

  const issueAutoRunPatch = {};
  const issueAutoEnabledValue = getFlag(args, "--issue-auto-enabled", null);
  if (issueAutoEnabledValue !== null) {
    const parsed = parseBool(issueAutoEnabledValue, null);
    if (parsed === null) {
      fail("--issue-auto-enabled must be true/false");
    }
    issueAutoRunPatch.enabled = parsed;
  }

  const issueAutoCronValue = getFlag(args, "--issue-auto-cron", null);
  if (issueAutoCronValue !== null) {
    issueAutoRunPatch.cron = String(issueAutoCronValue);
  }

  const issueAutoLabelValue = getFlag(args, "--issue-auto-label", null);
  if (issueAutoLabelValue !== null) {
    issueAutoRunPatch.label = String(issueAutoLabelValue);
  }

  const issueAutoOnlyWhenIdleValue = getFlag(args, "--issue-auto-only-when-idle", null);
  if (issueAutoOnlyWhenIdleValue !== null) {
    const parsed = parseBool(issueAutoOnlyWhenIdleValue, null);
    if (parsed === null) {
      fail("--issue-auto-only-when-idle must be true/false");
    }
    issueAutoRunPatch.onlyWhenIdle = parsed;
  }

  const issueAutoMaxRunsValue = getFlag(args, "--issue-auto-max-runs-per-tick", null);
  if (issueAutoMaxRunsValue !== null) {
    const parsed = Number(issueAutoMaxRunsValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail("--issue-auto-max-runs-per-tick must be a positive integer");
    }
    issueAutoRunPatch.maxRunsPerTick = Math.floor(parsed);
  }

  if (Object.keys(issueAutoRunPatch).length > 0) {
    patch.issueAutoRun = issueAutoRunPatch;
  }

  const skillPromotionPatch = {};
  const skillAutoEnabledValue = getFlag(args, "--skill-auto-enabled", null);
  if (skillAutoEnabledValue !== null) {
    const parsed = parseBool(skillAutoEnabledValue, null);
    if (parsed === null) {
      fail("--skill-auto-enabled must be true/false");
    }
    skillPromotionPatch.enabled = parsed;
  }
  const skillAutoCronValue = getFlag(args, "--skill-auto-cron", null);
  if (skillAutoCronValue !== null) {
    skillPromotionPatch.cron = String(skillAutoCronValue);
  }
  const skillAutoOnlyWhenIdleValue = getFlag(args, "--skill-auto-only-when-idle", null);
  if (skillAutoOnlyWhenIdleValue !== null) {
    const parsed = parseBool(skillAutoOnlyWhenIdleValue, null);
    if (parsed === null) {
      fail("--skill-auto-only-when-idle must be true/false");
    }
    skillPromotionPatch.onlyWhenIdle = parsed;
  }
  const skillAutoMaxPromotionsValue = getFlag(args, "--skill-auto-max-promotions-per-tick", null);
  if (skillAutoMaxPromotionsValue !== null) {
    const parsed = Number(skillAutoMaxPromotionsValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail("--skill-auto-max-promotions-per-tick must be a positive integer");
    }
    skillPromotionPatch.maxPromotionsPerTick = Math.floor(parsed);
  }
  const skillAutoMinOccurrencesValue = getFlag(args, "--skill-auto-min-occurrences", null);
  if (skillAutoMinOccurrencesValue !== null) {
    const parsed = Number(skillAutoMinOccurrencesValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail("--skill-auto-min-occurrences must be a positive integer");
    }
    skillPromotionPatch.minCandidateOccurrences = Math.floor(parsed);
  }
  const skillAutoLookbackValue = getFlag(args, "--skill-auto-lookback-days", null);
  if (skillAutoLookbackValue !== null) {
    const parsed = Number(skillAutoLookbackValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail("--skill-auto-lookback-days must be a positive integer");
    }
    skillPromotionPatch.lookbackDays = Math.floor(parsed);
  }
  const skillAutoMinScoreValue = getFlag(args, "--skill-auto-min-score", null);
  if (skillAutoMinScoreValue !== null) {
    const parsed = Number(skillAutoMinScoreValue);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      fail("--skill-auto-min-score must be between 0 and 1");
    }
    skillPromotionPatch.minScore = Number(parsed.toFixed(3));
  }
  const skillAutoDraftValue = getFlag(args, "--skill-auto-draft", null);
  if (skillAutoDraftValue !== null) {
    const parsed = parseBool(skillAutoDraftValue, null);
    if (parsed === null) {
      fail("--skill-auto-draft must be true/false");
    }
    skillPromotionPatch.draft = parsed;
  }
  const skillAutoRolesValues = [
    ...getFlags(args, "--skill-auto-roles"),
    ...getFlags(args, "--skill-auto-role"),
  ];
  if (skillAutoRolesValues.length > 0) {
    const roles = [];
    for (const value of skillAutoRolesValues) {
      for (const part of String(value).split(",")) {
        const role = part.trim();
        if (!role) continue;
        if (roles.includes(role)) continue;
        roles.push(role);
      }
    }
    skillPromotionPatch.roles = roles;
  }
  if (Object.keys(skillPromotionPatch).length > 0) {
    patch.skillPromotion = skillPromotionPatch;
  }

  const globalSkillPromotionPatch = {};
  const globalSkillAutoEnabledValue = getFlag(args, "--global-skill-auto-enabled", null);
  if (globalSkillAutoEnabledValue !== null) {
    const parsed = parseBool(globalSkillAutoEnabledValue, null);
    if (parsed === null) {
      fail("--global-skill-auto-enabled must be true/false");
    }
    globalSkillPromotionPatch.enabled = parsed;
  }
  const globalSkillAutoCronValue = getFlag(args, "--global-skill-auto-cron", null);
  if (globalSkillAutoCronValue !== null) {
    globalSkillPromotionPatch.cron = String(globalSkillAutoCronValue);
  }
  const globalSkillAutoOnlyWhenIdleValue = getFlag(args, "--global-skill-auto-only-when-idle", null);
  if (globalSkillAutoOnlyWhenIdleValue !== null) {
    const parsed = parseBool(globalSkillAutoOnlyWhenIdleValue, null);
    if (parsed === null) {
      fail("--global-skill-auto-only-when-idle must be true/false");
    }
    globalSkillPromotionPatch.onlyWhenIdle = parsed;
  }
  const globalSkillAutoMaxPromotionsValue = getFlag(args, "--global-skill-auto-max-promotions-per-tick", null);
  if (globalSkillAutoMaxPromotionsValue !== null) {
    const parsed = Number(globalSkillAutoMaxPromotionsValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail("--global-skill-auto-max-promotions-per-tick must be a positive integer");
    }
    globalSkillPromotionPatch.maxPromotionsPerTick = Math.floor(parsed);
  }
  const globalSkillAutoMinOccurrencesValue = getFlag(args, "--global-skill-auto-min-occurrences", null);
  if (globalSkillAutoMinOccurrencesValue !== null) {
    const parsed = Number(globalSkillAutoMinOccurrencesValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail("--global-skill-auto-min-occurrences must be a positive integer");
    }
    globalSkillPromotionPatch.minCandidateOccurrences = Math.floor(parsed);
  }
  const globalSkillAutoLookbackValue = getFlag(args, "--global-skill-auto-lookback-days", null);
  if (globalSkillAutoLookbackValue !== null) {
    const parsed = Number(globalSkillAutoLookbackValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      fail("--global-skill-auto-lookback-days must be a positive integer");
    }
    globalSkillPromotionPatch.lookbackDays = Math.floor(parsed);
  }
  const globalSkillAutoMinScoreValue = getFlag(args, "--global-skill-auto-min-score", null);
  if (globalSkillAutoMinScoreValue !== null) {
    const parsed = Number(globalSkillAutoMinScoreValue);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      fail("--global-skill-auto-min-score must be between 0 and 1");
    }
    globalSkillPromotionPatch.minScore = Number(parsed.toFixed(3));
  }
  const globalSkillAutoRequireProjectSkillValue = getFlag(args, "--global-skill-auto-require-project-skill", null);
  if (globalSkillAutoRequireProjectSkillValue !== null) {
    const parsed = parseBool(globalSkillAutoRequireProjectSkillValue, null);
    if (parsed === null) {
      fail("--global-skill-auto-require-project-skill must be true/false");
    }
    globalSkillPromotionPatch.requireProjectSkill = parsed;
  }
  const globalSkillAutoDraftValue = getFlag(args, "--global-skill-auto-draft", null);
  if (globalSkillAutoDraftValue !== null) {
    const parsed = parseBool(globalSkillAutoDraftValue, null);
    if (parsed === null) {
      fail("--global-skill-auto-draft must be true/false");
    }
    globalSkillPromotionPatch.draft = parsed;
  }
  if (Object.keys(globalSkillPromotionPatch).length > 0) {
    patch.globalSkillPromotion = globalSkillPromotionPatch;
  }

  if (Object.keys(patch).length === 0) {
    fail("No scheduler fields provided. Use --enabled/--cleanup-enabled/--cleanup-mode/--cron/--timezone/--task/--only-when-idle/--issue-auto-enabled/--issue-auto-cron/--issue-auto-label/--issue-auto-only-when-idle/--issue-auto-max-runs-per-tick/--skill-auto-*/--global-skill-auto-*");
  }

  const saved = updateSchedulerConfig(project.root_path, patch);
  process.stdout.write(`Updated scheduler config: ${saved.path}\n`);
  process.stdout.write(`${JSON.stringify(saved.config, null, 2)}\n`);
}

async function commandWorkflow(store, args) {
  const action = args[0];
  if (
    action !== "show"
    && action !== "set"
    && action !== "set-conflict-retries"
    && action !== "get-conflict-retries"
  ) {
    fail("Unknown workflow command. Try: forgeops workflow show|set|set-conflict-retries|get-conflict-retries");
  }

  const projectId = args[1];
  if (!projectId) {
    fail(`Usage: forgeops workflow ${action} <projectId>`);
  }

  const project = store.getProject(projectId);
  if (!project) {
    fail(`Project not found: ${projectId}`);
  }

  if (action === "show") {
    const loaded = loadWorkflowConfig(project.root_path);
    process.stdout.write(`Project: ${project.id} (${project.name})\n`);
    process.stdout.write(`Path: ${loaded.path}\n`);
    process.stdout.write(`Source: ${loaded.source}\n`);
    process.stdout.write(`Resolved: ${loaded.resolved.id} / ${loaded.resolved.name}\n`);
    const controls = loaded.resolved.workflowControls ?? {};
    process.stdout.write(
      `Controls: autoMerge=${controls.autoMerge ?? true} mergeMethod=${controls.mergeMethod ?? "squash"} autoCloseIssueOnMerge=${controls.autoCloseIssueOnMerge ?? true} autoMergeConflictMaxAttempts=${controls.autoMergeConflictMaxAttempts ?? 2}\n`
    );
    process.stdout.write(`Steps: ${loaded.resolved.steps.map((step) => step.key).join(" -> ")}\n`);
    for (const step of loaded.resolved.steps) {
      process.stdout.write(`- ${formatWorkflowResolvedStep(step)}\n`);
    }
    process.stdout.write("--- workflow.yaml ---\n");
    process.stdout.write(loaded.yaml);
    return;
  }

  if (action === "get-conflict-retries") {
    const loaded = loadWorkflowConfig(project.root_path);
    const controls = loaded.resolved.workflowControls ?? {};
    const retries = Number.isFinite(Number(controls.autoMergeConflictMaxAttempts))
      ? Math.floor(Number(controls.autoMergeConflictMaxAttempts))
      : 2;
    process.stdout.write(`${retries}\n`);
    return;
  }

  if (action === "set-conflict-retries") {
    const retriesRaw = args[2];
    if (retriesRaw === undefined) {
      fail("Usage: forgeops workflow set-conflict-retries <projectId> <0-8>");
    }
    const parsed = Number(retriesRaw);
    if (!Number.isFinite(parsed) || Math.floor(parsed) !== parsed || parsed < 0 || parsed > 8) {
      fail("workflow set-conflict-retries expects an integer in [0, 8]");
    }
    const loaded = loadWorkflowConfig(project.root_path);
    let yamlObj = {};
    try {
      const candidate = YAML.parse(loaded.yaml);
      yamlObj = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : {};
    } catch (err) {
      fail(`Invalid workflow yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
    yamlObj.auto_merge_conflict_max_attempts = Math.floor(parsed);
    const saved = writeWorkflowConfigYaml(project.root_path, buildWorkflowYaml(yamlObj));
    process.stdout.write(`Updated workflow config: ${saved.path}\n`);
    process.stdout.write(`Resolved: ${saved.resolved.id} / ${saved.resolved.name}\n`);
    const controls = saved.resolved.workflowControls ?? {};
    process.stdout.write(
      `Controls: autoMerge=${controls.autoMerge ?? true} mergeMethod=${controls.mergeMethod ?? "squash"} autoCloseIssueOnMerge=${controls.autoCloseIssueOnMerge ?? true} autoMergeConflictMaxAttempts=${controls.autoMergeConflictMaxAttempts ?? 2}\n`
    );
    process.stdout.write(`Steps: ${saved.resolved.steps.map((step) => step.key).join(" -> ")}\n`);
    for (const step of saved.resolved.steps) {
      process.stdout.write(`- ${formatWorkflowResolvedStep(step)}\n`);
    }
    return;
  }

  const yamlFile = getFlag(args, "--yaml-file", null);
  const yamlInline = getFlag(args, "--yaml", null);
  const resetDefault = args.includes("--reset-default");
  const autoMergeConflictMaxAttemptsRaw = getFlag(args, "--auto-merge-conflict-max-attempts", null);
  const hasAutoMergeConflictPatch = autoMergeConflictMaxAttemptsRaw !== null;
  const modes = Number(Boolean(yamlFile))
    + Number(Boolean(yamlInline))
    + Number(resetDefault)
    + Number(hasAutoMergeConflictPatch);
  if (modes !== 1) {
    fail("workflow set requires exactly one mode: --yaml-file PATH | --yaml TEXT | --reset-default | --auto-merge-conflict-max-attempts N");
  }

  let yamlText = "";
  if (hasAutoMergeConflictPatch) {
    const parsed = Number(autoMergeConflictMaxAttemptsRaw);
    if (!Number.isFinite(parsed) || Math.floor(parsed) !== parsed || parsed < 0 || parsed > 8) {
      fail("--auto-merge-conflict-max-attempts must be an integer in [0, 8]");
    }
    const loaded = loadWorkflowConfig(project.root_path);
    let yamlObj = {};
    try {
      const candidate = YAML.parse(loaded.yaml);
      yamlObj = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : {};
    } catch (err) {
      fail(`Invalid workflow yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
    yamlObj.auto_merge_conflict_max_attempts = Math.floor(parsed);
    yamlText = buildWorkflowYaml(yamlObj);
  } else if (resetDefault) {
    yamlText = buildWorkflowYaml(DEFAULT_WORKFLOW_CONFIG);
  } else if (yamlFile) {
    const filePath = path.resolve(String(yamlFile));
    if (!fs.existsSync(filePath)) {
      fail(`workflow yaml file not found: ${filePath}`);
    }
    yamlText = fs.readFileSync(filePath, "utf8");
  } else {
    yamlText = String(yamlInline ?? "");
  }

  const saved = writeWorkflowConfigYaml(project.root_path, yamlText);
  process.stdout.write(`Updated workflow config: ${saved.path}\n`);
  process.stdout.write(`Resolved: ${saved.resolved.id} / ${saved.resolved.name}\n`);
  const controls = saved.resolved.workflowControls ?? {};
  process.stdout.write(
    `Controls: autoMerge=${controls.autoMerge ?? true} mergeMethod=${controls.mergeMethod ?? "squash"} autoCloseIssueOnMerge=${controls.autoCloseIssueOnMerge ?? true} autoMergeConflictMaxAttempts=${controls.autoMergeConflictMaxAttempts ?? 2}\n`
  );
  process.stdout.write(`Steps: ${saved.resolved.steps.map((step) => step.key).join(" -> ")}\n`);
  for (const step of saved.resolved.steps) {
    process.stdout.write(`- ${formatWorkflowResolvedStep(step)}\n`);
  }
}

function formatDoctorText(result) {
  const lines = [];
  lines.push(`ForgeOps Doctor @ ${result.checkedAt}`);
  lines.push("");
  for (const check of result.checks) {
    const icon = check.ok ? "[ok]" : "[x]";
    lines.push(`${icon} ${check.id} - ${check.title}`);
    if (check.detail) lines.push(`    detail: ${check.detail}`);
    if (!check.ok && check.hint) lines.push(`    hint:   ${check.hint}`);
  }
  lines.push("");
  lines.push(result.ok ? "Overall: PASS" : "Overall: FAIL");
  return `${lines.join("\n")}\n`;
}

async function commandDoctor(args) {
  const asJson = args.includes("--json");
  const result = runDoctor();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorText(result));
  }
  if (!result.ok) {
    process.exitCode = 2;
  }
}

function formatServiceStatusText(status) {
  const lines = [];
  const running = typeof status.running === "boolean" ? status.running : Boolean(status.loaded);
  lines.push(`Service manager: ${status.manager} (${status.platform})`);
  lines.push(`Service id: ${status.serviceId}`);
  lines.push(`Installed: ${status.installed ? "yes" : "no"}`);
  lines.push(`Enabled: ${status.enabled ? "yes" : "no"}`);
  lines.push(`Running: ${running ? "yes" : "no"}`);
  if (status.lifecycle) {
    const rawState = String(status.rawState ?? "").trim();
    lines.push(`Lifecycle: ${rawState ? `${status.lifecycle} (state=${rawState})` : status.lifecycle}`);
  }
  lines.push(`Service path: ${status.servicePath}`);
  lines.push(`Stdout log: ${status.stdoutLogPath}`);
  lines.push(`Stderr log: ${status.stderrLogPath}`);
  if (status.detail) {
    lines.push(`Detail: ${status.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseServiceOptions(args) {
  const runtimeHome = getFlag(args, "--runtime-home", null);
  const host = getFlag(args, "--host", null);
  const port = getFlag(args, "--port", null);
  const pollMs = getFlag(args, "--poll-ms", null);
  const concurrency = getFlag(args, "--concurrency", null);
  return {
    runtimeHome: runtimeHome ? path.resolve(String(runtimeHome)) : undefined,
    host: host ?? undefined,
    port: port !== null ? toInt(port, 4173) : undefined,
    pollMs: pollMs !== null ? toInt(pollMs, 1500) : undefined,
    concurrency: concurrency !== null ? toInt(concurrency, 2) : undefined,
  };
}

async function commandService(args) {
  const action = String(args[0] ?? "").trim().toLowerCase();
  if (!action) {
    fail("Usage: forgeops service <install|start|stop|restart|status|logs|uninstall> [...]");
  }

  const opts = parseServiceOptions(args);

  if (action === "install") {
    const status = installForgeOpsService({
      ...opts,
      startNow: !args.includes("--no-start"),
    });
    process.stdout.write(formatServiceStatusText(status));
    return;
  }

  if (action === "start") {
    const status = startForgeOpsService(opts);
    process.stdout.write(formatServiceStatusText(status));
    return;
  }

  if (action === "stop") {
    const status = stopForgeOpsService(opts);
    process.stdout.write(formatServiceStatusText(status));
    return;
  }

  if (action === "restart") {
    stopForgeOpsService(opts);
    const status = startForgeOpsService(opts);
    process.stdout.write(formatServiceStatusText(status));
    return;
  }

  if (action === "status") {
    const status = getForgeOpsServiceInfo(opts);
    process.stdout.write(formatServiceStatusText(status));
    return;
  }

  if (action === "uninstall") {
    const status = uninstallForgeOpsService(opts);
    process.stdout.write(formatServiceStatusText(status));
    return;
  }

  if (action === "logs") {
    const linesLimit = toInt(getFlag(args, "--lines", "120"), 120);
    const logs = readForgeOpsServiceLogs({
      ...opts,
      lines: linesLimit,
    });

    process.stdout.write(`Service manager: ${logs.manager} (${logs.platform})\n`);
    process.stdout.write(`Service id: ${logs.serviceId}\n`);
    process.stdout.write(`Stdout log: ${logs.stdoutLogPath}\n`);
    process.stdout.write(`Stderr log: ${logs.stderrLogPath}\n`);

    if (logs.manager === "launchd") {
      process.stdout.write("--- stdout ---\n");
      if (logs.stdout?.exists) {
        process.stdout.write(`${(logs.stdout.lines ?? []).join("\n")}\n`);
      } else {
        process.stdout.write("(not found)\n");
      }
      process.stdout.write("--- stderr ---\n");
      if (logs.stderr?.exists) {
        process.stdout.write(`${(logs.stderr.lines ?? []).join("\n")}\n`);
      } else {
        process.stdout.write("(not found)\n");
      }
      return;
    }

    process.stdout.write("--- journal ---\n");
    if (logs.journal?.ok) {
      process.stdout.write(`${logs.journal.output || "(empty)"}\n`);
    } else {
      process.stdout.write(`${logs.journal?.error || "(unavailable)"}\n`);
    }
    return;
  }

  fail("Unknown service command. Try: forgeops service install|start|stop|restart|status|logs|uninstall");
}

function resolveForgeOpsRuntimeHome() {
  if (process.env.FORGEOPS_HOME) {
    return path.resolve(process.env.FORGEOPS_HOME);
  }
  return path.join(os.homedir(), ".forgeops");
}

function resolveCodexHome() {
  if (process.env.CODEX_HOME) {
    return path.resolve(process.env.CODEX_HOME);
  }
  return path.join(os.homedir(), ".codex");
}

function resolveCodexSessionRegistryPath() {
  return path.join(resolveForgeOpsRuntimeHome(), CODEX_SESSION_REGISTRY_FILE);
}

function normalizeWorkspacePath(cwd) {
  const resolved = path.resolve(String(cwd ?? ""));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithinWorkspace(targetPath, workspaceRoot) {
  const target = normalizeWorkspacePath(targetPath);
  const root = normalizeWorkspacePath(workspaceRoot);
  if (!target || !root) return false;
  if (target === root) return true;
  const rel = path.relative(root, target);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveManagedProjectByPath(store, cwd) {
  const target = normalizeWorkspacePath(cwd);
  const projects = store.listProjects();
  let matched = null;
  let matchedRoot = "";
  for (const project of projects) {
    const root = normalizeWorkspacePath(project.root_path);
    if (!isPathWithinWorkspace(target, root)) continue;
    if (!matched || root.length > matchedRoot.length) {
      matched = project;
      matchedRoot = root;
    }
  }
  return matched;
}

function findProjectMetaSkillDescriptor(resolvedSkills) {
  const preferredRoles = ["developer", "tester", "reviewer"];
  const roleMap = resolvedSkills?.agentSkills && typeof resolvedSkills.agentSkills === "object"
    ? resolvedSkills.agentSkills
    : {};

  const matchFromItems = (items) => {
    const list = Array.isArray(items) ? items : [];
    for (const item of list) {
      const name = String(item?.name ?? "").trim().toLowerCase();
      const source = String(item?.source ?? "").trim().toLowerCase();
      const absolutePath = String(item?.absolutePath ?? "").trim();
      if (!name.startsWith("project-meta-")) continue;
      if (source !== "project-local") continue;
      if (!absolutePath || !fs.existsSync(absolutePath)) continue;
      return absolutePath;
    }
    return "";
  };

  for (const role of preferredRoles) {
    const matched = matchFromItems(roleMap[role]);
    if (matched) return matched;
  }

  for (const role of Object.keys(roleMap)) {
    const matched = matchFromItems(roleMap[role]);
    if (matched) return matched;
  }

  return "";
}

function resolveDefaultProjectMetaSkillPath(store, project) {
  const projectRoot = path.resolve(String(project?.root_path ?? ""));
  const productType = String(project?.product_type ?? "").trim().toLowerCase();

  if (project?.id) {
    try {
      const resolved = store.resolveProjectSkills(project.id);
      const fromResolved = findProjectMetaSkillDescriptor(resolved);
      if (fromResolved) {
        return fromResolved;
      }
    } catch {
      // fallback to deterministic path probing
    }
  }

  const candidates = [];
  if (projectRoot && productType) {
    candidates.push(path.join(projectRoot, ".forgeops", "skills", `project-meta-${productType}-copilot`, "SKILL.md"));
  }
  if (projectRoot) {
    candidates.push(path.join(projectRoot, ".forgeops", "skills", "project-meta-generic-copilot", "SKILL.md"));
  }
  candidates.push(DEFAULT_META_SKILL_PATH);

  for (const candidate of candidates) {
    const resolved = path.resolve(String(candidate ?? "").trim());
    if (!resolved) continue;
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return "";
}

function resolveCodexSessionTrackingKey(cwd, sessionKey) {
  const explicitKey = String(sessionKey ?? "").trim();
  if (explicitKey) {
    return `session:${explicitKey}`;
  }
  return `cwd:${normalizeWorkspacePath(cwd)}`;
}

function readCodexSessionRegistry() {
  const filePath = resolveCodexSessionRegistryPath();
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      workspaces: {},
      filePath,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const workspaces = parsed?.workspaces && typeof parsed.workspaces === "object"
      ? parsed.workspaces
      : {};
    return {
      version: 1,
      workspaces,
      filePath,
    };
  } catch {
    return {
      version: 1,
      workspaces: {},
      filePath,
    };
  }
}

function writeCodexSessionRegistry(registry) {
  const filePath = resolveCodexSessionRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    version: 1,
    workspaces: registry?.workspaces && typeof registry.workspaces === "object"
      ? registry.workspaces
      : {},
  }, null, 2)}\n`, "utf8");
}

function getTrackedCodexWorkspaceSession(cwd, sessionKey = "") {
  const key = resolveCodexSessionTrackingKey(cwd, sessionKey);
  const registry = readCodexSessionRegistry();
  const raw = registry.workspaces?.[key];
  if (!raw || typeof raw !== "object") return null;
  const threadId = String(raw.threadId ?? "").trim();
  if (!threadId) return null;
  return {
    trackingKey: key,
    threadId,
    updatedAt: String(raw.updatedAt ?? "").trim(),
    source: String(raw.source ?? "").trim(),
    sessionFile: String(raw.sessionFile ?? "").trim(),
    workspaceCwd: String(raw.workspaceCwd ?? "").trim(),
    model: String(raw.model ?? "").trim(),
    metaSkillPath: String(raw.metaSkillPath ?? "").trim(),
  };
}

function setTrackedCodexWorkspaceSession(cwd, sessionKey, patch) {
  const key = resolveCodexSessionTrackingKey(cwd, sessionKey);
  const normalizedCwd = normalizeWorkspacePath(cwd);
  const registry = readCodexSessionRegistry();
  const current = registry.workspaces?.[key] && typeof registry.workspaces[key] === "object"
    ? registry.workspaces[key]
    : {};
  const next = {
    threadId: String(patch?.threadId ?? current.threadId ?? "").trim(),
    updatedAt: String(patch?.updatedAt ?? current.updatedAt ?? new Date().toISOString()).trim(),
    source: String(patch?.source ?? current.source ?? "").trim(),
    sessionFile: String(patch?.sessionFile ?? current.sessionFile ?? "").trim(),
    workspaceCwd: String(patch?.workspaceCwd ?? current.workspaceCwd ?? normalizedCwd).trim(),
    model: String(patch?.model ?? current.model ?? "").trim(),
    metaSkillPath: String(patch?.metaSkillPath ?? current.metaSkillPath ?? "").trim(),
  };
  if (!next.threadId) return;
  registry.workspaces[key] = next;
  writeCodexSessionRegistry(registry);
}

function collectCodexSessionFilesNewestFirst(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  files.sort((a, b) => b.localeCompare(a));
  return files;
}

function parseSessionMetaRecordFromFile(filePath) {
  const maxReadBytes = 64 * 1024;
  try {
    const fd = fs.openSync(filePath, "r");
    let firstLine = "";
    try {
      const buffer = Buffer.allocUnsafe(maxReadBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxReadBytes, 0);
      if (bytesRead <= 0) return null;
      const text = buffer.toString("utf8", 0, bytesRead);
      const newlineIdx = text.indexOf("\n");
      firstLine = newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
    } finally {
      fs.closeSync(fd);
    }
    if (!firstLine) return null;
    const record = JSON.parse(firstLine);
    if (record?.type !== "session_meta") return null;
    const payload = record?.payload && typeof record.payload === "object"
      ? record.payload
      : null;
    if (!payload) return null;
    const sessionId = String(payload.id ?? "").trim();
    const cwd = String(payload.cwd ?? "").trim();
    const source = String(payload.source ?? "").trim().toLowerCase();
    const timestamp = String(payload.timestamp ?? record.timestamp ?? "").trim();
    if (!sessionId || !cwd || !source) return null;
    const timestampMs = Number.isFinite(Date.parse(timestamp))
      ? Date.parse(timestamp)
      : 0;
    return {
      sessionId,
      cwd,
      source,
      timestamp,
      timestampMs,
      filePath,
    };
  } catch {
    return null;
  }
}

function findLatestInteractiveCodexSessionForCwd(cwd, options = {}) {
  const target = normalizeWorkspacePath(cwd);
  const minTimestampMs = Number(options.minTimestampMs ?? 0);
  const maxScan = toInt(options.maxScan ?? 300, 300);
  const sessionsRoot = path.join(resolveCodexHome(), "sessions");
  const files = collectCodexSessionFilesNewestFirst(sessionsRoot);
  let scanned = 0;
  for (const filePath of files) {
    if (scanned >= maxScan) break;
    scanned += 1;
    const meta = parseSessionMetaRecordFromFile(filePath);
    if (!meta) continue;
    if (meta.source !== "cli" && meta.source !== "vscode") continue;
    const sessionCwd = normalizeWorkspacePath(meta.cwd);
    if (sessionCwd !== target) continue;
    if (minTimestampMs > 0) {
      if (!Number.isFinite(meta.timestampMs) || meta.timestampMs <= 0) continue;
      if (meta.timestampMs < minTimestampMs) continue;
    }
    return meta;
  }
  return null;
}

function isCodexAppInstalled() {
  if (process.platform === "darwin") {
    return fs.existsSync("/Applications/Codex.app")
      || fs.existsSync(path.join(os.homedir(), "Applications", "Codex.app"));
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA) : "";
    if (!localAppData) return false;
    return fs.existsSync(path.join(localAppData, "Programs", "Codex", "Codex.exe"));
  }
  return false;
}

function buildMetaSkillBootstrapPrompt(params = {}) {
  const userPrompt = String(params.userPrompt ?? "").trim();
  const includeMetaSkill = params.includeMetaSkill !== false;
  const metaSkillPath = String(params.metaSkillPath ?? "").trim();
  const lines = [];

  lines.push("你是 ForgeOps 控制面协作 Agent。");
  lines.push("默认使用 ForgeOps CLI 完成探测、执行、恢复与验证，不绕过主路径。");

  if (includeMetaSkill && metaSkillPath) {
    lines.push(`先完整阅读并严格遵循 ForgeOps 技能文档：${metaSkillPath}`);
    lines.push("执行时遵守其中的执行原则、命令剧本、决策规则与禁止事项。");
  }

  lines.push("先做只读探测，再做变更；输出保持 Command / Result / Next 三段。");

  if (userPrompt) {
    lines.push("");
    lines.push("用户初始请求：");
    lines.push(userPrompt);
  } else {
    lines.push("");
    lines.push("先回一句：已进入 ForgeOps 技能会话，等待任务指令。");
  }

  return lines.join("\n");
}

function buildProjectBootstrapPrompt(params = {}) {
  const userPrompt = String(params.userPrompt ?? "").trim();
  const includeMetaSkill = params.includeMetaSkill === true;
  const metaSkillPath = String(params.metaSkillPath ?? "").trim();
  const localOnly = params.localOnly === true;
  const launchCwd = String(params.launchCwd ?? "").trim();
  const project = params.project && typeof params.project === "object"
    ? params.project
    : {};
  const projectId = String(project.id ?? "").trim();
  const projectName = String(project.name ?? "").trim();
  const productType = String(project.product_type ?? "").trim();
  const projectRoot = String(project.root_path ?? launchCwd).trim();
  const problemStatement = String(project.problem_statement ?? "").trim();
  const projectContext = String(params.projectContext ?? "").trim();
  const projectGovernance = String(params.projectGovernance ?? "").trim();
  const lines = [];

  const clipSection = (text, maxChars = 2400) => {
    const raw = String(text ?? "").trim();
    if (!raw) return "";
    if (raw.length <= maxChars) return raw;
    return `${raw.slice(0, maxChars)}\n...[truncated]`;
  };

  lines.push("你是 ForgeOps 项目协作 Agent。");
  lines.push("目标：在具体项目内，和用户协作推进需求，优先通过 ForgeOps CLI 驱动研发流水线。");
  lines.push("你既可以使用 ForgeOps 命令，也可以直接在当前项目代码库执行实现/测试/验证。");
  lines.push("创建 run 前先做模式判定：`quick` 或 `standard`（禁止使用不存在的 `full` 模式）。");
  lines.push("run mode 路由规则：");
  lines.push("- quick：单点修复、小范围重构、配置/脚本调整、文档更新、低风险回归验证。");
  lines.push("- standard：跨模块改造、架构变更、数据模型/迁移、接口契约变化、权限/安全相关、需要完整评审链路。");
  lines.push("不确定时默认 quick；一旦发现影响面扩大或验收风险上升，升级到 standard。");
  lines.push("执行时可显式带模式参数：`forgeops run create ... --mode quick|standard`（未指定时默认 quick）。");
  lines.push("若先创建 issue，可显式声明：`forgeops issue create ... --mode quick|standard`（未指定时默认 quick）。");
  if (localOnly) {
    lines.push("当前会话运行在 LOCAL_ONLY 模式。");
    lines.push("禁止执行流水线命令：`forgeops issue create/list`、`forgeops run create/list/show/stop/resume/attach`。");
    lines.push("仅允许在本地项目目录进行代码修改、构建、测试、调试与文档更新。");
    lines.push("若用户明确要求走 Issue/Run 流程，先说明当前是 LOCAL_ONLY，再请求用户移除该模式。");
  }

  if (includeMetaSkill && metaSkillPath) {
    lines.push(`先完整阅读并遵循 ForgeOps 技能文档：${metaSkillPath}`);
    lines.push("在不和项目上下文冲突的前提下执行 ForgeOps 技能约束。");
  }

  lines.push(`当前项目：${projectName || "(unnamed)"} (${projectId || "unknown"})`);
  lines.push(`项目类型：${productType || "unknown"}`);
  lines.push(`项目根目录：${projectRoot || launchCwd}`);
  if (problemStatement) {
    lines.push(`项目问题定义：${problemStatement}`);
  }
  if (projectContext) {
    lines.push("");
    lines.push("项目上下文（.forgeops/context.md 摘要）：");
    lines.push(clipSection(projectContext, 2800));
  }
  if (projectGovernance) {
    lines.push("");
    lines.push("项目治理约束（.forgeops/governance.md 摘要）：");
    lines.push(clipSection(projectGovernance, 1400));
  }
  lines.push("先读取项目上下文（如 AGENTS.md、README、.forgeops/context.md），再执行改动。");
  lines.push("输出保持 Command / Result / Next 三段，先探测后改动。");

  if (userPrompt) {
    lines.push("");
    lines.push("用户初始请求：");
    lines.push(userPrompt);
  } else {
    lines.push("");
    lines.push(`先回一句：已进入项目协作会话（${projectName || projectId || "unknown"}），等待任务指令。`);
  }

  return lines.join("\n");
}

function buildProjectLocalOnlyReminderPrompt(userPrompt = "") {
  const instruction = [
    "LOCAL_ONLY 模式提醒：",
    "- 仅进行本地代码与文档修改、构建、测试、调试。",
    "- 禁止执行 `forgeops issue *` 与 `forgeops run *` 命令。",
    "- 如需走流水线，先让用户确认退出 LOCAL_ONLY 模式。",
  ].join("\n");
  const promptText = String(userPrompt ?? "").trim();
  if (!promptText) return instruction;
  return `${instruction}\n\n用户请求：\n${promptText}`;
}

async function commandCodex(_store, args) {
  const head = String(args[0] ?? "").trim().toLowerCase();
  if (head === "help" || head === "--help" || head === "-h") {
    process.stdout.write(
      "Usage: forgeops codex session [--client auto|app|cli] [--session-key KEY] [--cwd DIR] [--prompt TEXT] [--model MODEL] [--meta-skill PATH] [--no-meta-skill] [--fresh]\n"
      + "       forgeops codex project [--project PROJECT_ID] [--cwd DIR] [--client auto|app|cli] [--session-key KEY] [--prompt TEXT] [--model MODEL] [--meta-skill PATH] [--no-meta-skill] [--local-only] [--fresh]\n"
    );
    return;
  }
  const actionExplicit = head === "session" || head === "project";
  const probeCommandArgs = actionExplicit ? args.slice(1) : args;
  const probeCwd = path.resolve(String(getFlag(probeCommandArgs, "--cwd", "") ?? "").trim() || process.cwd());
  const autoMatchedProject = (!actionExplicit && (!head || head.startsWith("-")))
    ? resolveManagedProjectByPath(_store, probeCwd)
    : null;
  const action = actionExplicit
    ? head
    : ((!head || head.startsWith("-")) && autoMatchedProject ? "project" : "session");
  const commandArgs = actionExplicit ? args.slice(1) : args;
  const actionAutoDetectedByCwd = !actionExplicit && action === "project" && Boolean(autoMatchedProject);

  if (action !== "session" && action !== "project") {
    fail("Usage: forgeops codex session [--client auto|app|cli] [--session-key KEY] [--cwd DIR] [--prompt TEXT] [--model MODEL] [--meta-skill PATH] [--no-meta-skill] [--fresh]\n"
      + "       forgeops codex project [--project PROJECT_ID] [--cwd DIR] [--client auto|app|cli] [--session-key KEY] [--prompt TEXT] [--model MODEL] [--meta-skill PATH] [--no-meta-skill] [--local-only] [--fresh]");
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("forgeops codex session/project requires an interactive TTY terminal");
  }

  const cwdFlag = String(getFlag(commandArgs, "--cwd", "") ?? "").trim();
  let projectScope = null;
  let projectLookupCwd = "";
  if (action === "project") {
    const projectId = String(getFlag(commandArgs, "--project", "") ?? "").trim();
    projectLookupCwd = path.resolve(cwdFlag || process.cwd());
    if (projectId) {
      projectScope = _store.getProject(projectId);
      if (!projectScope) {
        fail(`Project not found: ${projectId}`);
      }
      if (!isPathWithinWorkspace(projectLookupCwd, projectScope.root_path)) {
        fail(`--cwd is outside project root: cwd=${projectLookupCwd} root=${projectScope.root_path}`);
      }
    } else {
      projectScope = autoMatchedProject ?? resolveManagedProjectByPath(_store, projectLookupCwd);
      if (!projectScope) {
        fail(`No managed project found for cwd: ${projectLookupCwd}\nHint: run in project dir, or pass --project PROJECT_ID.`);
      }
    }
  }

  const defaultLaunchCwd = action === "project"
    ? String(projectScope?.root_path ?? "").trim()
    : REPO_ROOT;
  const launchCwd = path.resolve(cwdFlag || defaultLaunchCwd);

  if (!fs.existsSync(launchCwd)) {
    fail(`CWD not found: ${launchCwd}`);
  }

  const defaultSessionKey = action === "project"
    ? `project:${projectScope?.id ?? "unknown"}`
    : "forgeops-meta";
  const sessionKey = String(getFlag(commandArgs, "--session-key", defaultSessionKey) ?? defaultSessionKey).trim();
  const trackingKey = resolveCodexSessionTrackingKey(launchCwd, sessionKey);

  const clientPreference = String(getFlag(commandArgs, "--client", "auto") ?? "auto").trim().toLowerCase();
  if (!["auto", "app", "cli"].includes(clientPreference)) {
    fail("--client must be one of: auto, app, cli");
  }

  const includeMetaSkillByDefault = true;
  const explicitMetaSkillPath = String(getFlag(commandArgs, "--meta-skill", "") ?? "").trim();
  const projectDefaultMetaSkillPath = action === "project" && projectScope
    ? resolveDefaultProjectMetaSkillPath(_store, projectScope)
    : "";
  const metaSkillPathFallback = action === "project"
    ? (projectDefaultMetaSkillPath || DEFAULT_META_SKILL_PATH)
    : DEFAULT_META_SKILL_PATH;
  const resolvedMetaSkillPath = explicitMetaSkillPath || metaSkillPathFallback;
  const includeMetaSkill = commandArgs.includes("--no-meta-skill")
    ? false
    : (commandArgs.includes("--meta-skill") ? true : includeMetaSkillByDefault);
  const metaSkillPath = path.resolve(resolvedMetaSkillPath);
  if (includeMetaSkill && !fs.existsSync(metaSkillPath)) {
    fail(`ForgeOps skill not found: ${metaSkillPath}`);
  }
  const metaSkillSource = !includeMetaSkill
    ? "disabled"
    : (explicitMetaSkillPath
      ? "explicit"
      : (action === "project" && projectDefaultMetaSkillPath
        ? "project-default"
        : "forgeops-default"));
  const localOnly = action === "project" && commandArgs.includes("--local-only");
  if (action !== "project" && commandArgs.includes("--local-only")) {
    fail("--local-only is only supported by: forgeops codex project");
  }
  const freshStart = commandArgs.includes("--fresh");

  const userPromptRaw = String(getFlag(commandArgs, "--prompt", "") ?? "").trim();
  const userPrompt = localOnly
    ? buildProjectLocalOnlyReminderPrompt(userPromptRaw)
    : userPromptRaw;
  const codexBin = String(process.env.FORGEOPS_CODEX_BIN ?? "codex").trim() || "codex";
  const model = String(getFlag(commandArgs, "--model", "") ?? "").trim();
  const projectContextSeed = action === "project" && projectScope
    ? String(_store.loadProjectContext(projectScope.root_path) ?? "").trim()
    : "";
  const projectGovernanceSeed = action === "project" && projectScope
    ? String(_store.loadProjectGovernance(projectScope.root_path) ?? "").trim()
    : "";
  const enforceDangerSandbox = parseBool(process.env.FORGEOPS_ENFORCE_DANGER_SANDBOX, true) !== false;
  const tracked = getTrackedCodexWorkspaceSession(launchCwd, sessionKey);
  const appInstalled = isCodexAppInstalled();
  const hasTrackedThread = Boolean(tracked?.threadId) && !freshStart;

  let resolvedClient = "cli";
  if (clientPreference === "cli") {
    resolvedClient = "cli";
  } else if (clientPreference === "app") {
    resolvedClient = appInstalled ? "app" : "cli";
  } else {
    resolvedClient = "cli";
  }

  process.stdout.write("Starting ForgeOps Codex session entry…\n");
  process.stdout.write(`- agent-profile: ${action === "project" ? "project-copilot" : "forgeops-coach"}\n`);
  process.stdout.write(`- entry-action: ${action}${actionAutoDetectedByCwd ? " (auto-detected by managed project cwd)" : ""}\n`);
  if (projectScope) {
    process.stdout.write(`- project: ${projectScope.id} (${projectScope.name})\n`);
  }
  process.stdout.write(`- cwd: ${launchCwd}\n`);
  process.stdout.write(`- session-key: ${sessionKey || "(cwd scoped)"}\n`);
  process.stdout.write(`- tracking-key: ${trackingKey}\n`);
  process.stdout.write(`- client: ${resolvedClient} (requested=${clientPreference})\n`);
  process.stdout.write(`- tracked-thread: ${tracked?.threadId ?? "(none)"}\n`);
  process.stdout.write(`- fresh: ${freshStart ? "true" : "false"}\n`);
  process.stdout.write(`- meta-skill: ${includeMetaSkill ? metaSkillPath : "disabled"}\n`);
  process.stdout.write(`- meta-skill-source: ${metaSkillSource}\n`);
  process.stdout.write(`- local-only: ${localOnly ? "true" : "false"}\n`);
  process.stdout.write(`- model: ${model || "(codex default)"}\n`);

  if (resolvedClient === "app") {
    const appLaunch = spawnSync(codexBin, ["app", launchCwd], {
      stdio: "inherit",
      cwd: launchCwd,
      env: process.env,
    });
    if (appLaunch.error) {
      const message = appLaunch.error instanceof Error ? appLaunch.error.message : String(appLaunch.error);
      process.stdout.write(`Codex App launch failed: ${message}\n`);
      process.stdout.write("Falling back to Codex CLI session.\n");
    } else if (typeof appLaunch.status === "number" && appLaunch.status !== 0) {
      process.stdout.write(`Codex App exited with code ${appLaunch.status}. Falling back to Codex CLI session.\n`);
    } else {
      process.stdout.write(`Codex App opened. Resume thread in App: ${tracked?.threadId ?? "(untracked)"}\n`);
      return;
    }
  } else if (clientPreference === "app" && !appInstalled) {
    process.stdout.write("Codex App not installed. Falling back to Codex CLI session.\n");
  } else if (clientPreference === "auto" && hasTrackedThread) {
    process.stdout.write("Auto mode uses CLI resume to guarantee same tracked thread.\n");
  } else if (freshStart && tracked?.threadId) {
    process.stdout.write(`--fresh enabled: ignore tracked thread ${tracked.threadId} and start a new CLI thread.\n`);
  } else if (clientPreference === "auto" && appInstalled && !hasTrackedThread) {
    process.stdout.write("No tracked thread found yet; bootstrapping first session via Codex CLI.\n");
  }

  const sessionStartMs = Date.now();
  let cliArgs = [];
  if (hasTrackedThread) {
    cliArgs = ["resume", "--cd", launchCwd];
    if (enforceDangerSandbox) {
      cliArgs.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
    }
    if (model) {
      cliArgs.push("--model", model);
    }
    cliArgs.push(tracked.threadId);
    if (userPrompt) {
      cliArgs.push(userPrompt);
    }
    process.stdout.write(`Resuming tracked thread via CLI: ${tracked.threadId}\n`);
  } else {
    const bootstrapPrompt = action === "project"
      ? buildProjectBootstrapPrompt({
          includeMetaSkill,
          metaSkillPath,
          userPrompt,
          project: projectScope,
          launchCwd,
          projectContext: projectContextSeed,
          projectGovernance: projectGovernanceSeed,
          localOnly,
        })
      : buildMetaSkillBootstrapPrompt({
          includeMetaSkill,
          metaSkillPath,
          userPrompt,
        });
    cliArgs = ["--cd", launchCwd];
    if (enforceDangerSandbox) {
      cliArgs.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
    }
    if (model) {
      cliArgs.push("--model", model);
    }
    cliArgs.push(bootstrapPrompt);
    process.stdout.write("Launching new tracked CLI thread (source-kind=cli).\n");
  }

  const cliLaunch = spawnSync(codexBin, cliArgs, {
    stdio: "inherit",
    cwd: launchCwd,
    env: process.env,
  });

  if (cliLaunch.error) {
    const msg = cliLaunch.error instanceof Error ? cliLaunch.error.message : String(cliLaunch.error);
    fail(`Failed to launch codex session: ${msg}`);
  }
  const cliExitCode = typeof cliLaunch.status === "number" ? cliLaunch.status : 0;

  const discovered = findLatestInteractiveCodexSessionForCwd(launchCwd, {
    minTimestampMs: sessionStartMs - 2_000,
    maxScan: 400,
  });
  if (discovered?.sessionId) {
    setTrackedCodexWorkspaceSession(launchCwd, sessionKey, {
      threadId: discovered.sessionId,
      updatedAt: discovered.timestamp || new Date().toISOString(),
      source: discovered.source,
      sessionFile: discovered.filePath,
      workspaceCwd: launchCwd,
      model,
      metaSkillPath: includeMetaSkill ? metaSkillPath : "",
    });
    process.stdout.write(`Tracked thread updated: ${discovered.sessionId}\n`);
    if (cliExitCode !== 0) {
      process.exit(cliExitCode);
    }
    return;
  }

  if (hasTrackedThread) {
    setTrackedCodexWorkspaceSession(launchCwd, sessionKey, {
      threadId: tracked.threadId,
      updatedAt: new Date().toISOString(),
      source: tracked.source || "cli",
      sessionFile: tracked.sessionFile || "",
      workspaceCwd: launchCwd || tracked.workspaceCwd || "",
      model: model || tracked.model || "",
      metaSkillPath: includeMetaSkill ? metaSkillPath : (tracked.metaSkillPath || ""),
    });
    process.stdout.write(`Tracked thread preserved: ${tracked.threadId}\n`);
    if (cliExitCode !== 0) {
      process.exit(cliExitCode);
    }
    return;
  }

  process.stdout.write("Warning: unable to discover latest interactive thread id; next launch may require bootstrap again.\n");
  if (cliExitCode !== 0) {
    process.exit(cliExitCode);
  }
}

async function commandStart(args) {
  const runtimeReady = ensureCodexRuntimeReady();
  let githubPrecheckWarning = "";
  try {
    ensureGlobalGitHubDeveloperAccess();
  } catch (err) {
    githubPrecheckWarning = err instanceof Error ? err.message : String(err);
  }

  const host = getFlag(args, "--host", "127.0.0.1");
  const port = toInt(getFlag(args, "--port", "4173"), 4173);
  const pollMs = toInt(getFlag(args, "--poll-ms", "1500"), 1500);
  const concurrency = toInt(getFlag(args, "--concurrency", "2"), 2);

  const store = await createStoreInstance();
  const runtimeRegistry = createRuntimeRegistry();
  const engine = new ForgeOpsEngine({
    store,
    runtimeRegistry,
    pollMs,
    concurrency,
  });
  const scheduler = new ForgeOpsScheduler({
    store,
    pollMs: 30_000,
  });

  const app = createServerApp({
    store,
    engine,
    scheduler,
    host,
    port,
    publicDir: path.join(process.cwd(), "public"),
    frontendDistDir: path.join(process.cwd(), "frontend", "dist"),
  });

  const shutdown = async () => {
    process.stdout.write("\nShutting down ForgeOps...\n");
    scheduler.stop();
    engine.stop();
    await app.stop();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  engine.start();
  await scheduler.start();
  const started = await app.start();
  process.stdout.write(`ForgeOps started at http://${started.host}:${started.port}\n`);
  process.stdout.write(`Runtime precheck: ${runtimeReady.codexBin} ${runtimeReady.version}\n`);
  process.stdout.write(`Runtimes: ${runtimeRegistry.list().join(", ")}\n`);
  if (githubPrecheckWarning) {
    process.stdout.write(`GitHub precheck: blocked (${githubPrecheckWarning})\n`);
  } else {
    process.stdout.write("GitHub precheck: ok\n");
  }
  process.stdout.write(`Scheduler: managed_projects=${scheduler.getState().managedProjects}\n`);
}

async function commandEnv(store, args) {
  const sub = String(args[0] ?? "").trim().toLowerCase();
  const asJson = args.includes("--json");
  const show = args.includes("--show");

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    fail("Usage: forgeops env set|ls|unset|effective ...");
  }

  if (sub === "set") {
    const scope = String(args[1] ?? "").trim().toLowerCase();
    const secret = args.includes("--plain") ? false : true;
    const forceSecret = args.includes("--secret");
    const isSecret = forceSecret ? true : secret;

    if (scope === "system") {
      const kv = parseEnvAssignment(args, 2);
      if (!kv.key) fail("Usage: forgeops env set system KEY=VALUE [--secret|--plain]");
      const row = store.setEnvVar({ scopeType: "system", key: kv.key, value: kv.value, secret: isSecret });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ ok: true, scope: "system", envKey: kv.key, isSecret, row }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`OK env set system ${kv.key} (${isSecret ? "secret" : "plain"})\n`);
      return;
    }

    if (scope === "project") {
      const projectId = String(args[2] ?? "").trim();
      if (!projectId) fail("Usage: forgeops env set project <projectId> KEY=VALUE [--secret|--plain]");
      const kv = parseEnvAssignment(args, 3);
      if (!kv.key) fail("Usage: forgeops env set project <projectId> KEY=VALUE [--secret|--plain]");
      const row = store.setEnvVar({ scopeType: "project", projectId, key: kv.key, value: kv.value, secret: isSecret });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ ok: true, scope: "project", projectId, envKey: kv.key, isSecret, row }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`OK env set project=${projectId} ${kv.key} (${isSecret ? "secret" : "plain"})\n`);
      return;
    }

    if (scope === "run") {
      const runId = String(args[2] ?? "").trim();
      if (!runId) fail("Usage: forgeops env set run <runId> KEY=VALUE [--secret|--plain]");
      const kv = parseEnvAssignment(args, 3);
      if (!kv.key) fail("Usage: forgeops env set run <runId> KEY=VALUE [--secret|--plain]");
      const row = store.setEnvVar({ scopeType: "run", runId, key: kv.key, value: kv.value, secret: isSecret });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ ok: true, scope: "run", runId, envKey: kv.key, isSecret, row }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`OK env set run=${runId} ${kv.key} (${isSecret ? "secret" : "plain"})\n`);
      return;
    }

    if (scope === "step") {
      const runId = String(args[2] ?? "").trim();
      const stepKey = String(args[3] ?? "").trim();
      if (!runId || !stepKey) fail("Usage: forgeops env set step <runId> <stepKey> KEY=VALUE [--secret|--plain]");
      const kv = parseEnvAssignment(args, 4);
      if (!kv.key) fail("Usage: forgeops env set step <runId> <stepKey> KEY=VALUE [--secret|--plain]");
      const row = store.setEnvVar({ scopeType: "step", runId, stepKey, key: kv.key, value: kv.value, secret: isSecret });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ ok: true, scope: "step", runId, stepKey, envKey: kv.key, isSecret, row }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`OK env set step=${stepKey} run=${runId} ${kv.key} (${isSecret ? "secret" : "plain"})\n`);
      return;
    }

    fail("Usage: forgeops env set system|project|run|step ...");
  }

  if (sub === "ls" || sub === "list") {
    const scope = String(args[1] ?? "").trim().toLowerCase();
    if (scope === "system") {
      const rows = store.listEnvVars({ scopeType: "system", showValues: show });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "system", rows }, null, 2)}\n`);
        return;
      }
      for (const row of rows) {
        process.stdout.write(`${row.env_key}=${row.env_value}${row.is_secret ? "  # secret" : ""}\n`);
      }
      return;
    }
    if (scope === "project") {
      const projectId = String(args[2] ?? "").trim();
      if (!projectId) fail("Usage: forgeops env ls project <projectId> [--show] [--json]");
      const rows = store.listEnvVars({ scopeType: "project", projectId, showValues: show });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "project", projectId, rows }, null, 2)}\n`);
        return;
      }
      for (const row of rows) {
        process.stdout.write(`${row.env_key}=${row.env_value}${row.is_secret ? "  # secret" : ""}\n`);
      }
      return;
    }
    if (scope === "run") {
      const runId = String(args[2] ?? "").trim();
      if (!runId) fail("Usage: forgeops env ls run <runId> [--show] [--json]");
      const rows = store.listEnvVars({ scopeType: "run", runId, showValues: show });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "run", runId, rows }, null, 2)}\n`);
        return;
      }
      for (const row of rows) {
        process.stdout.write(`${row.env_key}=${row.env_value}${row.is_secret ? "  # secret" : ""}\n`);
      }
      return;
    }
    if (scope === "step") {
      const runId = String(args[2] ?? "").trim();
      const stepKey = String(args[3] ?? "").trim();
      if (!runId || !stepKey) fail("Usage: forgeops env ls step <runId> <stepKey> [--show] [--json]");
      const rows = store.listEnvVars({ scopeType: "step", runId, stepKey, showValues: show });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "step", runId, stepKey, rows }, null, 2)}\n`);
        return;
      }
      for (const row of rows) {
        process.stdout.write(`${row.env_key}=${row.env_value}${row.is_secret ? "  # secret" : ""}\n`);
      }
      return;
    }
    fail("Usage: forgeops env ls system|project|run|step ...");
  }

  if (sub === "unset" || sub === "rm" || sub === "del" || sub === "delete") {
    const scope = String(args[1] ?? "").trim().toLowerCase();
    if (scope === "system") {
      const key = String(args[2] ?? "").trim();
      if (!key) fail("Usage: forgeops env unset system KEY");
      const ok = store.unsetEnvVar({ scopeType: "system", key });
      process.stdout.write(ok ? "OK\n" : "Not found\n");
      return;
    }
    if (scope === "project") {
      const projectId = String(args[2] ?? "").trim();
      const key = String(args[3] ?? "").trim();
      if (!projectId || !key) fail("Usage: forgeops env unset project <projectId> KEY");
      const ok = store.unsetEnvVar({ scopeType: "project", projectId, key });
      process.stdout.write(ok ? "OK\n" : "Not found\n");
      return;
    }
    if (scope === "run") {
      const runId = String(args[2] ?? "").trim();
      const key = String(args[3] ?? "").trim();
      if (!runId || !key) fail("Usage: forgeops env unset run <runId> KEY");
      const ok = store.unsetEnvVar({ scopeType: "run", runId, key });
      process.stdout.write(ok ? "OK\n" : "Not found\n");
      return;
    }
    if (scope === "step") {
      const runId = String(args[2] ?? "").trim();
      const stepKey = String(args[3] ?? "").trim();
      const key = String(args[4] ?? "").trim();
      if (!runId || !stepKey || !key) fail("Usage: forgeops env unset step <runId> <stepKey> KEY");
      const ok = store.unsetEnvVar({ scopeType: "step", runId, stepKey, key });
      process.stdout.write(ok ? "OK\n" : "Not found\n");
      return;
    }
    fail("Usage: forgeops env unset system|project|run|step ...");
  }

  if (sub === "effective") {
    const scope = String(args[1] ?? "").trim().toLowerCase();
    if (scope !== "step") {
      fail("Usage: forgeops env effective step <runId> <stepKey> [--show] [--json]");
    }
    const runId = String(args[2] ?? "").trim();
    const stepKey = String(args[3] ?? "").trim();
    if (!runId || !stepKey) fail("Usage: forgeops env effective step <runId> <stepKey> [--show] [--json]");
    const effective = store.getEffectiveEnvVarsForStep({ runId, stepKey });
    const out = Object.entries(effective.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => {
        const meta = effective.meta[k] ?? {};
        const isSecret = Boolean(meta.is_secret);
        return {
          env_key: k,
          env_value: show ? v : (isSecret ? "***" : v),
          is_secret: isSecret,
          scope_type: String(meta.scope_type ?? ""),
        };
      });
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ scope: "step", runId, stepKey, rows: out }, null, 2)}\n`);
      return;
    }
    for (const row of out) {
      process.stdout.write(`${row.env_key}=${row.env_value}${row.is_secret ? "  # secret" : ""}  # from ${row.scope_type}\n`);
    }
    return;
  }

  fail("Usage: forgeops env set|ls|unset|effective ...");
}

async function commandChart(store, args) {
  const scope = String(args[0] ?? "").trim().toLowerCase();
  const asJson = args.includes("--json");
  const outFlag = String(getFlag(args, "--out", "") ?? "").trim();
  const format = String(getFlag(args, "--format", "svg") ?? "svg").trim().toLowerCase();
  const experimental = args.includes("--experimental") || String(process.env.FORGEOPS_CHART_EXPERIMENTAL ?? "").trim() === "1";
  const widthFlag = Number(getFlag(args, "--width", "") ?? "");
  const heightFlag = Number(getFlag(args, "--height", "") ?? "");
  const cardWidth = Number.isFinite(widthFlag) && widthFlag > 0 ? Math.floor(widthFlag) : 1280;
  const cardHeight = Number.isFinite(heightFlag) && heightFlag > 0 ? Math.floor(heightFlag) : 900;

  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    fail("Usage: forgeops chart system|project|run|session ...");
  }

  if (scope === "system") {
    const windowMinutes = Number(getFlag(args, "--window-minutes", "60") ?? "60") || 60;
    const wantsGithub = format === "png" || format === "html";
    const status = store.getSystemStatus({ windowMinutes, includeGitHubMetrics: wantsGithub });
    if (format === "svg") {
      const outPath = path.resolve(outFlag || resolveDefaultChartPath("system", "", "svg"));
      const svg = renderSystemStatusSvg(status, { title: "ForgeOps System Status" });
      writeChartOutput(svg, outPath);
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "system", windowMinutes, format: "svg", path: outPath }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`Wrote chart: ${outPath}\n`);
      return;
    }
    if (format === "html") {
      const outPath = path.resolve(outFlag || resolveDefaultChartPath("system", "", "html"));
      const html = renderSystemStatusHtml(status, { title: "ForgeOps System Status", width: cardWidth, height: cardHeight });
      writeTextOutput(html, outPath);
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "system", windowMinutes, format: "html", path: outPath }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`Wrote chart: ${outPath}\n`);
      return;
    }
    if (format === "png") {
      const outPath = path.resolve(outFlag || resolveDefaultChartPath("system", "", "png"));
      const html = renderSystemStatusHtml(status, { title: "ForgeOps System Status", width: cardWidth, height: cardHeight });
      const result = renderHtmlToPngWithChrome({ html, outPath, width: cardWidth, height: cardHeight });
      if (!result.ok) {
        fail(`PNG render failed: ${result.error} ${result.detail || ""}`.trim());
      }
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "system", windowMinutes, format: "png", path: result.outPath, htmlPath: result.htmlPath }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`Wrote chart: ${result.outPath}\n`);
      return;
    }
    fail("--format must be one of: svg, html, png");
  }

  if (scope === "project") {
    const projectId = String(args[1] ?? "").trim();
    if (!projectId) fail("Usage: forgeops chart project <projectId> [--window-minutes 60] [--out PATH] [--json]");
    const windowMinutes = Number(getFlag(args, "--window-minutes", "60") ?? "60") || 60;
    const status = store.getProjectStatus(projectId, { windowMinutes });
    const projectName = String(status?.project?.name ?? "").trim();
    if (format === "svg") {
      const outPath = path.resolve(outFlag || resolveDefaultChartPath("project", projectId, "svg"));
      const svg = renderProjectStatusSvg(status, { projectId, projectName });
      writeChartOutput(svg, outPath);
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "project", projectId, windowMinutes, format: "svg", path: outPath }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`Wrote chart: ${outPath}\n`);
      return;
    }
    if (format === "html") {
      const outPath = path.resolve(outFlag || resolveDefaultChartPath("project", projectId, "html"));
      const html = renderProjectStatusHtml(status, { projectId, projectName, width: cardWidth, height: cardHeight });
      writeTextOutput(html, outPath);
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "project", projectId, windowMinutes, format: "html", path: outPath }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`Wrote chart: ${outPath}\n`);
      return;
    }
    if (format === "png") {
      const outPath = path.resolve(outFlag || resolveDefaultChartPath("project", projectId, "png"));
      const html = renderProjectStatusHtml(status, { projectId, projectName, width: cardWidth, height: cardHeight });
      const result = renderHtmlToPngWithChrome({ html, outPath, width: cardWidth, height: cardHeight });
      if (!result.ok) {
        fail(`PNG render failed: ${result.error} ${result.detail || ""}`.trim());
      }
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ scope: "project", projectId, windowMinutes, format: "png", path: result.outPath, htmlPath: result.htmlPath }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`Wrote chart: ${result.outPath}\n`);
      return;
    }
    fail("--format must be one of: svg, html, png");
  }

  if (scope === "run") {
    if (!experimental) {
      fail("Chart scope 'run' is not enabled by default. Supported: system, project. Use --experimental to enable run/session charts.");
    }
    const runId = String(args[1] ?? "").trim();
    if (!runId) fail("Usage: forgeops chart run <runId> [--step STEP_KEY] [--out PATH] [--json]");
    const stepKey = String(getFlag(args, "--step", "") ?? "").trim();
    const details = store.getRunDetails(runId);
    if (!details) fail(`Run not found: ${runId}`);

    const steps = Array.isArray(details.steps) ? details.steps : [];
    const sessions = Array.isArray(details.sessions) ? details.sessions : [];
    const events = Array.isArray(details.events) ? details.events : [];

    const countBy = (rows, keyFn) => {
      const out = {};
      for (const row of rows) {
        const key = String(keyFn(row) ?? "").trim() || "unknown";
        out[key] = Number(out[key] ?? 0) + 1;
      }
      return out;
    };

    const stepsFiltered = stepKey ? steps.filter((row) => String(row.step_key ?? "").trim() === stepKey) : steps;
    const stepIds = new Set(stepsFiltered.map((row) => String(row.id ?? "").trim()).filter(Boolean));
    const sessionsFiltered = stepKey
      ? sessions.filter((row) => stepIds.has(String(row.step_id ?? "").trim()))
      : sessions;

    const stepsByStatus = countBy(stepsFiltered, (row) => row.status);
    const sessionsByStatus = countBy(sessionsFiltered, (row) => row.status);
    const eventsByTypeTop = (() => {
      const counts = countBy(events, (row) => row.event_type);
      const entries = Object.entries(counts).map(([k, v]) => ({ k, v }));
      entries.sort((a, b) => Number(b.v) - Number(a.v));
      const out = {};
      for (const row of entries.slice(0, 16)) out[row.k] = row.v;
      return out;
    })();

    const queue = {
      waiting: Number(stepsFiltered.filter((r) => r.status === "waiting").length),
      pending: Number(stepsFiltered.filter((r) => r.status === "pending").length),
      running: Number(stepsFiltered.filter((r) => r.status === "running").length),
      failed: Number(stepsFiltered.filter((r) => r.status === "failed").length),
    };

    const tokens = (() => {
      let input = 0;
      let cachedInput = 0;
      let output = 0;
      let reasoningOutput = 0;
      for (const se of sessionsFiltered) {
        input += Number(se.token_input ?? 0) || 0;
        cachedInput += Number(se.token_cached_input ?? 0) || 0;
        output += Number(se.token_output ?? 0) || 0;
        reasoningOutput += Number(se.token_reasoning_output ?? 0) || 0;
      }
      return {
        windowMinutes: 0,
        since: "",
        sessions: sessionsFiltered.length,
        input,
        cachedInput,
        output,
        reasoningOutput,
        total: input + cachedInput + output + reasoningOutput,
      };
    })();

    const snapshot = {
      now: new Date().toISOString(),
      windowMinutes: 0,
      since: "",
      runsByStatus: { [String(details.run.status ?? "unknown")]: 1 },
      stepsByStatus,
      sessionsByStatus,
      queue,
      events: { windowMinutes: 0, since: "", total: events.length, byTypeTop: eventsByTypeTop },
      tokens,
    };

    const outPath = path.resolve(outFlag || resolveDefaultChartPath("run", runId));
    const svg = renderRunStatusSvg(snapshot, { runId, task: String(details.run.task ?? ""), subtitle: stepKey ? `step=${stepKey}` : "" });
    writeChartOutput(svg, outPath);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ scope: "run", runId, stepKey: stepKey || null, path: outPath }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Wrote chart: ${outPath}\n`);
    return;
  }

  if (scope === "session") {
    if (!experimental) {
      fail("Chart scope 'session' is not enabled by default. Supported: system, project. Use --experimental to enable run/session charts.");
    }
    const sessionId = String(args[1] ?? "").trim();
    if (!sessionId) fail("Usage: forgeops chart session <sessionId> [--out PATH] [--json]");
    const row = store.getSessionDetails(sessionId);
    if (!row) fail(`Session not found: ${sessionId}`);

    const tokens = {
      input: Number(row.token_input ?? 0) || 0,
      cachedInput: Number(row.token_cached_input ?? 0) || 0,
      output: Number(row.token_output ?? 0) || 0,
      reasoningOutput: Number(row.token_reasoning_output ?? 0) || 0,
    };
    tokens.total = tokens.input + tokens.cachedInput + tokens.output + tokens.reasoningOutput;
    const snapshot = {
      now: new Date().toISOString(),
      status: String(row.status ?? ""),
      tokens,
    };

    const outPath = path.resolve(outFlag || resolveDefaultChartPath("session", sessionId));
    const svg = renderSessionStatusSvg(snapshot, {
      sessionId,
      stepKey: String(row.step_key ?? ""),
      agentId: String(row.agent_id ?? ""),
    });
    writeChartOutput(svg, outPath);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ scope: "session", sessionId, path: outPath }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Wrote chart: ${outPath}\n`);
    return;
  }

  fail("Usage: forgeops chart system|project|run|session ...");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "start") {
    await commandStart(args.slice(1));
    return;
  }

  if (command === "doctor") {
    await commandDoctor(args.slice(1));
    return;
  }

  if (command === "service") {
    await commandService(args.slice(1));
    return;
  }

  const store = await createStoreInstance();
  try {
    if (command === "status") {
      const windowMinutes = Number(getFlag(args, "--window-minutes", "60") ?? "60") || 60;
      const asJson = args.includes("--json");
      const chart = String(getFlag(args, "--chart", "") ?? "").trim().toLowerCase();
      const chartStdout = args.includes("--stdout");
      const outFlag = String(getFlag(args, "--out", "") ?? "").trim();
      const status = store.getSystemStatus({ windowMinutes });

      const tryServiceInfo = () => {
        try {
          const runtimeHome = String(getFlag(args, "--runtime-home", "") ?? "").trim();
          return getForgeOpsServiceInfo(runtimeHome ? { runtimeHome } : {});
        } catch {
          return null;
        }
      };
      const svc = tryServiceInfo();

      if (asJson) {
        process.stdout.write(`${JSON.stringify({ service: svc, status }, null, 2)}\n`);
        return;
      }

      if (chart) {
        if (chart !== "svg") {
          fail("--chart currently supports: svg");
        }
        const svg = renderSystemStatusSvg(status, {
          title: "ForgeOps Status",
        });
        if (chartStdout) {
          process.stdout.write(`${svg}\n`);
          return;
        }
        const outPath = path.resolve(outFlag || resolveDefaultChartPath("system"));
        writeChartOutput(svg, outPath);
        process.stdout.write(`Wrote chart: ${outPath}\n`);
        return;
      }

      const formatBars = (obj) => {
        const entries = Object.entries(obj ?? {}).map(([k, v]) => ({ k, v: Number(v) || 0 }));
        entries.sort((a, b) => b.v - a.v);
        const max = entries.reduce((acc, row) => Math.max(acc, row.v), 0) || 1;
        const width = 22;
        const lines = [];
        for (const row of entries) {
          const n = Math.max(0, Math.min(width, Math.round((row.v / max) * width)));
          lines.push(`${String(row.k).padEnd(14)} ${"#".repeat(n).padEnd(width)} ${row.v}`);
        }
        return lines.join("\n");
      };

      process.stdout.write(`ForgeOps Status\n`);
      process.stdout.write(`- now: ${status.now}\n`);
      process.stdout.write(`- window: last ${status.windowMinutes}m (since ${status.since})\n`);
      if (svc) {
        process.stdout.write(`- service: platform=${svc.platform} installed=${svc.installed ? "yes" : "no"} running=${svc.running ? "yes" : "no"}\n`);
        if (svc.endpoint) {
          process.stdout.write(`- endpoint: ${svc.endpoint}\n`);
        }
      } else {
        process.stdout.write(`- service: unavailable (use: forgeops service status)\n`);
      }
      process.stdout.write("\n");

      process.stdout.write(`Projects: total=${status.projects.total} active=${status.projects.active}\n`);
      process.stdout.write("Projects by type:\n");
      process.stdout.write(`${formatBars(status.projects.byProductType)}\n\n`);

      process.stdout.write("Runs by status:\n");
      process.stdout.write(`${formatBars(status.runsByStatus)}\n\n`);

      process.stdout.write("Steps by status:\n");
      process.stdout.write(`${formatBars(status.stepsByStatus)}\n\n`);

      process.stdout.write(`Queue snapshot: waiting=${status.queue.waiting} pending=${status.queue.pending} running=${status.queue.running} failed=${status.queue.failed}\n\n`);

      process.stdout.write("Sessions by status:\n");
      process.stdout.write(`${formatBars(status.sessionsByStatus)}\n\n`);

      process.stdout.write(`Events (last ${status.events.windowMinutes}m): total=${status.events.total}\n`);
      process.stdout.write("Top event types:\n");
      process.stdout.write(`${formatBars(status.events.byTypeTop)}\n\n`);

      process.stdout.write(
        `Tokens (last ${status.tokens.windowMinutes}m): total=${status.tokens.total} (in=${status.tokens.input} cached=${status.tokens.cachedInput} out=${status.tokens.output} reasoning=${status.tokens.reasoningOutput}) sessions=${status.tokens.sessions}\n`
      );
      return;
    }

    if (command === "chart") {
      await commandChart(store, args.slice(1));
      return;
    }

    if (command === "env") {
      await commandEnv(store, args.slice(1));
      return;
    }

    if (command === "project") {
      await commandProject(store, args.slice(1));
      return;
    }

    if (command === "issue") {
      await commandIssue(store, args.slice(1));
      return;
    }

    if (command === "skill") {
      await commandSkill(store, args.slice(1));
      return;
    }

    if (command === "run") {
      await commandRun(store, args.slice(1));
      return;
    }

    if (command === "scheduler") {
      await commandScheduler(store, args.slice(1));
      return;
    }

    if (command === "workflow") {
      await commandWorkflow(store, args.slice(1));
      return;
    }

    if (command === "codex") {
      await commandCodex(store, args.slice(1));
      return;
    }

    if (command === "init") {
      await commandProject(store, ["init", ...args.slice(1)]);
      return;
    }

    printUsage();
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
