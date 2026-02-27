import { CodexExecJsonRuntime } from "./codex-exec-json.js";
import { CodexAppServerRuntime } from "./codex-app-server.js";

export function createRuntimeRegistry(options = {}) {
  const codexBin = options.codexBin ?? process.env.FORGEOPS_CODEX_BIN ?? "codex";
  const defaultSandbox = options.defaultSandbox
    ?? process.env.FORGEOPS_CODEX_SANDBOX
    ?? "danger-full-access";
  const defaultApprovalPolicy = options.defaultApprovalPolicy
    ?? process.env.FORGEOPS_CODEX_APPROVAL_POLICY
    ?? "never";

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
