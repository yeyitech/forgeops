import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const AGENT_IDS = [
  "architect",
  "issue-manager",
  "developer",
  "tester",
  "reviewer",
  "garbage-collector",
];

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../..");
const OFFICIAL_SKILLS_ROOT = path.join(REPO_ROOT, "official-skills");
const OFFICIAL_MANIFEST_PATH = path.join(OFFICIAL_SKILLS_ROOT, "manifest.json");

function resolveRuntimeHome(input) {
  if (input) {
    return path.resolve(String(input));
  }
  if (process.env.FORGEOPS_HOME) {
    return path.resolve(process.env.FORGEOPS_HOME);
  }
  return path.join(os.homedir(), ".forgeops");
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseFrontmatter(text) {
  const raw = String(text ?? "");
  if (!raw.startsWith("---\n")) {
    return {
      name: "",
      description: "",
      body: raw,
    };
  }

  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return {
      name: "",
      description: "",
      body: raw,
    };
  }

  const block = raw.slice(4, end).split(/\r?\n/);
  const out = { name: "", description: "" };

  for (const line of block) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }

  const body = raw.slice(end + "\n---".length).replace(/^\r?\n/, "");
  return {
    name: out.name,
    description: out.description,
    body,
  };
}

function parseRoleMap(rawRoles) {
  const roles = rawRoles && typeof rawRoles === "object" ? rawRoles : {};
  const out = {};
  for (const agentId of AGENT_IDS) {
    const raw = Array.isArray(roles[agentId]) ? roles[agentId] : [];
    const list = [];
    for (const item of raw) {
      const name = String(item ?? "").trim();
      if (!name) continue;
      if (list.includes(name)) continue;
      list.push(name);
    }
    if (list.length > 0) {
      out[agentId] = list;
    }
  }
  return out;
}

function mergeRoleMaps(...maps) {
  const out = {};
  for (const agentId of AGENT_IDS) {
    const list = [];
    for (const roleMap of maps) {
      const names = Array.isArray(roleMap?.[agentId]) ? roleMap[agentId] : [];
      for (const name of names) {
        const normalized = String(name ?? "").trim();
        if (!normalized) continue;
        if (list.includes(normalized)) continue;
        list.push(normalized);
      }
    }
    if (list.length > 0) {
      out[agentId] = list;
    }
  }
  return out;
}

function buildTemplateVars(params) {
  const productType = String(params?.productType ?? "web");
  const tech = normalizeTechProfile({
    productType,
    language: params?.tech?.language,
    frontendStack: params?.tech?.frontendStack,
    backendStack: params?.tech?.backendStack,
    ciProvider: params?.tech?.ciProvider,
  });
  return {
    productType,
    language: tech.language,
    frontendStack: tech.frontendStack,
    backendStack: tech.backendStack,
    ciProvider: tech.ciProvider,
  };
}

function renderTemplate(text, vars) {
  const source = String(text ?? "");
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_all, key) => {
    const value = vars && Object.prototype.hasOwnProperty.call(vars, key)
      ? vars[key]
      : "";
    return String(value ?? "");
  });
}

function loadOfficialManifest() {
  const parsed = readJsonFile(OFFICIAL_MANIFEST_PATH, {});
  const profiles = parsed?.profiles && typeof parsed.profiles === "object"
    ? parsed.profiles
    : {};
  return {
    version: Number(parsed?.version ?? 1) || 1,
    profiles,
  };
}

function resolveOfficialRoleMap(productType) {
  const manifest = loadOfficialManifest();
  const key = String(productType ?? "web").trim() || "web";
  const profile = manifest.profiles[key]
    ?? manifest.profiles.web
    ?? manifest.profiles.other
    ?? {};
  const roleMap = parseRoleMap(profile?.roles);
  return {
    roleMap,
    profileKey: profile === manifest.profiles[key]
      ? key
      : (manifest.profiles.web ? "web" : "other"),
  };
}

function loadProjectRoleConfig(rootPath) {
  const mapPath = path.join(rootPath, ".forgeops", "agent-skills.json");
  const parsed = readJsonFile(mapPath, null);
  if (!parsed) {
    return {
      roles: {},
      tech: null,
      productType: "",
      mapPath,
      exists: false,
    };
  }

  const tech = parsed?.tech && typeof parsed.tech === "object"
    ? {
        language: String(parsed.tech.language ?? ""),
        frontendStack: String(parsed.tech.frontendStack ?? ""),
        backendStack: String(parsed.tech.backendStack ?? ""),
        ciProvider: String(parsed.tech.ciProvider ?? ""),
      }
    : null;

  return {
    roles: parseRoleMap(parsed?.roles),
    tech,
    productType: String(parsed?.productType ?? "").trim(),
    mapPath,
    exists: true,
  };
}

function loadUserGlobalRoleMap(runtimeHome) {
  const filePath = path.join(runtimeHome, "skills-global", "catalog", "roles.json");
  const parsed = readJsonFile(filePath, null);
  if (!parsed) {
    return {
      roles: {},
      filePath,
      exists: false,
    };
  }
  const rolesRoot = parsed?.roles && typeof parsed.roles === "object"
    ? parsed.roles
    : parsed;
  return {
    roles: parseRoleMap(rolesRoot),
    filePath,
    exists: true,
  };
}

function toDisplayPath(filePath, layer, options = {}) {
  if (layer === "project-local") {
    const projectRoot = String(options.projectRootPath ?? "");
    if (projectRoot) {
      return path.relative(projectRoot, filePath);
    }
  }

  if (layer === "user-global") {
    const runtimeHome = String(options.runtimeHome ?? "");
    if (runtimeHome && filePath.startsWith(runtimeHome)) {
      const rel = path.relative(runtimeHome, filePath);
      return `~/.forgeops/${rel.replace(/\\/g, "/")}`;
    }
  }

  if (layer === "official") {
    const rel = path.relative(REPO_ROOT, filePath);
    return rel.replace(/\\/g, "/");
  }

  return filePath;
}

function toSkillMentionPath(filePath, layer, options = {}) {
  const resolved = String(filePath ?? "").trim();
  if (!resolved) return "";

  if (layer === "project-local") {
    const projectRoot = String(options.projectRootPath ?? "").trim();
    if (projectRoot) {
      return path.relative(projectRoot, resolved).replace(/\\/g, "/");
    }
  }

  // For user-global/official layers, keep absolute paths so Codex can resolve them
  // regardless of the current project worktree cwd.
  return resolved;
}

function readSkillDescriptor(params) {
  const skillPath = params?.skillPath ? path.resolve(params.skillPath) : "";
  if (!skillPath || !fs.existsSync(skillPath)) return null;

  const source = String(params?.source ?? "").trim();
  const shouldRenderTemplate = params?.renderTemplate === true;
  const templateVars = params?.templateVars && typeof params.templateVars === "object"
    ? params.templateVars
    : {};

  const raw = fs.readFileSync(skillPath, "utf8");
  const text = shouldRenderTemplate ? renderTemplate(raw, templateVars) : raw;
  const parsed = parseFrontmatter(text);
  const fallbackName = path.basename(path.dirname(skillPath));
  const name = String(parsed.name ?? "").trim() || fallbackName;
  const description = String(parsed.description ?? "").trim();
  const contentHash = createHash("sha256").update(text).digest("hex");
  const mentionPath = toSkillMentionPath(skillPath, source, {
    projectRootPath: params?.projectRootPath,
    runtimeHome: params?.runtimeHome,
  });

  return {
    name,
    description,
    source,
    path: toDisplayPath(skillPath, source, {
      projectRootPath: params?.projectRootPath,
      runtimeHome: params?.runtimeHome,
    }),
    absolutePath: skillPath,
    mentionPath,
    contentHash,
  };
}

function resolveSkillDescriptorByPriority(params) {
  const skillName = String(params?.skillName ?? "").trim();
  if (!skillName) return null;

  const projectRootPath = path.resolve(String(params?.projectRootPath ?? ""));
  const runtimeHome = resolveRuntimeHome(params?.runtimeHome);
  const templateVars = params?.templateVars && typeof params.templateVars === "object"
    ? params.templateVars
    : {};

  const projectSkillPath = path.join(projectRootPath, ".forgeops", "skills", skillName, "SKILL.md");
  if (fs.existsSync(projectSkillPath)) {
    return readSkillDescriptor({
      skillPath: projectSkillPath,
      source: "project-local",
      projectRootPath,
      runtimeHome,
      templateVars,
      renderTemplate: false,
    });
  }

  const globalSkillPath = path.join(runtimeHome, "skills-global", "skills", skillName, "SKILL.md");
  if (fs.existsSync(globalSkillPath)) {
    return readSkillDescriptor({
      skillPath: globalSkillPath,
      source: "user-global",
      projectRootPath,
      runtimeHome,
      templateVars,
      renderTemplate: false,
    });
  }

  const officialSkillPath = path.join(OFFICIAL_SKILLS_ROOT, "skills", skillName, "SKILL.md");
  if (fs.existsSync(officialSkillPath)) {
    return readSkillDescriptor({
      skillPath: officialSkillPath,
      source: "official",
      projectRootPath,
      runtimeHome,
      templateVars,
      renderTemplate: true,
    });
  }

  return null;
}

function collectRoleSkillNames(roleMap) {
  const out = [];
  for (const agentId of AGENT_IDS) {
    const list = Array.isArray(roleMap?.[agentId]) ? roleMap[agentId] : [];
    for (const name of list) {
      const normalized = String(name ?? "").trim();
      if (!normalized) continue;
      if (out.includes(normalized)) continue;
      out.push(normalized);
    }
  }
  return out;
}

export function getOfficialSkillsInfo() {
  const manifest = loadOfficialManifest();
  return {
    rootPath: OFFICIAL_SKILLS_ROOT,
    manifestPath: OFFICIAL_MANIFEST_PATH,
    version: manifest.version,
    profiles: Object.keys(manifest.profiles ?? {}),
  };
}

export function normalizeTechProfile(meta) {
  const productType = String(meta.productType ?? "web");

  const language = String(meta.language ?? "").trim()
    || (productType === "ios"
      ? "swift"
      : (productType === "microservice"
        ? "python"
        : (productType === "android" ? "kotlin" : "typescript")));

  const frontendStack = String(meta.frontendStack ?? "").trim()
    || (productType === "ios"
      ? "swiftui"
      : (productType === "miniapp"
        ? "wechat-miniapp-native"
        : (productType === "microservice"
          ? "none"
          : (productType === "android"
            ? "jetpack-compose"
            : (productType === "serverless" ? "none" : "lit+vite")))));

  const backendStack = String(meta.backendStack ?? "").trim()
    || (productType === "ios"
      ? "optional-api-service"
      : (productType === "microservice"
        ? "python-fastapi"
        : (productType === "android"
          ? "optional-api-service"
          : (productType === "serverless" ? "aws-lambda-nodejs" : "nodejs-fastify"))));

  const ciProvider = String(meta.ciProvider ?? "").trim() || "github-actions";

  return {
    language,
    frontendStack,
    backendStack,
    ciProvider,
  };
}

export function scaffoldProjectSkills(meta) {
  const rootPath = path.resolve(meta.rootPath);
  const productType = String(meta.productType ?? "web").trim() || "web";
  const tech = normalizeTechProfile({
    productType,
    language: meta.language,
    frontendStack: meta.frontendStack,
    backendStack: meta.backendStack,
    ciProvider: meta.ciProvider,
  });

  const templateVars = buildTemplateVars({
    productType,
    tech,
  });

  const official = resolveOfficialRoleMap(productType);
  const roleMap = official.roleMap;
  const writes = [];

  const mapPath = path.join(rootPath, ".forgeops", "agent-skills.json");
  const mapContent = `${JSON.stringify({
    version: 2,
    productType,
    tech,
    roles: roleMap,
    roleLayers: ["official", "user-global", "project-local"],
  }, null, 2)}\n`;
  writes.push({
    path: ".forgeops/agent-skills.json",
    created: writeIfMissing(mapPath, mapContent),
  });

  const allSkillNames = collectRoleSkillNames(roleMap);
  for (const skillName of allSkillNames) {
    const officialSkillPath = path.join(OFFICIAL_SKILLS_ROOT, "skills", skillName, "SKILL.md");
    if (!fs.existsSync(officialSkillPath)) {
      throw new Error(`Official skill missing: ${skillName}`);
    }
    const rendered = renderTemplate(fs.readFileSync(officialSkillPath, "utf8"), templateVars);
    const skillPath = path.join(rootPath, ".forgeops", "skills", skillName, "SKILL.md");
    writes.push({
      path: path.relative(rootPath, skillPath),
      created: writeIfMissing(skillPath, rendered),
    });
  }

  return {
    writes,
    roleMap,
    tech,
    officialProfile: official.profileKey,
  };
}

export function loadProjectAgentSkills(rootPath) {
  const projectRoot = path.resolve(rootPath);
  const cfg = loadProjectRoleConfig(projectRoot);
  const out = {};

  for (const agentId of AGENT_IDS) {
    const names = Array.isArray(cfg.roles?.[agentId]) ? cfg.roles[agentId] : [];
    const items = [];
    for (const name of names) {
      const skillPath = path.join(projectRoot, ".forgeops", "skills", name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const meta = parseFrontmatter(fs.readFileSync(skillPath, "utf8"));
      items.push({
        name: String(meta.name ?? "").trim() || name,
        description: String(meta.description ?? "").trim(),
        source: "project-local",
        path: path.relative(projectRoot, skillPath),
      });
    }
    if (items.length > 0) {
      out[agentId] = items;
    }
  }

  return out;
}

export function resolveAgentSkills(params) {
  const projectRootPath = path.resolve(String(params?.projectRootPath ?? ""));
  const runtimeHome = resolveRuntimeHome(params?.runtimeHome);

  const projectCfg = loadProjectRoleConfig(projectRootPath);
  const effectiveProductType = String(
    params?.productType
      ?? projectCfg.productType
      ?? "web"
  ).trim() || "web";

  const tech = normalizeTechProfile({
    productType: effectiveProductType,
    language: params?.techProfile?.language ?? projectCfg.tech?.language,
    frontendStack: params?.techProfile?.frontendStack ?? projectCfg.tech?.frontendStack,
    backendStack: params?.techProfile?.backendStack ?? projectCfg.tech?.backendStack,
    ciProvider: params?.techProfile?.ciProvider ?? projectCfg.tech?.ciProvider,
  });

  const templateVars = buildTemplateVars({
    productType: effectiveProductType,
    tech,
  });

  const official = resolveOfficialRoleMap(effectiveProductType);
  const userGlobal = loadUserGlobalRoleMap(runtimeHome);
  const effectiveRoleMap = mergeRoleMaps(
    official.roleMap,
    userGlobal.roles,
    projectCfg.roles,
  );

  const out = {};
  for (const agentId of AGENT_IDS) {
    const names = Array.isArray(effectiveRoleMap?.[agentId]) ? effectiveRoleMap[agentId] : [];
    const items = [];
    for (const name of names) {
      const resolved = resolveSkillDescriptorByPriority({
        skillName: name,
        projectRootPath,
        runtimeHome,
        templateVars,
      });
      if (!resolved) continue;
      items.push(resolved);
    }
    if (items.length > 0) {
      out[agentId] = items;
    }
  }

  return {
    agentSkills: out,
    productType: effectiveProductType,
    techProfile: tech,
    roleMaps: {
      official: official.roleMap,
      userGlobal: userGlobal.roles,
      project: projectCfg.roles,
      effective: effectiveRoleMap,
    },
    layerInfo: {
      officialRoot: OFFICIAL_SKILLS_ROOT,
      officialManifestPath: OFFICIAL_MANIFEST_PATH,
      userGlobalRoot: path.join(runtimeHome, "skills-global"),
      projectMapPath: projectCfg.mapPath,
      userGlobalRoleMapPath: userGlobal.filePath,
      officialProfile: official.profileKey,
    },
  };
}

export function loadProjectTechProfile(rootPath) {
  const cfg = loadProjectRoleConfig(path.resolve(rootPath));
  return cfg.tech;
}
