import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  WORKFLOW_ID,
  WORKFLOW_NAME,
  getWorkflowConfigPath,
  resolveWorkflow,
  resolveWorkflowFromContent,
} from "./workflow.js";

export const DEFAULT_WORKFLOW_CONFIG = {
  id: WORKFLOW_ID,
  name: WORKFLOW_NAME,
  auto_merge: true,
  merge_method: "squash",
  auto_close_issue_on_merge: true,
  auto_merge_conflict_max_attempts: 2,
  steps: [
    { key: "architect" },
    { key: "issue", depends_on: ["architect"] },
    { key: "implement", depends_on: ["issue"] },
    { key: "test", depends_on: ["implement"] },
    {
      key: "review",
      depends_on: ["test"],
      auto_fix_enabled: true,
      auto_fix_max_turns: 2,
      auto_fix_max_files: 6,
      auto_fix_max_lines: 200,
      auto_fix_allowlist: "ci,tooling,typecheck,docs",
    },
    { key: "cleanup", depends_on: ["review"] },
  ],
};

export function buildWorkflowYaml(config = DEFAULT_WORKFLOW_CONFIG) {
  return `${YAML.stringify(config)}`;
}

function formatResolvedWorkflow(resolved) {
  return {
    id: resolved.id,
    name: resolved.name,
    source: resolved.source,
    workflowControls: resolved.workflowControls ?? {
      autoMerge: true,
      mergeMethod: "squash",
      autoCloseIssueOnMerge: true,
      autoMergeConflictMaxAttempts: 2,
    },
    steps: resolved.steps.map((step) => ({
      key: step.key,
      templateKey: step.templateKey,
      agentId: step.agentId,
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
      maxRetries: Number(step.maxRetries ?? 0),
      reviewAutoFixPolicy: step.reviewAutoFixPolicy ?? null,
    })),
  };
}

export function loadWorkflowConfig(rootPath) {
  const projectRoot = path.resolve(rootPath);
  const configPath = getWorkflowConfigPath(projectRoot);

  if (!fs.existsSync(configPath)) {
    const yaml = buildWorkflowYaml(DEFAULT_WORKFLOW_CONFIG);
    const resolved = resolveWorkflowFromContent(yaml, "default-generated");
    return {
      path: configPath,
      source: "default",
      yaml,
      resolved: formatResolvedWorkflow(resolved),
    };
  }

  const yaml = fs.readFileSync(configPath, "utf8");
  const resolved = resolveWorkflow(projectRoot);
  return {
    path: configPath,
    source: "file",
    yaml,
    resolved: formatResolvedWorkflow(resolved),
  };
}

export function writeWorkflowConfigYaml(rootPath, yamlText) {
  const projectRoot = path.resolve(rootPath);
  const configPath = getWorkflowConfigPath(projectRoot);
  const nextYaml = String(yamlText ?? "");
  if (!nextYaml.trim()) {
    throw new Error("workflow yaml cannot be empty");
  }

  const resolved = resolveWorkflowFromContent(nextYaml, configPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, nextYaml.endsWith("\n") ? nextYaml : `${nextYaml}\n`, "utf8");

  return {
    path: configPath,
    source: "file",
    yaml: fs.readFileSync(configPath, "utf8"),
    resolved: formatResolvedWorkflow(resolved),
  };
}

export function writeWorkflowConfigObject(rootPath, workflowObject) {
  if (!workflowObject || typeof workflowObject !== "object") {
    throw new Error("workflow object required");
  }
  return writeWorkflowConfigYaml(rootPath, buildWorkflowYaml(workflowObject));
}
