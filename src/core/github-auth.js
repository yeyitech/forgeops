import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RUNTIME_HOME = process.env.FORGEOPS_HOME
  ? path.resolve(process.env.FORGEOPS_HOME)
  : path.join(os.homedir(), ".forgeops");
const AUTH_FILE = path.join(RUNTIME_HOME, "github-auth.json");
const LEGACY_AUTH_FILE = path.join(process.cwd(), ".forgeops-runtime", "github-auth.json");
const REQUIRED_CLASSIC_PAT_SCOPES = ["repo", "workflow"];

function ensureRuntimeHome() {
  fs.mkdirSync(RUNTIME_HOME, { recursive: true });
}

function maskToken(token) {
  const raw = String(token ?? "").trim();
  if (!raw) return "";
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function readAuthDoc() {
  ensureRuntimeHome();
  if (!fs.existsSync(AUTH_FILE)) {
    if (fs.existsSync(LEGACY_AUTH_FILE)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_AUTH_FILE, "utf8"));
        const migrated = {
          patToken: String(legacy?.patToken ?? ""),
          updatedAt: legacy?.updatedAt ? String(legacy.updatedAt) : new Date().toISOString(),
        };
        writeAuthDoc(migrated);
        return migrated;
      } catch {
        // fall through to default empty doc
      }
    }
    return {
      patToken: "",
      updatedAt: null,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    return {
      patToken: String(parsed?.patToken ?? ""),
      updatedAt: parsed?.updatedAt ? String(parsed.updatedAt) : null,
    };
  } catch {
    return {
      patToken: "",
      updatedAt: null,
    };
  }
}

function writeAuthDoc(doc) {
  ensureRuntimeHome();
  const payload = JSON.stringify({
    patToken: String(doc?.patToken ?? ""),
    updatedAt: doc?.updatedAt ? String(doc.updatedAt) : new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(AUTH_FILE, payload, { encoding: "utf8", mode: 0o600 });
}

export function readGitHubPatToken() {
  const raw = readAuthDoc();
  return String(raw.patToken ?? "").trim();
}

export function setGitHubPatToken(token) {
  const raw = String(token ?? "").trim();
  if (!raw) {
    throw new Error("系统配置失败: GitHub PAT 不能为空");
  }
  if (raw.length < 20) {
    throw new Error("系统配置失败: GitHub PAT 长度过短，请使用 Personal access token (classic)");
  }
  const validation = validateGitHubPatCandidate(raw);
  if (!validation.valid) {
    throw new Error(`系统配置失败: GitHub PAT 验证失败：${validation.detail}`);
  }
  if (!validation.scopesOk) {
    throw new Error(
      `系统配置失败: GitHub PAT scope 不满足要求，缺失 ${validation.missingScopes.join(", ")}（要求: ${validation.requiredScopes.join(", ")}）`
    );
  }
  writeAuthDoc({
    patToken: raw,
    updatedAt: new Date().toISOString(),
  });
  return getGitHubAuthStatus();
}

export function clearGitHubPatToken() {
  writeAuthDoc({
    patToken: "",
    updatedAt: new Date().toISOString(),
  });
  return getGitHubAuthStatus();
}

export function getGitHubAuthStatus() {
  const raw = readAuthDoc();
  const token = String(raw.patToken ?? "").trim();
  return {
    patRequired: true,
    patConfigured: Boolean(token),
    patMasked: token ? maskToken(token) : "",
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
  };
}

export function buildGitHubTokenEnv() {
  const token = readGitHubPatToken();
  if (!token) return null;
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

export function requireGitHubPatToken() {
  const token = readGitHubPatToken();
  if (!token) {
    throw new Error("GitHub flow precheck failed: 必须先在系统配置中设置 GitHub PAT (classic)");
  }
  return token;
}

function commandExists(name) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

function parseScopesFromRawHeaders(rawText) {
  const lines = String(rawText ?? "").split(/\r?\n/);
  const headerLine = lines.find((line) => /^x-oauth-scopes\s*:/i.test(line));
  if (!headerLine) return [];
  const value = headerLine.replace(/^x-oauth-scopes\s*:/i, "").trim();
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function getRequiredGitHubPatScopes() {
  return [...REQUIRED_CLASSIC_PAT_SCOPES];
}

function validateGitHubPatWithToken(token) {
  const rawToken = String(token ?? "").trim();
  if (!rawToken) {
    return {
      configured: false,
      valid: false,
      scopesOk: false,
      scopes: [],
      requiredScopes: getRequiredGitHubPatScopes(),
      missingScopes: getRequiredGitHubPatScopes(),
      detail: "未配置 GitHub PAT (classic)",
    };
  }
  if (!commandExists("gh")) {
    return {
      configured: true,
      valid: false,
      scopesOk: false,
      scopes: [],
      requiredScopes: getRequiredGitHubPatScopes(),
      missingScopes: getRequiredGitHubPatScopes(),
      detail: "未找到 gh 命令，无法验证 PAT scope",
    };
  }
  const tokenEnv = {
    GH_TOKEN: rawToken,
    GITHUB_TOKEN: rawToken,
  };

  const result = spawnSync("gh", ["api", "-i", "/user"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 6000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      ...tokenEnv,
    },
  });

  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "PAT 验证失败").trim();
    return {
      configured: true,
      valid: false,
      scopesOk: false,
      scopes: [],
      requiredScopes: getRequiredGitHubPatScopes(),
      missingScopes: getRequiredGitHubPatScopes(),
      detail: detail || "PAT 验证失败",
    };
  }

  const rawOutput = String(result.stdout ?? "");
  const scopes = parseScopesFromRawHeaders(rawOutput);
  const required = getRequiredGitHubPatScopes();
  const missingScopes = required.filter((scope) => !scopes.includes(scope));
  const scopesOk = missingScopes.length === 0;
  return {
    configured: true,
    valid: true,
    scopesOk,
    scopes,
    requiredScopes: required,
    missingScopes,
    detail: scopesOk
      ? `PAT scope 校验通过: ${scopes.join(", ") || "(empty)"}`
      : `PAT scope 缺失: ${missingScopes.join(", ")}`,
  };
}

export function validateGitHubPat() {
  return validateGitHubPatWithToken(readGitHubPatToken());
}

export function validateGitHubPatCandidate(token) {
  return validateGitHubPatWithToken(token);
}
