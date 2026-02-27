#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rootPath = process.cwd();
const configPath = path.join(rootPath, ".forgeops", "invariants.json");
const format = process.argv.includes("--format")
  ? String(process.argv[process.argv.indexOf("--format") + 1] ?? "text")
  : "text";

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function toPosix(filePath) {
  return String(filePath).split(path.sep).join("/");
}

function listCodeFiles(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const out = [];
  const stack = [baseDir];
  const blocked = new Set(["node_modules", "dist", ".git", ".forgeops"]);
  const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (blocked.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!exts.has(path.extname(entry.name))) continue;
      out.push(abs);
    }
  }

  return out;
}

function parseImports(source) {
  const imports = [];
  const patterns = [
    /import\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      imports.push(match[1]);
    }
  }

  return imports;
}

function firstLineContains(source, text) {
  const idx = source.indexOf(text);
  if (idx < 0) return 1;
  return source.slice(0, idx).split(/\r?\n/).length;
}

function resolveImportPath(filePath, specifier) {
  if (!specifier || specifier.startsWith("node:") || specifier.startsWith("http:")) {
    return null;
  }

  if (specifier.startsWith(".")) {
    const abs = path.resolve(path.dirname(filePath), specifier);
    return toPosix(path.relative(rootPath, abs));
  }

  if (specifier.startsWith("src/")) {
    return toPosix(specifier);
  }

  return null;
}

function parseDomainLayer(relPath, domainRoot) {
  const normalized = toPosix(relPath).replace(/^\.\//, "");
  const base = toPosix(domainRoot).replace(/\/+$/, "");
  if (!normalized.startsWith(base + "/")) return null;
  const parts = normalized.split("/");
  const baseParts = base.split("/");
  const domain = parts[baseParts.length];
  const layer = parts[baseParts.length + 1];
  if (!domain || !layer) return null;
  return { domain, layer };
}

const config = readJson(configPath, null);
if (!config) {
  console.error("Missing .forgeops/invariants.json");
  process.exit(2);
}

const arch = config.architecture ?? {};
const domainRoot = String(arch.domainRoot ?? "src/domains");
const providersRoot = String(arch.providersRoot ?? "src/providers");
const layers = Array.isArray(arch.layers) ? arch.layers.map((x) => String(x)) : ["types", "config", "repo", "service", "runtime", "ui"];
const layerIndex = new Map(layers.map((layer, index) => [layer, index]));
const dependencyRule = String(arch.dependencyRule ?? "towards-types");
const crossCuttingRoots = Array.isArray(arch.crossCuttingRoots) ? arch.crossCuttingRoots.map((x) => toPosix(String(x))) : [];
const maxFileLines = Number(arch.maxFileLines ?? 450);

const boundaries = config.boundaries ?? {};
const enforceParseAtBoundary = boundaries.enforceParseAtBoundary !== false;
const boundaryLayers = new Set(Array.isArray(boundaries.boundaryLayers) ? boundaries.boundaryLayers.map((x) => String(x)) : ["repo", "runtime", "providers"]);
const boundarySignals = Array.isArray(boundaries.boundarySignals) ? boundaries.boundarySignals.map((x) => String(x)) : [];
const parseSignals = Array.isArray(boundaries.parseSignals) ? boundaries.parseSignals.map((x) => String(x)) : [];

const logging = config.logging ?? {};
const forbidConsoleLog = logging.forbidConsoleLog !== false;

const violations = [];

function addViolation(severity, rule, filePath, line, message, hint) {
  violations.push({
    severity,
    rule,
    file: toPosix(path.relative(rootPath, filePath)),
    line,
    message,
    hint,
  });
}

const files = listCodeFiles(path.join(rootPath, "src"));
for (const filePath of files) {
  const source = fs.readFileSync(filePath, "utf8");
  const rel = toPosix(path.relative(rootPath, filePath));
  const sourceMeta = parseDomainLayer(rel, domainRoot);

  const lines = source.split(/\r?\n/).length;
  if (Number.isFinite(maxFileLines) && maxFileLines > 0 && lines > maxFileLines) {
    addViolation(
      "error",
      "file-size-limit",
      filePath,
      1,
      `File exceeds max line limit (${lines} > ${maxFileLines})`,
      "Split responsibilities into smaller modules to keep future agent runs legible."
    );
  }

  if (forbidConsoleLog && source.includes("console.log(")) {
    addViolation(
      "warn",
      "structured-logging",
      filePath,
      firstLineContains(source, "console.log("),
      "console.log detected; use structured logger instead.",
      "Use a structured logger (fields + message) to keep telemetry machine-readable."
    );
  }

  if (enforceParseAtBoundary && sourceMeta && (boundaryLayers.has(sourceMeta.layer) || rel.startsWith(toPosix(providersRoot) + "/"))) {
    const hasBoundarySignal = boundarySignals.some((token) => source.includes(token));
    if (hasBoundarySignal) {
      const hasParseSignal = parseSignals.some((token) => source.includes(token));
      if (!hasParseSignal) {
        addViolation(
          "error",
          "boundary-parse",
          filePath,
          1,
          "Boundary data handling detected without explicit parse/validation signal.",
          "Parse/validate data shapes at boundaries (schema.parse/safeParse/validator/assert)."
        );
      }
    }
  }

  const imports = parseImports(source);
  for (const specifier of imports) {
    const resolved = resolveImportPath(filePath, specifier);
    if (!resolved) continue;

    const targetMeta = parseDomainLayer(resolved, domainRoot);
    if (sourceMeta) {
      const isProviderImport = resolved === toPosix(providersRoot) || resolved.startsWith(toPosix(providersRoot) + "/");

      if (!isProviderImport) {
        for (const root of crossCuttingRoots) {
          if (resolved === root || resolved.startsWith(root + "/")) {
            addViolation(
              "error",
              "providers-entrypoint",
              filePath,
              firstLineContains(source, specifier),
              `Cross-cutting import '${specifier}' must go through Providers entrypoint '${providersRoot}'.`,
              `Expose the capability through ${providersRoot} and import from that single interface.`
            );
          }
        }
      }

      if (targetMeta) {
        if (sourceMeta.domain !== targetMeta.domain) {
          addViolation(
            "error",
            "cross-domain-import",
            filePath,
            firstLineContains(source, specifier),
            `Cross-domain direct import is not allowed (${sourceMeta.domain} -> ${targetMeta.domain}).`,
            `Use ${providersRoot} or an explicit API boundary instead of direct domain coupling.`
          );
          continue;
        }

        const fromIndex = layerIndex.get(sourceMeta.layer);
        const toIndex = layerIndex.get(targetMeta.layer);
        if (fromIndex === undefined || toIndex === undefined) {
          continue;
        }

        let allowed = true;
        if (dependencyRule === "towards-types") {
          allowed = toIndex <= fromIndex;
        } else if (dependencyRule === "towards-ui") {
          allowed = toIndex >= fromIndex;
        }

        if (!allowed) {
          addViolation(
            "error",
            "layer-dependency",
            filePath,
            firstLineContains(source, specifier),
            `Invalid layer dependency: '${sourceMeta.layer}' -> '${targetMeta.layer}'`,
            `Follow layer order ${layers.join(" -> ")} with rule '${dependencyRule}'.`
          );
        }
      }
    }
  }
}

const errors = violations.filter((item) => item.severity === "error");
const warnings = violations.filter((item) => item.severity !== "error");

const result = {
  ok: errors.length === 0,
  summary: {
    filesChecked: files.length,
    errors: errors.length,
    warnings: warnings.length,
  },
  violations,
};

if (format === "json") {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  process.stdout.write(`Invariant check: files=${result.summary.filesChecked} errors=${result.summary.errors} warnings=${result.summary.warnings}\n`);
  for (const violation of violations) {
    process.stdout.write(`[${violation.severity}] ${violation.rule} ${violation.file}:${violation.line} ${violation.message}\n`);
    if (violation.hint) {
      process.stdout.write(`  hint: ${violation.hint}\n`);
    }
  }
}

process.exit(result.ok ? 0 : 1);
