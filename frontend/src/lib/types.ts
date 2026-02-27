export type Project = {
  id: string;
  name: string;
  root_path: string;
  product_type: string;
  github_repo: string;
  problem_statement: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type ProjectMetrics = {
  project_id: string;
  issue_count_all: number;
  issue_count_open: number;
  issue_count_closed: number;
  pr_count_all: number;
  pr_count_open: number;
  pr_count_closed: number;
  run_count: number;
  run_running_count: number;
  run_completed_count: number;
  run_failed_count: number;
  token_total: number;
  token_input_total: number;
  token_cached_input_total: number;
  token_output_total: number;
  token_cache_hit_rate: number;
  code_lines: number;
  code_files: number;
  doc_words: number;
  doc_files: number;
  docs_doc_words: number;
  docs_doc_files: number;
  code_languages: Array<{
    language: string;
    lines: number;
    files: number;
  }>;
  code_trend_7d: {
    available: boolean;
    source: string;
    commit_count: number;
    added_lines: number;
    deleted_lines: number;
    net_lines: number;
    days: Array<{
      date: string;
      added_lines: number;
      deleted_lines: number;
      net_lines: number;
      commit_count: number;
    }>;
    warning: string;
  };
  elapsed_sec: number;
  created_at: string;
  updated_at: string;
  loc_scanned_at: string;
  loc_source: string;
  github_available: boolean;
  github_source: string;
  github_repo: string;
  github_warning: string;
  github_fetched_at: string;
};

export type RuntimeTokenUsage = {
  runtime: string;
  token_input_total: number;
  token_cached_input_total: number;
  token_output_total: number;
  total_tokens: number;
  token_cache_hit_rate: number;
  share_rate: number;
};

export type ProjectTokenUsage = {
  project_id: string;
  project_name: string;
  token_input_total: number;
  token_cached_input_total: number;
  token_output_total: number;
  total_tokens: number;
  token_cache_hit_rate: number;
  share_rate: number;
};

export type GlobalTokenUsage = {
  total_tokens: number;
  token_input_total: number;
  token_cached_input_total: number;
  token_output_total: number;
  token_cache_hit_rate: number;
  project_totals: ProjectTokenUsage[];
  runtime_totals: RuntimeTokenUsage[];
  trend_7d: {
    available: boolean;
    source: string;
    days: Array<{
      date: string;
      total_tokens: number;
      runtime_totals: Array<{
        runtime: string;
        token_input_total: number;
        token_cached_input_total: number;
        token_output_total: number;
        total_tokens: number;
      }>;
    }>;
    warning: string;
  };
  collected_at: string;
};

export type Issue = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  workflow_status?: string;
  created_at: string;
  updated_at: string;
  github_number?: number;
  github_url?: string;
  labels?: string[];
};

export type IssueCreateResult = {
  issue: Issue;
  run: RunRow | null;
  autoRunEnabled: boolean;
  autoRunError: string;
};

export type RunRow = {
  id: string;
  project_id: string;
  github_issue_id: string | null;
  task: string;
  status: string;
  workflow_id: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_ref: string | null;
  current_step_index: number;
  created_at: string;
  updated_at: string;
  project_name?: string;
  running_step?: string | null;
  total_tokens?: number;
  quality_gates?: RunQualityGates;
};

export type RunQualityGateStatus = "passed" | "failed" | "running" | "pending" | "not_configured" | "skipped";

export type RunQualityGateSummary = {
  status: RunQualityGateStatus;
  stepKey: string | null;
  templateKey: string | null;
  summary: string;
  error: string;
  updatedAt: string | null;
};

export type RunQualityGates = {
  ci: RunQualityGateSummary;
  platform: RunQualityGateSummary;
  overall: RunQualityGateStatus;
};

export type StepRow = {
  id: string;
  run_id: string;
  step_key: string;
  template_key: string | null;
  depends_on_json: string;
  agent_id: string;
  step_index: number;
  status: string;
  summary: string | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  runtime: string;
  requested_model: string | null;
  effective_model: string | null;
  token_input: number;
  token_cached_input: number;
  token_output: number;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type Artifact = {
  id: string;
  run_id: string;
  step_id: string;
  kind: string;
  title: string;
  content: string;
  path: string | null;
  created_at: string;
};

export type SessionRow = {
  id: string;
  run_id: string;
  step_id: string;
  runtime: string;
  process_pid: number | null;
  thread_id: string | null;
  turn_id: string | null;
  requested_model: string | null;
  effective_model: string | null;
  model_provider: string | null;
  token_input: number;
  token_cached_input: number;
  token_output: number;
  token_reasoning_output: number;
  status: string;
  started_at: string;
  ended_at: string | null;
  error: string | null;
};

export type EventRow = {
  id: number;
  run_id: string | null;
  step_id: string | null;
  ts: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type RunDetail = {
  run: RunRow;
  context: Record<string, unknown>;
  steps: StepRow[];
  sessions: SessionRow[];
  events: EventRow[];
  artifacts: Artifact[];
  qualityGates?: RunQualityGates;
};

export type RunAttachTerminalResult = {
  ok: boolean;
  runId: string;
  threadId: string;
  sessionId: string | null;
  stepKey: string | null;
  cwd: string;
  command: string;
  terminal: string;
  platform: string;
  notice: string;
};

export type RunBatchActionResult = {
  total: number;
  changed: number;
  failed: string[];
  projectId: string | null;
};

export type EngineState = {
  running: boolean;
  pollMs: number;
  concurrency: number;
  activeSessions: number;
  lastTickAt: string | null;
  availableRuntimes: string[];
  scheduler?: SchedulerRuntimeState | null;
};

export type DoctorCheck = {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
  hint: string;
};

export type DoctorReport = {
  ok: boolean;
  checkedAt: string;
  checks: DoctorCheck[];
};

export type ProcessTag = "core" | "agent" | "runtime" | "scm" | "tooling" | "unknown";
export type ProcessRole = "core-control-plane" | "core-executor" | "agent-worker" | "runtime" | "scm" | "tooling" | "unknown";

export type ProcessSnapshotRow = {
  pid: number;
  ppid: number;
  cpuPercent: number;
  memPercent: number;
  rssBytes: number;
  elapsed: string;
  command: string;
  args: string;
  isRelated: boolean;
  tags: ProcessTag[];
  primaryTag: ProcessTag;
  role: ProcessRole;
};

export type SystemConfig = {
  runtime: {
    selected: string;
    supported: string[];
    modelDefault: string;
    codexBin: string;
    codexVersion: string;
    ready: boolean;
    error: string;
  };
  git: {
    userName: string;
    userEmail: string;
    configured: boolean;
    available: boolean;
  };
  github: {
    patRequired: boolean;
    patConfigured: boolean;
    patMasked: string;
    updatedAt: string | null;
    validated: boolean;
    detail: string;
  };
  doctor: DoctorReport;
  machine: {
    collectedAt: string;
    device: {
      hostname: string;
      platform: string;
      arch: string;
      release: string;
      nodeVersion: string;
      uptimeSec: number;
    };
    cpu: {
      model: string;
      cores: number;
      speedMHz: number;
      loadAvg1: number;
      loadAvg5: number;
      loadAvg15: number;
    };
    memory: {
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
      usedPercent: number;
    };
    gpu: {
      available: boolean;
      source: string;
      model: string;
      vendor: string;
      coreCount: number;
      utilizationPercent: number;
      frequencyMHz: number;
      powerW: number;
      temperatureC: number;
      memoryTotalBytes: number;
      warning: string;
    };
    disks: Array<{
      path: string;
      mountPoint: string;
      totalBytes: number;
      usedBytes: number;
      freeBytes: number;
      usedPercent: number;
    }>;
    currentProcess: {
      pid: number;
      ppid: number;
      cwd: string;
      uptimeSec: number;
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
    };
    processes: {
      totalCount: number;
      nodeCount: number;
      forgeopsCount: number;
      warning: string;
      related: ProcessSnapshotRow[];
      topByCpu: ProcessSnapshotRow[];
    };
  };
};

export type SchedulerConfig = {
  version: number;
  enabled: boolean;
  timezone: string;
  cleanup: {
    enabled: boolean;
    mode: "lite" | "deep";
    cron: string;
    task: string;
    onlyWhenIdle: boolean;
  };
  issueAutoRun: {
    enabled: boolean;
    cron: string;
    label: string;
    onlyWhenIdle: boolean;
    maxRunsPerTick: number;
  };
  skillPromotion?: {
    enabled: boolean;
    cron: string;
    onlyWhenIdle: boolean;
    maxPromotionsPerTick: number;
    minCandidateOccurrences: number;
    lookbackDays: number;
    minScore: number;
    draft: boolean;
    roles: string[];
  };
  globalSkillPromotion?: {
    enabled: boolean;
    cron: string;
    onlyWhenIdle: boolean;
    maxPromotionsPerTick: number;
    minCandidateOccurrences: number;
    lookbackDays: number;
    minScore: number;
    requireProjectSkill: boolean;
    draft: boolean;
  };
};

export type SchedulerRuntimeState = {
  running: boolean;
  pollMs: number;
  managedProjects: number;
  lastSyncAt: string | null;
  jobs: Array<{
    kind: string;
    projectId: string;
    projectName: string;
    cron: string;
    timezone: string;
    task: string;
    onlyWhenIdle: boolean;
    cleanupMode?: string;
    label?: string;
    maxRunsPerTick?: number;
    minCandidateOccurrences?: number;
    lookbackDays?: number;
    minScore?: number;
    maxPromotionsPerTick?: number;
    requireProjectSkill?: boolean;
    draft?: boolean;
    syncedAt: string;
  }>;
};

export type WorkflowResolvedStep = {
  key: string;
  templateKey: string;
  agentId: string;
  dependsOn: string[];
  maxRetries: number;
  reviewAutoFixPolicy?: {
    enabled: boolean;
    maxTurns: number;
    maxFiles: number;
    maxLines: number;
    allowlist: string[];
  } | null;
};

export type WorkflowConfigDoc = {
  path: string;
  source: string;
  yaml: string;
  resolved: {
    id: string;
    name: string;
    source: string;
    workflowControls?: {
      autoMerge: boolean;
      mergeMethod: "squash" | "merge" | "rebase";
      autoCloseIssueOnMerge: boolean;
      autoMergeConflictMaxAttempts: number;
    };
    steps: WorkflowResolvedStep[];
  };
};
