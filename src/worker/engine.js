import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createGitHubIssue } from "../core/git.js";
import { STEP_OUTPUT_SCHEMA } from "../core/workflow.js";
import { nowIso } from "../core/utils.js";

function toPlainError(err) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function normalizeRuntimeStatus(value) {
  if (value === "done" || value === "retry" || value === "failed") {
    return value;
  }
  return "failed";
}

function summarizeInvariantViolations(violations, limit = 3) {
  const list = Array.isArray(violations) ? violations : [];
  if (list.length === 0) {
    return "No violation details available";
  }
  return list
    .slice(0, limit)
    .map((item) => {
      const rule = String(item?.rule ?? "unknown-rule");
      const file = String(item?.file ?? "unknown-file");
      const line = Number(item?.line ?? 1);
      const message = String(item?.message ?? "violation");
      return `${rule} ${file}:${line} ${message}`;
    })
    .join(" | ");
}

function normalizeInvariantPolicy(config) {
  const policy = config && typeof config === "object" ? config.policy : null;
  const blockOn = Array.isArray(policy?.blockOn)
    ? policy.blockOn.map((item) => String(item).toLowerCase())
    : ["error"];
  const followup = policy && typeof policy.followup === "object"
    ? policy.followup
    : {};

  const maxItemsRaw = Number(followup.maxItems ?? 8);
  const maxItems = Number.isFinite(maxItemsRaw)
    ? Math.min(30, Math.max(1, Math.floor(maxItemsRaw)))
    : 8;

  return {
    blockOn,
    followup: {
      createGithubIssueOnWarnings: followup.createGithubIssueOnWarnings !== false,
      onlyAtStep: String(followup.onlyAtStep ?? "review").trim(),
      maxItems,
    },
  };
}

function renderFollowupIssueBody(step, parsed, warningList, cappedWarningList) {
  const lines = [];
  lines.push("## 背景");
  lines.push(`- run: \`${step.run_id}\``);
  lines.push(`- step: \`${step.step_key}\``);
  lines.push(`- project: \`${step.project_name}\``);
  if (step.worktree_branch) {
    lines.push(`- branch: \`${step.worktree_branch}\``);
  }
  lines.push(`- created_at: \`${nowIso()}\``);
  lines.push("");
  lines.push("## 不变量告警汇总");
  lines.push(`- files_checked: ${Number(parsed?.summary?.filesChecked ?? 0)}`);
  lines.push(`- warnings: ${warningList.length}`);
  lines.push("");
  lines.push("## Top 告警（可自动化修复优先）");

  if (cappedWarningList.length === 0) {
    lines.push("- 未获取到具体告警明细。");
  } else {
    for (const item of cappedWarningList) {
      const rule = String(item?.rule ?? "unknown-rule");
      const file = String(item?.file ?? "unknown-file");
      const line = Number(item?.line ?? 1);
      const message = String(item?.message ?? "warning");
      lines.push(`- [${rule}] \`${file}:${line}\` ${message}`);
      const hint = String(item?.hint ?? "").trim();
      if (hint) {
        lines.push(`  - hint: ${hint}`);
      }
    }
  }

  lines.push("");
  lines.push("## 建议");
  lines.push("- 以小步 PR 修复 warning，避免一次性大改。");
  lines.push("- 重复出现的 warning 需要升级为机械检查（lint/test/script）。");

  return lines.join("\n");
}

export class ForgeOpsEngine {
  constructor(params) {
    this.store = params.store;
    this.runtimeRegistry = params.runtimeRegistry;
    this.pollMs = Number(params.pollMs ?? 1500);
    this.concurrency = Number(params.concurrency ?? 2);
    this.timer = null;
    this.active = new Set();
    this.running = false;
    this.lastTickAt = null;
  }

  getState() {
    return {
      running: this.running,
      pollMs: this.pollMs,
      concurrency: this.concurrency,
      activeSessions: this.active.size,
      lastTickAt: this.lastTickAt,
      availableRuntimes: this.runtimeRegistry.list(),
    };
  }

  updateConfig(patch) {
    if (patch && Number.isFinite(Number(patch.concurrency))) {
      const nextConcurrency = Number(patch.concurrency);
      if (nextConcurrency > 0) {
        this.concurrency = nextConcurrency;
      }
    }
    if (patch && Number.isFinite(Number(patch.pollMs))) {
      const nextPollMs = Number(patch.pollMs);
      if (nextPollMs >= 200) {
        this.pollMs = nextPollMs;
      }
    }
    return this.getState();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const recovered = this.store.recoverOrphanedRunningSteps();
    if (recovered > 0) {
      this.store.emitEvent(null, null, "engine.recovered", {
        recoveredSteps: recovered,
      });
    }

    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      this.timer = setTimeout(loop, this.pollMs);
    };

    loop().catch((err) => {
      this.store.emitEvent(null, null, "engine.error", {
        message: toPlainError(err),
      });
      this.timer = setTimeout(loop, this.pollMs);
    });
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    this.lastTickAt = nowIso();
    if (!this.running) return;

    let slots = this.concurrency - this.active.size;
    while (slots > 0) {
      const step = this.store.claimNextPendingStep();
      if (!step) break;

      const task = this.#executeStep(step)
        .catch((err) => {
          this.store.emitEvent(step.run_id, step.id, "engine.step.error", {
            stepId: step.id,
            stepKey: step.step_key,
            error: toPlainError(err),
          });
        })
        .finally(() => {
          this.active.delete(step.id);
        });

      this.active.add(step.id);
      slots -= 1;
      void task;
    }
  }

  async #executeStep(step) {
    const runId = step.run_id;
    const stepId = step.id;
    const runtimeName = step.runtime || "codex-exec-json";
    const runtime = this.runtimeRegistry.get(runtimeName);

    this.store.emitEvent(runId, stepId, "step.dispatched", {
      stepId,
      stepKey: step.step_key,
      runtime: runtimeName,
      agentId: step.agent_id,
    });

    const resumeSession = this.store.getStepResumeSession(stepId, runtimeName);
    if (resumeSession?.threadId) {
      this.store.emitEvent(runId, stepId, "step.resume.requested", {
        stepId,
        stepKey: step.step_key,
        runtime: runtimeName,
        sessionId: resumeSession.sessionId,
        threadId: resumeSession.threadId,
        turnId: resumeSession.turnId || null,
        reason: resumeSession.reason,
      });
    }

    const sessionId = this.store.startSession({
      runId,
      stepId,
      runtime: runtimeName,
      requestedModel: step.requested_model,
    });

    let runtimeResult;
    try {
      runtimeResult = await runtime.runStep({
        cwd: step.root_path,
        prompt: step.input_text,
        model: step.requested_model,
        outputSchema: STEP_OUTPUT_SCHEMA,
        timeoutMs: 20 * 60 * 1000,
        resumeSession: resumeSession?.threadId ? resumeSession : null,
        onRuntimeEvent: (evt) => {
          this.store.emitEvent(runId, stepId, `runtime.${evt.type}`, evt.payload ?? {});
          if (evt.type === "runtime.process.started") {
            this.store.updateSession(sessionId, {
              processPid: evt.payload?.processPid ?? null,
            });
          } else if (evt.type === "thread.started" || evt.type === "thread.resumed") {
            this.store.updateSession(sessionId, {
              threadId: evt.payload?.threadId ?? null,
            });
          } else if (evt.type === "turn.started") {
            this.store.updateSession(sessionId, {
              turnId: evt.payload?.turnId ?? null,
            });
          }
        },
      });
    } catch (err) {
      runtimeResult = {
        status: "failed",
        summary: toPlainError(err),
        rawOutput: "",
        structured: null,
        runtime: {
          processPid: null,
          threadId: null,
          turnId: null,
          requestedModel: step.requested_model,
          effectiveModel: step.requested_model,
          modelProvider: null,
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          },
          stderr: "",
        },
      };
    }

    if (runtimeResult.runtime?.resumeAttempted) {
      this.store.emitEvent(runId, stepId, "step.resume.result", {
        stepId,
        stepKey: step.step_key,
        runtime: runtimeName,
        attempted: true,
        succeeded: Boolean(runtimeResult.runtime?.resumeSucceeded),
        resumedFromSessionId: runtimeResult.runtime?.resumedFromSessionId ?? null,
        resumedFromThreadId: runtimeResult.runtime?.resumedFromThreadId ?? null,
      });
    }

    this.store.updateSession(sessionId, {
      processPid: runtimeResult.runtime?.processPid ?? null,
      threadId: runtimeResult.runtime?.threadId ?? null,
      turnId: runtimeResult.runtime?.turnId ?? null,
      effectiveModel: runtimeResult.runtime?.effectiveModel ?? null,
      modelProvider: runtimeResult.runtime?.modelProvider ?? null,
      tokenInput: Number(runtimeResult.runtime?.usage?.inputTokens ?? 0),
      tokenCachedInput: Number(runtimeResult.runtime?.usage?.cachedInputTokens ?? 0),
      tokenOutput: Number(runtimeResult.runtime?.usage?.outputTokens ?? 0),
      tokenReasoningOutput: Number(runtimeResult.runtime?.usage?.reasoningOutputTokens ?? 0),
      status: runtimeResult.status === "done" ? "completed" : "failed",
      error: runtimeResult.status === "done" ? null : runtimeResult.summary,
      endedAt: nowIso(),
    });

    const status = normalizeRuntimeStatus(runtimeResult.status);

    if (status === "done") {
      if (
        step.step_key === "implement"
        || step.step_key === "test"
        || step.step_key === "platform-smoke"
        || step.step_key === "review"
      ) {
        const checkerPath = path.join(step.root_path, ".forgeops", "tools", "check-invariants.mjs");
        if (fs.existsSync(checkerPath)) {
          const checkResult = spawnSync("node", [checkerPath, "--format", "json"], {
            cwd: step.root_path,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });

          const parsed = (() => {
            try {
              return JSON.parse(String(checkResult.stdout ?? "{}"));
            } catch {
              return null;
            }
          })();

          const policy = normalizeInvariantPolicy(step.context?.projectInvariants ?? null);
          const errors = Number(parsed?.summary?.errors ?? 0);
          const warnings = Number(parsed?.summary?.warnings ?? 0);
          const violations = Array.isArray(parsed?.violations) ? parsed.violations : [];
          const warningList = violations.filter((item) => String(item?.severity ?? "warn") !== "error");
          const warningSummary = summarizeInvariantViolations(warningList);
          const blockOnWarn = policy.blockOn.includes("warn") || policy.blockOn.includes("warning");

          this.store.emitEvent(runId, stepId, "invariants.checked", {
            stepKey: step.step_key,
            ok: checkResult.status === 0,
            errors,
            warnings,
          });

          if (checkResult.status !== 0) {
            const detail = summarizeInvariantViolations(parsed?.violations ?? []);
            const reason = `Invariant check failed: ${detail}`;
            this.store.emitEvent(runId, stepId, "invariants.failed", {
              stepKey: step.step_key,
              error: reason,
              stderr: String(checkResult.stderr ?? "").trim(),
            });
            this.store.retryOrFailStep({
              stepId,
              error: reason,
            });
            return;
          }

          if (warnings > 0 && blockOnWarn) {
            const reason = `Invariant check failed: warning policy blocks merge (${warningSummary})`;
            this.store.emitEvent(runId, stepId, "invariants.failed", {
              stepKey: step.step_key,
              error: reason,
            });
            this.store.retryOrFailStep({
              stepId,
              error: reason,
            });
            return;
          }

          const onlyAtStep = policy.followup.onlyAtStep;
          const shouldCreateFollowupIssue = warnings > 0
            && policy.followup.createGithubIssueOnWarnings
            && (!onlyAtStep || onlyAtStep === step.step_key);

          if (shouldCreateFollowupIssue && !this.store.hasRunEvent(runId, "followup.issue.created", stepId)) {
            const cappedWarnings = warningList.slice(0, policy.followup.maxItems);
            const title = `[ForgeOps][${step.project_name}] run ${runId} invariant warnings (${warnings})`;
            const body = renderFollowupIssueBody(step, parsed, warningList, cappedWarnings);
            const issue = createGitHubIssue({
              repoRootPath: step.root_path,
              title,
              body,
            });

            if (issue.created) {
              this.store.emitEvent(runId, stepId, "followup.issue.created", {
                stepKey: step.step_key,
                warnings,
                repo: issue.repo,
                issueUrl: issue.url,
              });
              this.store.addArtifact({
                runId,
                stepId,
                kind: "followup_issue",
                title: "Invariant warnings follow-up",
                content: body,
                path: issue.url,
              });
            } else {
              this.store.emitEvent(runId, stepId, "followup.issue.failed", {
                stepKey: step.step_key,
                warnings,
                error: issue.error ?? "unknown",
              });
            }
          }
        }
      }

      if (step.step_key === "cleanup") {
        const docChecks = [
          {
            key: "docs.freshness",
            scriptPath: path.join(step.root_path, "scripts", "check-doc-freshness.js"),
          },
          {
            key: "docs.structure",
            scriptPath: path.join(step.root_path, "scripts", "check-doc-structure.js"),
          },
        ];

        for (const check of docChecks) {
          if (!fs.existsSync(check.scriptPath)) {
            continue;
          }
          const checkResult = spawnSync("node", [check.scriptPath], {
            cwd: step.root_path,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });

          if (checkResult.status !== 0) {
            const detail = String(checkResult.stdout ?? "").trim()
              || String(checkResult.stderr ?? "").trim()
              || `${check.key} failed`;
            this.store.emitEvent(runId, stepId, "docs.check.failed", {
              key: check.key,
              error: detail,
            });
            this.store.retryOrFailStep({
              stepId,
              error: `${check.key} failed: ${detail}`,
            });
            return;
          }

          this.store.emitEvent(runId, stepId, "docs.check.passed", {
            key: check.key,
          });
        }
      }

      this.store.completeStep({
        stepId,
        outputText: runtimeResult.rawOutput,
        structured: runtimeResult.structured ?? {
          status: "done",
          summary: runtimeResult.summary,
        },
        requestedModel: runtimeResult.runtime?.requestedModel,
        effectiveModel: runtimeResult.runtime?.effectiveModel,
        modelProvider: runtimeResult.runtime?.modelProvider,
        tokens: runtimeResult.runtime?.usage ?? {},
      });
      return;
    }

    const retryError = runtimeResult.summary || "Step failed";
    this.store.retryOrFailStep({
      stepId,
      error: retryError,
    });
  }
}
