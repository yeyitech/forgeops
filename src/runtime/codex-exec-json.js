import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { extractJsonObject } from "../core/utils.js";

function normalizeStatus(value) {
  if (value === "done" || value === "retry" || value === "failed") {
    return value;
  }
  return null;
}

function normalizeResumeSession(input) {
  if (!input || typeof input !== "object") return null;
  const threadId = String(input.threadId ?? "").trim();
  if (!threadId) return null;
  return {
    sessionId: String(input.sessionId ?? "").trim(),
    threadId,
    turnId: String(input.turnId ?? "").trim(),
    reason: String(input.reason ?? "").trim(),
  };
}

function shouldFallbackFromResume(result) {
  if (!result || result.status !== "failed") return false;
  const summary = String(result.summary ?? "").toLowerCase();
  const stderr = String(result.runtime?.stderr ?? "").toLowerCase();
  const combined = `${summary}\n${stderr}`;
  if (
    combined.includes("no saved session found")
    || combined.includes("session not found")
    || combined.includes("could not find")
    || combined.includes("unknown session")
    || combined.includes("invalid session")
  ) {
    return true;
  }
  return !String(result.runtime?.turnId ?? "").trim();
}

async function writeOutputSchema(schema) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeops-schema-"));
  const filePath = path.join(dir, "schema.json");
  await fs.writeFile(filePath, JSON.stringify(schema, null, 2));
  return {
    filePath,
    async cleanup() {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export class CodexExecJsonRuntime {
  constructor(options = {}) {
    this.kind = "codex-exec-json";
    this.codexBin = options.codexBin ?? "codex";
    this.defaultModel = options.defaultModel ?? "gpt-5.3-codex";
    this.defaultSandbox = options.defaultSandbox ?? "danger-full-access";
    this.defaultApprovalPolicy = options.defaultApprovalPolicy ?? "never";
  }

  capabilities() {
    return ["code_read", "code_write", "shell_exec", "git_ops", "test_run"];
  }

  async runStep(params) {
    const prompt = String(params.prompt ?? "");
    const requestedModel = params.model ?? this.defaultModel;
    const sandboxMode = params.sandboxMode ?? this.defaultSandbox;
    const approvalPolicy = params.approvalPolicy ?? this.defaultApprovalPolicy;
    const resumeSession = normalizeResumeSession(params.resumeSession);

    const notify = (type, payload) => {
      if (typeof params.onRuntimeEvent === "function") {
        params.onRuntimeEvent({ type, payload });
      }
    };

    const executeOnce = async (mode, resume) => {
      const isResumeMode = mode === "resume" && Boolean(resume?.threadId);
      const schemaFile = isResumeMode
        ? null
        : await writeOutputSchema(params.outputSchema ?? {
            type: "object",
            additionalProperties: true,
          });

      const args = isResumeMode
        ? [
            "exec",
            "resume",
            "--json",
            "--all",
            "--skip-git-repo-check",
            "--config",
            `approval_policy=\"${approvalPolicy}\"`,
          ]
        : [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--cd",
            params.cwd,
            "--sandbox",
            sandboxMode,
            "--config",
            `approval_policy=\"${approvalPolicy}\"`,
            "--output-schema",
            schemaFile.filePath,
          ];

      if (requestedModel) {
        args.push("--model", requestedModel);
      }
      if (isResumeMode) {
        args.push(resume.threadId, "-");
      } else {
        args.push("-");
      }

      const child = spawn(this.codexBin, args, {
        cwd: params.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stderrChunks = [];
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          stderrChunks.push(String(chunk));
        });
      }

      let processPid = child.pid ?? null;
      let threadId = isResumeMode ? resume.threadId : null;
      let turnId = null;
      let turnStarted = false;
      let turnCompleted = false;
      let turnFailedMessage = null;
      let lastErrorMessage = null;
      let finalAgentMessage = "";
      let resumeNotified = false;
      let usage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      };

      if (isResumeMode) {
        notify("thread.resume.attempt", {
          threadId: resume.threadId,
          sourceSessionId: resume.sessionId || null,
          sourceTurnId: resume.turnId || null,
          reason: resume.reason || "",
        });
      }
      notify("runtime.process.started", { processPid, args });

      const stdoutRl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });

      const parseLine = (line) => {
        if (!line || !line.trim()) return;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }

        if (evt.type === "thread.started") {
          threadId = evt.thread_id ?? threadId;
          notify("thread.started", { threadId });
          return;
        }

        if (evt.type === "thread.resumed") {
          threadId = evt.thread_id ?? evt.threadId ?? threadId;
          notify("thread.resumed", { threadId });
          return;
        }

        if (evt.type === "turn.started") {
          turnStarted = true;
          turnId = evt.turn_id ?? evt.turnId ?? turnId;
          notify("turn.started", { threadId, turnId });
          if (isResumeMode && !resumeNotified) {
            resumeNotified = true;
            notify("thread.resumed", {
              threadId: threadId ?? resume.threadId,
              sourceSessionId: resume.sessionId || null,
              sourceTurnId: resume.turnId || null,
            });
          }
          return;
        }

        if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
          finalAgentMessage = evt.item.text ?? finalAgentMessage;
          notify("item.agent_message", {
            threadId,
            size: finalAgentMessage.length,
          });
          return;
        }

        if (evt.type === "turn.completed") {
          turnCompleted = true;
          usage = {
            inputTokens: Number(evt.usage?.input_tokens ?? 0),
            cachedInputTokens: Number(evt.usage?.cached_input_tokens ?? 0),
            outputTokens: Number(evt.usage?.output_tokens ?? 0),
            reasoningOutputTokens: 0,
            totalTokens: Number(evt.usage?.input_tokens ?? 0)
              + Number(evt.usage?.cached_input_tokens ?? 0)
              + Number(evt.usage?.output_tokens ?? 0),
          };
          notify("turn.completed", { threadId, usage });
          return;
        }

        if (evt.type === "turn.failed") {
          turnFailedMessage = evt.error?.message ?? "Turn failed";
          notify("turn.failed", { threadId, error: turnFailedMessage });
          return;
        }

        if (evt.type === "error") {
          lastErrorMessage = evt.message ?? lastErrorMessage;
          notify("runtime.error", { message: lastErrorMessage });
        }
      };

      try {
        child.stdin.write(prompt);
        child.stdin.end();

        const linesDone = new Promise((resolve) => {
          stdoutRl.on("line", parseLine);
          stdoutRl.on("close", resolve);
        });

        const exitDone = new Promise((resolve) => {
          child.once("exit", (code, signal) => {
            resolve({ code, signal });
          });
        });

        await Promise.all([linesDone, exitDone]);
        const exitResult = await exitDone;

        let structured = extractJsonObject(finalAgentMessage) ?? {};
        if (!structured || typeof structured !== "object") {
          structured = {};
        }

        const normalized = normalizeStatus(structured.status);
        let status = normalized ?? "failed";
        let summary = String(structured.summary ?? "");

        if (turnFailedMessage) {
          status = "failed";
          summary = turnFailedMessage;
        } else if (!turnCompleted && !normalized) {
          status = "failed";
          summary = lastErrorMessage ?? "Codex turn did not complete";
        } else if (!summary) {
          summary = status === "done" ? "Completed" : "Runtime returned non-success";
        }

        if (status === "done" && exitResult.code && exitResult.code !== 0 && !turnCompleted) {
          status = "failed";
          summary = `codex exited with code ${exitResult.code}`;
        }

        if (!turnStarted && !turnCompleted && !turnFailedMessage && !finalAgentMessage) {
          status = "failed";
          summary = summary || "No execution events received from codex";
        }

        return {
          status,
          summary,
          rawOutput: finalAgentMessage,
          structured,
          runtime: {
            processPid,
            threadId,
            turnId,
            requestedModel,
            effectiveModel: requestedModel,
            modelProvider: null,
            usage,
            stderr: stderrChunks.join(""),
            resumeAttempted: isResumeMode,
            resumeSucceeded: isResumeMode ? Boolean(turnStarted || turnCompleted) : false,
            resumedFromSessionId: isResumeMode ? (resume.sessionId || null) : null,
            resumedFromThreadId: isResumeMode ? resume.threadId : null,
          },
        };
      } catch (err) {
        return {
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
          rawOutput: finalAgentMessage,
          structured: null,
          runtime: {
            processPid,
            threadId,
            turnId,
            requestedModel,
            effectiveModel: requestedModel,
            modelProvider: null,
            usage,
            stderr: stderrChunks.join(""),
            resumeAttempted: isResumeMode,
            resumeSucceeded: false,
            resumedFromSessionId: isResumeMode ? (resume.sessionId || null) : null,
            resumedFromThreadId: isResumeMode ? resume.threadId : null,
          },
        };
      } finally {
        stdoutRl.close();
        try {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
        if (schemaFile) {
          await schemaFile.cleanup();
        }
      }
    };

    if (resumeSession?.threadId) {
      const resumedResult = await executeOnce("resume", resumeSession);
      if (!shouldFallbackFromResume(resumedResult)) {
        return resumedResult;
      }
      notify("thread.resume.failed", {
        threadId: resumeSession.threadId,
        sourceSessionId: resumeSession.sessionId || null,
        error: resumedResult.summary,
      });
    }

    const freshResult = await executeOnce("fresh", null);
    if (freshResult?.runtime) {
      freshResult.runtime.resumeAttempted = Boolean(resumeSession?.threadId);
      freshResult.runtime.resumeSucceeded = false;
      freshResult.runtime.resumedFromSessionId = resumeSession?.sessionId || null;
      freshResult.runtime.resumedFromThreadId = resumeSession?.threadId || null;
    }
    return freshResult;
  }
}
