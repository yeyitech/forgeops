import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVICE_LABEL = "com.forgeops.control-plane";
const DEFAULT_SYSTEMD_UNIT = "forgeops-control-plane.service";

function resolveAppRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function detectServicePlatform() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return "unsupported";
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const ok = !result.error && result.status === 0;

  if (!ok && !options.allowFailure) {
    if (result.error) {
      throw new Error(`${options.errorPrefix ?? `${command} failed`}: ${result.error.message}`);
    }
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`${options.errorPrefix ?? `${command} failed`}: ${detail}`);
  }

  return {
    ok,
    status: Number(result.status ?? 1),
    stdout,
    stderr,
    error: result.error ? String(result.error.message || result.error) : "",
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readTailLines(filePath, maxLines = 120) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      lines: [],
    };
  }
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, lines.length - Math.max(1, maxLines));
  return {
    exists: true,
    lines: lines.slice(start),
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (!text) return "''";
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

function resolveServiceConfig(options = {}) {
  const appRoot = path.resolve(options.appRoot ?? resolveAppRoot());
  const runtimeHome = path.resolve(
    options.runtimeHome
      ?? process.env.FORGEOPS_HOME
      ?? path.join(os.homedir(), ".forgeops")
  );
  const logsDir = path.join(runtimeHome, "logs");
  const host = String(options.host ?? "127.0.0.1");
  const port = toPositiveInt(options.port ?? 4173, 4173);
  const pollMs = toPositiveInt(options.pollMs ?? 1500, 1500);
  const concurrency = toPositiveInt(options.concurrency ?? 2, 2);
  const nodeBin = path.resolve(options.nodeBin ?? process.execPath);
  const cliScriptPath = path.resolve(options.cliScriptPath ?? path.join(appRoot, "src", "cli", "index.js"));
  const serviceLabel = String(options.serviceLabel ?? DEFAULT_SERVICE_LABEL);
  const systemdUnitName = String(options.systemdUnitName ?? DEFAULT_SYSTEMD_UNIT);

  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const launchdPlistPath = path.join(launchAgentsDir, `${serviceLabel}.plist`);
  const systemdUserDir = path.join(os.homedir(), ".config", "systemd", "user");
  const systemdUnitPath = path.join(systemdUserDir, systemdUnitName);

  return {
    platform: detectServicePlatform(),
    appRoot,
    runtimeHome,
    logsDir,
    host,
    port,
    pollMs,
    concurrency,
    nodeBin,
    cliScriptPath,
    serviceLabel,
    systemdUnitName,
    launchAgentsDir,
    launchdPlistPath,
    systemdUserDir,
    systemdUnitPath,
    stdoutLogPath: path.join(logsDir, "forgeops-service.out.log"),
    stderrLogPath: path.join(logsDir, "forgeops-service.err.log"),
  };
}

function getStartArgs(cfg) {
  return [
    "start",
    "--host",
    cfg.host,
    "--port",
    String(cfg.port),
    "--poll-ms",
    String(cfg.pollMs),
    "--concurrency",
    String(cfg.concurrency),
  ];
}

function launchdDomain() {
  if (typeof process.getuid !== "function") {
    throw new Error("无法读取当前用户 uid，launchd 用户域不可用");
  }
  return `gui/${process.getuid()}`;
}

function launchdTarget(label) {
  return `${launchdDomain()}/${label}`;
}

function buildLaunchdPlist(cfg) {
  const args = [cfg.nodeBin, cfg.cliScriptPath, ...getStartArgs(cfg)];
  const argLines = args.map((item) => `    <string>${xmlEscape(item)}</string>`).join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(cfg.serviceLabel)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argLines,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(cfg.appRoot)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>FORGEOPS_HOME</key>",
    `    <string>${xmlEscape(cfg.runtimeHome)}</string>`,
    "    <key>PATH</key>",
    `    <string>${xmlEscape(process.env.PATH ?? "")}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(cfg.stdoutLogPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(cfg.stderrLogPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function buildSystemdUnit(cfg) {
  const exec = [cfg.nodeBin, cfg.cliScriptPath, ...getStartArgs(cfg)].map((item) => shellQuote(item)).join(" ");
  return [
    "[Unit]",
    "Description=ForgeOps Control Plane",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${cfg.appRoot}`,
    `Environment=FORGEOPS_HOME=${cfg.runtimeHome}`,
    `ExecStart=${exec}`,
    "Restart=always",
    "RestartSec=2",
    `StandardOutput=append:${cfg.stdoutLogPath}`,
    `StandardError=append:${cfg.stderrLogPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function ensureSupportedPlatform(cfg) {
  if (cfg.platform === "unsupported") {
    throw new Error(`当前平台 ${process.platform} 暂不支持 service 管理`);
  }
}

function serviceStatusDarwin(cfg) {
  const installed = fs.existsSync(cfg.launchdPlistPath);
  const target = launchdTarget(cfg.serviceLabel);
  const printRes = runCommand("launchctl", ["print", target], { allowFailure: true });
  const loaded = installed && printRes.ok;
  return {
    manager: "launchd",
    platform: cfg.platform,
    installed,
    loaded,
    enabled: loaded,
    serviceId: cfg.serviceLabel,
    servicePath: cfg.launchdPlistPath,
    stdoutLogPath: cfg.stdoutLogPath,
    stderrLogPath: cfg.stderrLogPath,
    detail: printRes.ok ? printRes.stdout : (printRes.stderr || printRes.error || "service not loaded"),
  };
}

function installDarwin(cfg, options = {}) {
  ensureDir(cfg.launchAgentsDir);
  ensureDir(cfg.logsDir);
  fs.writeFileSync(cfg.launchdPlistPath, buildLaunchdPlist(cfg), "utf8");

  if (options.startNow !== false) {
    const domain = launchdDomain();
    const target = launchdTarget(cfg.serviceLabel);
    runCommand("launchctl", ["bootout", domain, target], { allowFailure: true });
    runCommand("launchctl", ["bootstrap", domain, cfg.launchdPlistPath], {
      errorPrefix: "launchd install 失败",
    });
    runCommand("launchctl", ["kickstart", "-k", target], {
      errorPrefix: "launchd 启动失败",
    });
  }
  return serviceStatusDarwin(cfg);
}

function startDarwin(cfg) {
  if (!fs.existsSync(cfg.launchdPlistPath)) {
    throw new Error(`service 未安装: ${cfg.launchdPlistPath}`);
  }
  const domain = launchdDomain();
  const target = launchdTarget(cfg.serviceLabel);
  runCommand("launchctl", ["bootout", domain, target], { allowFailure: true });
  runCommand("launchctl", ["bootstrap", domain, cfg.launchdPlistPath], {
    errorPrefix: "launchd 启动失败",
  });
  runCommand("launchctl", ["kickstart", "-k", target], {
    errorPrefix: "launchd kickstart 失败",
  });
  return serviceStatusDarwin(cfg);
}

function stopDarwin(cfg) {
  const domain = launchdDomain();
  const target = launchdTarget(cfg.serviceLabel);
  runCommand("launchctl", ["bootout", domain, target], { allowFailure: true });
  return serviceStatusDarwin(cfg);
}

function uninstallDarwin(cfg) {
  stopDarwin(cfg);
  if (fs.existsSync(cfg.launchdPlistPath)) {
    fs.unlinkSync(cfg.launchdPlistPath);
  }
  return serviceStatusDarwin(cfg);
}

function logsDarwin(cfg, options = {}) {
  const lines = toPositiveInt(options.lines ?? 120, 120);
  const stdout = readTailLines(cfg.stdoutLogPath, lines);
  const stderr = readTailLines(cfg.stderrLogPath, lines);
  return {
    manager: "launchd",
    platform: cfg.platform,
    serviceId: cfg.serviceLabel,
    stdoutLogPath: cfg.stdoutLogPath,
    stderrLogPath: cfg.stderrLogPath,
    stdout,
    stderr,
  };
}

function systemctlUser(args, options = {}) {
  return runCommand("systemctl", ["--user", ...args], options);
}

function serviceStatusLinux(cfg) {
  const installed = fs.existsSync(cfg.systemdUnitPath);
  const enabledRes = systemctlUser(["is-enabled", cfg.systemdUnitName], { allowFailure: true });
  const activeRes = systemctlUser(["is-active", cfg.systemdUnitName], { allowFailure: true });
  return {
    manager: "systemd-user",
    platform: cfg.platform,
    installed,
    loaded: activeRes.ok && activeRes.stdout === "active",
    enabled: enabledRes.ok && enabledRes.stdout === "enabled",
    serviceId: cfg.systemdUnitName,
    servicePath: cfg.systemdUnitPath,
    stdoutLogPath: cfg.stdoutLogPath,
    stderrLogPath: cfg.stderrLogPath,
    detail: activeRes.ok ? activeRes.stdout : (activeRes.stderr || activeRes.error || "inactive"),
  };
}

function installLinux(cfg, options = {}) {
  ensureDir(cfg.systemdUserDir);
  ensureDir(cfg.logsDir);
  fs.writeFileSync(cfg.systemdUnitPath, buildSystemdUnit(cfg), "utf8");
  systemctlUser(["daemon-reload"], { errorPrefix: "systemd daemon-reload 失败" });
  if (options.startNow !== false) {
    systemctlUser(["enable", "--now", cfg.systemdUnitName], { errorPrefix: "systemd enable --now 失败" });
  } else {
    systemctlUser(["enable", cfg.systemdUnitName], { errorPrefix: "systemd enable 失败" });
  }
  return serviceStatusLinux(cfg);
}

function startLinux(cfg) {
  if (!fs.existsSync(cfg.systemdUnitPath)) {
    throw new Error(`service 未安装: ${cfg.systemdUnitPath}`);
  }
  systemctlUser(["start", cfg.systemdUnitName], { errorPrefix: "systemd start 失败" });
  return serviceStatusLinux(cfg);
}

function stopLinux(cfg) {
  systemctlUser(["stop", cfg.systemdUnitName], { allowFailure: true });
  return serviceStatusLinux(cfg);
}

function uninstallLinux(cfg) {
  systemctlUser(["disable", "--now", cfg.systemdUnitName], { allowFailure: true });
  if (fs.existsSync(cfg.systemdUnitPath)) {
    fs.unlinkSync(cfg.systemdUnitPath);
  }
  systemctlUser(["daemon-reload"], { allowFailure: true });
  return serviceStatusLinux(cfg);
}

function logsLinux(cfg, options = {}) {
  const lines = toPositiveInt(options.lines ?? 120, 120);
  const journal = runCommand(
    "journalctl",
    ["--user", "-u", cfg.systemdUnitName, "-n", String(lines), "--no-pager"],
    { allowFailure: true },
  );
  return {
    manager: "systemd-user",
    platform: cfg.platform,
    serviceId: cfg.systemdUnitName,
    stdoutLogPath: cfg.stdoutLogPath,
    stderrLogPath: cfg.stderrLogPath,
    journal: {
      ok: journal.ok,
      output: journal.stdout,
      error: journal.stderr || journal.error,
    },
  };
}

export function getForgeOpsServiceInfo(options = {}) {
  const cfg = resolveServiceConfig(options);
  ensureSupportedPlatform(cfg);
  if (cfg.platform === "darwin") {
    return serviceStatusDarwin(cfg);
  }
  return serviceStatusLinux(cfg);
}

export function installForgeOpsService(options = {}) {
  const cfg = resolveServiceConfig(options);
  ensureSupportedPlatform(cfg);
  if (cfg.platform === "darwin") {
    return installDarwin(cfg, options);
  }
  return installLinux(cfg, options);
}

export function startForgeOpsService(options = {}) {
  const cfg = resolveServiceConfig(options);
  ensureSupportedPlatform(cfg);
  if (cfg.platform === "darwin") {
    return startDarwin(cfg);
  }
  return startLinux(cfg);
}

export function stopForgeOpsService(options = {}) {
  const cfg = resolveServiceConfig(options);
  ensureSupportedPlatform(cfg);
  if (cfg.platform === "darwin") {
    return stopDarwin(cfg);
  }
  return stopLinux(cfg);
}

export function uninstallForgeOpsService(options = {}) {
  const cfg = resolveServiceConfig(options);
  ensureSupportedPlatform(cfg);
  if (cfg.platform === "darwin") {
    return uninstallDarwin(cfg);
  }
  return uninstallLinux(cfg);
}

export function readForgeOpsServiceLogs(options = {}) {
  const cfg = resolveServiceConfig(options);
  ensureSupportedPlatform(cfg);
  if (cfg.platform === "darwin") {
    return logsDarwin(cfg, options);
  }
  return logsLinux(cfg, options);
}
