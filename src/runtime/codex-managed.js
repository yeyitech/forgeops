import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

function parseBooleanLike(value, fallback) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function toPlainError(err) {
  if (!err) return "";
  return err instanceof Error ? err.message : String(err);
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function safeReadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function resolveDefaultUserCodexHome() {
  // Codex resolves CODEX_HOME internally; for ForgeOps-managed runs we use a
  // best-effort default that matches typical local installs.
  const envHome = String(process.env.CODEX_HOME ?? "").trim();
  if (envHome) return envHome;
  return path.join(os.homedir(), ".codex");
}

async function ensureIsolatedOsHome(params) {
  const repoRoot = path.resolve(String(params?.repoRoot ?? ""));
  const isolate = parseBooleanLike(params?.isolate, true);
  if (!repoRoot || !isolate) {
    return {
      ok: true,
      homeDir: "",
      env: {},
      warnings: [],
    };
  }

  const warnings = [];
  const homeDir = path.join(repoRoot, ".forgeops-runtime", "home");
  await ensureDir(homeDir);

  // Minimal XDG layout so tools that expect it can still work deterministically.
  try {
    await ensureDir(path.join(homeDir, ".config"));
    await ensureDir(path.join(homeDir, ".cache"));
    await ensureDir(path.join(homeDir, ".local", "share"));
  } catch (err) {
    warnings.push(`failed to setup XDG dirs: ${toPlainError(err)}`);
  }

  return {
    ok: true,
    homeDir,
    env: {
      HOME: homeDir,
      // Some tooling on Windows reads USERPROFILE; keep parity even if unused on macOS.
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: path.join(homeDir, ".config"),
      XDG_CACHE_HOME: path.join(homeDir, ".cache"),
      XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    },
    warnings,
  };
}

function normalizeSkillItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const absPath = String(item.absolutePath ?? "").trim();
    if (!absPath) continue;
    const name = String(item.name ?? "").trim();
    const description = String(item.description ?? "").trim();
    const source = String(item.source ?? "").trim();
    out.push({
      name,
      description,
      source,
      absolutePath: absPath,
    });
  }
  return out;
}

function deriveSkillDirName(skill) {
  // Prefer stable directory name derived from on-disk layout, not from frontmatter
  // (frontmatter name may include spaces or be user-facing).
  const dir = path.basename(path.dirname(skill.absolutePath));
  return dir || "skill";
}

async function unlinkIfSymlink(p) {
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) {
      await fs.unlink(p);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function removeManagedSymlinks(skillsRoot) {
  // Conservative cleanup:
  // - remove previously managed symlinks recorded in manifest
  // - also remove any stray symlinks (ForgeOps may have crashed mid-update)
  const manifestPath = path.join(skillsRoot, ".forgeops-managed.json");
  const manifest = await safeReadJson(manifestPath, null);
  const managedNames = Array.isArray(manifest?.skills)
    ? manifest.skills.map((row) => String(row?.linkName ?? "").trim()).filter(Boolean)
    : [];

  for (const name of managedNames) {
    await unlinkIfSymlink(path.join(skillsRoot, name));
  }

  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    for (const ent of entries) {
      const name = ent.name;
      if (!name || name === ".forgeops-managed.json") continue;
      // Only remove symlinks; never delete real directories/files to avoid
      // clobbering user-owned `.agents/skills` content.
      await unlinkIfSymlink(path.join(skillsRoot, name));
    }
  } catch {
    // ignore
  }
}

async function materializeRoleSkillsIntoRepoAgentsRoot(params) {
  const repoRoot = path.resolve(String(params?.repoRoot ?? ""));
  const agentId = String(params?.agentId ?? "").trim();
  const rawSkills = normalizeSkillItems(params?.skills);
  if (!repoRoot || !agentId) {
    return {
      ok: false,
      error: "repoRoot and agentId are required",
      skillsRoot: "",
      installed: [],
      warnings: [],
    };
  }

  const skillsRoot = path.join(repoRoot, ".agents", "skills");
  const warnings = [];
  await ensureDir(skillsRoot);
  await removeManagedSymlinks(skillsRoot);

  const installed = [];
  const usedNames = new Set();

  for (const skill of rawSkills) {
    const targetDir = path.dirname(path.resolve(skill.absolutePath));
    if (!fsSync.existsSync(targetDir)) {
      warnings.push(`skill target missing: ${targetDir}`);
      continue;
    }

    let linkName = deriveSkillDirName(skill);
    if (!linkName) linkName = "skill";
    // Avoid collisions if two skills resolve to same folder name.
    let finalName = linkName;
    let n = 2;
    while (usedNames.has(finalName)) {
      finalName = `${linkName}-${n}`;
      n += 1;
    }
    usedNames.add(finalName);

    const linkPath = path.join(skillsRoot, finalName);
    try {
      await fs.symlink(targetDir, linkPath, "dir");
      installed.push({
        linkName: finalName,
        targetDir,
        skillName: skill.name,
        source: skill.source,
      });
    } catch (err) {
      warnings.push(`failed to symlink skill '${finalName}' -> ${targetDir}: ${toPlainError(err)}`);
    }
  }

  const manifestPath = path.join(skillsRoot, ".forgeops-managed.json");
  try {
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          managed_by: "forgeops",
          agent_id: agentId,
          updated_at: new Date().toISOString(),
          skills: installed,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (err) {
    warnings.push(`failed to write skills manifest: ${toPlainError(err)}`);
  }

  return {
    ok: true,
    error: "",
    skillsRoot,
    installed,
    warnings,
  };
}

async function ensureIsolatedCodexHome(params) {
  const repoRoot = path.resolve(String(params?.repoRoot ?? ""));
  const isolate = parseBooleanLike(params?.isolate, true);
  if (!repoRoot || !isolate) {
    return {
      ok: true,
      codexHome: "",
      env: {},
      warnings: [],
    };
  }

  const warnings = [];
  const codexHome = path.join(repoRoot, ".forgeops-runtime", "codex-home");
  await ensureDir(codexHome);

  const sourceHome = String(params?.sourceCodexHome ?? "").trim() || resolveDefaultUserCodexHome();
  const sourceAuth = path.join(sourceHome, "auth.json");
  const targetAuth = path.join(codexHome, "auth.json");
  if (await pathExists(sourceAuth)) {
    try {
      await fs.copyFile(sourceAuth, targetAuth);
    } catch (err) {
      warnings.push(`failed to copy auth.json into isolated CODEX_HOME: ${toPlainError(err)}`);
    }
  } else {
    warnings.push(`source auth.json not found at ${sourceAuth}; Codex may require login in this managed run`);
  }

  return {
    ok: true,
    codexHome,
    env: {
      CODEX_HOME: codexHome,
      // Keep Codex thread DB and session logs co-located with the managed worktree.
      CODEX_SQLITE_HOME: codexHome,
    },
    warnings,
  };
}

function isReservedEnvKey(key) {
  const k = String(key ?? "").trim();
  if (!k) return true;
  if (k === "HOME" || k === "USERPROFILE") return true;
  if (k.startsWith("XDG_")) return true;
  if (k.startsWith("FORGEOPS_")) return true;
  if (k.startsWith("CODEX_")) return true;
  if (k === "CODEX_HOME" || k === "CODEX_SQLITE_HOME" || k === "FORGEOPS_HOME") return true;
  return false;
}

function normalizeExtraEnv(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const env = {};
  const warnings = [];
  for (const [key, value] of Object.entries(input)) {
    const k = String(key ?? "").trim();
    if (!k) continue;
    if (isReservedEnvKey(k)) {
      warnings.push(`ignored reserved env key: ${k}`);
      continue;
    }
    env[k] = String(value ?? "");
  }
  return { env, warnings };
}

export async function prepareManagedCodexEnvironment(params) {
  const repoRoot = path.resolve(String(params?.repoRoot ?? ""));
  const agentId = String(params?.agentId ?? "").trim();
  const skills = normalizeSkillItems(params?.skills);
  const isolateCodexHome = parseBooleanLike(
    params?.isolateHome ?? process.env.FORGEOPS_CODEX_ISOLATE_HOME,
    true,
  );
  const isolateOsHome = parseBooleanLike(
    params?.isolateOsHome ?? process.env.FORGEOPS_CODEX_ISOLATE_OS_HOME,
    true,
  );

  const skillRoot = await materializeRoleSkillsIntoRepoAgentsRoot({
    repoRoot,
    agentId,
    skills,
  });

  const osHome = await ensureIsolatedOsHome({
    repoRoot,
    isolate: isolateOsHome,
  });

  const codexHome = await ensureIsolatedCodexHome({
    repoRoot,
    isolate: isolateCodexHome,
    sourceCodexHome: params?.sourceCodexHome,
  });

  const extraEnv = normalizeExtraEnv(params?.extraEnv);
  const env = {
    ...codexHome.env,
    ...osHome.env,
    FORGEOPS_REPO_ROOT: repoRoot,
    FORGEOPS_AGENT_ID: agentId,
    FORGEOPS_MANAGED_SKILLS_ROOT: skillRoot.skillsRoot || "",
    ...extraEnv.env,
  };

  return {
    ok: skillRoot.ok && codexHome.ok && osHome.ok,
    cwd: repoRoot,
    env,
    codexHome: codexHome.codexHome || "",
    skillsRoot: skillRoot.skillsRoot || "",
    installedSkills: skillRoot.installed ?? [],
    warnings: [
      ...(skillRoot.warnings ?? []),
      ...(osHome.warnings ?? []),
      ...(codexHome.warnings ?? []),
      ...(extraEnv.warnings ?? []),
    ],
  };
}
