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
    skillPromotion: config.skillPromotion,
    globalSkillPromotion: config.globalSkillPromotion,
  });
}

export class ForgeOpsScheduler {
  constructor(params) {
    this.store = params.store;
    this.pollMs = Number(params.pollMs ?? 30000);
    this.mainlineSyncMinIntervalMs = Number(params.mainlineSyncMinIntervalMs ?? 10 * 60 * 1000);
    this.mainlineSyncRunLimit = Number(params.mainlineSyncRunLimit ?? 2);
    this.issueAutoRunMinIntervalMs = Number(params.issueAutoRunMinIntervalMs ?? 3 * 60 * 1000);
    this.missedExecutionRecoveryMinIntervalMs = Number(params.missedExecutionRecoveryMinIntervalMs ?? 15 * 1000);
    this.running = false;
    this.syncTimer = null;
    this.jobs = new Map();
    this.inflightProjects = new Set();
    this.inflightIssueProjects = new Set();
    this.inflightSkillPromotionProjects = new Set();
    this.inflightGlobalSkillPromotionProjects = new Set();
    this.inflightMainlineProjects = new Set();
    this.lastMainlineSyncAtByProject = new Map();
    this.lastIssueAutoRunAtByProject = new Map();
    this.lastMissedRecoveryAtByJob = new Map();
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
        minCandidateOccurrences: job.minCandidateOccurrences ?? 0,
        lookbackDays: job.lookbackDays ?? 0,
        minScore: job.minScore ?? 0,
        maxPromotionsPerTick: job.maxPromotionsPerTick ?? 0,
        requireProjectSkill: job.requireProjectSkill ?? false,
        draft: job.draft ?? true,
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
    this.inflightSkillPromotionProjects.clear();
    this.inflightGlobalSkillPromotionProjects.clear();
    this.inflightMainlineProjects.clear();
    this.lastMainlineSyncAtByProject.clear();
    this.lastIssueAutoRunAtByProject.clear();
    this.lastMissedRecoveryAtByJob.clear();
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
      this.#syncSkillPromotionJob(project, config, loaded.source, signature);
      this.#syncGlobalSkillPromotionJob(project, config, loaded.source, signature);
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
    this.lastMissedRecoveryAtByJob.delete(jobKey);
  }

  #attachMissedExecutionRecovery(params) {
    const jobKey = String(params?.jobKey ?? "").trim();
    const eventPrefix = String(params?.eventPrefix ?? "").trim();
    const project = params?.project ?? {};
    const scheduledTask = params?.scheduledTask;
    const trigger = typeof params?.trigger === "function" ? params.trigger : null;
    if (!jobKey || !eventPrefix || !scheduledTask || !trigger) return;

    scheduledTask.on("execution:missed", (context) => {
      const nowMs = Date.now();
      const minIntervalMs = Number.isFinite(this.missedExecutionRecoveryMinIntervalMs)
        ? Math.max(5_000, Math.floor(this.missedExecutionRecoveryMinIntervalMs))
        : 15_000;
      const lastRecoveryAtMs = Number(this.lastMissedRecoveryAtByJob.get(jobKey) ?? 0);
      const expectedAt = context?.date instanceof Date ? context.date.toISOString() : "";
      const observedAt = context?.triggeredAt instanceof Date ? context.triggeredAt.toISOString() : nowIso();
      if (lastRecoveryAtMs > 0 && nowMs - lastRecoveryAtMs < minIntervalMs) {
        this.store.emitEvent(null, null, `scheduler.${eventPrefix}.missed_recovery_throttled`, {
          projectId: project.id,
          projectName: project.name,
          expectedAt,
          observedAt,
          minIntervalMs,
          cooldownRemainingMs: minIntervalMs - (nowMs - lastRecoveryAtMs),
        });
        return;
      }

      this.lastMissedRecoveryAtByJob.set(jobKey, nowMs);
      this.store.emitEvent(null, null, `scheduler.${eventPrefix}.missed_recovery_started`, {
        projectId: project.id,
        projectName: project.name,
        expectedAt,
        observedAt,
      });
      Promise.resolve()
        .then(() => trigger())
        .then(() => {
          this.store.emitEvent(null, null, `scheduler.${eventPrefix}.missed_recovery_done`, {
            projectId: project.id,
            projectName: project.name,
            expectedAt,
            observedAt,
          });
        })
        .catch((err) => {
          this.store.emitEvent(null, null, `scheduler.${eventPrefix}.missed_recovery_failed`, {
            projectId: project.id,
            projectName: project.name,
            expectedAt,
            observedAt,
            error: safeErrorMessage(err),
          });
        });
    });
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
    const trigger = () => this.#triggerCleanup(project, config);
    const scheduledTask = cron.schedule(
      config.cleanup.cron,
      async () => trigger(),
      {
        timezone: config.timezone,
        noOverlap: true,
      }
    );
    this.#attachMissedExecutionRecovery({
      jobKey,
      eventPrefix: "cleanup",
      project,
      scheduledTask,
      trigger,
    });

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
    const trigger = () => this.#triggerIssueAutoRun(project, config);
    const scheduledTask = cron.schedule(
      rule.cron,
      async () => trigger(),
      {
        timezone: config.timezone,
        noOverlap: true,
      }
    );
    this.#attachMissedExecutionRecovery({
      jobKey,
      eventPrefix: "issue_autorun",
      project,
      scheduledTask,
      trigger,
    });

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

  #syncSkillPromotionJob(project, config, source, signature) {
    const kind = "skillPromotion";
    const jobKey = this.#jobKey(project.id, kind);
    const current = this.jobs.get(jobKey);
    const rule = config.skillPromotion ?? {};
    const enabled = config.enabled && rule.enabled;

    if (!enabled) {
      if (current) {
        this.#unschedule(jobKey);
        this.store.emitEvent(null, null, "scheduler.skill_promotion.job.disabled", {
          projectId: project.id,
          projectName: project.name,
        });
      }
      return;
    }

    if (!cron.validate(rule.cron)) {
      if (current) this.#unschedule(jobKey);
      this.store.emitEvent(null, null, "scheduler.skill_promotion.job.invalid_cron", {
        projectId: project.id,
        projectName: project.name,
        cron: rule.cron,
        source,
      });
      return;
    }

    if (current && current.signature === signature) return;
    if (current) this.#unschedule(jobKey);
    this.#scheduleSkillPromotionJob(project, config, signature);
  }

  #scheduleSkillPromotionJob(project, config, signature) {
    const kind = "skillPromotion";
    const jobKey = this.#jobKey(project.id, kind);
    const rule = config.skillPromotion ?? {};
    const trigger = () => this.#triggerSkillPromotion(project, config);
    const scheduledTask = cron.schedule(
      rule.cron,
      async () => trigger(),
      {
        timezone: config.timezone,
        noOverlap: true,
      }
    );
    this.#attachMissedExecutionRecovery({
      jobKey,
      eventPrefix: "skill_promotion",
      project,
      scheduledTask,
      trigger,
    });

    this.jobs.set(jobKey, {
      kind,
      projectId: project.id,
      projectName: project.name,
      cron: rule.cron,
      timezone: config.timezone,
      onlyWhenIdle: Boolean(rule.onlyWhenIdle),
      minCandidateOccurrences: Number(rule.minCandidateOccurrences ?? 0),
      lookbackDays: Number(rule.lookbackDays ?? 0),
      minScore: Number(rule.minScore ?? 0),
      maxPromotionsPerTick: Number(rule.maxPromotionsPerTick ?? 0),
      draft: rule.draft !== false,
      signature,
      syncedAt: nowIso(),
      handle: scheduledTask,
    });

    this.store.emitEvent(null, null, "scheduler.skill_promotion.job.scheduled", {
      projectId: project.id,
      projectName: project.name,
      cron: rule.cron,
      timezone: config.timezone,
      onlyWhenIdle: Boolean(rule.onlyWhenIdle),
      minCandidateOccurrences: Number(rule.minCandidateOccurrences ?? 0),
      lookbackDays: Number(rule.lookbackDays ?? 0),
      minScore: Number(rule.minScore ?? 0),
      maxPromotionsPerTick: Number(rule.maxPromotionsPerTick ?? 0),
      draft: rule.draft !== false,
      roles: Array.isArray(rule.roles) ? rule.roles : [],
    });
  }

  #syncGlobalSkillPromotionJob(project, config, source, signature) {
    const kind = "globalSkillPromotion";
    const jobKey = this.#jobKey(project.id, kind);
    const current = this.jobs.get(jobKey);
    const rule = config.globalSkillPromotion ?? {};
    const enabled = config.enabled && rule.enabled;

    if (!enabled) {
      if (current) {
        this.#unschedule(jobKey);
        this.store.emitEvent(null, null, "scheduler.global_skill_promotion.job.disabled", {
          projectId: project.id,
          projectName: project.name,
        });
      }
      return;
    }

    if (!cron.validate(rule.cron)) {
      if (current) this.#unschedule(jobKey);
      this.store.emitEvent(null, null, "scheduler.global_skill_promotion.job.invalid_cron", {
        projectId: project.id,
        projectName: project.name,
        cron: rule.cron,
        source,
      });
      return;
    }

    if (current && current.signature === signature) return;
    if (current) this.#unschedule(jobKey);
    this.#scheduleGlobalSkillPromotionJob(project, config, signature);
  }

  #scheduleGlobalSkillPromotionJob(project, config, signature) {
    const kind = "globalSkillPromotion";
    const jobKey = this.#jobKey(project.id, kind);
    const rule = config.globalSkillPromotion ?? {};
    const trigger = () => this.#triggerGlobalSkillPromotion(project, config);
    const scheduledTask = cron.schedule(
      rule.cron,
      async () => trigger(),
      {
        timezone: config.timezone,
        noOverlap: true,
      }
    );
    this.#attachMissedExecutionRecovery({
      jobKey,
      eventPrefix: "global_skill_promotion",
      project,
      scheduledTask,
      trigger,
    });

    this.jobs.set(jobKey, {
      kind,
      projectId: project.id,
      projectName: project.name,
      cron: rule.cron,
      timezone: config.timezone,
      onlyWhenIdle: Boolean(rule.onlyWhenIdle),
      minCandidateOccurrences: Number(rule.minCandidateOccurrences ?? 0),
      lookbackDays: Number(rule.lookbackDays ?? 0),
      minScore: Number(rule.minScore ?? 0),
      maxPromotionsPerTick: Number(rule.maxPromotionsPerTick ?? 0),
      requireProjectSkill: rule.requireProjectSkill !== false,
      draft: rule.draft !== false,
      signature,
      syncedAt: nowIso(),
      handle: scheduledTask,
    });

    this.store.emitEvent(null, null, "scheduler.global_skill_promotion.job.scheduled", {
      projectId: project.id,
      projectName: project.name,
      cron: rule.cron,
      timezone: config.timezone,
      onlyWhenIdle: Boolean(rule.onlyWhenIdle),
      minCandidateOccurrences: Number(rule.minCandidateOccurrences ?? 0),
      lookbackDays: Number(rule.lookbackDays ?? 0),
      minScore: Number(rule.minScore ?? 0),
      maxPromotionsPerTick: Number(rule.maxPromotionsPerTick ?? 0),
      requireProjectSkill: rule.requireProjectSkill !== false,
      draft: rule.draft !== false,
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

  async #triggerSkillPromotion(project, config) {
    const rule = config.skillPromotion ?? {};
    if (this.inflightSkillPromotionProjects.has(project.id)) {
      this.store.emitEvent(null, null, "scheduler.skill_promotion.skipped_inflight", {
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
        this.store.emitEvent(null, null, "scheduler.skill_promotion.skipped_busy", {
          projectId: project.id,
          projectName: project.name,
        });
        return;
      }
    }

    this.inflightSkillPromotionProjects.add(project.id);
    try {
      const result = this.store.autoPromoteProjectSkillCandidates({
        projectId: project.id,
        maxPromotionsPerTick: Number(rule.maxPromotionsPerTick ?? 1),
        minCandidateOccurrences: Number(rule.minCandidateOccurrences ?? 2),
        lookbackDays: Number(rule.lookbackDays ?? 14),
        minScore: Number(rule.minScore ?? 0.6),
        draft: rule.draft !== false,
        roles: Array.isArray(rule.roles) ? rule.roles : [],
      });
      this.store.emitEvent(null, null, "scheduler.skill_promotion.tick_done", {
        projectId: project.id,
        projectName: project.name,
        totalCandidates: Number(result.totalCandidates ?? 0),
        groupedSkills: Number(result.groupedSkills ?? 0),
        eligibleCount: Number(result.eligibleCount ?? 0),
        promotedCount: Array.isArray(result.promoted) ? result.promoted.length : 0,
        skippedCount: Array.isArray(result.skipped) ? result.skipped.length : 0,
        failedCount: Array.isArray(result.failed) ? result.failed.length : 0,
      });
    } catch (err) {
      this.store.emitEvent(null, null, "scheduler.skill_promotion.tick_failed", {
        projectId: project.id,
        projectName: project.name,
        error: safeErrorMessage(err),
      });
    } finally {
      this.inflightSkillPromotionProjects.delete(project.id);
    }
  }

  async #triggerGlobalSkillPromotion(project, config) {
    const rule = config.globalSkillPromotion ?? {};
    if (this.inflightGlobalSkillPromotionProjects.has(project.id)) {
      this.store.emitEvent(null, null, "scheduler.global_skill_promotion.skipped_inflight", {
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
        this.store.emitEvent(null, null, "scheduler.global_skill_promotion.skipped_busy", {
          projectId: project.id,
          projectName: project.name,
        });
        return;
      }
    }

    this.inflightGlobalSkillPromotionProjects.add(project.id);
    try {
      const result = this.store.autoPromoteGlobalSkillCandidates({
        projectId: project.id,
        maxPromotionsPerTick: Number(rule.maxPromotionsPerTick ?? 1),
        minCandidateOccurrences: Number(rule.minCandidateOccurrences ?? 3),
        lookbackDays: Number(rule.lookbackDays ?? 30),
        minScore: Number(rule.minScore ?? 0.75),
        requireProjectSkill: rule.requireProjectSkill !== false,
        draft: rule.draft !== false,
      });
      this.store.emitEvent(null, null, "scheduler.global_skill_promotion.tick_done", {
        projectId: project.id,
        projectName: project.name,
        totalCandidates: Number(result.totalCandidates ?? 0),
        groupedSkills: Number(result.groupedSkills ?? 0),
        eligibleCount: Number(result.eligibleCount ?? 0),
        promotedCount: Array.isArray(result.promoted) ? result.promoted.length : 0,
        skippedCount: Array.isArray(result.skipped) ? result.skipped.length : 0,
        failedCount: Array.isArray(result.failed) ? result.failed.length : 0,
      });
    } catch (err) {
      this.store.emitEvent(null, null, "scheduler.global_skill_promotion.tick_failed", {
        projectId: project.id,
        projectName: project.name,
        error: safeErrorMessage(err),
      });
    } finally {
      this.inflightGlobalSkillPromotionProjects.delete(project.id);
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
        const issueLabels = Array.isArray(issue?.labels)
          ? issue.labels.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
          : [];
        const runMode = issueLabels.includes("forgeops:quick") ? "quick" : "standard";
        const title = String(issue?.title ?? "").trim() || "未命名需求";
        const task = `[AUTO-ISSUE] 处理 GitHub Issue #${issueId}: ${title}`;
        try {
          const run = this.store.createRun({
            projectId: project.id,
            issueId,
            task,
            runMode,
          });
          createdRuns += 1;
          this.store.emitEvent(run.id, null, "scheduler.issue_autorun.run_created", {
            projectId: project.id,
            projectName: project.name,
            issueId,
            issueTitle: title,
            runId: run.id,
            task,
            runMode,
          });
        } catch (err) {
          this.store.emitEvent(null, null, "scheduler.issue_autorun.run_failed", {
            projectId: project.id,
            projectName: project.name,
            issueId,
            issueTitle: title,
            task,
            runMode,
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
