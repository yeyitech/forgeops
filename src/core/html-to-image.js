import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function toPlainError(err) {
  if (!err) return "";
  return err instanceof Error ? err.message : String(err);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileUrlForPath(p) {
  const abs = path.resolve(String(p));
  // Minimal file:// URL encoding for spaces etc.
  const encoded = abs.split(path.sep).map(encodeURIComponent).join("/");
  return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

function existsExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(cmd) {
  const res = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  if (res.status !== 0) return "";
  return String(res.stdout ?? "").trim();
}

export function findChromeExecutable() {
  const env = String(process.env.FORGEOPS_CHROME_BIN ?? "").trim();
  if (env && existsExecutable(env)) return env;

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of candidates) {
    if (existsExecutable(p)) return p;
  }

  const fromPath = which("google-chrome") || which("chrome") || which("chromium");
  if (fromPath && existsExecutable(fromPath)) return fromPath;
  return "";
}

export function renderHtmlToPngWithChrome(params) {
  const chromeBin = String(params?.chromeBin ?? "").trim() || findChromeExecutable();
  if (!chromeBin) {
    return { ok: false, error: "chrome_not_found", detail: "Google Chrome/Chromium not found. Set FORGEOPS_CHROME_BIN." };
  }

  const html = String(params?.html ?? "");
  const outPath = path.resolve(String(params?.outPath ?? ""));
  const width = Math.max(320, Math.min(2400, Math.floor(Number(params?.width ?? 1100) || 1100)));
  const height = Math.max(240, Math.min(2400, Math.floor(Number(params?.height ?? 760) || 760)));

  if (!outPath) {
    return { ok: false, error: "out_path_missing", detail: "outPath is required" };
  }

  ensureDir(path.dirname(outPath));

  const htmlPath = path.resolve(String(params?.htmlPath ?? `${outPath}.html`));
  try {
    fs.writeFileSync(htmlPath, html, "utf8");
  } catch (err) {
    return { ok: false, error: "write_html_failed", detail: toPlainError(err) };
  }

  const url = fileUrlForPath(htmlPath);

  const baseArgs = [
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=2",
    "--virtual-time-budget=1500",
    "--run-all-compositor-stages-before-draw",
    `--screenshot=${outPath}`,
    url,
  ];

  const tryRun = (headlessFlag) => {
    const args = [headlessFlag, ...baseArgs];
    const res = spawnSync(chromeBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return res;
  };

  let res = tryRun("--headless=new");
  if (res.status !== 0) {
    // Fallback for older Chrome builds.
    res = tryRun("--headless");
  }

  if (res.status !== 0) {
    return {
      ok: false,
      error: "chrome_failed",
      detail: `chrome exit=${res.status} ${String(res.stderr ?? "").trim()}`,
      chromeBin,
      outPath,
      htmlPath,
    };
  }

  return {
    ok: true,
    chromeBin,
    outPath,
    htmlPath,
  };
}

