import type {
  DoctorReport,
  EngineState,
  GlobalTokenUsage,
  Issue,
  IssueCreateResult,
  Project,
  ProjectMetrics,
  RunBatchActionResult,
  RunAttachTerminalResult,
  RunDetail,
  RunRow,
  SchedulerConfig,
  SystemConfig,
  WorkflowConfigDoc,
} from "./types";

async function jsonRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const resp = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error ?? `Request failed: ${resp.status}`);
  }
  return data as T;
}

export async function listProjects(): Promise<Project[]> {
  const payload = await jsonRequest<{ data: Project[] }>("/api/projects");
  return payload.data;
}

export async function createProject(input: {
  name: string;
  rootPath: string;
  productType: string;
  problemStatement: string;
  language?: string;
  frontendStack?: string;
  backendStack?: string;
  ciProvider?: string;
  githubRepo?: string;
  githubVisibility?: "private" | "public";
  createSessionId?: string;
}): Promise<Project> {
  const payload = await jsonRequest<{ data: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.data;
}

export async function getProjectMetrics(projectId: string): Promise<ProjectMetrics | null> {
  try {
    const payload = await jsonRequest<{ data: ProjectMetrics }>(
      `/api/projects/${encodeURIComponent(projectId)}/metrics`
    );
    return payload.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return null;
    throw err;
  }
}

export async function listIssues(projectId: string): Promise<Issue[]> {
  const payload = await jsonRequest<{ data: Issue[] }>(`/api/projects/${encodeURIComponent(projectId)}/issues`);
  return payload.data;
}

export async function createIssue(input: {
  projectId: string;
  title: string;
  description: string;
  autoRun?: boolean;
  runMode?: "standard" | "quick";
  labels?: string[];
}): Promise<IssueCreateResult> {
  const payload = await jsonRequest<{
    data: Issue;
    run?: RunRow | null;
    autoRun?: {
      enabled?: boolean;
      error?: string;
    };
  }>(`/api/projects/${encodeURIComponent(input.projectId)}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      autoRun: input.autoRun,
      runMode: input.runMode,
      labels: input.labels,
    }),
  });
  return {
    issue: payload.data,
    run: payload.run ?? null,
    autoRunEnabled: Boolean(payload.autoRun?.enabled),
    autoRunError: String(payload.autoRun?.error ?? ""),
  };
}

export async function listRuns(projectId: string | null): Promise<RunRow[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const payload = await jsonRequest<{ data: RunRow[] }>(`/api/runs${query}`);
  return payload.data;
}

export async function createRun(input: {
  projectId: string;
  task?: string;
  issueId: string;
  runMode?: "standard" | "quick";
}): Promise<RunRow> {
  const payload = await jsonRequest<{ data: RunRow }>("/api/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.data;
}

export async function getRunDetail(runId: string): Promise<RunDetail> {
  const payload = await jsonRequest<{ data: RunDetail }>(`/api/runs/${encodeURIComponent(runId)}`);
  return payload.data;
}

export async function resumeRun(runId: string): Promise<void> {
  await jsonRequest<{ data: { ok: boolean } }>(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
  });
}

export async function stopRun(runId: string): Promise<void> {
  await jsonRequest<{ data: { ok: boolean } }>(`/api/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
  });
}

export async function stopAllRuns(projectId?: string): Promise<RunBatchActionResult> {
  const payload = await jsonRequest<{ data: RunBatchActionResult }>("/api/runs/stop-all", {
    method: "POST",
    body: JSON.stringify({
      projectId: projectId || undefined,
    }),
  });
  return payload.data;
}

export async function resumeAllPausedRuns(projectId?: string): Promise<RunBatchActionResult> {
  const payload = await jsonRequest<{ data: RunBatchActionResult }>("/api/runs/resume-all", {
    method: "POST",
    body: JSON.stringify({
      projectId: projectId || undefined,
    }),
  });
  return payload.data;
}

export async function attachRunTerminal(input: {
  runId: string;
  stepKey?: string;
  sessionId?: string;
  threadId?: string;
}): Promise<RunAttachTerminalResult> {
  const payload = await jsonRequest<{ data: RunAttachTerminalResult }>(
    `/api/runs/${encodeURIComponent(input.runId)}/attach-terminal`,
    {
      method: "POST",
      body: JSON.stringify({
        stepKey: input.stepKey,
        sessionId: input.sessionId,
        threadId: input.threadId,
      }),
    }
  );
  return payload.data;
}

export async function getEngineState(): Promise<EngineState> {
  return jsonRequest<EngineState>("/api/engine");
}

export async function updateEngineState(input: {
  concurrency?: number;
  pollMs?: number;
}): Promise<EngineState> {
  return jsonRequest<EngineState>("/api/engine", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getDoctorReport(): Promise<DoctorReport> {
  const payload = await jsonRequest<{ data: DoctorReport }>("/api/doctor");
  return payload.data;
}

export async function getSystemConfig(): Promise<SystemConfig> {
  const payload = await jsonRequest<{ data: SystemConfig }>("/api/system/config");
  return payload.data;
}

export async function getGlobalTokenUsage(): Promise<GlobalTokenUsage | null> {
  try {
    const payload = await jsonRequest<{ data: GlobalTokenUsage }>("/api/system/token-usage");
    return payload.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return null;
    throw err;
  }
}

export async function updateSystemConfig(input: {
  git?: {
    userName: string;
    userEmail: string;
  };
  github?: {
    patToken?: string;
    clearPat?: boolean;
  };
}): Promise<SystemConfig> {
  const payload = await jsonRequest<{ data: SystemConfig }>("/api/system/config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return payload.data;
}

export async function pickProjectRootDirectory(startPath = "~/"): Promise<{
  cancelled: boolean;
  path: string;
  startPath: string;
}> {
  const payload = await jsonRequest<{
    data: {
      cancelled: boolean;
      path: string;
      startPath: string;
    };
  }>("/api/system/pick-directory", {
    method: "POST",
    body: JSON.stringify({
      startPath,
    }),
  });
  return payload.data;
}

export async function getProjectSchedulerConfig(projectId: string): Promise<SchedulerConfig> {
  const payload = await jsonRequest<{ data: SchedulerConfig }>(
    `/api/projects/${encodeURIComponent(projectId)}/scheduler`
  );
  return payload.data;
}

export async function updateProjectSchedulerConfig(
  projectId: string,
  patch: Partial<SchedulerConfig>
): Promise<SchedulerConfig> {
  const payload = await jsonRequest<{ data: SchedulerConfig }>(
    `/api/projects/${encodeURIComponent(projectId)}/scheduler`,
    {
      method: "PUT",
      body: JSON.stringify(patch),
    }
  );
  return payload.data;
}

export async function getProjectWorkflowConfig(projectId: string): Promise<WorkflowConfigDoc> {
  const payload = await jsonRequest<{ data: WorkflowConfigDoc }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow`
  );
  return payload.data;
}

export async function updateProjectWorkflowConfig(
  projectId: string,
  input: {
    yaml?: string;
    resetDefault?: boolean;
  }
): Promise<WorkflowConfigDoc> {
  const payload = await jsonRequest<{ data: WorkflowConfigDoc }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    }
  );
  return payload.data;
}
