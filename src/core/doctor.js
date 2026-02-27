import { spawnSync } from "node:child_process";
import { getGitHubAuthStatus, getRequiredGitHubPatScopes, validateGitHubPat } from "./github-auth.js";

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function commandExists(name) {
  const checker = process.platform === "win32" ? "where" : "which";
  const res = run(checker, [name]);
  return res.ok;
}

function buildCheck(id, title, ok, detail, hint = "") {
  return {
    id,
    title,
    ok: Boolean(ok),
    detail: String(detail ?? ""),
    hint: String(hint ?? ""),
  };
}

export function runDoctor() {
  const checks = [];

  const gitExists = commandExists("git");
  checks.push(
    buildCheck(
      "git.installed",
      "git 命令可用",
      gitExists,
      gitExists ? "git 已安装" : "未找到 git 命令",
      gitExists ? "" : "安装 git 并确保 PATH 可访问"
    )
  );

  const ghExists = commandExists("gh");
  checks.push(
    buildCheck(
      "gh.installed",
      "gh 命令可用",
      ghExists,
      ghExists ? "gh 已安装" : "未找到 gh 命令",
      ghExists ? "" : "安装 GitHub CLI 并确保 PATH 可访问"
    )
  );

  const codexExists = commandExists("codex");
  checks.push(
    buildCheck(
      "runtime.codex_installed",
      "Codex Runtime 命令可用",
      codexExists,
      codexExists ? "codex 已安装" : "未找到 codex 命令",
      codexExists ? "" : "安装 codex CLI，并确保 'codex' 可执行"
    )
  );

  if (codexExists) {
    const ver = run("codex", ["--version"]);
    checks.push(
      buildCheck(
        "runtime.codex_version",
        "Codex Runtime 版本检查",
        ver.ok,
        ver.ok ? (ver.stdout || "codex --version ok") : (ver.stderr || ver.error || "codex --version failed"),
        ver.ok ? "" : "检查 codex 安装是否完整，或重新登录/升级"
      )
    );
  } else {
    checks.push(
      buildCheck(
        "runtime.codex_version",
        "Codex Runtime 版本检查",
        false,
        "跳过：codex 不可用",
        "先修复 runtime.codex_installed"
      )
    );
  }

  if (gitExists) {
    const name = run("git", ["config", "--global", "--get", "user.name"]);
    const email = run("git", ["config", "--global", "--get", "user.email"]);
    const ok = name.ok && email.ok && Boolean(name.stdout) && Boolean(email.stdout);
    checks.push(
      buildCheck(
        "git.identity.global",
        "全局 Git 身份配置",
        ok,
        ok ? `user.name=${name.stdout}, user.email=${email.stdout}` : "缺少全局 git user.name 或 user.email",
        ok ? "" : "执行: git config --global user.name \"<name>\" && git config --global user.email \"<email>\""
      )
    );
  } else {
    checks.push(
      buildCheck(
        "git.identity.global",
        "全局 Git 身份配置",
        false,
        "跳过：git 不可用",
        "先修复 git.installed"
      )
    );
  }

  const githubAuth = getGitHubAuthStatus();
  checks.push(
    buildCheck(
      "github.pat.configured",
      "GitHub PAT (classic) 已配置",
      githubAuth.patConfigured,
      githubAuth.patConfigured
        ? `已配置: ${githubAuth.patMasked}`
        : "未配置 GitHub PAT (classic)",
      githubAuth.patConfigured
        ? ""
        : `到系统配置页填写 PAT（classic），至少包含 scope: ${getRequiredGitHubPatScopes().join(", ")}`
    )
  );

  if (!ghExists) {
    checks.push(
      buildCheck(
        "github.pat.validation",
        "GitHub PAT 可用性验证",
        false,
        "跳过：gh 不可用",
        "先修复 gh.installed"
      )
    );
    checks.push(
      buildCheck(
        "github.pat.scopes",
        "GitHub PAT Scope 校验",
        false,
        "跳过：gh 不可用",
        "先修复 gh.installed"
      )
    );
  } else if (!githubAuth.patConfigured) {
    checks.push(
      buildCheck(
        "github.pat.validation",
        "GitHub PAT 可用性验证",
        false,
        "跳过：PAT 未配置",
        "到系统配置页填写 PAT（classic）"
      )
    );
    checks.push(
      buildCheck(
        "github.pat.scopes",
        "GitHub PAT Scope 校验",
        false,
        `跳过：PAT 未配置（要求 scope: ${getRequiredGitHubPatScopes().join(", ")}）`,
        "到系统配置页填写 PAT（classic）并补齐 scope"
      )
    );
  } else {
    const validation = validateGitHubPat();
    checks.push(
      buildCheck(
        "github.pat.validation",
        "GitHub PAT 可用性验证",
        validation.valid,
        validation.detail,
        validation.valid ? "" : "检查 PAT 是否过期/失效，并重新在系统配置中更新"
      )
    );
    checks.push(
      buildCheck(
        "github.pat.scopes",
        "GitHub PAT Scope 校验",
        validation.scopesOk,
        validation.scopesOk
          ? `scope 满足要求: ${validation.scopes.join(", ")}`
          : `缺失 scope: ${validation.missingScopes.join(", ")}（要求: ${validation.requiredScopes.join(", ")}）`,
        validation.scopesOk ? "" : "重新生成 PAT（classic），勾选所需 scope 后更新到系统配置"
      )
    );
  }

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    checkedAt: new Date().toISOString(),
    checks,
  };
}
