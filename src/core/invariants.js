import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(THIS_DIR, "templates");

function relPath(rootPath, targetPath) {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), "utf8");
}

export function buildInvariantsConfig(meta) {
  const productType = String(meta.productType ?? "web");
  const payload = {
    version: 1,
    architecture: {
      domainRoot: "src/domains",
      layers: ["types", "config", "repo", "service", "runtime", "ui"],
      dependencyRule: "towards-types",
      providersRoot: "src/providers",
      crossCuttingRoots: [
        "src/auth",
        "src/connectors",
        "src/telemetry",
        "src/feature-flags",
      ],
      maxFileLines: 450,
    },
    boundaries: {
      enforceParseAtBoundary: true,
      boundaryLayers: ["repo", "runtime", "providers"],
      boundarySignals: [
        "fetch(",
        "axios.",
        "JSON.parse(",
        "req.body",
        "response.json(",
        "process.env",
      ],
      parseSignals: [
        ".parse(",
        "safeParse(",
        "validate(",
        "assert(",
        "zod",
        "schema",
      ],
    },
    logging: {
      forbidConsoleLog: true,
    },
    policy: {
      blockOn: ["error"],
      allowWarningsInMerge: true,
      followup: {
        createGithubIssueOnWarnings: true,
        onlyAtStep: "review",
        maxItems: 8,
      },
    },
    profile: {
      productType,
      language: String(meta.tech?.language ?? ""),
      frontendStack: String(meta.tech?.frontendStack ?? ""),
      backendStack: String(meta.tech?.backendStack ?? ""),
      ciProvider: String(meta.tech?.ciProvider ?? ""),
    },
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function buildInvariantsCheckerScript() {
  return readTemplate("invariants-checker.mjs");
}

export function buildInvariantsTestScript() {
  return readTemplate("invariants-smoke.mjs");
}

export function getInvariantPaths(rootPath) {
  const base = path.resolve(rootPath);
  return {
    configPath: path.join(base, ".forgeops", "invariants.json"),
    checkerPath: path.join(base, ".forgeops", "tools", "check-invariants.mjs"),
    testPath: path.join(base, ".forgeops", "tests", "invariants-smoke.mjs"),
    checkerPathRelative: relPath(base, path.join(base, ".forgeops", "tools", "check-invariants.mjs")),
  };
}
