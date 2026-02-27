import { spawnSync } from "node:child_process";

function commandExists(name) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [name], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

export function ensureCodexRuntimeReady(options = {}) {
  const codexBin = String(options.codexBin ?? process.env.FORGEOPS_CODEX_BIN ?? "codex");
  if (!commandExists(codexBin)) {
    throw new Error(`Runtime precheck failed: 未找到 codex 运行时命令 '${codexBin}'`);
  }

  const versionRes = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (versionRes.error) {
    throw new Error(`Runtime precheck failed: codex 运行时检查失败: ${versionRes.error.message}`);
  }

  if (versionRes.status !== 0) {
    const detail = String(versionRes.stderr ?? "").trim() || String(versionRes.stdout ?? "").trim() || `exit code ${versionRes.status}`;
    throw new Error(`Runtime precheck failed: codex --version 执行失败: ${detail}`);
  }

  return {
    runtime: "codex",
    codexBin,
    version: String(versionRes.stdout ?? "").trim() || "unknown",
  };
}
