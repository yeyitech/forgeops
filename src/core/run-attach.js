import fs from "node:fs";

function chooseNewestSession(rows) {
  const copied = [...rows];
  copied.sort((left, right) => String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")));
  return copied[0] ?? null;
}

function chooseNewestStep(rows) {
  const copied = [...rows];
  copied.sort((left, right) => Number(right.step_index ?? -1) - Number(left.step_index ?? -1));
  return copied[0] ?? null;
}

export function selectRunAttachTarget(details, options = {}) {
  const sessions = Array.isArray(details?.sessions) ? details.sessions : [];
  const steps = Array.isArray(details?.steps) ? details.steps : [];
  const stepKey = String(options.stepKey ?? "").trim();
  const sessionId = String(options.sessionId ?? "").trim();
  const threadId = String(options.threadId ?? "").trim();
  const stepsById = new Map(steps.map((row) => [row.id, row]));

  const getStepById = (id) => stepsById.get(id) ?? null;

  if (threadId) {
    const matchedSession = sessions.find((row) => String(row.thread_id ?? "").trim() === threadId) ?? null;
    return {
      threadId,
      session: matchedSession,
      step: matchedSession ? getStepById(matchedSession.step_id) : null,
    };
  }

  const sessionsWithThread = sessions.filter((row) => String(row.thread_id ?? "").trim().length > 0);
  let candidateSessions = sessionsWithThread;
  let selectedStep = null;

  if (sessionId) {
    const selectedSession = sessions.find((row) => String(row.id ?? "").trim() === sessionId) ?? null;
    if (!selectedSession) return null;
    if (!String(selectedSession.thread_id ?? "").trim()) {
      return {
        threadId: "",
        session: selectedSession,
        step: getStepById(selectedSession.step_id),
      };
    }
    return {
      threadId: String(selectedSession.thread_id).trim(),
      session: selectedSession,
      step: getStepById(selectedSession.step_id),
    };
  }

  if (stepKey) {
    const matchedSteps = steps.filter((row) => String(row.step_key ?? "").trim() === stepKey);
    if (matchedSteps.length === 0) return null;
    selectedStep = matchedSteps.find((row) => row.status === "running") ?? chooseNewestStep(matchedSteps);
    candidateSessions = candidateSessions.filter((row) => row.step_id === selectedStep.id);
  } else {
    const runningStep = steps.find((row) => row.status === "running") ?? null;
    if (runningStep) {
      selectedStep = runningStep;
      const matched = candidateSessions.filter((row) => row.step_id === runningStep.id);
      if (matched.length > 0) candidateSessions = matched;
    } else {
      const stepsWithSession = steps.filter((row) => String(row.runtime_session_id ?? "").trim().length > 0);
      if (stepsWithSession.length > 0) {
        selectedStep = chooseNewestStep(stepsWithSession);
        const matched = candidateSessions.filter((row) => row.step_id === selectedStep.id);
        if (matched.length > 0) candidateSessions = matched;
      }
    }
  }

  if (candidateSessions.length === 0) {
    return null;
  }

  const selectedSession = candidateSessions.find((row) => row.status === "running") ?? chooseNewestSession(candidateSessions);
  if (!selectedSession) return null;

  return {
    threadId: String(selectedSession.thread_id ?? "").trim(),
    session: selectedSession,
    step: selectedStep ?? getStepById(selectedSession.step_id),
  };
}

export function resolveRunAttachContext(store, runId, options = {}) {
  const runIdText = String(runId ?? "").trim();
  if (!runIdText) {
    return {
      ok: false,
      code: "INVALID_RUN_ID",
      error: "runId is required",
    };
  }

  const details = store.getRunDetails(runIdText);
  if (!details) {
    return {
      ok: false,
      code: "RUN_NOT_FOUND",
      error: `Run not found: ${runIdText}`,
    };
  }

  const selected = selectRunAttachTarget(details, options);
  if (!selected) {
    const hasSessions = Array.isArray(details.sessions) && details.sessions.length > 0;
    const hasSessionWithoutThread = hasSessions
      ? details.sessions.some((row) => String(row.thread_id ?? "").trim().length === 0)
      : false;
    if (hasSessionWithoutThread) {
      return {
        ok: false,
        code: "THREAD_NOT_READY",
        error: "No resumable Codex thread yet (session started but thread_id is empty). Retry shortly.",
      };
    }
    return {
      ok: false,
      code: "THREAD_NOT_FOUND",
      error: "No resumable Codex thread found for this run.",
    };
  }

  if (!selected.threadId) {
    return {
      ok: false,
      code: "THREAD_NOT_READY",
      error: "Selected session has no thread_id yet. Retry shortly.",
    };
  }

  const project = store.getProject(details.run.project_id);
  const worktreePath = String(details.run.worktree_path ?? "").trim();
  const projectRoot = String(project?.root_path ?? "").trim();
  const cwdFallback = String(process.cwd());

  const hasDir = (dirPath) => {
    if (!dirPath) return false;
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  };

  const worktreeExists = hasDir(worktreePath);
  const projectRootExists = hasDir(projectRoot);
  const attachCwd = worktreeExists
    ? worktreePath
    : projectRootExists
      ? projectRoot
      : cwdFallback;
  const attachNotice = !worktreeExists && worktreePath
    ? `Worktree not found (possibly archived): ${worktreePath}. Fallback to: ${attachCwd}`
    : "";

  return {
    ok: true,
    runId: runIdText,
    details,
    project,
    selected,
    attachCwd,
    attachNotice,
  };
}
