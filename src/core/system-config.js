import { runDoctor } from "./doctor.js";
import { getGlobalGitIdentity, setGlobalGitIdentity } from "./git.js";
import { clearGitHubPatToken, getGitHubAuthStatus, setGitHubPatToken } from "./github-auth.js";
import { readMachineTelemetry } from "./machine-info.js";
import { ensureCodexRuntimeReady } from "../runtime/preflight.js";

function findCheck(doctor, checkId) {
  if (!doctor || !Array.isArray(doctor.checks)) return null;
  return doctor.checks.find((item) => item.id === checkId) ?? null;
}

function readRuntimeStatus() {
  try {
    const ready = ensureCodexRuntimeReady();
    return {
      selected: "codex-exec-json",
      supported: ["codex-exec-json", "codex-app-server"],
      modelDefault: "gpt-5.3-codex",
      codexBin: ready.codexBin,
      codexVersion: ready.version,
      ready: true,
      error: "",
    };
  } catch (err) {
    return {
      selected: "codex-exec-json",
      supported: ["codex-exec-json", "codex-app-server"],
      modelDefault: "gpt-5.3-codex",
      codexBin: "codex",
      codexVersion: "",
      ready: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readSystemConfig() {
  const doctor = runDoctor();
  const git = getGlobalGitIdentity();
  const runtime = readRuntimeStatus();
  const machine = readMachineTelemetry();
  const githubAuth = getGitHubAuthStatus();
  const patConfiguredCheck = findCheck(doctor, "github.pat.configured");
  const patValidationCheck = findCheck(doctor, "github.pat.validation");
  const patScopeCheck = findCheck(doctor, "github.pat.scopes");

  return {
    runtime,
    git,
    github: {
      patRequired: true,
      patConfigured: githubAuth.patConfigured,
      patMasked: githubAuth.patMasked,
      updatedAt: githubAuth.updatedAt,
      validated: Boolean(patValidationCheck?.ok) && Boolean(patScopeCheck?.ok),
      detail: String(patScopeCheck?.detail ?? patValidationCheck?.detail ?? patConfiguredCheck?.detail ?? ""),
    },
    doctor,
    machine,
  };
}

export function updateSystemConfig(patch) {
  const input = patch && typeof patch === "object" ? patch : {};
  if (input.git && typeof input.git === "object") {
    setGlobalGitIdentity({
      userName: input.git.userName,
      userEmail: input.git.userEmail,
    });
  }
  if (input.github && typeof input.github === "object") {
    if (input.github.clearPat === true) {
      clearGitHubPatToken();
    } else if (typeof input.github.patToken === "string") {
      setGitHubPatToken(input.github.patToken);
    }
  }
  return readSystemConfig();
}
