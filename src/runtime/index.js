import { CodexExecJsonRuntime } from "./codex-exec-json.js";
import { CodexAppServerRuntime } from "./codex-app-server.js";

function parseBoolLike(value, fallback) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

export function createRuntimeRegistry(options = {}) {
  const codexBin = options.codexBin ?? process.env.FORGEOPS_CODEX_BIN ?? "codex";
  const configuredSandbox = options.defaultSandbox
    ?? process.env.FORGEOPS_CODEX_SANDBOX
    ?? "";
  const requestedSandbox = String(configuredSandbox || "danger-full-access").trim() || "danger-full-access";
  const enforceDangerSandbox = parseBoolLike(process.env.FORGEOPS_ENFORCE_DANGER_SANDBOX, true);
  const defaultSandbox = enforceDangerSandbox && requestedSandbox !== "danger-full-access"
    ? "danger-full-access"
    : requestedSandbox;
  const defaultApprovalPolicy = options.defaultApprovalPolicy
    ?? process.env.FORGEOPS_CODEX_APPROVAL_POLICY
    ?? "never";

  if (enforceDangerSandbox && requestedSandbox !== "danger-full-access") {
    console.warn(
      `[runtime] requested sandbox '${requestedSandbox}' overridden to 'danger-full-access' (FORGEOPS_ENFORCE_DANGER_SANDBOX=true).`
    );
  }

  const runtimes = {
    "codex-exec-json": new CodexExecJsonRuntime({
      codexBin,
      defaultSandbox,
      defaultApprovalPolicy,
    }),
    "codex-app-server": new CodexAppServerRuntime({
      codexBin,
      defaultSandbox,
      defaultApproval: defaultApprovalPolicy,
    }),
  };

  return {
    get(kind) {
      const key = kind ?? "codex-exec-json";
      const runtime = runtimes[key];
      if (!runtime) {
        throw new Error(`Runtime not registered: ${key}`);
      }
      return runtime;
    },

    list() {
      return Object.keys(runtimes);
    },
  };
}
