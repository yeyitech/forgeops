import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";
import { runDoctor } from "../core/doctor.js";
import { resolveRunAttachContext } from "../core/run-attach.js";
import { findCodexSessionJsonlForThread, readTailTextFile, resolveManagedCodexHome } from "../core/codex-session-log.js";
import { buildCodexResumeShellCommand, launchTerminalCommand } from "../core/terminal-launcher.js";
import { readSystemConfig, updateSystemConfig } from "../core/system-config.js";
import { initProjectScaffold } from "../core/project-init.js";
import { normalizeProductType } from "../core/product-type.js";
import { loadSchedulerConfig, updateSchedulerConfig } from "../core/scheduler-config.js";
import { DEFAULT_WORKFLOW_CONFIG, buildWorkflowYaml, loadWorkflowConfig, writeWorkflowConfigYaml } from "../core/workflow-config.js";

function sendJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function sendText(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunks.reduce((a, b) => a + b.length, 0) > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function getStaticCandidatePaths(baseDir, pathname) {
  const clean = pathname === "/" ? "index.html" : String(pathname).replace(/^\/+/, "");
  const candidates = [];
  candidates.push(path.join(baseDir, clean));
  if (clean.endsWith("/")) {
    candidates.push(path.join(baseDir, clean, "index.html"));
  }
  return candidates;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function isLoopbackAddress(address) {
  const text = String(address ?? "").trim().toLowerCase();
  if (!text) return false;
  if (text === "127.0.0.1" || text === "::1" || text === "::ffff:127.0.0.1") return true;
  if (text.startsWith("127.")) return true;
  return false;
}

function toAppleScriptString(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

function resolveDirectoryPickerStartPath(rawPath) {
  const text = String(rawPath ?? "").trim();
  if (!text || text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return path.resolve(text);
}

function parseRunModeInput(value, fallback = "quick") {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === "standard" || text === "quick") return text;
  throw new Error(`Invalid run mode: ${text}`);
}

function pickDirectoryWithNativeDialog(startPath) {
  const resolvedStart = resolveDirectoryPickerStartPath(startPath);
  const validStart = fs.existsSync(resolvedStart) && fs.statSync(resolvedStart).isDirectory()
    ? resolvedStart
    : os.homedir();

  if (process.platform !== "darwin") {
    throw new Error(`Directory picker is not supported on platform: ${process.platform}`);
  }

  const scriptLines = [
    `set defaultPosixPath to ${toAppleScriptString(validStart)}`,
    "set chosenFolder to choose folder with prompt \"选择项目根路径\" default location (POSIX file defaultPosixPath)",
    "POSIX path of chosenFolder",
  ];

  const args = [];
  for (const line of scriptLines) {
    args.push("-e", line);
  }

  const launched = spawnSync("osascript", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (launched.error) {
    const message = launched.error instanceof Error ? launched.error.message : String(launched.error);
    throw new Error(`Failed to open directory picker: ${message}`);
  }

  if (launched.status !== 0) {
    const detail = String(launched.stderr ?? launched.stdout ?? "").trim();
    if (/user canceled|error number -128/i.test(detail)) {
      return {
        cancelled: true,
        path: "",
        startPath: validStart,
      };
    }
    throw new Error(`Failed to open directory picker: ${detail || `exit=${launched.status}`}`);
  }

  const selectedPath = String(launched.stdout ?? "").trim();
  return {
    cancelled: false,
    path: selectedPath,
    startPath: validStart,
  };
}

export function createServerApp(params) {
  const store = params.store;
  const engine = params.engine;
  const scheduler = params.scheduler ?? null;
  const host = params.host ?? "127.0.0.1";
  const port = Number(params.port ?? 4173);

  const publicDir = path.resolve(params.publicDir ?? path.join(process.cwd(), "public"));
  const frontendDistDir = path.resolve(params.frontendDistDir ?? path.join(process.cwd(), "frontend", "dist"));

  const sseClients = new Set();
  const projectCreateSseClients = new Set();
  const projectCreateEvents = new Map();
  const PROJECT_CREATE_EVENT_LIMIT = 200;
  let projectCreateEventSeq = 0;

  const pushSse = (event, row) => {
    const data = JSON.stringify({
      id: row.id,
      ts: row.ts,
      runId: row.run_id,
      stepId: row.step_id,
      eventType: row.event_type,
      payload: row.payload,
    });

    for (const client of sseClients) {
      if (client.runId && client.runId !== row.run_id) continue;
      if (row.id <= client.sinceId) continue;
      client.res.write(`id: ${row.id}\n`);
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${data}\n\n`);
      client.sinceId = row.id;
    }
  };

  const eventListener = (evt) => {
    const row = {
      id: Number(evt.id ?? 0),
      ts: evt.ts,
      run_id: evt.runId,
      step_id: evt.stepId,
      event_type: evt.eventType,
      payload: evt.payload,
    };
    pushSse("event", row);
  };

  const pushProjectCreateEvent = (sessionId, status, payload) => {
    const sid = String(sessionId ?? "").trim();
    if (!sid) return;

    const row = {
      id: ++projectCreateEventSeq,
      sessionId: sid,
      status: String(status ?? "progress"),
      stage: String(payload?.stage ?? ""),
      detail: String(payload?.detail ?? ""),
      at: String(payload?.at ?? new Date().toISOString()),
    };

    const cachedRows = projectCreateEvents.get(sid) ?? [];
    cachedRows.push(row);
    if (cachedRows.length > PROJECT_CREATE_EVENT_LIMIT) {
      cachedRows.shift();
    }
    projectCreateEvents.set(sid, cachedRows);

    for (const client of projectCreateSseClients) {
      if (client.sessionId !== sid) continue;
      if (row.id <= client.sinceId) continue;
      client.res.write(`id: ${row.id}\n`);
      client.res.write("event: project-create-progress\n");
      client.res.write(`data: ${JSON.stringify(row)}\n\n`);
      client.sinceId = row.id;
    }
  };

  store.events.on("event", eventListener);

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", `http://${host}:${port}`);
      const pathname = parsedUrl.pathname;

      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          engine: engine.getState(),
          scheduler: scheduler ? scheduler.getState() : null,
          dbPath: store.getDbPath(),
          now: new Date().toISOString(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/engine") {
        sendJson(res, 200, {
          ...engine.getState(),
          scheduler: scheduler ? scheduler.getState() : null,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/doctor") {
        sendJson(res, 200, {
          data: runDoctor(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/system/config") {
        const cfg = readSystemConfig();
        sendJson(res, 200, {
          ...cfg,
          data: cfg,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/system/token-usage") {
        sendJson(res, 200, {
          data: store.getGlobalTokenUsageMetrics({ trendDays: 7 }),
        });
        return;
      }

      if (method === "PUT" && pathname === "/api/system/config") {
        const body = await readJsonBody(req);
        try {
          const saved = updateSystemConfig(body ?? {});
          sendJson(res, 200, {
            ...saved,
            data: saved,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[system-config] update failed: ${message}`);
          if (message.startsWith("系统配置失败:")) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === "POST" && pathname === "/api/system/pick-directory") {
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: "Only localhost can open native directory picker." });
          return;
        }
        const body = await readJsonBody(req);
        try {
          const picked = pickDirectoryWithNativeDialog(body?.startPath);
          sendJson(res, 200, {
            data: picked,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: message });
        }
        return;
      }

      if (method === "POST" && pathname === "/api/engine") {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.concurrency !== undefined) {
          const value = Number(body.concurrency);
          if (!Number.isFinite(value) || value <= 0) {
            sendJson(res, 400, { error: "concurrency must be a positive number" });
            return;
          }
          patch.concurrency = value;
        }
        if (body.pollMs !== undefined) {
          const value = Number(body.pollMs);
          if (!Number.isFinite(value) || value < 200) {
            sendJson(res, 400, { error: "pollMs must be a number >= 200" });
            return;
          }
          patch.pollMs = value;
        }
        sendJson(res, 200, {
          ...engine.updateConfig(patch),
          scheduler: scheduler ? scheduler.getState() : null,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/projects") {
        sendJson(res, 200, {
          data: store.listProjects(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/projects/create/stream") {
        const sessionId = String(parsedUrl.searchParams.get("sessionId") ?? "").trim();
        if (!sessionId) {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }
        const sinceId = Number(parsedUrl.searchParams.get("sinceId") ?? "0") || 0;

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });

        const client = {
          res,
          sessionId,
          sinceId,
          heartbeat: null,
        };
        projectCreateSseClients.add(client);

        const replayRows = projectCreateEvents.get(sessionId) ?? [];
        for (const row of replayRows) {
          if (row.id <= sinceId) continue;
          res.write(`id: ${row.id}\n`);
          res.write("event: project-create-progress\n");
          res.write(`data: ${JSON.stringify(row)}\n\n`);
          client.sinceId = row.id;
        }

        client.heartbeat = setInterval(() => {
          res.write(`event: ping\ndata: {"now":"${new Date().toISOString()}"}\n\n`);
        }, 15000);

        req.on("close", () => {
          if (client.heartbeat) clearInterval(client.heartbeat);
          projectCreateSseClients.delete(client);
        });
        return;
      }

      if (method === "POST" && pathname === "/api/projects") {
        const body = await readJsonBody(req);
        if (!body.name || !body.rootPath || !body.productType) {
          sendJson(res, 400, { error: "name, rootPath, productType are required" });
          return;
        }
        const productType = normalizeProductType(body.productType);
        if (!productType) {
          sendJson(res, 400, {
            error: "productType must be one of: web, miniapp, ios, microservice, android, serverless, other",
          });
          return;
        }
        const createSessionId = String(body.createSessionId ?? "").trim();
        try {
          const rootPath = path.resolve(String(body.rootPath));
          if (createSessionId) {
            pushProjectCreateEvent(createSessionId, "progress", {
              stage: "request.accepted",
              detail: "已接收创建请求，开始初始化脚手架。",
              at: new Date().toISOString(),
            });
          }
          const scaffold = initProjectScaffold({
            name: String(body.name),
            rootPath,
            productType,
            problemStatement: String(body.problemStatement ?? ""),
            language: String(body.language ?? ""),
            frontendStack: String(body.frontendStack ?? ""),
            backendStack: String(body.backendStack ?? ""),
            ciProvider: String(body.ciProvider ?? ""),
            githubRepo: body.githubRepo ? String(body.githubRepo) : null,
            githubVisibility: body.githubVisibility === "public" ? "public" : "private",
            branchProtection: body.branchProtection !== false,
            onProgress: createSessionId
              ? (evt) => {
                  pushProjectCreateEvent(createSessionId, "progress", evt);
                }
              : null,
          });
          const resolvedGithubRepo = String(scaffold?.git?.remoteSlug ?? body.githubRepo ?? "").trim();

          const existing = store.getProjectByRootPath(rootPath);
          const createdOrExisting = existing ?? store.createProject({
            name: String(body.name),
            rootPath,
            productType,
            githubRepo: resolvedGithubRepo,
            problemStatement: String(body.problemStatement ?? ""),
          });
          const project = resolvedGithubRepo
            ? (store.setProjectGitHubRepo(createdOrExisting.id, resolvedGithubRepo) ?? createdOrExisting)
            : createdOrExisting;
          if (createSessionId) {
            pushProjectCreateEvent(createSessionId, "done", {
              stage: "project.done",
              detail: existing
                ? `项目已存在，复用 projectId=${project.id}`
                : `项目创建完成，projectId=${project.id}`,
              at: new Date().toISOString(),
            });
            setTimeout(() => {
              projectCreateEvents.delete(createSessionId);
            }, 2 * 60 * 1000);
          }
          sendJson(res, existing ? 200 : 201, {
            data: project,
            scaffold,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (createSessionId) {
            pushProjectCreateEvent(createSessionId, "error", {
              stage: "project.failed",
              detail: message,
              at: new Date().toISOString(),
            });
            setTimeout(() => {
              projectCreateEvents.delete(createSessionId);
            }, 5 * 60 * 1000);
          }
          if (
            message.startsWith("Git 初始化失败:")
            || message.startsWith("GitHub flow precheck failed:")
            || message.startsWith("Product toolchain precheck failed")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      const projectIssuesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/issues$/);
      const projectMetricsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/metrics$/);
      const projectSchedulerMatch = pathname.match(/^\/api\/projects\/([^/]+)\/scheduler$/);
      const projectWorkflowMatch = pathname.match(/^\/api\/projects\/([^/]+)\/workflow$/);
      const projectSkillCandidatesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/skills\/candidates$/);
      const projectSkillResolveMatch = pathname.match(/^\/api\/projects\/([^/]+)\/skills\/resolve$/);
      const projectSkillPromoteMatch = pathname.match(/^\/api\/projects\/([^/]+)\/skills\/promote$/);

      if (method === "GET" && pathname === "/api/skills/global") {
        sendJson(res, 200, {
          data: store.getUserGlobalSkillsStatus(),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/skills/global/promote") {
        const body = await readJsonBody(req);
        if (!body.projectId) {
          sendJson(res, 400, { error: "projectId is required" });
          return;
        }
        if (!body.candidate && !body.candidatePath) {
          sendJson(res, 400, { error: "candidate is required" });
          return;
        }
        try {
          const result = store.promoteSkillCandidateToUserGlobal({
            projectId: String(body.projectId),
            candidate: String(body.candidate ?? body.candidatePath ?? ""),
            skillName: String(body.skillName ?? body.name ?? ""),
            description: String(body.description ?? ""),
            baseRef: String(body.baseRef ?? ""),
            draft: body.draft !== false,
          });
          sendJson(res, 201, { data: result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Project not found:")
            || message.startsWith("candidate is required")
            || message.startsWith("skillName is required")
            || message.startsWith("Skill candidate not found:")
            || message.startsWith("Skill candidate path must be under")
            || message.startsWith("User-global skills repo is not initialized:")
            || message.startsWith("GitHub flow precheck failed:")
            || message.startsWith("创建 worktree 失败:")
            || message.startsWith("GitHub PR 创建失败")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (projectMetricsMatch && method === "GET") {
        const projectId = decodeURIComponent(projectMetricsMatch[1]);
        const metrics = store.getProjectMetrics(projectId);
        if (!metrics) {
          sendJson(res, 404, { error: "Project not found" });
          return;
        }
        sendJson(res, 200, { data: metrics });
        return;
      }

      if (projectSchedulerMatch && method === "GET") {
        const projectId = decodeURIComponent(projectSchedulerMatch[1]);
        const project = store.getProject(projectId);
        if (!project) {
          sendJson(res, 404, { error: "Project not found" });
          return;
        }
        const loaded = loadSchedulerConfig(project.root_path);
        sendJson(res, 200, {
          data: loaded.config,
          path: loaded.path,
          source: loaded.source,
        });
        return;
      }

      if (projectSchedulerMatch && method === "PUT") {
        const projectId = decodeURIComponent(projectSchedulerMatch[1]);
        const project = store.getProject(projectId);
        if (!project) {
          sendJson(res, 404, { error: "Project not found" });
          return;
        }
        const body = await readJsonBody(req);
        const saved = updateSchedulerConfig(project.root_path, body ?? {});
        if (scheduler) {
          await scheduler.syncNow();
        }
        sendJson(res, 200, {
          data: saved.config,
          path: saved.path,
        });
        return;
      }

      if (projectWorkflowMatch && method === "GET") {
        const projectId = decodeURIComponent(projectWorkflowMatch[1]);
        const project = store.getProject(projectId);
        if (!project) {
          sendJson(res, 404, { error: "Project not found" });
          return;
        }
        const loaded = loadWorkflowConfig(project.root_path);
        sendJson(res, 200, { data: loaded });
        return;
      }

      if (projectWorkflowMatch && method === "PUT") {
        const projectId = decodeURIComponent(projectWorkflowMatch[1]);
        const project = store.getProject(projectId);
        if (!project) {
          sendJson(res, 404, { error: "Project not found" });
          return;
        }
        const body = await readJsonBody(req);
        const resetDefault = body && body.resetDefault === true;
        const yamlText = resetDefault
          ? buildWorkflowYaml(DEFAULT_WORKFLOW_CONFIG)
          : String(body?.yaml ?? "");
        if (!yamlText.trim()) {
          sendJson(res, 400, { error: "yaml is required (or set resetDefault=true)" });
          return;
        }

        try {
          const saved = writeWorkflowConfigYaml(project.root_path, yamlText);
          sendJson(res, 200, { data: saved });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Invalid workflow config:")
            || message.includes("workflow yaml cannot be empty")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (projectSkillCandidatesMatch && method === "GET") {
        const projectId = decodeURIComponent(projectSkillCandidatesMatch[1]);
        try {
          sendJson(res, 200, {
            data: store.listSkillCandidates(projectId),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Project not found:")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (projectSkillResolveMatch && method === "GET") {
        const projectId = decodeURIComponent(projectSkillResolveMatch[1]);
        try {
          sendJson(res, 200, {
            data: store.resolveProjectSkills(projectId),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Project not found:")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (projectSkillPromoteMatch && method === "POST") {
        const projectId = decodeURIComponent(projectSkillPromoteMatch[1]);
        const body = await readJsonBody(req);
        if (!body.candidate && !body.candidatePath) {
          sendJson(res, 400, { error: "candidate is required" });
          return;
        }
        try {
          const result = store.promoteSkillCandidate({
            projectId,
            candidate: String(body.candidate ?? body.candidatePath ?? ""),
            skillName: String(body.skillName ?? body.name ?? ""),
            description: String(body.description ?? ""),
            roles: body.roles,
            baseRef: String(body.baseRef ?? ""),
            draft: body.draft !== false,
          });
          sendJson(res, 201, { data: result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Project not found:")
            || message.startsWith("candidate is required")
            || message.startsWith("skillName is required")
            || message.startsWith("Skill candidate not found:")
            || message.startsWith("Skill candidate path must be under")
            || message.startsWith("GitHub flow precheck failed:")
            || message.startsWith("创建 worktree 失败:")
            || message.startsWith("GitHub PR 创建失败")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (projectIssuesMatch && method === "GET") {
        const projectId = decodeURIComponent(projectIssuesMatch[1]);
        try {
          sendJson(res, 200, {
            data: store.listIssues(projectId),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Project not found:")
            || message.startsWith("GitHub flow precheck failed:")
            || message.startsWith("GitHub issue 列表读取失败")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (projectIssuesMatch && method === "POST") {
        const projectId = decodeURIComponent(projectIssuesMatch[1]);
        const body = await readJsonBody(req);
        if (!body.title) {
          sendJson(res, 400, { error: "title is required" });
          return;
        }
        try {
          const runMode = parseRunModeInput(body.runMode, "quick");
          const labels = Array.isArray(body.labels)
            ? body.labels.map((item) => String(item ?? "").trim()).filter(Boolean)
            : [];
          if (runMode === "quick" && !labels.some((item) => item.toLowerCase() === "forgeops:quick")) {
            labels.push("forgeops:quick");
          }
          if (runMode === "standard" && !labels.some((item) => item.toLowerCase() === "forgeops:standard")) {
            labels.push("forgeops:standard");
          }
          const created = store.createIssueWithAutoRun({
            projectId,
            title: String(body.title),
            description: String(body.description ?? ""),
            autoRun: body.autoRun !== false,
            runMode,
            labels,
          });
          sendJson(res, 201, {
            data: created.issue,
            run: created.run,
            autoRun: {
              enabled: created.auto_run_enabled,
              error: created.auto_run_error,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Project not found:")
            || message.startsWith("GitHub flow precheck failed:")
            || message.startsWith("创建 GitHub issue 失败")
            || message.startsWith("title is required")
            || message.startsWith("Invalid run mode:")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === "GET" && pathname === "/api/runs") {
        const projectId = parsedUrl.searchParams.get("projectId");
        sendJson(res, 200, {
          data: store.listRuns(projectId),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/runs") {
        const body = await readJsonBody(req);
        if (!body.projectId || !body.issueId) {
          sendJson(res, 400, { error: "projectId and issueId are required" });
          return;
        }
        let run;
        try {
          run = store.createRun({
            projectId: String(body.projectId),
            issueId: String(body.issueId),
            task: body.task === undefined || body.task === null
              ? ""
              : String(body.task),
            runMode: parseRunModeInput(body.runMode, "quick"),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.startsWith("Project not found:")
            || message.startsWith("GitHub issue is required to create run")
            || message.startsWith("GitHub issue not found in project:")
            || message.startsWith("Invalid GitHub issue ref:")
            || message.startsWith("Invalid workflow config:")
            || message.startsWith("GitHub flow precheck failed:")
            || message.startsWith("创建 worktree 失败:")
            || message.startsWith("Invalid run mode:")
          ) {
            sendJson(res, 400, { error: message });
            return;
          }
          throw err;
        }
        sendJson(res, 201, { data: run });
        return;
      }

      if (method === "POST" && pathname === "/api/runs/stop-all") {
        const body = await readJsonBody(req);
        const result = store.stopRuns({
          projectId: body?.projectId,
        });
        sendJson(res, 200, { data: result });
        return;
      }

      if (method === "POST" && pathname === "/api/runs/resume-all") {
        const body = await readJsonBody(req);
        const result = store.resumePausedRuns({
          projectId: body?.projectId,
        });
        sendJson(res, 200, { data: result });
        return;
      }

      const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runDetailMatch && method === "GET") {
        const runId = decodeURIComponent(runDetailMatch[1]);
        const detail = store.getRunDetails(runId);
        if (!detail) {
          sendJson(res, 404, { error: "Run not found" });
          return;
        }
        sendJson(res, 200, { data: detail });
        return;
      }

      const runSessionsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/sessions$/);
      if (runSessionsMatch && method === "GET") {
        const runId = decodeURIComponent(runSessionsMatch[1]);
        const stepKey = String(parsedUrl.searchParams.get("stepKey") ?? "").trim();
        const status = String(parsedUrl.searchParams.get("status") ?? "").trim();
        const requireThread = String(parsedUrl.searchParams.get("withThread") ?? "").trim() === "true";

        const run = store.getRun(runId);
        if (!run) {
          sendJson(res, 404, { error: "Run not found" });
          return;
        }

        const rows = store.listRunSessions(runId, { stepKey, status });
        const filtered = requireThread
          ? rows.filter((row) => String(row.thread_id ?? "").trim().length > 0)
          : rows;
        sendJson(res, 200, { data: { runId, sessions: filtered } });
        return;
      }

      const sessionLogMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/log$/);
      if (sessionLogMatch && method === "GET") {
        const sessionId = decodeURIComponent(sessionLogMatch[1]);
        const maxLines = Number(parsedUrl.searchParams.get("lines") ?? "400") || 400;
        const maxBytes = Number(parsedUrl.searchParams.get("maxBytes") ?? `${1024 * 1024}`) || (1024 * 1024);

        const details = store.getSessionDetails(sessionId);
        if (!details) {
          sendJson(res, 404, { error: "Session not found" });
          return;
        }

        const threadId = String(details.thread_id ?? "").trim();
        if (!threadId) {
          sendJson(res, 400, { error: "Session has no thread_id yet" });
          return;
        }

        const worktreePath = String(details.worktree_path ?? "").trim();
        if (!worktreePath || !fs.existsSync(worktreePath)) {
          sendJson(res, 400, { error: "Worktree not found (run may be archived)" });
          return;
        }

        const codexHome = resolveManagedCodexHome(worktreePath);
        const located = findCodexSessionJsonlForThread({ codexHome, threadId });
        if (!located.ok) {
          sendJson(res, 404, { error: located.error });
          return;
        }

        const tail = readTailTextFile({
          filePath: located.path,
          maxLines,
          maxBytes,
        });
        if (!tail.ok) {
          sendJson(res, 400, { error: tail.error });
          return;
        }

        sendJson(res, 200, {
          data: {
            sessionId,
            runId: String(details.run_id ?? ""),
            stepId: String(details.step_id ?? ""),
            stepKey: String(details.step_key ?? ""),
            agentId: String(details.agent_id ?? ""),
            threadId,
            worktreePath,
            codexHome,
            logPath: located.path,
            truncated: Boolean(tail.truncated),
            content: tail.content,
          },
        });
        return;
      }

      const runResumeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/resume$/);
      if (runResumeMatch && method === "POST") {
        const runId = decodeURIComponent(runResumeMatch[1]);
        const ok = store.resumeRun(runId);
        if (!ok) {
          sendJson(res, 400, { error: "Run cannot be resumed" });
          return;
        }
        sendJson(res, 200, { data: { ok: true } });
        return;
      }

      const runStopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
      if (runStopMatch && method === "POST") {
        const runId = decodeURIComponent(runStopMatch[1]);
        const ok = store.stopRun(runId);
        if (!ok) {
          sendJson(res, 400, { error: "Run cannot be stopped" });
          return;
        }
        sendJson(res, 200, { data: { ok: true } });
        return;
      }

      const runAttachTerminalMatch = pathname.match(/^\/api\/runs\/([^/]+)\/attach-terminal$/);
      if (runAttachTerminalMatch && method === "POST") {
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: "Only localhost can open terminal windows." });
          return;
        }

        const runId = decodeURIComponent(runAttachTerminalMatch[1]);
        const body = await readJsonBody(req);
        const resolved = resolveRunAttachContext(store, runId, {
          stepKey: body?.stepKey,
          sessionId: body?.sessionId,
          threadId: body?.threadId,
        });
        if (!resolved.ok) {
          const statusCode = resolved.code === "RUN_NOT_FOUND" ? 404 : 400;
          sendJson(res, statusCode, { error: resolved.error });
          return;
        }

        try {
          const codexBin = String(process.env.FORGEOPS_CODEX_BIN ?? "codex").trim() || "codex";
          const threadId = String(resolved.selected.threadId ?? "").trim();
          const managedCodexHome = path.join(resolved.attachCwd, ".forgeops-runtime", "codex-home");
          const managedOsHome = path.join(resolved.attachCwd, ".forgeops-runtime", "home");
          const useManagedEnv = fs.existsSync(managedCodexHome) && fs.statSync(managedCodexHome).isDirectory();
          const envPrefix = useManagedEnv
            ? {
                CODEX_HOME: managedCodexHome,
                CODEX_SQLITE_HOME: managedCodexHome,
                HOME: managedOsHome,
                USERPROFILE: managedOsHome,
                XDG_CONFIG_HOME: path.join(managedOsHome, ".config"),
                XDG_CACHE_HOME: path.join(managedOsHome, ".cache"),
                XDG_DATA_HOME: path.join(managedOsHome, ".local", "share"),
              }
            : null;
          const shellCommand = buildCodexResumeShellCommand(codexBin, threadId, resolved.attachCwd, envPrefix);
          const launch = launchTerminalCommand({
            cwd: resolved.attachCwd,
            command: shellCommand,
          });

          const notices = [];
          if (resolved.details.run.status === "running") {
            notices.push("Run is still running. Observe only; avoid sending new prompts.");
          }
          if (resolved.attachNotice) {
            notices.push(resolved.attachNotice);
          }
          const notice = notices.join(" ");

          sendJson(res, 200, {
            data: {
              ok: true,
              runId: resolved.runId,
              threadId,
              sessionId: resolved.selected.session?.id ?? null,
              stepKey: resolved.selected.step?.step_key ?? null,
              cwd: resolved.attachCwd,
              command: shellCommand,
              terminal: launch.terminal,
              platform: launch.platform,
              notice,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: message });
        }
        return;
      }

      if (method === "GET" && pathname === "/api/events") {
        const runId = parsedUrl.searchParams.get("runId");
        const sinceId = Number(parsedUrl.searchParams.get("sinceId") ?? "0") || 0;
        sendJson(res, 200, {
          data: store.listEvents(runId, sinceId),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/events/stream") {
        const runId = parsedUrl.searchParams.get("runId");
        const sinceId = Number(parsedUrl.searchParams.get("sinceId") ?? "0") || 0;

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });

        const client = {
          res,
          runId,
          sinceId,
          heartbeat: null,
        };
        sseClients.add(client);

        const replayRows = store.listEvents(runId, sinceId);
        for (const row of replayRows) {
          res.write(`id: ${row.id}\n`);
          res.write("event: event\n");
          res.write(`data: ${JSON.stringify({
            id: row.id,
            ts: row.ts,
            runId: row.run_id,
            stepId: row.step_id,
            eventType: row.event_type,
            payload: row.payload,
          })}\n\n`);
          client.sinceId = row.id;
        }

        client.heartbeat = setInterval(() => {
          res.write(`event: ping\ndata: {"now":"${new Date().toISOString()}"}\n\n`);
        }, 15000);

        req.on("close", () => {
          if (client.heartbeat) clearInterval(client.heartbeat);
          sseClients.delete(client);
        });
        return;
      }

      if (method === "GET") {
        const roots = [frontendDistDir, publicDir];
        for (const root of roots) {
          const candidates = getStaticCandidatePaths(root, pathname);
          for (const candidate of candidates) {
            if (!candidate.startsWith(root)) continue;
            if (!fs.existsSync(candidate)) continue;
            if (!fs.statSync(candidate).isFile()) continue;
            sendText(res, 200, fs.readFileSync(candidate), contentTypeFor(candidate));
            return;
          }
        }
      }

      sendJson(res, 404, {
        error: "Not found",
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    async start() {
      await new Promise((resolve) => {
        server.listen(port, host, resolve);
      });
      return {
        host,
        port,
      };
    },

    async stop() {
      store.events.off("event", eventListener);
      for (const client of sseClients) {
        if (client.heartbeat) clearInterval(client.heartbeat);
        try {
          client.res.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      for (const client of projectCreateSseClients) {
        if (client.heartbeat) clearInterval(client.heartbeat);
        try {
          client.res.end();
        } catch {
          // ignore
        }
      }
      projectCreateSseClients.clear();
      projectCreateEvents.clear();

      await new Promise((resolve) => server.close(resolve));
    },
  };
}
