#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../core/doctor.js";
import { ensureGlobalGitHubDeveloperAccess } from "../core/git.js";
import { normalizeProductType } from "../core/product-type.js";
import { initProjectScaffold } from "../core/project-init.js";
import { resolveRunAttachContext } from "../core/run-attach.js";
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
      "forgeops project init [--name NAME] [--type web|miniapp|ios|microservice|android|serverless|other] [--language LANG] [--frontend-stack STACK] [--backend-stack STACK] [--ci-provider NAME] [--problem TEXT] [--path DIR] [--github-repo OWNER/NAME] [--github-public|--github-private] [--branch-protection|--no-branch-protection]",
      "forgeops project list",
      "forgeops project metrics <projectId> [--json]",
      "forgeops issue create <projectId> <title> [--description TEXT] [--no-auto-run]    # create GitHub issue",
      "forgeops issue list <projectId>                                   # list GitHub issues",
      "forgeops skill candidates <projectId>                             # list skill candidates",
      "forgeops skill resolve <projectId>                                # resolve effective skills with priority",
      "forgeops skill promote <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--roles developer,tester] [--role reviewer] [--ready]",
      "forgeops skill global-status                                      # show user-global skill library status",
      "forgeops skill promote-global <projectId> --candidate PATH [--name SKILL_NAME] [--description TEXT] [--ready]",
      "forgeops run create <projectId> [task] --issue GITHUB_ISSUE_NUMBER",
      "forgeops run list [--project PROJECT_ID]",
      "forgeops run show <runId>",
      "forgeops run resume <runId>",
      "forgeops run attach <runId> [--step STEP_KEY] [--session SESSION_ID] [--thread THREAD_ID]  # open Codex thread",
      "forgeops doctor [--json]",
      "forgeops service install [--no-start] [--host 127.0.0.1] [--port 4173] [--poll-ms 1500] [--concurrency 2] [--runtime-home DIR]",
      "forgeops service start|stop|restart|status|uninstall [--runtime-home DIR]",
      "forgeops service logs [--lines 120] [--runtime-home DIR]",
      "forgeops scheduler show <projectId>",
      "forgeops scheduler set <projectId> [--enabled true|false] [--cleanup-enabled true|false] [--cron \"0 3 * * *\"] [--timezone UTC] [--task TEXT] [--only-when-idle true|false] [--issue-auto-enabled true|false] [--issue-auto-cron \"*/1 * * * *\"] [--issue-auto-label forgeops:ready|*] [--issue-auto-only-when-idle true|false] [--issue-auto-max-runs-per-tick 3]",
      "forgeops workflow show <projectId>",
      "forgeops workflow set <projectId> [--yaml-file PATH | --yaml TEXT | --reset-default]",
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
      fail("Usage: forgeops issue create <projectId> <title> [--description TEXT] [--no-auto-run]");
    }
    const description = getFlag(args, "--description", "");
    const autoRun = !args.includes("--no-auto-run");
    const created = store.createIssueWithAutoRun({ projectId, title, description, autoRun });
    const issue = created.issue;
    process.stdout.write(`Created GitHub issue: #${issue.id}${issue.github_url ? ` (${issue.github_url})` : ""}\n`);
    if (created.auto_run_enabled && created.run) {
      process.stdout.write(`Auto-created run: ${created.run.id}\n`);
    } else if (created.auto_run_enabled && created.auto_run_error) {
      process.stdout.write(`Auto-run warning: ${created.auto_run_error}\n`);
    } else {
      process.stdout.write("Auto-run: disabled\n");
    }
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

  fail("Unknown skill command. Try: forgeops skill global-status|candidates|resolve|promote|promote-global");
}

async function commandRun(store, args) {
  const action = args[0];

  if (action === "create") {
    const projectId = args[1];
    const task = args[2] ?? "";
    if (!projectId) {
      fail("Usage: forgeops run create <projectId> [task] --issue GITHUB_ISSUE_NUMBER");
    }

    const issueId = getFlag(args, "--issue", null);
    if (!issueId) {
      fail("Usage: forgeops run create <projectId> [task] --issue GITHUB_ISSUE_NUMBER");
    }
    const run = store.createRun({ projectId, issueId, task });
    process.stdout.write(`Created run: ${run.id}\n`);
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

  if (action === "resume") {
    const runId = args[1];
    if (!runId) fail("Usage: forgeops run resume <runId>");
    const ok = store.resumeRun(runId);
    if (!ok) fail("Run cannot be resumed", 2);
    process.stdout.write(`Resumed run: ${runId}\n`);
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
    process.stdout.write(`Launching: ${codexBin} resume --all --cd ${attachCwd} ${selected.threadId}\n`);

    const launch = spawnSync(codexBin, ["resume", "--all", "--cd", attachCwd, selected.threadId], {
      stdio: "inherit",
      cwd: attachCwd,
      env: process.env,
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

  fail("Unknown run command. Try: forgeops run create|list|show|resume|attach");
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

  if (Object.keys(patch).length === 0) {
    fail("No scheduler fields provided. Use --enabled/--cleanup-enabled/--cleanup-mode/--cron/--timezone/--task/--only-when-idle/--issue-auto-enabled/--issue-auto-cron/--issue-auto-label/--issue-auto-only-when-idle/--issue-auto-max-runs-per-tick");
  }

  const saved = updateSchedulerConfig(project.root_path, patch);
  process.stdout.write(`Updated scheduler config: ${saved.path}\n`);
  process.stdout.write(`${JSON.stringify(saved.config, null, 2)}\n`);
}

async function commandWorkflow(store, args) {
  const action = args[0];
  if (action !== "show" && action !== "set") {
    fail("Unknown workflow command. Try: forgeops workflow show|set");
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
    process.stdout.write(`Steps: ${loaded.resolved.steps.map((step) => step.key).join(" -> ")}\n`);
    for (const step of loaded.resolved.steps) {
      process.stdout.write(`- ${formatWorkflowResolvedStep(step)}\n`);
    }
    process.stdout.write("--- workflow.yaml ---\n");
    process.stdout.write(loaded.yaml);
    return;
  }

  const yamlFile = getFlag(args, "--yaml-file", null);
  const yamlInline = getFlag(args, "--yaml", null);
  const resetDefault = args.includes("--reset-default");
  const modes = Number(Boolean(yamlFile)) + Number(Boolean(yamlInline)) + Number(resetDefault);
  if (modes !== 1) {
    fail("workflow set requires exactly one mode: --yaml-file PATH | --yaml TEXT | --reset-default");
  }

  let yamlText = "";
  if (resetDefault) {
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
  lines.push(`Service manager: ${status.manager} (${status.platform})`);
  lines.push(`Service id: ${status.serviceId}`);
  lines.push(`Installed: ${status.installed ? "yes" : "no"}`);
  lines.push(`Enabled: ${status.enabled ? "yes" : "no"}`);
  lines.push(`Running: ${status.loaded ? "yes" : "no"}`);
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
