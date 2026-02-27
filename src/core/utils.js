import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  const direct = safeJsonParse(trimmed, null);
  if (direct && typeof direct === "object") return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1);
  const parsed = safeJsonParse(candidate, null);
  if (parsed && typeof parsed === "object") return parsed;
  return null;
}
