#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const PRODUCT_TYPE = "web";
const STRICT = process.argv.includes("--strict");
const JSON_OUTPUT = process.argv.includes("--json");

function check(id, title, ok, required, detail, hint = "") {
  return {
    id,
    title,
    ok: Boolean(ok),
    required: Boolean(required),
    detail: String(detail ?? ""),
    hint: String(hint ?? ""),
  };
}

function run(command, args = [], timeout = 5000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : "",
  };
}

function resolveCommandPath(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const out = run(checker, [command], 1800);
  if (!out.ok) return "";
  const first = out.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first ?? "";
}

function resolveFirstCommandPath(commands) {
  const list = Array.isArray(commands) ? commands : [commands];
  for (const item of list) {
    const command = String(item ?? "").trim();
    if (!command) continue;
    const commandPath = resolveCommandPath(command);
    if (commandPath) {
      return {
        command,
        path: commandPath,
      };
    }
  }
  return {
    command: "",
    path: "",
  };
}

function detectWechatCliPath() {
  const envPath = String(process.env.FORGEOPS_WECHAT_DEVTOOLS_CLI ?? "").trim();
  const candidates = [];
  if (envPath) candidates.push(envPath);
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
      "/Applications/wechatdevtools.app/Contents/MacOS/cli",
      "/Applications/微信开发者工具.app/Contents/MacOS/cli",
    );
  }
  for (const item of candidates) {
    const abs = path.resolve(item);
    if (fs.existsSync(abs)) return abs;
  }
  return "";
}

function probeWechatCliRuntime(cliPath) {
  if (!cliPath) {
    return {
      servicePortEnabled: false,
      loggedIn: false,
      detail: "cli path missing",
      hint: "先安装微信开发者工具并配置 FORGEOPS_WECHAT_DEVTOOLS_CLI。",
    };
  }

  const probe = spawnSync(cliPath, ["islogin", "--lang", "zh"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: "n\n",
    timeout: 8000,
  });
  const stdout = String(probe.stdout ?? "").trim();
  const stderr = String(probe.stderr ?? "").trim();
  const combined = stdout + "\n" + stderr;
  const combinedLower = combined.toLowerCase();
  const servicePortDisabled = combinedLower.includes("service port disabled")
    || combined.includes("服务端口已关闭")
    || combined.includes("工具的服务端口已关闭");
  const servicePortEnabled = !servicePortDisabled;
  const loggedIn = probe.status === 0
    || combinedLower.includes("islogin: true")
    || combinedLower.includes("is login: true")
    || combined.includes("已登录");

  let detail = "";
  if (servicePortDisabled) {
    detail = "检测到 IDE 服务端口关闭";
  } else if (probe.error) {
    detail = String(probe.error.message ?? probe.error);
  } else if (combined.trim()) {
    detail = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" | ");
  } else {
    detail = "exit=" + String(probe.status ?? -1);
  }

  return {
    servicePortEnabled,
    loggedIn,
    detail,
    hint: servicePortEnabled
      ? ""
      : "打开微信开发者工具 -> 设置 -> 安全设置，开启“服务端口”；或首次 CLI 提示时输入 y。",
  };
}

function readJsonFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function resolvePythonCommand() {
  const python = resolveFirstCommandPath(["python3", "python"]);
  return python.path ? python.command : "";
}

function resolvePythonDependencySyncCommand() {
  const fromEnv = String(process.env.FORGEOPS_PYTHON_DEPS_SYNC_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_PYTHON_DEPS_SYNC_CMD",
    };
  }
  const python = resolvePythonCommand();
  const hasPyproject = fs.existsSync(path.join(ROOT, "pyproject.toml"));
  const hasRequirements = fs.existsSync(path.join(ROOT, "requirements.txt"));
  const uv = resolveCommandPath("uv");
  if (hasPyproject && uv) {
    return {
      command: "uv sync",
      source: "pyproject.toml + uv",
    };
  }
  const poetry = resolveCommandPath("poetry");
  if (hasPyproject && poetry) {
    return {
      command: "poetry install",
      source: "pyproject.toml + poetry",
    };
  }
  if (hasRequirements && python) {
    return {
      command: python + " -m pip install -r requirements.txt",
      source: "requirements.txt + pip",
    };
  }
  return null;
}

function resolvePythonBackendStartCommand(backendPort) {
  const fromEnv = String(process.env.FORGEOPS_BACKEND_START_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_BACKEND_START_CMD",
    };
  }

  const python = resolvePythonCommand();
  if (!python) return null;

  const asgiCandidates = [
    { file: path.join(ROOT, "app", "main.py"), module: "app.main:app" },
    { file: path.join(ROOT, "service", "main.py"), module: "service.main:app" },
    { file: path.join(ROOT, "api", "main.py"), module: "api.main:app" },
    { file: path.join(ROOT, "main.py"), module: "main:app" },
  ];
  const asgi = asgiCandidates.find((item) => fs.existsSync(item.file));
  if (asgi) {
    return {
      command: python + " -m uvicorn " + asgi.module + " --host 127.0.0.1 --port " + String(backendPort),
      source: "python uvicorn auto-detect",
    };
  }

  if (fs.existsSync(path.join(ROOT, "manage.py"))) {
    return {
      command: python + " manage.py runserver 127.0.0.1:" + String(backendPort),
      source: "manage.py runserver",
    };
  }

  if (fs.existsSync(path.join(ROOT, "main.py"))) {
    return {
      command: python + " main.py",
      source: "main.py",
    };
  }
  return null;
}

function resolveBackendStartCommand(backendPort) {
  const fromEnv = String(process.env.FORGEOPS_BACKEND_START_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_BACKEND_START_CMD",
    };
  }

  const packageJson = readJsonFile("package.json");
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const preferred = [
    "backend:dev",
    "dev:backend",
    "dev:api",
    "start:backend",
    "start:api",
    "server",
    "start",
    "dev",
  ];
  const picked = preferred.find((name) => Boolean(scripts[name]));
  if (picked) {
    return {
      command: "npm run " + picked,
      source: "package.json#scripts." + picked,
    };
  }

  if (PRODUCT_TYPE === "microservice") {
    return resolvePythonBackendStartCommand(backendPort);
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHttp(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function tailText(input, maxLines = 8, maxChars = 800) {
  const text = String(input ?? "").trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-maxLines).join(" | ");
  if (tail.length <= maxChars) return tail;
  return tail.slice(0, Math.max(40, maxChars - 3)) + "...";
}

function hashText(text) {
  const source = String(text ?? "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % 1_000_000;
  }
  return hash;
}

function resolveRunScopedPort(defaultPort = 3000) {
  const fromEnv = Number(process.env.FORGEOPS_BACKEND_PORT ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) {
    return Math.floor(fromEnv);
  }

  const normalizedRoot = String(ROOT ?? "").split(path.sep).join("/");
  const matched = normalizedRoot.match(/\/\.forgeops\/worktrees\/([^/]+)/);
  const runId = String(matched?.[1] ?? "").trim();
  const seed = runId || normalizedRoot || String(process.pid);
  const offset = hashText(seed) % 1000;
  const candidate = defaultPort + offset;
  if (candidate < 1 || candidate > 65535) return defaultPort;
  return candidate;
}

async function runBackendHealthSmoke() {
  const checks = [];
  const backendPort = resolveRunScopedPort(3000);
  const defaultHealthUrl = "http://127.0.0.1:" + String(backendPort) + "/health";
  const healthUrl = String(process.env.FORGEOPS_BACKEND_HEALTH_URL ?? defaultHealthUrl).trim() || defaultHealthUrl;
  const commandInfo = resolveBackendStartCommand(backendPort);
  checks.push(check(
    "backend.start.command",
    "后端启动命令可解析",
    Boolean(commandInfo?.command),
    true,
    commandInfo?.command
      ? ("command=" + commandInfo.command + " (" + commandInfo.source + ")")
      : "未找到后端启动命令",
    commandInfo?.command
      ? ""
      : "请在 package.json 提供 backend:dev/dev:backend/start:backend/start，或设置 FORGEOPS_BACKEND_START_CMD。"
  ));
  if (!commandInfo?.command) return checks;

  const backendProcess = spawn(commandInfo.command, {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      PORT: String(backendPort),
      FORGEOPS_BACKEND_PORT: String(backendPort),
      FORGEOPS_BACKEND_HEALTH_URL: healthUrl,
    },
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  backendProcess.stdout?.on("data", (chunk) => {
    stdoutChunks.push(String(chunk ?? ""));
    if (stdoutChunks.length > 10) stdoutChunks.shift();
  });
  backendProcess.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk ?? ""));
    if (stderrChunks.length > 10) stderrChunks.shift();
  });

  const timeoutMs = Number(process.env.FORGEOPS_BACKEND_START_TIMEOUT_MS ?? 30000);
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);
  let reachable = false;
  let responseStatus = 0;
  let lastError = "";

  while (Date.now() < deadline) {
    const probed = await probeHttp(healthUrl, 1200);
    if (probed.ok) {
      reachable = true;
      responseStatus = Number(probed.status ?? 0);
      break;
    }
    lastError = String(probed.error ?? "");
    if (backendProcess.exitCode !== null) {
      break;
    }
    await delay(1000);
  }

  if (backendProcess.exitCode === null && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
    await delay(1000);
    if (backendProcess.exitCode === null && !backendProcess.killed) {
      backendProcess.kill("SIGKILL");
    }
  }

  const stdoutTail = tailText(stdoutChunks.join(""));
  const stderrTail = tailText(stderrChunks.join(""));
  const detailParts = [];
  detailParts.push("port=" + String(backendPort));
  detailParts.push("url=" + healthUrl);
  detailParts.push("command=" + commandInfo.command);
  if (reachable) {
    detailParts.push("status=" + String(responseStatus));
  } else if (backendProcess.exitCode !== null) {
    detailParts.push("backend exited with code " + String(backendProcess.exitCode));
  } else if (lastError) {
    detailParts.push(lastError);
  } else {
    detailParts.push("health probe timeout");
  }
  if (!reachable && stdoutTail) detailParts.push("stdout_tail=" + stdoutTail);
  if (!reachable && stderrTail) detailParts.push("stderr_tail=" + stderrTail);

  checks.push(check(
    "backend.health.reachable",
    "后端健康检查可达",
    reachable,
    true,
    detailParts.join(" | "),
    reachable
      ? ""
      : "确保后端提供健康检查端点，并通过 FORGEOPS_BACKEND_HEALTH_URL 指定 URL（默认使用 run 级隔离端口）。"
  ));

  return checks;
}

async function miniappChecks() {
  const out = [];
  const miniappRoot = path.join(ROOT, "miniapp");
  out.push(check(
    "miniapp.root.exists",
    "miniapp 目录存在",
    fs.existsSync(miniappRoot),
    true,
    fs.existsSync(miniappRoot) ? "miniapp 目录已找到" : "缺少 miniapp 目录",
    "请确保小程序工程位于项目根目录 miniapp/ 下。"
  ));

  const appJsonPath = path.join(ROOT, "miniapp", "app.json");
  out.push(check(
    "miniapp.app_json.exists",
    "miniapp/app.json 存在",
    fs.existsSync(appJsonPath),
    true,
    fs.existsSync(appJsonPath) ? "app.json 已找到" : "缺少 miniapp/app.json",
    "确认小程序目录结构与 app.json 配置。"
  ));

  const appJson = readJsonFile(path.join("miniapp", "app.json"));
  const pages = Array.isArray(appJson?.pages) ? appJson.pages : [];
  out.push(check(
    "miniapp.app_json.pages",
    "app.json 声明 pages 列表",
    pages.length > 0,
    true,
    pages.length > 0 ? "pages=" + pages.length : "app.json 未配置 pages",
    "在 app.json 中声明页面路由。"
  ));

  for (const rawPage of pages) {
    const page = String(rawPage ?? "").trim();
    if (!page) continue;
    const jsPath = path.join(ROOT, "miniapp", page + ".js");
    const tsPath = path.join(ROOT, "miniapp", page + ".ts");
    const hasJs = fs.existsSync(jsPath);
    out.push(check(
      "miniapp.page_entry." + page,
      "页面脚本存在: " + page,
      hasJs,
      true,
      hasJs ? "entry=" + path.relative(ROOT, jsPath) : "缺少 " + path.relative(ROOT, jsPath),
      fs.existsSync(tsPath)
        ? "发现 TypeScript 源文件，请先生成 .js 产物后再验收（例如 npm run build:miniapp）。"
        : "补充页面 JS 入口文件。"
    ));
  }

  const projectConfigPath = path.join(ROOT, "miniapp", "project.config.json");
  out.push(check(
    "miniapp.project_config.exists",
    "miniapp/project.config.json 存在",
    fs.existsSync(projectConfigPath),
    true,
    fs.existsSync(projectConfigPath) ? "project.config.json 已找到" : "缺少 miniapp/project.config.json",
    "导入微信开发者工具前需要项目配置文件。"
  ));

  const cliPath = detectWechatCliPath();
  out.push(check(
    "miniapp.devtools.cli.path",
    "微信开发者工具 CLI 可定位",
    Boolean(cliPath),
    true,
    cliPath ? "cli=" + cliPath : "未找到微信开发者工具 CLI",
    "安装微信开发者工具，或设置 FORGEOPS_WECHAT_DEVTOOLS_CLI。"
  ));
  if (cliPath) {
    const help = run(cliPath, ["--help"], 5000);
    out.push(check(
      "miniapp.devtools.cli.exec",
      "微信开发者工具 CLI 可执行",
      help.ok,
      true,
      help.ok ? "cli --help 执行成功" : (help.stderr || help.error || "执行失败"),
      "检查 CLI 路径权限或重新安装微信开发者工具。"
    ));
    const runtimeProbe = probeWechatCliRuntime(cliPath);
    out.push(check(
      "miniapp.devtools.cli.service_port",
      "微信开发者工具服务端口已开启",
      runtimeProbe.servicePortEnabled,
      true,
      runtimeProbe.detail,
      runtimeProbe.hint
    ));
    out.push(check(
      "miniapp.devtools.cli.login",
      "微信开发者工具登录状态可用",
      runtimeProbe.loggedIn,
      false,
      runtimeProbe.loggedIn ? "islogin 检测通过（已登录）" : "未检测到登录态（不阻断）",
      runtimeProbe.loggedIn ? "" : "如需 preview/upload 自动化，请先登录微信开发者工具。"
    ));
  }

  const backendChecks = await runBackendHealthSmoke();
  out.push(...backendChecks);

  return out;
}

function webChecks() {
  const out = [];
  const packageJson = readJsonFile("package.json");
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const hasBuild = Boolean(scripts.build || scripts["frontend:build"] || scripts.verify);
  out.push(check(
    "web.scripts.build",
    "存在可执行构建/验证脚本",
    hasBuild,
    true,
    hasBuild ? "已发现 build/verify 相关脚本" : "package.json 缺少 build/verify 相关脚本",
    "至少提供 build、verify 或 frontend:build 之一作为 web 验收入口。"
  ));
  const hasPlaywright = Boolean(scripts.e2e || scripts["test:e2e"] || scripts["smoke:web"]);
  out.push(check(
    "web.scripts.e2e",
    "存在 Web UI smoke/e2e 脚本",
    hasPlaywright,
    false,
    hasPlaywright ? "已发现 e2e/smoke 脚本" : "未发现 e2e/smoke 脚本",
    "建议增加 Playwright/Chrome DevTools 验收脚本。"
  ));
  return out;
}

function iosChecks() {
  const out = [];
  const entries = fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [];
  const hasProject = entries.some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"));
  out.push(check(
    "ios.workspace.exists",
    "Xcode 工程存在",
    hasProject,
    true,
    hasProject ? "已探测到 .xcodeproj/.xcworkspace" : "未探测到 Xcode 工程",
    "初始化 iOS 项目后应生成 .xcodeproj 或 .xcworkspace。"
  ));
  if (hasProject) {
    const xcodebuildList = run("xcodebuild", ["-list"], 7000);
    out.push(check(
      "ios.xcodebuild.list",
      "xcodebuild -list 可执行",
      xcodebuildList.ok,
      true,
      xcodebuildList.ok ? "xcodebuild -list 执行成功" : (xcodebuildList.stderr || xcodebuildList.error || "执行失败"),
      "检查工程路径、Xcode 配置与签名配置。"
    ));
  }
  return out;
}

async function microserviceChecks() {
  const out = [];
  const python = resolvePythonCommand();
  const hasPyproject = fs.existsSync(path.join(ROOT, "pyproject.toml"));
  const hasRequirements = fs.existsSync(path.join(ROOT, "requirements.txt"))
    || fs.existsSync(path.join(ROOT, "requirements-dev.txt"));

  out.push(check(
    "microservice.python.manifest",
    "Python 依赖清单存在",
    hasPyproject || hasRequirements,
    true,
    hasPyproject
      ? "found pyproject.toml"
      : (hasRequirements ? "found requirements*.txt" : "未找到 pyproject.toml 或 requirements*.txt"),
    hasPyproject || hasRequirements ? "" : "请提供 pyproject.toml 或 requirements*.txt。"
  ));

  out.push(check(
    "microservice.python.command",
    "Python 命令可用",
    Boolean(python),
    true,
    python ? ("python=" + python) : "未找到 python3/python 命令",
    python ? "" : "安装 Python 3.10+ 并确保 PATH 可访问。"
  ));

  const depSync = resolvePythonDependencySyncCommand();
  out.push(check(
    "microservice.python.deps.sync",
    "依赖同步命令可解析",
    Boolean(depSync?.command),
    true,
    depSync?.command
      ? ("command=" + depSync.command + " (" + depSync.source + ")")
      : "未解析到依赖同步命令",
    depSync?.command
      ? ""
      : "建议配置 uv/poetry/pip 路径，或设置 FORGEOPS_PYTHON_DEPS_SYNC_CMD。"
  ));

  const backendChecks = await runBackendHealthSmoke();
  out.push(...backendChecks);
  return out;
}

function resolveAndroidBuildCommand() {
  const fromEnv = String(process.env.FORGEOPS_ANDROID_BUILD_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_ANDROID_BUILD_CMD",
    };
  }

  const gradleWrapper = path.join(ROOT, "gradlew");
  if (fs.existsSync(gradleWrapper)) {
    return {
      command: "./gradlew assembleDebug",
      source: "gradlew",
    };
  }

  const gradle = resolveCommandPath("gradle");
  const hasGradleProject = fs.existsSync(path.join(ROOT, "settings.gradle"))
    || fs.existsSync(path.join(ROOT, "settings.gradle.kts"))
    || fs.existsSync(path.join(ROOT, "build.gradle"))
    || fs.existsSync(path.join(ROOT, "build.gradle.kts"));
  if (gradle && hasGradleProject) {
    return {
      command: "gradle assembleDebug",
      source: "gradle command + gradle files",
    };
  }
  return null;
}

function androidChecks() {
  const out = [];
  const hasGradleProject = fs.existsSync(path.join(ROOT, "settings.gradle"))
    || fs.existsSync(path.join(ROOT, "settings.gradle.kts"))
    || fs.existsSync(path.join(ROOT, "build.gradle"))
    || fs.existsSync(path.join(ROOT, "build.gradle.kts"));
  out.push(check(
    "android.gradle.project",
    "Android Gradle 工程文件存在",
    hasGradleProject,
    true,
    hasGradleProject ? "found settings.gradle/build.gradle" : "未找到 Gradle 工程文件",
    "请确认仓库根目录包含 Android Gradle 工程（settings.gradle/build.gradle）。"
  ));

  const hasManifest = fs.existsSync(path.join(ROOT, "app", "src", "main", "AndroidManifest.xml"));
  out.push(check(
    "android.manifest.exists",
    "AndroidManifest 存在",
    hasManifest,
    true,
    hasManifest ? "found app/src/main/AndroidManifest.xml" : "缺少 app/src/main/AndroidManifest.xml",
    "请确保 Android app 模块结构完整。"
  ));

  const buildCommand = resolveAndroidBuildCommand();
  out.push(check(
    "android.build.command",
    "Android 构建命令可解析",
    Boolean(buildCommand?.command),
    true,
    buildCommand?.command
      ? ("command=" + buildCommand.command + " (" + buildCommand.source + ")")
      : "未解析到 Android 构建命令",
    buildCommand?.command
      ? ""
      : "设置 FORGEOPS_ANDROID_BUILD_CMD，或提供 gradlew/gradle 工程文件。"
  ));
  return out;
}

function resolveServerlessSmokeCommand() {
  const fromEnv = String(process.env.FORGEOPS_SERVERLESS_SMOKE_CMD ?? "").trim();
  if (fromEnv) {
    return {
      command: fromEnv,
      source: "FORGEOPS_SERVERLESS_SMOKE_CMD",
    };
  }

  const packageJson = readJsonFile("package.json");
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const preferred = ["smoke:serverless", "test:functions", "verify", "test"];
  const picked = preferred.find((name) => Boolean(scripts[name]));
  if (picked) {
    return {
      command: "npm run " + picked,
      source: "package.json#scripts." + picked,
    };
  }

  const deployTool = resolveFirstCommandPath(["serverless", "sls", "sam", "cdk", "vercel", "netlify", "aws"]);
  if (deployTool.path) {
    return {
      command: deployTool.command + " --help",
      source: deployTool.command,
    };
  }
  return null;
}

function serverlessChecks() {
  const out = [];
  const hasInfraManifest = fs.existsSync(path.join(ROOT, "serverless.yml"))
    || fs.existsSync(path.join(ROOT, "serverless.yaml"))
    || fs.existsSync(path.join(ROOT, "template.yml"))
    || fs.existsSync(path.join(ROOT, "template.yaml"))
    || fs.existsSync(path.join(ROOT, "cdk.json"))
    || fs.existsSync(path.join(ROOT, "vercel.json"))
    || fs.existsSync(path.join(ROOT, "netlify.toml"));
  out.push(check(
    "serverless.infra.manifest",
    "Serverless 基础设施清单存在",
    hasInfraManifest,
    true,
    hasInfraManifest ? "found serverless/infra manifest" : "未找到 serverless 模板清单文件",
    "请提供 serverless.yml/template.yaml/cdk.json/vercel.json/netlify.toml 之一。"
  ));

  const hasDepsManifest = fs.existsSync(path.join(ROOT, "package.json"))
    || fs.existsSync(path.join(ROOT, "pyproject.toml"))
    || fs.existsSync(path.join(ROOT, "requirements.txt"))
    || fs.existsSync(path.join(ROOT, "requirements-dev.txt"));
  out.push(check(
    "serverless.deps.manifest",
    "依赖清单存在",
    hasDepsManifest,
    true,
    hasDepsManifest ? "found dependency manifest" : "未找到 package.json/pyproject.toml/requirements*.txt",
    "请补充依赖清单文件。"
  ));

  const smokeCommand = resolveServerlessSmokeCommand();
  out.push(check(
    "serverless.smoke.command",
    "Serverless smoke 命令可解析",
    Boolean(smokeCommand?.command),
    true,
    smokeCommand?.command
      ? ("command=" + smokeCommand.command + " (" + smokeCommand.source + ")")
      : "未解析到 serverless smoke 命令",
    smokeCommand?.command
      ? ""
      : "设置 FORGEOPS_SERVERLESS_SMOKE_CMD，或在 package.json 增加 smoke:serverless/test:functions 脚本。"
  ));
  return out;
}

function otherChecks() {
  return [
    check("other.smoke.placeholder", "通用 smoke 检查", true, true, "other 类型暂无额外平台 smoke 约束"),
  ];
}

async function pickChecks() {
  if (PRODUCT_TYPE === "miniapp") return miniappChecks();
  if (PRODUCT_TYPE === "ios") return iosChecks();
  if (PRODUCT_TYPE === "microservice") return microserviceChecks();
  if (PRODUCT_TYPE === "android") return androidChecks();
  if (PRODUCT_TYPE === "serverless") return serverlessChecks();
  if (PRODUCT_TYPE === "web") return webChecks();
  return otherChecks();
}

async function main() {
  const checks = await pickChecks();
  const requiredFailed = checks.filter((item) => item.required && !item.ok);
  const report = {
    productType: PRODUCT_TYPE,
    checkedAt: new Date().toISOString(),
    ok: requiredFailed.length === 0,
    checks,
    failedRequired: requiredFailed.map((item) => ({
      id: item.id,
      detail: item.detail,
      hint: item.hint,
    })),
  };

  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write("Platform smoke checks:\n");
    for (const item of checks) {
      const badge = item.ok ? "OK" : (item.required ? "FAIL" : "WARN");
      process.stdout.write("- [" + badge + "] " + item.id + " " + item.title + " :: " + item.detail + "\n");
    }
  }

  if (STRICT && !report.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  const message = String(err?.message ?? err);
  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({
      productType: PRODUCT_TYPE,
      checkedAt: new Date().toISOString(),
      ok: false,
      checks: [],
      failedRequired: [
        {
          id: "platform-smoke.runtime.error",
          detail: message,
          hint: "检查平台 smoke 脚本执行环境。",
        },
      ],
    }, null, 2) + "\n");
  } else {
    process.stderr.write("Platform smoke runtime error: " + message + "\n");
  }
  process.exit(1);
});
