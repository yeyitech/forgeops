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
  skillPromotion: {
    enabled: true,
    cron: "15 */6 * * *",
    onlyWhenIdle: true,
    maxPromotionsPerTick: 1,
    minCandidateOccurrences: 2,
    lookbackDays: 14,
    minScore: 0.6,
    draft: true,
    roles: [],
  },
  globalSkillPromotion: {
    enabled: true,
    cron: "45 */12 * * *",
    onlyWhenIdle: true,
    maxPromotionsPerTick: 1,
    minCandidateOccurrences: 3,
    lookbackDays: 30,
    minScore: 0.75,
    requireProjectSkill: true,
    draft: true,
  },
};

const SKILL_PROMOTION_ROLES = new Set([
  "architect",
  "issue-manager",
  "developer",
  "tester",
  "reviewer",
  "garbage-collector",
]);

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

function normalizeRate(value, fallback, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Number(n.toFixed(3));
}

function normalizeRoles(value, fallback = []) {
  const rows = Array.isArray(value) ? value : [value];
  const out = [];
  for (const row of rows) {
    if (row === null || row === undefined) continue;
    const parts = String(row)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (!SKILL_PROMOTION_ROLES.has(part)) continue;
      if (out.includes(part)) continue;
      out.push(part);
    }
  }
  return out.length > 0 ? out : fallback;
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
    skillPromotion: {
      ...(left.skillPromotion && typeof left.skillPromotion === "object" ? left.skillPromotion : {}),
      ...(right.skillPromotion && typeof right.skillPromotion === "object" ? right.skillPromotion : {}),
    },
    globalSkillPromotion: {
      ...(left.globalSkillPromotion && typeof left.globalSkillPromotion === "object" ? left.globalSkillPromotion : {}),
      ...(right.globalSkillPromotion && typeof right.globalSkillPromotion === "object" ? right.globalSkillPromotion : {}),
    },
  };
}

export function normalizeSchedulerConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const cleanup = raw.cleanup && typeof raw.cleanup === "object" ? raw.cleanup : {};
  const issueAutoRun = raw.issueAutoRun && typeof raw.issueAutoRun === "object" ? raw.issueAutoRun : {};
  const skillPromotion = raw.skillPromotion && typeof raw.skillPromotion === "object" ? raw.skillPromotion : {};
  const globalSkillPromotion = raw.globalSkillPromotion && typeof raw.globalSkillPromotion === "object"
    ? raw.globalSkillPromotion
    : {};

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
    skillPromotion: {
      enabled: normalizeBool(skillPromotion.enabled, DEFAULT_SCHEDULER_CONFIG.skillPromotion.enabled),
      cron: normalizeText(skillPromotion.cron, DEFAULT_SCHEDULER_CONFIG.skillPromotion.cron),
      onlyWhenIdle: normalizeBool(
        skillPromotion.onlyWhenIdle,
        DEFAULT_SCHEDULER_CONFIG.skillPromotion.onlyWhenIdle,
      ),
      maxPromotionsPerTick: normalizePositiveInt(
        skillPromotion.maxPromotionsPerTick,
        DEFAULT_SCHEDULER_CONFIG.skillPromotion.maxPromotionsPerTick,
        1,
        20
      ),
      minCandidateOccurrences: normalizePositiveInt(
        skillPromotion.minCandidateOccurrences,
        DEFAULT_SCHEDULER_CONFIG.skillPromotion.minCandidateOccurrences,
        1,
        50
      ),
      lookbackDays: normalizePositiveInt(
        skillPromotion.lookbackDays,
        DEFAULT_SCHEDULER_CONFIG.skillPromotion.lookbackDays,
        1,
        365
      ),
      minScore: normalizeRate(
        skillPromotion.minScore,
        DEFAULT_SCHEDULER_CONFIG.skillPromotion.minScore,
        0,
        1
      ),
      draft: normalizeBool(skillPromotion.draft, DEFAULT_SCHEDULER_CONFIG.skillPromotion.draft),
      roles: normalizeRoles(skillPromotion.roles, DEFAULT_SCHEDULER_CONFIG.skillPromotion.roles),
    },
    globalSkillPromotion: {
      enabled: normalizeBool(globalSkillPromotion.enabled, DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.enabled),
      cron: normalizeText(globalSkillPromotion.cron, DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.cron),
      onlyWhenIdle: normalizeBool(
        globalSkillPromotion.onlyWhenIdle,
        DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.onlyWhenIdle,
      ),
      maxPromotionsPerTick: normalizePositiveInt(
        globalSkillPromotion.maxPromotionsPerTick,
        DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.maxPromotionsPerTick,
        1,
        20
      ),
      minCandidateOccurrences: normalizePositiveInt(
        globalSkillPromotion.minCandidateOccurrences,
        DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.minCandidateOccurrences,
        1,
        50
      ),
      lookbackDays: normalizePositiveInt(
        globalSkillPromotion.lookbackDays,
        DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.lookbackDays,
        1,
        365
      ),
      minScore: normalizeRate(
        globalSkillPromotion.minScore,
        DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.minScore,
        0,
        1
      ),
      requireProjectSkill: normalizeBool(
        globalSkillPromotion.requireProjectSkill,
        DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.requireProjectSkill,
      ),
      draft: normalizeBool(globalSkillPromotion.draft, DEFAULT_SCHEDULER_CONFIG.globalSkillPromotion.draft),
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
