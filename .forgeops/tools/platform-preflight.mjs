#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PRODUCT_TYPE = "web";
const STRICT = process.argv.includes("--strict");
const JSON_OUTPUT = process.argv.includes("--json");

function run(command, args = [], timeout = 3500) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    ok: !result.error && result.status === 0,
    status: Number(result.status ?? -1),
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

function miniappChecks() {
  const out = [];
  const nodePath = resolveCommandPath("node");
  out.push(check("toolchain.node", "Node.js 命令可用", Boolean(nodePath), true, nodePath ? "node=" + nodePath : "未找到 node 命令", "安装 Node.js 并确保 PATH 可访问。"));
  const npmPath = resolveCommandPath("npm");
  out.push(check("toolchain.npm", "npm 命令可用", Boolean(npmPath), true, npmPath ? "npm=" + npmPath : "未找到 npm 命令", "安装 npm 并确保 PATH 可访问。"));
  const supported = process.platform === "darwin" || process.platform === "win32";
  out.push(check("miniapp.platform.supported", "微信开发者工具平台支持", supported, true, "platform=" + process.platform, supported ? "" : "请在 macOS 或 Windows 上运行 miniapp 验收。"));
  const cliPath = detectWechatCliPath();
  out.push(check("miniapp.devtools.cli.path", "微信开发者工具 CLI 可定位", Boolean(cliPath), true, cliPath ? "cli=" + cliPath : "未找到微信开发者工具 CLI", "安装微信开发者工具，或设置 FORGEOPS_WECHAT_DEVTOOLS_CLI。"));
  if (cliPath) {
    const help = run(cliPath, ["--help"], 5000);
    out.push(check("miniapp.devtools.cli.exec", "微信开发者工具 CLI 可执行", help.ok, true, help.ok ? "cli --help 执行成功" : (help.stderr || help.error || "执行失败"), "检查 CLI 路径权限或重新安装微信开发者工具。"));
    const runtimeProbe = probeWechatCliRuntime(cliPath);
    out.push(check("miniapp.devtools.cli.service_port", "微信开发者工具服务端口已开启", runtimeProbe.servicePortEnabled, true, runtimeProbe.detail, runtimeProbe.hint));
    out.push(check("miniapp.devtools.cli.login", "微信开发者工具登录状态可用", runtimeProbe.loggedIn, false, runtimeProbe.loggedIn ? "islogin 检测通过（已登录）" : "未检测到登录态（不阻断初始化）", runtimeProbe.loggedIn ? "" : "如需 preview/upload 自动化，请先执行微信开发者工具登录。"));
  }
  return out;
}

function webChecks() {
  const out = [];
  const nodePath = resolveCommandPath("node");
  out.push(check("toolchain.node", "Node.js 命令可用", Boolean(nodePath), true, nodePath ? "node=" + nodePath : "未找到 node 命令", "安装 Node.js 并确保 PATH 可访问。"));
  const npmPath = resolveCommandPath("npm");
  out.push(check("toolchain.npm", "npm 命令可用", Boolean(npmPath), true, npmPath ? "npm=" + npmPath : "未找到 npm 命令", "安装 npm 并确保 PATH 可访问。"));
  const browserPath = resolveCommandPath("google-chrome")
    || resolveCommandPath("chromium")
    || resolveCommandPath("chromium-browser")
    || resolveCommandPath("msedge");
  const appExists = process.platform === "darwin" && (fs.existsSync("/Applications/Google Chrome.app") || fs.existsSync("/Applications/Microsoft Edge.app"));
  out.push(check("web.browser.devtools", "浏览器 DevTools 验收能力", Boolean(browserPath || appExists), false, browserPath ? "browser=" + browserPath : (appExists ? "发现可用浏览器 App" : "未探测到 Chrome/Chromium/Edge"), "建议安装 Chrome/Chromium/Edge 以支持 Web UI 自动化验收。"));
  return out;
}

function iosChecks() {
  const out = [];
  const isDarwin = process.platform === "darwin";
  out.push(check("ios.platform.darwin", "iOS 工具链平台支持", isDarwin, true, "platform=" + process.platform, isDarwin ? "" : "iOS 验收仅支持 macOS。"));
  const xcodebuildPath = resolveCommandPath("xcodebuild");
  out.push(check("ios.xcodebuild.path", "xcodebuild 命令可用", Boolean(xcodebuildPath), true, xcodebuildPath ? "xcodebuild=" + xcodebuildPath : "未找到 xcodebuild", "安装 Xcode Command Line Tools：xcode-select --install"));
  const xcrunPath = resolveCommandPath("xcrun");
  out.push(check("ios.xcrun.path", "xcrun 命令可用", Boolean(xcrunPath), true, xcrunPath ? "xcrun=" + xcrunPath : "未找到 xcrun", "安装 Xcode 并确认 xcrun 在 PATH 中可用。"));
  if (xcodebuildPath) {
    const version = run("xcodebuild", ["-version"], 5000);
    out.push(check("ios.xcodebuild.version", "xcodebuild 版本检查", version.ok, true, version.ok ? version.stdout.split(/\r?\n/).slice(0, 2).join(" | ") : (version.stderr || version.error || "执行失败"), "检查 xcode-select 指向与 Xcode 安装状态。"));
  }
  if (xcrunPath) {
    const simctl = run("xcrun", ["simctl", "list", "devices"], 7000);
    out.push(check("ios.simctl.devices", "iOS 模拟器设备列表可读取", simctl.ok, true, simctl.ok ? "xcrun simctl list devices 执行成功" : (simctl.stderr || simctl.error || "执行失败"), "打开 Xcode 完成首次组件安装并初始化 Simulator Runtime。"));
  }
  return out;
}

function microserviceChecks() {
  const out = [];
  const python = resolveFirstCommandPath(["python3", "python"]);
  out.push(check(
    "toolchain.python",
    "Python 命令可用",
    Boolean(python.path),
    true,
    python.path ? (python.command + "=" + python.path) : "未找到 python3/python 命令",
    python.path ? "" : "安装 Python 3.10+ 并确保 PATH 可访问。"
  ));

  if (python.path) {
    const version = run(python.command, ["--version"], 3000);
    out.push(check(
      "toolchain.python.version",
      "Python 版本可读取",
      version.ok,
      true,
      version.ok ? (version.stdout || version.stderr || "python version ok") : (version.stderr || version.error || "执行失败"),
      version.ok ? "" : "检查 Python 安装或 PATH 配置。"
    ));
  }

  const deps = resolveFirstCommandPath(["uv", "poetry", "pip3", "pip"]);
  out.push(check(
    "microservice.python.deps.manager",
    "Python 依赖管理器可用（uv/poetry/pip）",
    Boolean(deps.path),
    true,
    deps.path ? (deps.command + "=" + deps.path) : "未找到 uv/poetry/pip3/pip",
    deps.path ? "" : "建议安装 uv（首选）或 poetry/pip，并确保命令在 PATH 中可用。"
  ));

  const pytestPath = resolveCommandPath("pytest");
  out.push(check(
    "microservice.python.pytest",
    "pytest 命令可用",
    Boolean(pytestPath),
    false,
    pytestPath ? "pytest=" + pytestPath : "未找到 pytest 命令",
    pytestPath ? "" : "建议安装 pytest 以支持微服务自动化回归。"
  ));
  return out;
}

function androidChecks() {
  const out = [];
  const javaPath = resolveCommandPath("java");
  out.push(check(
    "android.java.path",
    "Java 命令可用",
    Boolean(javaPath),
    true,
    javaPath ? ("java=" + javaPath) : "未找到 java 命令",
    javaPath ? "" : "安装 JDK 17+ 并确保 PATH 可访问。"
  ));

  if (javaPath) {
    const version = run("java", ["-version"], 4000);
    out.push(check(
      "android.java.version",
      "Java 版本可读取",
      version.ok,
      true,
      version.ok ? (version.stderr || version.stdout || "java version ok") : (version.stderr || version.error || "执行失败"),
      version.ok ? "" : "检查 JDK 安装与 JAVA_HOME/PATH 配置。"
    ));
  }

  const sdkTool = resolveFirstCommandPath(["sdkmanager", "adb"]);
  out.push(check(
    "android.sdk.tool",
    "Android SDK 工具可用（sdkmanager/adb）",
    Boolean(sdkTool.path),
    true,
    sdkTool.path ? (sdkTool.command + "=" + sdkTool.path) : "未找到 sdkmanager/adb 命令",
    sdkTool.path ? "" : "安装 Android SDK Platform-Tools / Command-line Tools 并配置 PATH。"
  ));

  const gradlePath = resolveCommandPath("gradle");
  out.push(check(
    "android.gradle.path",
    "Gradle 命令可用",
    Boolean(gradlePath),
    false,
    gradlePath ? ("gradle=" + gradlePath) : "未找到 gradle 命令",
    gradlePath ? "" : "建议安装 Gradle，或在仓库中使用 ./gradlew。"
  ));

  return out;
}

function serverlessChecks() {
  const out = [];
  const runtime = resolveFirstCommandPath(["node", "python3", "python"]);
  out.push(check(
    "serverless.runtime.command",
    "Serverless 运行时命令可用（node/python）",
    Boolean(runtime.path),
    true,
    runtime.path ? (runtime.command + "=" + runtime.path) : "未找到 node/python3/python 命令",
    runtime.path ? "" : "安装 Node.js 或 Python 并确保 PATH 可访问。"
  ));

  const deps = resolveFirstCommandPath(["npm", "pnpm", "yarn", "uv", "poetry", "pip3", "pip"]);
  out.push(check(
    "serverless.deps.manager",
    "依赖管理器可用",
    Boolean(deps.path),
    true,
    deps.path ? (deps.command + "=" + deps.path) : "未找到 npm/pnpm/yarn/uv/poetry/pip",
    deps.path ? "" : "安装至少一种依赖管理器并确保 PATH 可访问。"
  ));

  const deployTool = resolveFirstCommandPath(["serverless", "sls", "sam", "cdk", "vercel", "netlify", "aws"]);
  out.push(check(
    "serverless.deploy.tool",
    "部署/本地仿真工具可用",
    Boolean(deployTool.path),
    true,
    deployTool.path ? (deployTool.command + "=" + deployTool.path) : "未找到 serverless/sam/cdk/vercel/netlify/aws",
    deployTool.path ? "" : "按项目技术栈安装对应 CLI（例如 serverless、sam、cdk、vercel 或 netlify）。"
  ));

  return out;
}

function otherChecks() {
  const nodePath = resolveCommandPath("node");
  return [
    check("toolchain.node", "Node.js 命令可用", Boolean(nodePath), true, nodePath ? "node=" + nodePath : "未找到 node 命令", "安装 Node.js 并确保 PATH 可访问。"),
  ];
}

function pickChecks() {
  if (PRODUCT_TYPE === "miniapp") return miniappChecks();
  if (PRODUCT_TYPE === "ios") return iosChecks();
  if (PRODUCT_TYPE === "microservice") return microserviceChecks();
  if (PRODUCT_TYPE === "android") return androidChecks();
  if (PRODUCT_TYPE === "serverless") return serverlessChecks();
  if (PRODUCT_TYPE === "web") return webChecks();
  return otherChecks();
}

function main() {
  const checks = pickChecks();
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
    process.stdout.write("Platform preflight checks:\n");
    for (const item of checks) {
      const badge = item.ok ? "OK" : (item.required ? "FAIL" : "WARN");
      process.stdout.write("- [" + badge + "] " + item.id + " " + item.title + " :: " + item.detail + "\n");
    }
  }

  if (STRICT && !report.ok) {
    process.exit(1);
    return;
  }
}

main();
