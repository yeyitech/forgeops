import { spawn } from "node:child_process";
import { JsonRpcStdioClient } from "./jsonrpc-stdio.js";
import { extractJsonObject } from "../core/utils.js";

export class CodexAppServerRuntime {
  constructor(options = {}) {
    this.kind = "codex-app-server";
    this.codexBin = options.codexBin ?? "codex";
    this.defaultModel = options.defaultModel ?? "gpt-5.3-codex";
    this.defaultApproval = options.defaultApproval ?? "never";
    this.defaultSandbox = options.defaultSandbox ?? "danger-full-access";
  }

  capabilities() {
    return ["code_read", "code_write", "shell_exec", "git_ops", "test_run"];
  }

  async runStep(params) {
    const envOverrides = params?.env && typeof params.env === "object" ? params.env : null;
    const env = envOverrides
      ? Object.fromEntries(
          Object.entries({ ...process.env, ...envOverrides })
            .filter(([key]) => Boolean(key))
            .map(([key, value]) => [key, String(value ?? "")])
        )
      : process.env;
    const child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: params.cwd,
      env,
    });

    const stderr = [];
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr.push(String(chunk));
      });
    }

    const client = new JsonRpcStdioClient(child);
    const requestedModel = params.model ?? this.defaultModel;
    const resumeSession = params.resumeSession && typeof params.resumeSession === "object"
      ? {
          sessionId: String(params.resumeSession.sessionId ?? "").trim(),
          threadId: String(params.resumeSession.threadId ?? "").trim(),
          turnId: String(params.resumeSession.turnId ?? "").trim(),
          reason: String(params.resumeSession.reason ?? "").trim(),
        }
      : null;
    const resumeAttempted = Boolean(resumeSession?.threadId);
    let resumeSucceeded = false;

    let threadId = null;
    let turnId = null;
    let effectiveModel = requestedModel;
    let modelProvider = null;
    let lastAgentMessage = "";
    let turnStatus = "failed";
    let turnError = null;
    let usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      modelContextWindow: null,
    };

    const notify = (type, payload) => {
      if (typeof params.onRuntimeEvent === "function") {
        params.onRuntimeEvent({ type, payload });
      }
    };
    notify("runtime.process.started", { processPid: child.pid ?? null });

    try {
      await client.call("initialize", {
        clientInfo: {
          name: "forgeops",
          title: "ForgeOps",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [],
        },
      }, 30_000);
      client.notify("initialized");

      const unlisten = client.onNotification((msg) => {
        if (msg.method === "thread/started") {
          threadId = msg.params?.thread?.id ?? threadId;
          notify("thread.started", { threadId });
        }

        if (msg.method === "item/completed") {
          const item = msg.params?.item;
          if (item?.type === "agentMessage" && msg.params?.threadId === threadId) {
            lastAgentMessage = item.text ?? lastAgentMessage;
          }
        }

        if (msg.method === "thread/tokenUsage/updated") {
          const tokenUsage = msg.params?.tokenUsage;
          if (msg.params?.threadId === threadId && tokenUsage?.last) {
            usage = {
              inputTokens: Number(tokenUsage.last.inputTokens ?? usage.inputTokens ?? 0),
              cachedInputTokens: Number(tokenUsage.last.cachedInputTokens ?? usage.cachedInputTokens ?? 0),
              outputTokens: Number(tokenUsage.last.outputTokens ?? usage.outputTokens ?? 0),
              reasoningOutputTokens: Number(tokenUsage.last.reasoningOutputTokens ?? usage.reasoningOutputTokens ?? 0),
              totalTokens: Number(tokenUsage.last.totalTokens ?? usage.totalTokens ?? 0),
              modelContextWindow: tokenUsage.modelContextWindow ?? usage.modelContextWindow,
            };
            notify("thread.tokenUsage", { threadId, usage });
          }
        }

        if (msg.method === "model/rerouted") {
          if (msg.params?.threadId === threadId) {
            effectiveModel = msg.params?.toModel ?? effectiveModel;
            notify("model.rerouted", {
              fromModel: msg.params?.fromModel,
              toModel: msg.params?.toModel,
              reason: msg.params?.reason,
            });
          }
        }

        if (msg.method === "turn/completed") {
          if (msg.params?.threadId === threadId) {
            const turn = msg.params?.turn;
            turnStatus = turn?.status ?? turnStatus;
            turnId = turn?.id ?? turnId;
            if (turn?.status === "failed") {
              turnError = turn?.error?.message ?? "Turn failed";
            }
          }
        }

        if (msg.method === "error") {
          const payload = msg.params?.error;
          if (payload?.threadId === threadId) {
            turnError = payload?.error?.message ?? payload?.message ?? turnError;
            turnStatus = "failed";
          }
        }
      });

      const startThread = async () => {
        const threadStartRes = await client.call("thread/start", {
          model: requestedModel,
          modelProvider: null,
          cwd: params.cwd,
          approvalPolicy: params.approvalPolicy ?? this.defaultApproval,
          sandbox: params.sandboxMode ?? this.defaultSandbox,
          config: null,
          baseInstructions: null,
          developerInstructions: null,
          personality: "pragmatic",
          ephemeral: false,
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        }, 30_000);

        threadId = threadStartRes?.thread?.id ?? threadId;
        modelProvider = threadStartRes?.modelProvider ?? modelProvider;
        effectiveModel = threadStartRes?.model ?? effectiveModel;
        notify("thread.start.response", {
          threadId,
          model: effectiveModel,
          modelProvider,
        });
      };

      const startTurn = async () => {
        const turnRes = await client.call("turn/start", {
          threadId,
          input: [{ type: "text", text: params.prompt, text_elements: [] }],
          cwd: params.cwd,
          approvalPolicy: params.approvalPolicy ?? this.defaultApproval,
          sandboxPolicy: params.sandboxMode ?? this.defaultSandbox,
          model: requestedModel,
          effort: null,
          summary: "auto",
          personality: "pragmatic",
          outputSchema: params.outputSchema ?? null,
          collaborationMode: null,
        }, 30_000);

        turnId = turnRes?.turn?.id ?? turnId;
        notify("turn.started", { threadId, turnId });
      };

      if (resumeAttempted) {
        threadId = resumeSession.threadId;
        notify("thread.resume.attempt", {
          threadId: resumeSession.threadId,
          sourceSessionId: resumeSession.sessionId || null,
          sourceTurnId: resumeSession.turnId || null,
          reason: resumeSession.reason || "",
        });
        try {
          await startTurn();
          resumeSucceeded = true;
          notify("thread.resumed", {
            threadId,
            sourceSessionId: resumeSession.sessionId || null,
            sourceTurnId: resumeSession.turnId || null,
          });
        } catch (resumeErr) {
          notify("thread.resume.failed", {
            threadId: resumeSession.threadId,
            sourceSessionId: resumeSession.sessionId || null,
            error: resumeErr instanceof Error ? resumeErr.message : String(resumeErr),
          });
          threadId = null;
          turnId = null;
          await startThread();
          await startTurn();
        }
      } else {
        await startThread();
        await startTurn();
      }

      await this.#waitForTurnCompletion(client, {
        threadId,
        turnId,
        timeoutMs: params.timeoutMs ?? 20 * 60 * 1000,
      });

      unlisten();

      const parsed = extractJsonObject(lastAgentMessage);
      let status = "failed";
      let summary = "No summary";

      if (turnStatus === "completed") {
        if (parsed?.status === "done" || parsed?.status === "retry" || parsed?.status === "failed") {
          status = parsed.status;
        } else {
          status = "done";
        }
        summary = parsed?.summary ?? "Completed";
      } else if (turnStatus === "interrupted") {
        status = "retry";
        summary = "Interrupted";
      } else {
        status = "failed";
        summary = turnError ?? "Turn failed";
      }

      return {
        status,
        summary,
        rawOutput: lastAgentMessage,
        structured: parsed,
        runtime: {
          processPid: child.pid ?? null,
          threadId,
          turnId,
          requestedModel,
          effectiveModel,
          modelProvider,
          usage,
          stderr: stderr.join(""),
          resumeAttempted,
          resumeSucceeded,
          resumedFromSessionId: resumeAttempted ? (resumeSession.sessionId || null) : null,
          resumedFromThreadId: resumeAttempted ? resumeSession.threadId : null,
        },
      };
    } catch (err) {
      return {
        status: "failed",
        summary: err instanceof Error ? err.message : String(err),
        rawOutput: "",
        structured: null,
        runtime: {
          processPid: child.pid ?? null,
          threadId,
          turnId,
          requestedModel,
          effectiveModel,
          modelProvider,
          usage,
          stderr: stderr.join(""),
          resumeAttempted,
          resumeSucceeded: false,
          resumedFromSessionId: resumeAttempted ? (resumeSession.sessionId || null) : null,
          resumedFromThreadId: resumeAttempted ? resumeSession.threadId : null,
        },
      };
    } finally {
      await client.close();
    }
  }

  async #waitForTurnCompletion(client, opts) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let done = false;

      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        unlisten();
        reject(new Error("Turn completion timeout"));
      }, opts.timeoutMs);

      const unlisten = client.onNotification((msg) => {
        if (done) return;
        if (msg.method !== "turn/completed") return;
        if (msg.params?.threadId !== opts.threadId) return;
        if (opts.turnId && msg.params?.turn?.id !== opts.turnId) return;

        done = true;
        clearTimeout(timeout);
        unlisten();
        resolve({
          elapsedMs: Date.now() - startedAt,
        });
      });
    });
  }
}
