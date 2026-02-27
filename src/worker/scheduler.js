import fs from "node:fs";
import cron from "node-cron";
import { loadSchedulerConfig } from "../core/scheduler-config.js";
import { resolveWorkflowFromContent } from "../core/workflow.js";
import { nowIso } from "../core/utils.js";

function safeErrorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

const CLEANUP_MODE_LITE = "lite";
const CLEANUP_MODE_DEEP = "deep";

function buildCleanupIssueTitle(cleanupMode, cleanupTask) {
  const taskPrefix = cleanupMode === CLEANUP_MODE_LITE
    ? "[AUTO-CLEANUP][LITE]"
    : "[AUTO-CLEANUP][DEEP]";
  return `${taskPrefix} ${cleanupTask}`;
}

function buildCleanupIssueDescription(project, cleanupMode, cleanupTask) {
  const modeLabel = cleanupMode === CLEANUP_MODE_LITE ? "lite" : "deep";
  return [
    "## 背景",
    "这是 ForgeOps 调度器自动创建的 Cleanup Issue，用于沉淀定时治理任务执行记录。",
    "",
    "## 项目信息",
    `- project: ${project.name} (${project.id})`,
    `- cleanup mode: ${modeLabel}`,
    `- cleanup task: ${cleanupTask}`,
    "",
    "## 说明",
    "- 该 Issue 会被周期性复用并触发关联 Run。",
    "- Run 状态会通过 forgeops 标签自动回写（running/done/failed）。",
  ].join("\n");
}

function normalizeCleanupMode(rawMode) {
  const text = String(rawMode ?? "").trim().toLowerCase();
  if (text === CLEANUP_MODE_LITE || text === CLEANUP_MODE_DEEP) return text;
  return CLEANUP_MODE_DEEP;
}

const DEEP_CLEANUP_WORKFLOW = resolveWorkflowFromContent(`
id: forgeops-cleanup-deep-v1
name: ForgeOps 深度清理工作流
steps:
  - key: cleanup
`, "<scheduler.cleanup.deep>");

function buildConfigSignature(config) {
  return JSON.stringify({
    enabled: config.enabled,
    timezone: config.timezone,
    cleanup: config.cleanup,
    issueAutoRun: config.issueAutoRun,
  });
}

export class ForgeOpsScheduler {
  constructor(params) {
    this.store = params.store;
    this.pollMs = Number(params.pollMs ?? 30000);
    this.mainlineSyncMinIntervalMs = Number(params.mainlineSyncMinIntervalMs ?? 10 * 60 * 1000);
    this.mainlineSyncRunLimit = Number(params.mainlineSyncRunLimit ?? 2);
    this.issueAutoRunMinIntervalMs = Number(params.issueAutoRunMinIntervalMs ?? 3 * 60 * 1000);
    this.running = false;
    this.syncTimer = null;
    this.jobs = new Map();
    this.inflightProjects = new Set();
    this.inflightIssueProjects = new Set();
    this.inflightMainlineProjects = new Set();
    this.lastMainlineSyncAtByProject = new Map();
    this.lastIssueAutoRunAtByProject = new Map();
    this.lastSyncAt = null;
  }

  getState() {
    const managedProjects = new Set(
      Array.from(this.jobs.values()).map((job) => job.projectId)
    ).size;
    return {
      running: this.running,
      pollMs: this.pollMs,
      managedProjects,
      lastSyncAt: this.lastSyncAt,
      jobs: Array.from(this.jobs.values()).map((job) => ({
        kind: job.kind,
        projectId: job.projectId,
        projectName: job.projectName,
        cron: job.cron,
        timezone: job.timezone,
        task: job.task,
        onlyWhenIdle: job.onlyWhenIdle,
        cleanupMode: job.cleanupMode ?? "",
        label: job.label ?? "",
        maxRunsPerTick: job.maxRunsPerTick ?? 0,
        syncedAt: job.syncedAt,
      })),
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.syncNow();
    this.syncTimer = setInterval(() => {
      void this.syncNow();
    }, this.pollMs);
  }

  stop() {
    this.running = false;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const job of this.jobs.values()) {
      try {
        job.handle.stop();
      } catch {
        // ignore
      }
      try {
        job.handle.destroy();
      } catch {
        // ignore
      }
    }
    this.jobs.clear();
    this.inflightProjects.clear();
    this.inflightIssueProjects.clear();
    this.inflightMainlineProjects.clear();
    this.lastMainlineSyncAtByProject.clear();
    this.lastIssueAutoRunAtByProject.clear();
  }

  async syncNow() {
    this.lastSyncAt = nowIso();
    if (!this.running) return;

    const projects = this.store.listProjects();
    const activeProjectIds = new Set();

    for (const project of projects) {
      activeProjectIds.add(project.id);
      if (!fs.existsSync(project.root_path)) {
        this.#unscheduleProjectJobs(project.id);
        this.store.emitEvent(null, null, "scheduler.project.missing_root", {
          projectId: project.id,
          projectName: project.name,
          rootPath: project.root_path,
        });
        continue;
      }

      const loaded = loadSchedulerConfig(project.root_path);
      const config = loaded.config;
      const signature = buildConfigSignature(config);
      this.#syncCleanupJob(project, config, loaded.source, signature);
      this.#syncIssueAutoRunJob(project, config, loaded.source, signature);
      this.#syncMergedPrMainline(project);
    }

    for (const [jobKey, job] of this.jobs) {
      if (!activeProjectIds.has(job.projectId)) {
        this.#unschedule(jobKey);
      }
    }
  }

  #jobKey(projectId, kind) {
    return `${projectId}:${kind}`;
  }

  #unscheduleProjectJobs(projectId) {
    const prefix = `${projectId}:`;
    for (const key of this.jobs.keys()) {
      if (key.startsWith(prefix)) {
        this.#unschedule(key);
      }
    }
  }

  #unschedule(jobKey) {
    const job = this.jobs.get(jobKey);
    if (!job) return;
    try {
      job.handle.stop();
    } catch {
      // ignore
    }
    try {
      job.handle.destroy();
    } catch {
      // ignore
    }
    this.jobs.delete(jobKey);
  }

  #syncCleanupJob(project, config, source, signature) {
    const kind = "cleanup";
    const jobKey = this.#jobKey(project.id, kind);
    const current = this.jobs.get(jobKey);
    const cleanupEnabled = config.enabled && config.cleanup.enabled;
    if (!cleanupEnabled) {
      if (current) {
        this.#unschedule(jobKey);
        this.store.emitEvent(null, null, "scheduler.cleanup.job.disabled", {
          projectId: project.id,
          projectName: project.name,
        });
      }
      return;
    }
    if (!cron.validate(config.cleanup.cron)) {
      if (current) {
        this.#unschedule(jobKey);
      }
      this.store.emitEvent(null, null, "scheduler.cleanup.job.invalid_cron", {
        projectId: project.id,
        projectName: project.name,
        cron: config.cleanup.cron,
        source,
      });
      return;
    }
    if (current && current.signature === signature) return;
    if (current) this.#unschedule(jobKey);
    this.#scheduleCleanupJob(project, config, signature);
  }

  #scheduleCleanupJob(project, config, signature) {
    const kind = "cleanup";
    const jobKey = this.#jobKey(project.id, kind);
    const cleanupMode = normalizeCleanupMode(config.cleanup.mode);
    const scheduledTask = cron.schedule(
      config.cleanup.cron,
      () => {
        void this.#triggerCleanup(project, config);
      },
      {
        timezone: config.timezone,
      }
    );

    this.jobs.set(jobKey, {
      kind,
      projectId: project.id,
      projectName: project.name,
      cron: config.cleanup.cron,
      timezone: config.timezone,
      task: config.cleanup.task,
      onlyWhenIdle: config.cleanup.onlyWhenIdle,
      cleanupMode,
      signature,
      syncedAt: nowIso(),
      handle: scheduledTask,
    });

    this.store.emitEvent(null, null, "scheduler.cleanup.job.scheduled", {
      projectId: project.id,
      projectName: project.name,
      cron: config.cleanup.cron,
      timezone: config.timezone,
      task: config.cleanup.task,
      onlyWhenIdle: config.cleanup.onlyWhenIdle,
      cleanupMode,
    });
  }

  #syncIssueAutoRunJob(project, config, source, signature) {
    const kind = "issueAutoRun";
    const jobKey = this.#jobKey(project.id, kind);
    const current = this.jobs.get(jobKey);
    const rule = config.issueAutoRun ?? {};
    const enabled = config.enabled && rule.enabled;
    const label = String(rule.label ?? "").trim();
    if (!enabled) {
      if (current) {
        this.#unschedule(jobKey);
        this.store.emitEvent(null, null, "scheduler.issue_autorun.job.disabled", {
          projectId: project.id,
          projectName: project.name,
        });
      }
      return;
    }
    if (!label) {
      if (current) this.#unschedule(jobKey);
      this.store.emitEvent(null, null, "scheduler.issue_autorun.job.invalid_label", {
        projectId: project.id,
        projectName: project.name,
      });
      return;
    }
    if (!cron.validate(rule.cron)) {
      if (current) this.#unschedule(jobKey);
      this.store.emitEvent(null, null, "scheduler.issue_autorun.job.invalid_cron", {
        projectId: project.id,
        projectName: project.name,
        cron: rule.cron,
        source,
      });
      return;
    }
    if (current && current.signature === signature) return;
    if (current) this.#unschedule(jobKey);
    this.#scheduleIssueAutoRunJob(project, config, signature);
  }

  #scheduleIssueAutoRunJob(project, config, signature) {
    const kind = "issueAutoRun";
    const jobKey = this.#jobKey(project.id, kind);
    const rule = config.issueAutoRun ?? {};
    const scheduledTask = cron.schedule(
      rule.cron,
      () => {
        void this.#triggerIssueAutoRun(project, config);
      },
      {
        timezone: config.timezone,
      }
    );

    this.jobs.set(jobKey, {
      kind,
      projectId: project.id,
      projectName: project.name,
      cron: rule.cron,
      timezone: config.timezone,
      task: "",
      onlyWhenIdle: rule.onlyWhenIdle,
      label: String(rule.label ?? ""),
      maxRunsPerTick: Number(rule.maxRunsPerTick ?? 0),
      signature,
      syncedAt: nowIso(),
      handle: scheduledTask,
    });

    this.store.emitEvent(null, null, "scheduler.issue_autorun.job.scheduled", {
      projectId: project.id,
      projectName: project.name,
      cron: rule.cron,
      timezone: config.timezone,
      label: rule.label,
      onlyWhenIdle: Boolean(rule.onlyWhenIdle),
      maxRunsPerTick: Number(rule.maxRunsPerTick ?? 0),
    });
  }

  #syncMergedPrMainline(project) {
    if (!project?.id) return;
    if (this.inflightMainlineProjects.has(project.id)) return;
    const minIntervalMs = Number.isFinite(this.mainlineSyncMinIntervalMs)
      ? Math.max(10_000, Math.floor(this.mainlineSyncMinIntervalMs))
      : 10 * 60 * 1000;
    const lastSyncAtMs = Number(this.lastMainlineSyncAtByProject.get(project.id) ?? 0);
    const nowMs = Date.now();
    if (lastSyncAtMs > 0 && nowMs - lastSyncAtMs < minIntervalMs) {
      return;
    }
    this.lastMainlineSyncAtByProject.set(project.id, nowMs);
    this.inflightMainlineProjects.add(project.id);
    try {
      const limit = Number.isFinite(this.mainlineSyncRunLimit)
        ? Math.max(1, Math.min(8, Math.floor(this.mainlineSyncRunLimit)))
        : 2;
      this.store.syncProjectMainlineAfterMergedPr({
        projectId: project.id,
        limit,
      });
    } catch (err) {
      this.store.emitEvent(null, null, "scheduler.mainline_sync.failed", {
        projectId: project.id,
        projectName: project.name,
        error: safeErrorMessage(err),
      });
    } finally {
      this.inflightMainlineProjects.delete(project.id);
    }
  }

  async #triggerCleanup(project, config) {
    const cleanupMode = normalizeCleanupMode(config.cleanup.mode);
    if (this.inflightProjects.has(project.id)) {
      this.store.emitEvent(null, null, "scheduler.cleanup.skipped_inflight", {
        projectId: project.id,
        projectName: project.name,
        cleanupMode,
      });
      return;
    }

    if (config.cleanup.onlyWhenIdle) {
      const hasRunning = this.store
        .listRuns(project.id)
        .some((run) => String(run.status) === "running");
      if (hasRunning) {
        this.store.emitEvent(null, null, "scheduler.cleanup.skipped_busy", {
          projectId: project.id,
          projectName: project.name,
          cleanupMode,
        });
        return;
      }
    }

    this.inflightProjects.add(project.id);
    const issueTitle = buildCleanupIssueTitle(cleanupMode, config.cleanup.task);
    const task = `${issueTitle} @ ${nowIso()}`;

    try {
      const openIssues = this.store.listIssues(project.id);
      const reusedIssue = openIssues.find(
        (issue) => String(issue.status ?? "").toLowerCase() === "open"
          && String(issue.title ?? "").trim() === issueTitle
      );
      const issue = reusedIssue ?? this.store.createIssue({
        projectId: project.id,
        title: issueTitle,
        description: buildCleanupIssueDescription(project, cleanupMode, config.cleanup.task),
      });

      if (!reusedIssue) {
        this.store.emitEvent(null, null, "scheduler.cleanup.issue_created", {
          projectId: project.id,
          projectName: project.name,
          issueId: issue.id,
          issueTitle,
          cleanupMode,
        });
      }

      const run = this.store.createRun({
        projectId: project.id,
        issueId: issue.id,
        task,
        workflowOverride: cleanupMode === CLEANUP_MODE_DEEP ? DEEP_CLEANUP_WORKFLOW : null,
      });
      this.store.emitEvent(run.id, null, "scheduler.cleanup.run_created", {
        projectId: project.id,
        projectName: project.name,
        issueId: issue.id,
        runId: run.id,
        workflowId: run.workflow_id,
        cleanupMode,
        task,
      });
    } catch (err) {
      this.store.emitEvent(null, null, "scheduler.cleanup.run_failed", {
        projectId: project.id,
        projectName: project.name,
        cleanupMode,
        task,
        error: safeErrorMessage(err),
      });
    } finally {
      this.inflightProjects.delete(project.id);
    }
  }

  async #triggerIssueAutoRun(project, config) {
    const rule = config.issueAutoRun ?? {};
    const rawLabel = String(rule.label ?? "").trim();
    const targetLabel = rawLabel.toLowerCase();
    if (!targetLabel) {
      return;
    }
    const minIntervalMs = Number.isFinite(this.issueAutoRunMinIntervalMs)
      ? Math.max(10_000, Math.floor(this.issueAutoRunMinIntervalMs))
      : 3 * 60 * 1000;
    const lastRunAtMs = Number(this.lastIssueAutoRunAtByProject.get(project.id) ?? 0);
    const nowMs = Date.now();
    if (lastRunAtMs > 0 && nowMs - lastRunAtMs < minIntervalMs) {
      return;
    }
    this.lastIssueAutoRunAtByProject.set(project.id, nowMs);
    const includeAllOpenIssues = targetLabel === "*" || targetLabel === "all";

    if (this.inflightIssueProjects.has(project.id)) {
      this.store.emitEvent(null, null, "scheduler.issue_autorun.skipped_inflight", {
        projectId: project.id,
        projectName: project.name,
      });
      return;
    }

    if (rule.onlyWhenIdle) {
      const hasRunning = this.store
        .listRuns(project.id)
        .some((run) => String(run.status) === "running");
      if (hasRunning) {
        this.store.emitEvent(null, null, "scheduler.issue_autorun.skipped_busy", {
          projectId: project.id,
          projectName: project.name,
        });
        return;
      }
    }

    this.inflightIssueProjects.add(project.id);
    try {
      const issueRows = this.store.listIssues(project.id);
      const openTargetIssues = issueRows
        .filter((issue) => String(issue.status ?? "open").toLowerCase() === "open")
        .filter((issue) => {
          if (includeAllOpenIssues) return true;
          const labels = Array.isArray(issue.labels) ? issue.labels : [];
          return labels.some((label) => String(label ?? "").trim().toLowerCase() === targetLabel);
        })
        .sort((left, right) => {
          const l = Date.parse(String(left.updated_at ?? left.created_at ?? ""));
          const r = Date.parse(String(right.updated_at ?? right.created_at ?? ""));
          return (Number.isFinite(l) ? l : 0) - (Number.isFinite(r) ? r : 0);
        });

      const maxRunsPerTick = Math.max(1, Number(rule.maxRunsPerTick ?? 1));
      let createdRuns = 0;
      let skippedExisting = 0;
      for (const issue of openTargetIssues) {
        if (createdRuns >= maxRunsPerTick) break;
        const issueId = String(issue?.id ?? "").trim();
        if (!issueId) continue;
        if (this.store.hasRunForGitHubIssue(project.id, issueId)) {
          skippedExisting += 1;
          continue;
        }
        const title = String(issue?.title ?? "").trim() || "未命名需求";
        const task = `[AUTO-ISSUE] 处理 GitHub Issue #${issueId}: ${title}`;
        try {
          const run = this.store.createRun({
            projectId: project.id,
            issueId,
            task,
          });
          createdRuns += 1;
          this.store.emitEvent(run.id, null, "scheduler.issue_autorun.run_created", {
            projectId: project.id,
            projectName: project.name,
            issueId,
            issueTitle: title,
            runId: run.id,
            task,
          });
        } catch (err) {
          this.store.emitEvent(null, null, "scheduler.issue_autorun.run_failed", {
            projectId: project.id,
            projectName: project.name,
            issueId,
            issueTitle: title,
            task,
            error: safeErrorMessage(err),
          });
        }
      }

      this.store.emitEvent(null, null, "scheduler.issue_autorun.tick_done", {
        projectId: project.id,
        projectName: project.name,
        scannedOpenReady: openTargetIssues.length,
        createdRuns,
        skippedExisting,
        label: includeAllOpenIssues ? "*" : targetLabel,
        mode: includeAllOpenIssues ? "all_open" : "label_match",
        maxRunsPerTick,
      });
    } catch (err) {
      this.store.emitEvent(null, null, "scheduler.issue_autorun.tick_failed", {
        projectId: project.id,
        projectName: project.name,
        label: includeAllOpenIssues ? "*" : targetLabel,
        mode: includeAllOpenIssues ? "all_open" : "label_match",
        error: safeErrorMessage(err),
      });
    } finally {
      this.inflightIssueProjects.delete(project.id);
    }
  }
}
