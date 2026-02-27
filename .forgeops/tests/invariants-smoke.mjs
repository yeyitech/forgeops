#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptPath = path.join(process.cwd(), ".forgeops", "tools", "check-invariants.mjs");
const result = spawnSync("node", [scriptPath, "--format", "json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}

const output = String(result.stdout ?? "").trim();
if (!output) {
  console.error("Invariant checker returned empty output");
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(output);
} catch {
  console.error("Invariant checker output is not valid JSON");
  process.exit(2);
}

if (!parsed || typeof parsed !== "object" || !parsed.summary) {
  console.error("Invariant checker output missing summary");
  process.exit(2);
}

if (result.status !== 0) {
  console.error(`Invariant errors: ${parsed.summary.errors}`);
  process.exit(1);
}

console.log(`Invariant check passed: files=${parsed.summary.filesChecked} warnings=${parsed.summary.warnings}`);
