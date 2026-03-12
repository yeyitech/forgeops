import { spawnSync } from "node:child_process";

function shellQuote(value) {
  const raw = String(value ?? "");
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function renderEnvPrefix(env) {
  if (!env || typeof env !== "object") return "";
  const entries = Object.entries(env)
    .filter(([key]) => Boolean(String(key ?? "").trim()))
    .map(([key, value]) => `${String(key).trim()}=${shellQuote(String(value ?? ""))}`);
  if (entries.length === 0) return "";
  return `${entries.join(" ")} `;
}

function toAppleScriptString(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

export function buildCodexResumeShellCommand(codexBin, threadId, cwd, env = null) {
  const bin = String(codexBin ?? "").trim() || "codex";
  const thread = String(threadId ?? "").trim();
  const workDir = String(cwd ?? "").trim();
  if (!thread) {
    throw new Error("threadId is required");
  }
  const cdArg = workDir ? ` --cd ${shellQuote(workDir)}` : "";
  const prefix = renderEnvPrefix(env);
  return `${prefix}${shellQuote(bin)} resume --all${cdArg} ${shellQuote(thread)}`;
}

export function launchTerminalCommand(params) {
  const cwd = String(params?.cwd ?? "").trim();
  const shellCommand = String(params?.command ?? "").trim();
  if (!cwd) {
    throw new Error("cwd is required");
  }
  if (!shellCommand) {
    throw new Error("command is required");
  }

  if (process.platform === "darwin") {
    const terminalScript = `cd ${shellQuote(cwd)} && ${shellCommand}`;
    const activateScript = 'tell application "Terminal" to activate';
    const doScript = `tell application "Terminal" to do script ${toAppleScriptString(terminalScript)}`;
    const launched = spawnSync("osascript", ["-e", activateScript, "-e", doScript], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (launched.error) {
      const message = launched.error instanceof Error ? launched.error.message : String(launched.error);
      throw new Error(`Failed to start Terminal.app: ${message}`);
    }
    if (launched.status !== 0) {
      const detail = String(launched.stderr ?? launched.stdout ?? "").trim();
      throw new Error(`Failed to start Terminal.app: ${detail || `exit=${launched.status}`}`);
    }
    return {
      platform: process.platform,
      terminal: "Terminal.app",
    };
  }

  throw new Error(`Open terminal is not supported on platform: ${process.platform}`);
}
