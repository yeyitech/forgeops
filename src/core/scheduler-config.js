import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const DEFAULT_SCHEDULER_CONFIG = {
  version: 1,
  enabled: true,
  timezone: "UTC",
  cleanup: {
    enabled: true,
    mode: "deep",
    cron: "0 3 * * *",
    task: "执行每日熵增清理、文档园艺（freshness/structure）与质量回收",
    onlyWhenIdle: true,
  },
  issueAutoRun: {
    enabled: true,
    label: "forgeops:ready",
    onlyWhenIdle: true,
    cron: "*/1 * * * *",
    maxRunsPerTick: 3,
  },
};

function normalizeBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeText(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeTimezone(value, fallback) {
  const text = normalizeText(value, fallback);
  const compact = text.toLowerCase().replace(/\s+/g, "");
  if (["utc", "gmt", "z", "+00:00", "+0000"].includes(compact)) {
    return "UTC";
  }
  if ([
    "utc+8",
    "utc+08:00",
    "utc+0800",
    "gmt+8",
    "gmt+08:00",
    "gmt+0800",
    "+08:00",
    "+0800",
  ].includes(compact)) {
    return "Asia/Shanghai";
  }
  return text;
}

function normalizeCleanupMode(value, fallback) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (text === "lite" || text === "deep") return text;
  return fallback;
}

function normalizePositiveInt(value, fallback, min = 1, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < min) return fallback;
  if (rounded > max) return max;
  return rounded;
}

function mergeConfig(base, patch) {
  const left = base && typeof base === "object" ? base : {};
  const right = patch && typeof patch === "object" ? patch : {};
  return {
    ...left,
    ...right,
    cleanup: {
      ...(left.cleanup && typeof left.cleanup === "object" ? left.cleanup : {}),
      ...(right.cleanup && typeof right.cleanup === "object" ? right.cleanup : {}),
    },
    issueAutoRun: {
      ...(left.issueAutoRun && typeof left.issueAutoRun === "object" ? left.issueAutoRun : {}),
      ...(right.issueAutoRun && typeof right.issueAutoRun === "object" ? right.issueAutoRun : {}),
    },
  };
}

export function normalizeSchedulerConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const cleanup = raw.cleanup && typeof raw.cleanup === "object" ? raw.cleanup : {};
  const issueAutoRun = raw.issueAutoRun && typeof raw.issueAutoRun === "object" ? raw.issueAutoRun : {};

  return {
    version: 1,
    enabled: normalizeBool(raw.enabled, DEFAULT_SCHEDULER_CONFIG.enabled),
    timezone: normalizeTimezone(raw.timezone, DEFAULT_SCHEDULER_CONFIG.timezone),
    cleanup: {
      enabled: normalizeBool(cleanup.enabled, DEFAULT_SCHEDULER_CONFIG.cleanup.enabled),
      mode: normalizeCleanupMode(cleanup.mode, DEFAULT_SCHEDULER_CONFIG.cleanup.mode),
      cron: normalizeText(cleanup.cron, DEFAULT_SCHEDULER_CONFIG.cleanup.cron),
      task: normalizeText(cleanup.task, DEFAULT_SCHEDULER_CONFIG.cleanup.task),
      onlyWhenIdle: normalizeBool(cleanup.onlyWhenIdle, DEFAULT_SCHEDULER_CONFIG.cleanup.onlyWhenIdle),
    },
    issueAutoRun: {
      enabled: normalizeBool(issueAutoRun.enabled, DEFAULT_SCHEDULER_CONFIG.issueAutoRun.enabled),
      label: normalizeText(issueAutoRun.label, DEFAULT_SCHEDULER_CONFIG.issueAutoRun.label),
      onlyWhenIdle: normalizeBool(issueAutoRun.onlyWhenIdle, DEFAULT_SCHEDULER_CONFIG.issueAutoRun.onlyWhenIdle),
      cron: normalizeText(issueAutoRun.cron, DEFAULT_SCHEDULER_CONFIG.issueAutoRun.cron),
      maxRunsPerTick: normalizePositiveInt(
        issueAutoRun.maxRunsPerTick,
        DEFAULT_SCHEDULER_CONFIG.issueAutoRun.maxRunsPerTick,
        1,
        20
      ),
    },
  };
}

export function getSchedulerConfigPath(rootPath) {
  return path.join(path.resolve(rootPath), ".forgeops", "scheduler.yaml");
}

export function buildSchedulerConfigYaml(config) {
  const normalized = normalizeSchedulerConfig(config);
  return `${YAML.stringify(normalized)}`;
}

export function loadSchedulerConfig(rootPath) {
  const configPath = getSchedulerConfigPath(rootPath);
  if (!fs.existsSync(configPath)) {
    return {
      config: normalizeSchedulerConfig(DEFAULT_SCHEDULER_CONFIG),
      path: configPath,
      source: "default",
    };
  }

  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
    return {
      config: normalizeSchedulerConfig(parsed),
      path: configPath,
      source: "file",
    };
  } catch {
    return {
      config: normalizeSchedulerConfig(DEFAULT_SCHEDULER_CONFIG),
      path: configPath,
      source: "invalid_file_fallback_default",
    };
  }
}

export function writeSchedulerConfig(rootPath, config) {
  const configPath = getSchedulerConfigPath(rootPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const normalized = normalizeSchedulerConfig(config);
  fs.writeFileSync(configPath, buildSchedulerConfigYaml(normalized), "utf8");
  return {
    path: configPath,
    config: normalized,
  };
}

export function updateSchedulerConfig(rootPath, patch) {
  const loaded = loadSchedulerConfig(rootPath);
  const merged = mergeConfig(loaded.config, patch);
  return writeSchedulerConfig(rootPath, merged);
}
