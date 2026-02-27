#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REQUIRED_FILES = [
  "AGENTS.md",
  "docs/00-index.md",
  "docs/architecture/00-overview.md",
  "docs/design/core-beliefs.md",
  "docs/quality/verification-status.md",
  "docs/meta/doc-freshness.md",
  "docs/meta/doc-structure.md",
  "docs/exec-plans/tech-debt-tracker.md",
];
const REQUIRED_DIRS = [
  "docs/exec-plans/active",
  "docs/exec-plans/completed",
];
const INDEX_FILES = [
  "AGENTS.md",
  "docs/00-index.md",
];
const DYNAMIC_DOC_PREFIXES = [
  "docs/exec-plans/active/",
  "docs/exec-plans/completed/",
];

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

function isDynamicDoc(relPath) {
  return DYNAMIC_DOC_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function loadIndexText() {
  return INDEX_FILES
    .map((rel) => {
      const abs = path.join(ROOT, rel);
      return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    })
    .join("\n");
}

function main() {
  const errors = [];

  for (const rel of REQUIRED_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      errors.push(`missing required file: ${rel}`);
    }
  }

  for (const rel of REQUIRED_DIRS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      errors.push(`missing required directory: ${rel}`);
    }
  }

  const docsDir = path.join(ROOT, "docs");
  if (!fs.existsSync(docsDir)) {
    errors.push("docs directory not found");
  } else {
    const docs = listMarkdownFiles(docsDir)
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
    const indexText = loadIndexText();
    for (const rel of docs) {
      if (isDynamicDoc(rel)) continue;
      if (!indexText.includes(rel)) {
        errors.push(`unindexed doc: ${rel} (not referenced by AGENTS.md or docs/00-index.md)`);
      }
    }
  }

  if (errors.length === 0) {
    console.log("OK: docs structure policy satisfied.");
    process.exit(0);
  }

  console.log("Doc structure check failed:");
  for (const item of errors) {
    console.log(`- ${item}`);
  }
  process.exit(1);
}

main();
