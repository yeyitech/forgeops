import fs from "node:fs";
import path from "node:path";

function toPlainError(err) {
  if (!err) return "";
  return err instanceof Error ? err.message : String(err);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function ensurePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

function collectJsonlFilesNewestFirst(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  // Codex session log paths generally embed time; lexicographic desc is a good heuristic
  // and avoids extra stat() calls.
  files.sort((a, b) => b.localeCompare(a));
  return files;
}

function readFirstLineFromFile(filePath, maxReadBytes = 64 * 1024) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(maxReadBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxReadBytes, 0);
      if (bytesRead <= 0) return "";
      const text = buffer.toString("utf8", 0, bytesRead);
      const newlineIdx = text.indexOf("\n");
      return newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function parseSessionMetaFromFirstLine(line) {
  const raw = normalizeText(line);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (record?.type !== "session_meta") return null;
    const payload = record?.payload && typeof record.payload === "object" ? record.payload : null;
    if (!payload) return null;
    const threadId = normalizeText(payload.id);
    if (!threadId) return null;
    return {
      threadId,
      cwd: normalizeText(payload.cwd),
      source: normalizeText(payload.source).toLowerCase(),
      timestamp: normalizeText(payload.timestamp ?? record.timestamp),
    };
  } catch {
    return null;
  }
}

export function resolveManagedCodexHome(worktreePath) {
  const root = path.resolve(String(worktreePath ?? "").trim());
  if (!root) return "";
  return path.join(root, ".forgeops-runtime", "codex-home");
}

export function findCodexSessionJsonlForThread(params) {
  const codexHome = path.resolve(String(params?.codexHome ?? "").trim());
  const threadId = normalizeText(params?.threadId);
  if (!codexHome || !threadId) {
    return { ok: false, path: "", error: "codexHome and threadId are required" };
  }

  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot) || !fs.statSync(sessionsRoot).isDirectory()) {
    return { ok: false, path: "", error: `sessions root not found: ${sessionsRoot}` };
  }

  const maxScan = ensurePositiveInt(params?.maxScan, 600);
  const files = collectJsonlFilesNewestFirst(sessionsRoot);
  let scanned = 0;
  for (const filePath of files) {
    if (scanned >= maxScan) break;
    scanned += 1;
    const firstLine = readFirstLineFromFile(filePath);
    const meta = parseSessionMetaFromFirstLine(firstLine);
    if (!meta) continue;
    if (meta.threadId === threadId) {
      return { ok: true, path: filePath, error: "" };
    }
  }

  return { ok: false, path: "", error: `session log not found for thread: ${threadId}` };
}

export function readTailTextFile(params) {
  const filePath = path.resolve(String(params?.filePath ?? "").trim());
  if (!filePath) {
    return { ok: false, content: "", truncated: false, error: "filePath is required" };
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { ok: false, content: "", truncated: false, error: `file not found: ${filePath}` };
  }

  const maxBytes = ensurePositiveInt(params?.maxBytes, 1024 * 1024);
  const maxLines = ensurePositiveInt(params?.maxLines, 400);

  let st;
  try {
    st = fs.statSync(filePath);
  } catch (err) {
    return { ok: false, content: "", truncated: false, error: toPlainError(err) };
  }
  const fileSize = Number(st.size ?? 0);
  const bytesToRead = Math.min(fileSize, maxBytes);
  const start = Math.max(0, fileSize - bytesToRead);

  let chunk = "";
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(bytesToRead);
      const read = fs.readSync(fd, buf, 0, bytesToRead, start);
      chunk = buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, content: "", truncated: false, error: toPlainError(err) };
  }

  // Keep last N lines. This is for observability; it doesn't need to preserve
  // perfect JSONL boundaries if we start mid-line.
  const lines = chunk.split("\n").filter((line) => line.length > 0);
  const sliced = lines.slice(Math.max(0, lines.length - maxLines));
  const content = sliced.join("\n") + (sliced.length > 0 ? "\n" : "");
  const truncated = start > 0 || lines.length > sliced.length;

  return { ok: true, content, truncated, error: "" };
}

