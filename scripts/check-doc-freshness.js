#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const STALE_DAYS = 45;
const HEADER_PREFIX = "Updated:";

function listMarkdownFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function parseUpdatedDate(content) {
  const lines = content.split(/\r?\n/).slice(0, 20);
  for (const line of lines) {
    const idx = line.indexOf(HEADER_PREFIX);
    if (idx === -1) continue;
    const raw = line.slice(idx + HEADER_PREFIX.length).trim();
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  return null;
}

function daysBetween(a, b) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.log("docs/ directory not found; skipping freshness check.");
    process.exit(0);
  }

  const today = new Date();
  const files = listMarkdownFiles(DOCS_DIR);
  const missing = [];
  const stale = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, "utf8");
    const updated = parseUpdatedDate(content);
    if (!updated) {
      missing.push(rel);
      continue;
    }
    const age = daysBetween(today, updated);
    if (age > STALE_DAYS) {
      stale.push({ rel, age, updated: updated.toISOString().slice(0, 10) });
    }
  }

  if (missing.length === 0 && stale.length === 0) {
    console.log(`OK: ${files.length} docs checked, freshness policy satisfied.`);
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log("Missing Updated header:");
    for (const rel of missing) {
      console.log(`- ${rel}`);
    }
  }

  if (stale.length > 0) {
    console.log(`Stale docs (> ${STALE_DAYS} days):`);
    for (const item of stale) {
      console.log(`- ${item.rel} (updated ${item.updated}, age ${item.age}d)`);
    }
  }

  process.exit(1);
}

main();
