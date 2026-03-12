import { resolveSkillDescriptor } from "./skills.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeJoinedText(...parts) {
  return parts
    .map((p) => normalizeText(p))
    .filter(Boolean)
    .join("\n");
}

function textIncludesAny(haystackLower, needles) {
  for (const needle of needles) {
    const n = String(needle ?? "").trim().toLowerCase();
    if (!n) continue;
    if (haystackLower.includes(n)) return true;
  }
  return false;
}

export function detectIssueIntents(context) {
  const task = normalizeText(context?.task);
  const title = normalizeText(context?.issue?.title);
  const description = normalizeText(context?.issue?.description);
  const issueOutputs = context?.stepOutputs?.issue?.outputs ?? null;
  const issueOutputsText = typeof issueOutputs === "string"
    ? issueOutputs
    : (issueOutputs && typeof issueOutputs === "object" ? JSON.stringify(issueOutputs) : "");

  const text = normalizeJoinedText(task, title, description, issueOutputsText);
  const lower = text.toLowerCase();

  const intents = new Set();

  if (textIncludesAny(lower, [
    "supabase",
    "row level security",
    "rls",
    "postgrest",
    "postgres",
    "postgresql",
    "pg ",
    " pg",
    "psql",
  ])) {
    intents.add("supabase_postgres");
  }

  if (textIncludesAny(lower, [
    "migration",
    "migrate",
    "schema change",
    "ddl",
    "prisma migrate",
    "knex",
    "typeorm migration",
    "alembic",
    "flyway",
    "liquibase",
  ])) {
    intents.add("db_migrations");
  }

  if (textIncludesAny(lower, [
    "api",
    "endpoint",
    "openapi",
    "swagger",
    "contract",
    "graphql",
    "rest",
  ])) {
    intents.add("api_design");
  }

  if (textIncludesAny(lower, [
    "e2e",
    "end-to-end",
    "playwright",
    "cypress",
    "selenium",
  ])) {
    intents.add("e2e_testing");
  }

  if (textIncludesAny(lower, [
    "deploy",
    "deployment",
    "release",
    "ci",
    "cd",
    "pipeline",
    "github actions",
    "gitlab ci",
    "docker",
    "container",
    "kubernetes",
    "k8s",
    "helm",
    "terraform",
    "pulumi",
  ])) {
    intents.add("deployment");
  }

  if (textIncludesAny(lower, [
    "github actions",
    ".github/workflows",
    "workflow_dispatch",
    "actions/cache",
  ])) {
    intents.add("github_actions");
  }

  if (textIncludesAny(lower, [
    "kubernetes",
    "k8s",
    "eks",
    "gke",
    "aks",
    "kubectl",
  ])) {
    intents.add("kubernetes");
  }

  if (textIncludesAny(lower, [
    "helm",
    "helmfile",
    "chart.yaml",
    "values.yaml",
  ])) {
    intents.add("helm");
  }

  if (textIncludesAny(lower, [
    "terraform",
    "terraform plan",
    "terraform apply",
    ".tf",
  ])) {
    intents.add("terraform");
  }

  if (textIncludesAny(lower, [
    "gitops",
    "argocd",
    "argo cd",
    "applicationset",
  ])) {
    intents.add("gitops");
  }

  if (textIncludesAny(lower, [
    "security",
    "vulnerability",
    "auth",
    "authentication",
    "authorization",
    "rbac",
    "xss",
    "csrf",
    "sql injection",
  ])) {
    intents.add("security");
  }

  return {
    text,
    intents: Array.from(intents).sort(),
  };
}

function recommendedSkillsForIntent(intent) {
  // Keep this mapping small and high-signal. It is used at runtime to auto-append
  // skills, so every addition should be clearly justified.
  if (intent === "supabase_postgres") {
    return ["supabase-postgres-best-practices"];
  }
  if (intent === "db_migrations") {
    return ["database-migrations"];
  }
  if (intent === "api_design") {
    return ["api-design"];
  }
  if (intent === "e2e_testing") {
    return ["e2e-testing"];
  }
  if (intent === "deployment") {
    return ["deployment-patterns", "docker-patterns"];
  }
  if (intent === "github_actions") {
    return ["github-actions-cicd"];
  }
  if (intent === "kubernetes") {
    return ["kubernetes-patterns"];
  }
  if (intent === "helm") {
    return ["helm-patterns"];
  }
  if (intent === "terraform") {
    return ["terraform-patterns"];
  }
  if (intent === "gitops") {
    return ["gitops-argocd"];
  }
  if (intent === "security") {
    return ["security-review"];
  }
  return [];
}

export function selectAdditionalSkillNamesForStep(params) {
  const agentId = normalizeText(params?.agentId);
  const stepKey = normalizeText(params?.stepKey);
  const intents = Array.isArray(params?.intents) ? params.intents : [];

  const allowedSteps = new Set(["architect", "issue", "implement", "test", "review", "cleanup"]);
  if (!allowedSteps.has(stepKey)) {
    return [];
  }

  const allowByAgent = (skillName) => {
    // Simple allowlist by role: avoid weird skills leaking into unrelated roles.
    // - architect: design/plan oriented
    // - developer: implement + migrations + deployment
    // - tester/reviewer: verification + security + deployment gates
    // - issue-manager: do not auto-append deep technical skills
    if (agentId === "issue-manager") return false;
    if (agentId === "architect") {
      return [
        "api-design",
        "deployment-patterns",
        "docker-patterns",
        "github-actions-cicd",
        "kubernetes-patterns",
        "helm-patterns",
        "terraform-patterns",
        "gitops-argocd",
      ].includes(skillName);
    }
    if (agentId === "developer") return true;
    if (agentId === "tester") {
      return [
        "e2e-testing",
        "deployment-patterns",
        "docker-patterns",
        "github-actions-cicd",
        "kubernetes-patterns",
        "helm-patterns",
        "terraform-patterns",
        "gitops-argocd",
        "supabase-postgres-best-practices",
        "database-migrations",
      ].includes(skillName);
    }
    if (agentId === "reviewer") {
      return [
        "security-review",
        "api-design",
        "deployment-patterns",
        "docker-patterns",
        "github-actions-cicd",
        "kubernetes-patterns",
        "helm-patterns",
        "terraform-patterns",
        "gitops-argocd",
        "database-migrations",
        "supabase-postgres-best-practices",
      ].includes(skillName);
    }
    if (agentId === "garbage-collector") {
      return ["coding-standards", "security-review", "deployment-patterns", "docker-patterns"].includes(skillName);
    }
    return true;
  };

  const out = [];
  for (const intent of intents) {
    const names = recommendedSkillsForIntent(intent);
    for (const name of names) {
      if (!allowByAgent(name)) continue;
      if (!out.includes(name)) out.push(name);
    }
  }

  // Step-specific tweaks:
  // - Review step benefits more from security and deployment-related skills when present.
  if (stepKey === "review") {
    const extra = [];
    if (intents.includes("security")) extra.push("security-review");
    if (intents.includes("deployment")) extra.push("deployment-patterns");
    for (const name of extra) {
      if (!allowByAgent(name)) continue;
      if (!out.includes(name)) out.push(name);
    }
  }

  return out;
}

export function resolveAdditionalSkills(params) {
  const context = params?.context ?? {};
  const projectRootPath = normalizeText(params?.projectRootPath ?? context?.project?.rootPath);
  const productType = normalizeText(params?.productType ?? context?.project?.productType) || "web";
  const techProfile = context?.projectTechProfile && typeof context.projectTechProfile === "object"
    ? context.projectTechProfile
    : (params?.techProfile ?? null);
  const skillNames = Array.isArray(params?.skillNames) ? params.skillNames : [];

  const resolved = [];
  for (const skillName of skillNames) {
    const name = normalizeText(skillName);
    if (!name) continue;
    const item = resolveSkillDescriptor({
      skillName: name,
      projectRootPath,
      productType,
      techProfile,
    });
    if (!item) continue;
    resolved.push({
      ...item,
      whenSteps: Array.isArray(params?.whenSteps) ? params.whenSteps : null,
      priority: Number.isFinite(Number(params?.priority)) ? Number(params.priority) : 80,
      tags: ["intent", ...(Array.isArray(params?.tags) ? params.tags : [])],
    });
  }
  return resolved;
}

export function buildEffectiveAgentSkillsForStep(params) {
  const context = params?.context ?? {};
  const agentId = normalizeText(params?.agentId);
  const stepKey = normalizeText(params?.stepKey);
  const baseMap = context?.agentSkills && typeof context.agentSkills === "object"
    ? context.agentSkills
    : {};
  const base = Array.isArray(baseMap?.[agentId]) ? baseMap[agentId] : [];

  const intentResult = detectIssueIntents(context);
  const extraNames = selectAdditionalSkillNamesForStep({
    agentId,
    stepKey,
    intents: intentResult.intents,
  });
  const extras = resolveAdditionalSkills({
    context,
    projectRootPath: params?.projectRootPath,
    productType: params?.productType,
    techProfile: params?.techProfile,
    skillNames: extraNames,
    whenSteps: [stepKey].filter(Boolean),
    priority: 80,
    tags: intentResult.intents,
  });

  const merged = [];
  const seen = new Set();
  for (const item of [...base, ...extras]) {
    const key = String(item?.name ?? "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return {
    intents: intentResult.intents,
    additionalSkillNames: extraNames,
    additionalResolved: extras,
    merged,
  };
}
