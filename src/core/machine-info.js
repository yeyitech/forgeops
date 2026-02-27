import os from "node:os";
import process from "node:process";
import { execFileSync } from "node:child_process";

const CACHE_TTL_MS = 3000;
const GPU_CACHE_TTL_MS = 30000;

let cached = null;
let cachedAt = 0;
let gpuCached = null;
let gpuCachedAt = 0;

function toFixedNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function safeExec(bin, args) {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2200,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseHumanBytes(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return 0;
  const match = raw.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return 0;
  const amount = toFiniteNumber(match[1], 0);
  const unit = String(match[2] ?? "").toUpperCase();
  if (amount <= 0) return 0;
  const factorMap = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  const factor = factorMap[unit] ?? 1;
  return Math.round(amount * factor);
}

function parseCoreCount(value) {
  const text = String(value ?? "");
  const match = text.match(/(\d+)/);
  if (!match) return 0;
  return Number(match[1]) || 0;
}

function parseSystemProfilerGpuSnapshot() {
  if (process.platform !== "darwin") {
    return {
      available: false,
      source: "none",
      model: "",
      vendor: "",
      coreCount: 0,
      utilizationPercent: 0,
      frequencyMHz: 0,
      powerW: 0,
      temperatureC: 0,
      memoryTotalBytes: 0,
      warning: "GPU telemetry is currently only implemented on macOS.",
    };
  }
  const output = safeExec("system_profiler", ["SPDisplaysDataType", "-json", "-detailLevel", "mini"]);
  if (!output.trim()) {
    return {
      available: false,
      source: "none",
      model: "",
      vendor: "",
      coreCount: 0,
      utilizationPercent: 0,
      frequencyMHz: 0,
      powerW: 0,
      temperatureC: 0,
      memoryTotalBytes: 0,
      warning: "system_profiler did not return GPU data.",
    };
  }
  try {
    const payload = JSON.parse(output);
    const rows = Array.isArray(payload?.SPDisplaysDataType) ? payload.SPDisplaysDataType : [];
    const preferred = rows.find((row) => /apple/i.test(String(row?.sppci_model ?? row?._name ?? ""))) ?? rows[0];
    if (!preferred) {
      return {
        available: false,
        source: "system_profiler",
        model: "",
        vendor: "",
        coreCount: 0,
        utilizationPercent: 0,
        frequencyMHz: 0,
        powerW: 0,
        temperatureC: 0,
        memoryTotalBytes: 0,
        warning: "No GPU device entry found in system_profiler output.",
      };
    }

    const model = String(preferred.sppci_model ?? preferred._name ?? "").trim();
    const vendor = String(preferred.spdisplays_vendor ?? preferred.sppci_vendor ?? "").trim();
    const coreCount = parseCoreCount(preferred.sppci_cores ?? preferred.spdisplays_gpu_cores);
    const memoryTotalBytes = parseHumanBytes(preferred.spdisplays_vram ?? preferred.spdisplays_vram_shared ?? "");

    return {
      available: Boolean(model),
      source: "system_profiler",
      model,
      vendor,
      coreCount,
      utilizationPercent: 0,
      frequencyMHz: 0,
      powerW: 0,
      temperatureC: 0,
      memoryTotalBytes,
      warning: "",
    };
  } catch {
    return {
      available: false,
      source: "none",
      model: "",
      vendor: "",
      coreCount: 0,
      utilizationPercent: 0,
      frequencyMHz: 0,
      powerW: 0,
      temperatureC: 0,
      memoryTotalBytes: 0,
      warning: "system_profiler JSON parsing failed.",
    };
  }
}

function parsePowermetricsGpuMetrics(output) {
  const text = String(output ?? "");
  if (!text.trim()) return null;

  const utilMatch =
    text.match(/GPU active residency:\s*([\d.]+)%/i) ??
    text.match(/GPU Busy:\s*([\d.]+)%/i);
  const freqMatch =
    text.match(/GPU(?:\s+HW)?(?:\s+active)?\s+frequency:\s*([\d.]+)\s*MHz/i) ??
    text.match(/GPU Frequency:\s*([\d.]+)\s*MHz/i);
  const powerMatch = text.match(/GPU Power:\s*([\d.]+)\s*(mW|W)/i);
  const tempMatch =
    text.match(/GPU(?:\s+die)?\s+temperature:\s*([\d.]+)\s*C/i) ??
    text.match(/GPU Temperature:\s*([\d.]+)\s*C/i);

  if (!utilMatch && !freqMatch && !powerMatch && !tempMatch) {
    return null;
  }

  const utilizationPercent = utilMatch ? toFixedNumber(utilMatch[1], 2) : 0;
  const frequencyMHz = freqMatch ? toFixedNumber(freqMatch[1], 0) : 0;
  const temperatureC = tempMatch ? toFixedNumber(tempMatch[1], 1) : 0;

  let powerW = 0;
  if (powerMatch) {
    const raw = toFiniteNumber(powerMatch[1], 0);
    const unit = String(powerMatch[2] ?? "W").toUpperCase();
    powerW = unit === "MW" ? toFixedNumber(raw / 1000, 3) : toFixedNumber(raw, 3);
  }

  return {
    utilizationPercent,
    frequencyMHz,
    powerW,
    temperatureC,
  };
}

function readGpuSnapshot() {
  const now = Date.now();
  if (gpuCached && now - gpuCachedAt < GPU_CACHE_TTL_MS) {
    return gpuCached;
  }

  const base = parseSystemProfilerGpuSnapshot();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    gpuCached = base;
    gpuCachedAt = now;
    return base;
  }

  const powerOut = safeExec("powermetrics", ["--samplers", "gpu_power", "-n", "1", "-i", "1000"]);
  const dynamic = parsePowermetricsGpuMetrics(powerOut);
  if (!dynamic) {
    gpuCached = {
      ...base,
      warning: base.warning || "powermetrics unavailable (likely permission-gated or unsupported).",
    };
    gpuCachedAt = now;
    return gpuCached;
  }

  gpuCached = {
    ...base,
    available: base.available || dynamic.utilizationPercent > 0 || dynamic.frequencyMHz > 0 || dynamic.powerW > 0,
    source: "powermetrics",
    utilizationPercent: dynamic.utilizationPercent,
    frequencyMHz: dynamic.frequencyMHz,
    powerW: dynamic.powerW,
    temperatureC: dynamic.temperatureC,
    warning: "",
  };
  gpuCachedAt = now;
  return gpuCached;
}

const PROCESS_TAG_PRIORITY = ["core", "agent", "runtime", "scm", "tooling", "unknown"];

function pickPrimaryProcessTag(tags) {
  for (const key of PROCESS_TAG_PRIORITY) {
    if (tags.includes(key)) return key;
  }
  return "unknown";
}

function classifyProcessRole(command, args, tags) {
  const commandText = String(command ?? "").trim().toLowerCase();
  const argsText = String(args ?? "").trim().toLowerCase();
  const combined = `${commandText} ${argsText}`.trim();

  if (tags.includes("core")) {
    if (
      /\/src\/worker\//.test(combined)
      || /\b(worker|engine|scheduler)\b/.test(combined)
      || /\/worker\/(engine|scheduler)\.js\b/.test(combined)
    ) {
      return "core-executor";
    }
    return "core-control-plane";
  }
  if (tags.includes("agent")) return "agent-worker";
  if (tags.includes("runtime")) return "runtime";
  if (tags.includes("scm")) return "scm";
  if (tags.includes("tooling")) return "tooling";
  return "unknown";
}

function classifyProcessTags(command, args) {
  const commandText = String(command ?? "").trim().toLowerCase();
  const commandName = commandText.split("/").filter(Boolean).pop() ?? commandText;
  const argsText = String(args ?? "").trim().toLowerCase();
  const combined = `${commandText} ${argsText}`.trim();

  const tags = [];
  if (/\bforgeops\b/.test(combined) || /\/forgeops(?:\/|$)/.test(combined)) {
    tags.push("core");
  }
  if (/\bcodex(?:-exec-json|-app-server)?\b/.test(combined)) {
    tags.push("agent");
  }
  if (
    /^(node|npm|npx|pnpm|yarn|bun|vite|tsx|ts-node)$/.test(commandName)
    || /\b(node|npm|npx|pnpm|yarn|bun|vite|tsx|ts-node)\b/.test(argsText)
  ) {
    tags.push("runtime");
  }
  if (/^(git|gh)$/.test(commandName) || /\b(git|gh)\b/.test(argsText)) {
    tags.push("scm");
  }
  if (/^(python|python3|uv|pytest|go|cargo|java|ruby|perl|make|cmake)$/.test(commandName)) {
    tags.push("tooling");
  }
  return Array.from(new Set(tags));
}

function hasRelatedProcessKeyword(command, args) {
  const commandText = String(command ?? "").trim().toLowerCase();
  const argsText = String(args ?? "").trim().toLowerCase();
  const combined = `${commandText} ${argsText}`.trim();
  return /\b(forgeops|codex|node|npm|npx|pnpm|yarn|bun|vite|tsx|ts-node|gh|git)\b/.test(combined);
}

function parsePsRow(line) {
  const text = String(line ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  const args = match[8] ? match[8].trim() : "";
  const command = match[7];
  const tags = classifyProcessTags(command, args);
  const related = hasRelatedProcessKeyword(command, args);
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuPercent: toFixedNumber(match[3], 2),
    memPercent: toFixedNumber(match[4], 2),
    rssBytes: Number(match[5]) * 1024,
    elapsed: match[6],
    command,
    args: args.slice(0, 220),
    isRelated: related,
    tags,
    primaryTag: pickPrimaryProcessTag(tags),
    role: classifyProcessRole(command, args, tags),
  };
}

function readProcessSnapshot() {
  if (process.platform === "win32") {
    return {
      totalCount: 0,
      nodeCount: 0,
      forgeopsCount: 0,
      related: [],
      topByCpu: [],
      warning: "Windows process snapshot is not implemented.",
    };
  }

  const output = safeExec("ps", ["-axo", "pid=,ppid=,pcpu=,pmem=,rss=,etime=,comm=,args="]);
  const rows = output
    .split(/\r?\n/)
    .map((line) => parsePsRow(line))
    .filter((row) => Boolean(row));

  rows.sort((a, b) => b.cpuPercent - a.cpuPercent);

  const relatedPids = new Set(rows.filter((row) => row.isRelated).map((row) => row.pid));
  if (relatedPids.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!relatedPids.has(row.pid) && relatedPids.has(row.ppid)) {
          relatedPids.add(row.pid);
          row.isRelated = true;
          if (row.tags.length === 0) {
            row.tags = ["unknown"];
            row.primaryTag = "unknown";
          }
          changed = true;
        }
      }
    }
  }

  for (const row of rows) {
    row.isRelated = relatedPids.has(row.pid);
    if (row.isRelated && row.tags.length === 0) {
      row.tags = ["unknown"];
    }
    row.primaryTag = pickPrimaryProcessTag(row.tags);
    row.role = classifyProcessRole(row.command, row.args, row.tags);
  }

  const related = rows.filter((row) => row.isRelated).slice(0, 20);
  const topByCpu = rows.slice(0, 20);
  const nodeCount = rows.filter((row) => /(^|\/)node$/i.test(row.command) || /\bnode\b/i.test(row.args)).length;
  const forgeopsCount = rows.filter((row) => /\bforgeops\b/i.test(row.args)).length;

  return {
    totalCount: rows.length,
    nodeCount,
    forgeopsCount,
    related,
    topByCpu,
    warning: "",
  };
}

function parseDiskUsageForPath(targetPath) {
  if (process.platform === "win32") {
    return null;
  }
  const output = safeExec("df", ["-kP", targetPath]);
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return null;
  }
  const cols = lines[1].split(/\s+/);
  if (cols.length < 6) {
    return null;
  }

  const totalBytes = Number(cols[1]) * 1024;
  const usedBytes = Number(cols[2]) * 1024;
  const freeBytes = Number(cols[3]) * 1024;
  const usedPercentRaw = Number(String(cols[4]).replace("%", ""));
  const mountPoint = cols.slice(5).join(" ");

  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return null;
  }

  return {
    path: targetPath,
    mountPoint,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: Number.isFinite(usedPercentRaw) ? usedPercentRaw : toFixedNumber((usedBytes / totalBytes) * 100, 2),
  };
}

function readDiskSnapshot() {
  const candidates = Array.from(new Set(["/", process.cwd()]));
  const out = [];
  const seenMount = new Set();
  for (const candidate of candidates) {
    const info = parseDiskUsageForPath(candidate);
    if (!info) continue;
    if (seenMount.has(info.mountPoint)) continue;
    seenMount.add(info.mountPoint);
    out.push(info);
  }
  return out;
}

function buildTelemetrySnapshot() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const load = os.loadavg();
  const currentMem = process.memoryUsage();

  return {
    collectedAt: new Date().toISOString(),
    device: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      nodeVersion: process.version,
      uptimeSec: Math.round(os.uptime()),
    },
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
      speedMHz: cpus[0]?.speed ?? 0,
      loadAvg1: toFixedNumber(load[0], 2),
      loadAvg5: toFixedNumber(load[1], 2),
      loadAvg15: toFixedNumber(load[2], 2),
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: totalMem > 0 ? toFixedNumber((usedMem / totalMem) * 100, 2) : 0,
    },
    gpu: readGpuSnapshot(),
    disks: readDiskSnapshot(),
    currentProcess: {
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      uptimeSec: Math.round(process.uptime()),
      rssBytes: currentMem.rss,
      heapUsedBytes: currentMem.heapUsed,
      heapTotalBytes: currentMem.heapTotal,
    },
    processes: readProcessSnapshot(),
  };
}

export function readMachineTelemetry() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }
  cached = buildTelemetrySnapshot();
  cachedAt = now;
  return cached;
}
