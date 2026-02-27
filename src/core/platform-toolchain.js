import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getProductTypeLabel, normalizeProductType } from "./product-type.js";

const COMMAND_CHECK_TIMEOUT_MS = 3500;

function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Number(options.timeoutMs ?? COMMAND_CHECK_TIMEOUT_MS),
  });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  return {
    ok: !result.error && result.status === 0,
    status: Number(result.status ?? -1),
    stdout,
    stderr,
    error: result.error ? String(result.error.message ?? result.error) : "",
  };
}

function resolveCommandPath(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const out = runCommand(checker, [command], { timeoutMs: 1800 });
  if (!out.ok) return "";
  const first = out.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first ?? "";
}

function resolveFirstCommandPath(commands) {
  const list = Array.isArray(commands) ? commands : [commands];
  for (const name of list) {
    const normalized = String(name ?? "").trim();
    if (!normalized) continue;
    const commandPath = resolveCommandPath(normalized);
    if (commandPath) {
      return {
        command: normalized,
        path: commandPath,
      };
    }
  }
  return {
    command: "",
    path: "",
  };
}

function createCheck({ id, title, ok, required = true, detail = "", hint = "" }) {
  return {
    id: String(id),
    title: String(title),
    ok: Boolean(ok),
    required: Boolean(required),
    detail: String(detail ?? ""),
    hint: String(hint ?? ""),
  };
}

function detectWechatDevtoolsCliPath() {
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
    if (fs.existsSync(abs)) {
      return abs;
    }
  }

  return "";
}

function probeWechatDevtoolsCliRuntime(cliPath) {
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
  const combined = `${stdout}\n${stderr}`;
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
  } else if (combined) {
    detail = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" | ");
  } else {
    detail = `exit=${Number(probe.status ?? -1)}`;
  }

  return {
    servicePortEnabled,
    loggedIn,
    detail,
    hint: servicePortEnabled
      ? ""
      : "打开微信开发者工具 → 设置 → 安全设置，开启“服务端口”；或首次 CLI 提示时输入 y。",
  };
}

function runMiniappChecks() {
  const checks = [];
  const nodePath = resolveCommandPath("node");
  checks.push(
    createCheck({
      id: "toolchain.node",
      title: "Node.js 命令可用",
      ok: Boolean(nodePath),
      required: true,
      detail: nodePath ? `node=${nodePath}` : "未找到 node 命令",
      hint: nodePath ? "" : "安装 Node.js 并确保 PATH 可访问。",
    }),
  );

  const npmPath = resolveCommandPath("npm");
  checks.push(
    createCheck({
      id: "toolchain.npm",
      title: "npm 命令可用",
      ok: Boolean(npmPath),
      required: true,
      detail: npmPath ? `npm=${npmPath}` : "未找到 npm 命令",
      hint: npmPath ? "" : "安装 npm 并确保 PATH 可访问。",
    }),
  );

  const supportedPlatform = process.platform === "darwin" || process.platform === "win32";
  checks.push(
    createCheck({
      id: "miniapp.platform.supported",
      title: "微信开发者工具平台支持",
      ok: supportedPlatform,
      required: true,
      detail: supportedPlatform
        ? `platform=${process.platform}`
        : `当前平台 ${process.platform} 不支持微信开发者工具自动化验收`,
      hint: supportedPlatform
        ? ""
        : "请在 macOS 或 Windows 上运行 ForgeOps miniapp 流程。",
    }),
  );

  const cliPath = detectWechatDevtoolsCliPath();
  checks.push(
    createCheck({
      id: "miniapp.devtools.cli.path",
      title: "微信开发者工具 CLI 可定位",
      ok: Boolean(cliPath),
      required: true,
      detail: cliPath ? `cli=${cliPath}` : "未找到微信开发者工具 CLI",
      hint: cliPath
        ? ""
        : "安装微信开发者工具，或设置 FORGEOPS_WECHAT_DEVTOOLS_CLI 指向 cli 可执行文件。",
    }),
  );

  if (cliPath) {
    const help = runCommand(cliPath, ["--help"]);
    checks.push(
      createCheck({
        id: "miniapp.devtools.cli.exec",
        title: "微信开发者工具 CLI 可执行",
        ok: help.ok,
        required: true,
        detail: help.ok ? "cli --help 执行成功" : (help.stderr || help.error || `exit=${help.status}`),
        hint: help.ok ? "" : "重新安装微信开发者工具，或检查 CLI 路径权限。",
      }),
    );

    const runtimeProbe = probeWechatDevtoolsCliRuntime(cliPath);
    checks.push(
      createCheck({
        id: "miniapp.devtools.cli.service_port",
        title: "微信开发者工具服务端口已开启",
        ok: runtimeProbe.servicePortEnabled,
        required: true,
        detail: runtimeProbe.detail,
        hint: runtimeProbe.hint,
      }),
    );
    checks.push(
      createCheck({
        id: "miniapp.devtools.cli.login",
        title: "微信开发者工具登录状态可用",
        ok: runtimeProbe.loggedIn,
        required: false,
        detail: runtimeProbe.loggedIn
          ? "islogin 检测通过（已登录）"
          : "未检测到登录态（不阻断初始化）",
        hint: runtimeProbe.loggedIn
          ? ""
          : "如需 preview/upload 自动化，请先执行微信开发者工具登录。",
      }),
    );
  }

  return checks;
}

function runWebChecks() {
  const checks = [];
  const nodePath = resolveCommandPath("node");
  checks.push(
    createCheck({
      id: "toolchain.node",
      title: "Node.js 命令可用",
      ok: Boolean(nodePath),
      required: true,
      detail: nodePath ? `node=${nodePath}` : "未找到 node 命令",
      hint: nodePath ? "" : "安装 Node.js 并确保 PATH 可访问。",
    }),
  );

  const npmPath = resolveCommandPath("npm");
  checks.push(
    createCheck({
      id: "toolchain.npm",
      title: "npm 命令可用",
      ok: Boolean(npmPath),
      required: true,
      detail: npmPath ? `npm=${npmPath}` : "未找到 npm 命令",
      hint: npmPath ? "" : "安装 npm 并确保 PATH 可访问。",
    }),
  );

  const chromePath = resolveCommandPath("google-chrome")
    || resolveCommandPath("chromium")
    || resolveCommandPath("chromium-browser")
    || resolveCommandPath("msedge");
  const chromeAppExists = process.platform === "darwin" && (
    fs.existsSync("/Applications/Google Chrome.app")
    || fs.existsSync("/Applications/Microsoft Edge.app")
  );
  checks.push(
    createCheck({
      id: "web.browser.devtools",
      title: "浏览器 DevTools 验收能力",
      ok: Boolean(chromePath || chromeAppExists),
      required: false,
      detail: chromePath
        ? `browser=${chromePath}`
        : (chromeAppExists ? "发现可用浏览器 App" : "未探测到 Chrome/Chromium/Edge 可执行"),
      hint: chromePath || chromeAppExists
        ? ""
        : "建议安装 Chrome/Chromium/Edge，便于 Web UI 自动化验收。",
    }),
  );

  return checks;
}

function runIosChecks() {
  const checks = [];
  checks.push(
    createCheck({
      id: "ios.platform.darwin",
      title: "iOS 工具链平台支持",
      ok: process.platform === "darwin",
      required: true,
      detail: `platform=${process.platform}`,
      hint: process.platform === "darwin" ? "" : "iOS 自动化构建与模拟器验收仅支持 macOS。",
    }),
  );

  const xcodebuildPath = resolveCommandPath("xcodebuild");
  checks.push(
    createCheck({
      id: "ios.xcodebuild.path",
      title: "xcodebuild 命令可用",
      ok: Boolean(xcodebuildPath),
      required: true,
      detail: xcodebuildPath ? `xcodebuild=${xcodebuildPath}` : "未找到 xcodebuild",
      hint: xcodebuildPath ? "" : "安装 Xcode Command Line Tools：xcode-select --install",
    }),
  );

  const xcrunPath = resolveCommandPath("xcrun");
  checks.push(
    createCheck({
      id: "ios.xcrun.path",
      title: "xcrun 命令可用",
      ok: Boolean(xcrunPath),
      required: true,
      detail: xcrunPath ? `xcrun=${xcrunPath}` : "未找到 xcrun",
      hint: xcrunPath ? "" : "安装 Xcode 并确认 xcrun 在 PATH 中可用。",
    }),
  );

  if (xcodebuildPath) {
    const version = runCommand("xcodebuild", ["-version"], { timeoutMs: 5000 });
    checks.push(
      createCheck({
        id: "ios.xcodebuild.version",
        title: "xcodebuild 版本检查",
        ok: version.ok,
        required: true,
        detail: version.ok ? version.stdout.split(/\r?\n/).slice(0, 2).join(" | ") : (version.stderr || version.error || `exit=${version.status}`),
        hint: version.ok ? "" : "执行 xcode-select --switch 指向有效 Xcode，或重装 Xcode。",
      }),
    );
  }

  if (xcrunPath) {
    const simctl = runCommand("xcrun", ["simctl", "list", "devices"], { timeoutMs: 7000 });
    checks.push(
      createCheck({
        id: "ios.simctl.devices",
        title: "iOS 模拟器设备列表可读取",
        ok: simctl.ok,
        required: true,
        detail: simctl.ok ? "xcrun simctl list devices 执行成功" : (simctl.stderr || simctl.error || `exit=${simctl.status}`),
        hint: simctl.ok ? "" : "打开 Xcode 至少一次完成组件安装，并初始化 Simulator Runtime。",
      }),
    );
  }

  return checks;
}

function runOtherChecks() {
  const checks = [];
  const nodePath = resolveCommandPath("node");
  checks.push(
    createCheck({
      id: "toolchain.node",
      title: "Node.js 命令可用",
      ok: Boolean(nodePath),
      required: true,
      detail: nodePath ? `node=${nodePath}` : "未找到 node 命令",
      hint: nodePath ? "" : "安装 Node.js 并确保 PATH 可访问。",
    }),
  );
  return checks;
}

function runMicroserviceChecks() {
  const checks = [];

  const python = resolveFirstCommandPath(["python3", "python"]);
  checks.push(
    createCheck({
      id: "toolchain.python",
      title: "Python 命令可用",
      ok: Boolean(python.path),
      required: true,
      detail: python.path ? `${python.command}=${python.path}` : "未找到 python3/python 命令",
      hint: python.path ? "" : "安装 Python 3.10+ 并确保 PATH 可访问。",
    }),
  );

  if (python.path) {
    const version = runCommand(python.command, ["--version"], { timeoutMs: 3000 });
    checks.push(
      createCheck({
        id: "toolchain.python.version",
        title: "Python 版本可读取",
        ok: version.ok,
        required: true,
        detail: version.ok
          ? (version.stdout || version.stderr || "python version ok")
          : (version.stderr || version.error || `exit=${version.status}`),
        hint: version.ok ? "" : "检查 Python 安装或 PATH 配置。",
      }),
    );
  }

  const packageManager = resolveFirstCommandPath(["uv", "poetry", "pip3", "pip"]);
  checks.push(
    createCheck({
      id: "microservice.python.deps.manager",
      title: "Python 依赖管理器可用（uv/poetry/pip）",
      ok: Boolean(packageManager.path),
      required: true,
      detail: packageManager.path
        ? `${packageManager.command}=${packageManager.path}`
        : "未找到 uv/poetry/pip3/pip",
      hint: packageManager.path
        ? ""
        : "建议安装 uv（首选）或 poetry/pip，并确保命令在 PATH 中可用。",
    }),
  );

  const pytestPath = resolveCommandPath("pytest");
  checks.push(
    createCheck({
      id: "microservice.python.pytest",
      title: "pytest 命令可用",
      ok: Boolean(pytestPath),
      required: false,
      detail: pytestPath ? `pytest=${pytestPath}` : "未找到 pytest 命令",
      hint: pytestPath ? "" : "建议安装 pytest 以支持微服务自动化回归。",
    }),
  );

  const dockerPath = resolveCommandPath("docker");
  checks.push(
    createCheck({
      id: "microservice.runtime.docker",
      title: "Docker 运行环境（可选）",
      ok: Boolean(dockerPath),
      required: false,
      detail: dockerPath ? `docker=${dockerPath}` : "未找到 docker 命令",
      hint: dockerPath ? "" : "如需容器化本地验收，建议安装 Docker。",
    }),
  );

  return checks;
}

function runAndroidChecks() {
  const checks = [];

  const javaPath = resolveCommandPath("java");
  checks.push(
    createCheck({
      id: "android.java.path",
      title: "Java 命令可用",
      ok: Boolean(javaPath),
      required: true,
      detail: javaPath ? `java=${javaPath}` : "未找到 java 命令",
      hint: javaPath ? "" : "安装 JDK 17+ 并确保 PATH 可访问。",
    }),
  );

  if (javaPath) {
    const version = runCommand("java", ["-version"], { timeoutMs: 4000 });
    checks.push(
      createCheck({
        id: "android.java.version",
        title: "Java 版本可读取",
        ok: version.ok,
        required: true,
        detail: version.ok
          ? (version.stderr || version.stdout || "java version ok")
          : (version.stderr || version.error || `exit=${version.status}`),
        hint: version.ok ? "" : "检查 JDK 安装与 JAVA_HOME/PATH 配置。",
      }),
    );
  }

  const androidSdkTool = resolveFirstCommandPath(["sdkmanager", "adb"]);
  checks.push(
    createCheck({
      id: "android.sdk.tool",
      title: "Android SDK 工具可用（sdkmanager/adb）",
      ok: Boolean(androidSdkTool.path),
      required: true,
      detail: androidSdkTool.path
        ? `${androidSdkTool.command}=${androidSdkTool.path}`
        : "未找到 sdkmanager/adb 命令",
      hint: androidSdkTool.path
        ? ""
        : "安装 Android SDK Platform-Tools / Command-line Tools 并配置 PATH。",
    }),
  );

  const gradlePath = resolveCommandPath("gradle");
  checks.push(
    createCheck({
      id: "android.gradle.path",
      title: "Gradle 命令可用",
      ok: Boolean(gradlePath),
      required: false,
      detail: gradlePath ? `gradle=${gradlePath}` : "未找到 gradle 命令",
      hint: gradlePath ? "" : "建议安装 Gradle，或在仓库中使用 ./gradlew。",
    }),
  );

  return checks;
}

function runServerlessChecks() {
  const checks = [];

  const runtime = resolveFirstCommandPath(["node", "python3", "python"]);
  checks.push(
    createCheck({
      id: "serverless.runtime.command",
      title: "Serverless 运行时命令可用（node/python）",
      ok: Boolean(runtime.path),
      required: true,
      detail: runtime.path
        ? `${runtime.command}=${runtime.path}`
        : "未找到 node/python3/python 命令",
      hint: runtime.path
        ? ""
        : "安装 Node.js 或 Python 并确保 PATH 可访问。",
    }),
  );

  const dependencyTool = resolveFirstCommandPath(["npm", "pnpm", "yarn", "uv", "poetry", "pip3", "pip"]);
  checks.push(
    createCheck({
      id: "serverless.deps.manager",
      title: "依赖管理器可用",
      ok: Boolean(dependencyTool.path),
      required: true,
      detail: dependencyTool.path
        ? `${dependencyTool.command}=${dependencyTool.path}`
        : "未找到 npm/pnpm/yarn/uv/poetry/pip",
      hint: dependencyTool.path
        ? ""
        : "安装至少一种依赖管理器并确保 PATH 可访问。",
    }),
  );

  const deployTool = resolveFirstCommandPath([
    "serverless",
    "sls",
    "sam",
    "cdk",
    "vercel",
    "netlify",
    "aws",
  ]);
  checks.push(
    createCheck({
      id: "serverless.deploy.tool",
      title: "部署/本地仿真工具可用",
      ok: Boolean(deployTool.path),
      required: true,
      detail: deployTool.path
        ? `${deployTool.command}=${deployTool.path}`
        : "未找到 serverless/sam/cdk/vercel/netlify/aws",
      hint: deployTool.path
        ? ""
        : "按项目技术栈安装对应 CLI（例如 serverless、sam、cdk、vercel 或 netlify）。",
    }),
  );

  return checks;
}

function summarizeFailedChecks(checks) {
  return checks
    .filter((item) => item.required && !item.ok)
    .map((item) => {
      const base = `${item.id}: ${item.detail || "failed"}`;
      return item.hint ? `${base} (hint: ${item.hint})` : base;
    });
}

export function runProductToolchainPreflight(params = {}) {
  const normalized = normalizeProductType(params.productType) || "other";
  const productType = normalized;
  let checks = [];
  if (productType === "miniapp") {
    checks = runMiniappChecks();
  } else if (productType === "ios") {
    checks = runIosChecks();
  } else if (productType === "microservice") {
    checks = runMicroserviceChecks();
  } else if (productType === "android") {
    checks = runAndroidChecks();
  } else if (productType === "serverless") {
    checks = runServerlessChecks();
  } else if (productType === "web") {
    checks = runWebChecks();
  } else {
    checks = runOtherChecks();
  }

  const failedRequired = summarizeFailedChecks(checks);
  return {
    ok: failedRequired.length === 0,
    productType,
    productLabel: getProductTypeLabel(productType),
    checkedAt: new Date().toISOString(),
    checks,
    failedRequired,
  };
}

export function ensureProductToolchainReady(params = {}) {
  const report = runProductToolchainPreflight(params);
  if (typeof params.onCheck === "function") {
    for (const item of report.checks) {
      params.onCheck(item);
    }
  }
  if (!report.ok) {
    const reason = report.failedRequired.join("; ");
    throw new Error(
      `Product toolchain precheck failed (${report.productLabel}): ${reason}`
    );
  }
  return report;
}
