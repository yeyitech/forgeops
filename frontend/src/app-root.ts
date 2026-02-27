import { LitElement, css, html, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  attachRunTerminal,
  createIssue,
  createProject,
  createRun,
  getEngineState,
  getGlobalTokenUsage,
  getProjectMetrics,
  getProjectSchedulerConfig,
  getProjectWorkflowConfig,
  getRunDetail,
  getSystemConfig,
  listIssues,
  listProjects,
  listRuns,
  pickProjectRootDirectory,
  resumeAllPausedRuns,
  resumeRun,
  stopAllRuns,
  stopRun,
  updateEngineState,
  updateProjectSchedulerConfig,
  updateProjectWorkflowConfig,
  updateSystemConfig,
} from "./lib/api";
import type { DoctorReport, EngineState, GlobalTokenUsage, Issue, ProcessRole, ProcessTag, Project, ProjectMetrics, RunDetail, RunQualityGateStatus, RunQualityGates, RunRow, SchedulerConfig, SessionRow, StepRow, SystemConfig, WorkflowConfigDoc, WorkflowResolvedStep } from "./lib/types";
import "./components/status-dot";
import type { AgentTeam3DNode } from "./components/agent-team-3d";

type ProjectCreateProgressRow = {
  id: number;
  stage: string;
  detail: string;
  at: string;
  status: "progress" | "done" | "error";
};

type ProjectCreateProgressGroupKey = "precheck" | "scaffold" | "git" | "finalize" | "unknown";
const CREATE_PROJECT_PROGRESS_GROUP_ORDER: ProjectCreateProgressGroupKey[] = ["precheck", "scaffold", "git", "finalize"];
const DEFAULT_SCHEDULER_TIMEZONE = "Asia/Shanghai";
const SELECTED_PROJECT_STORAGE_KEY = "forgeops:selectedProjectId";
const PLATFORM_GATE_ONLY_FAILED_STORAGE_KEY_PREFIX = "forgeops:platformGateOnlyFailed:";

type ProjectAgentTeamRow = {
  agentId: string;
  stepKeys: string[];
  templates: string[];
  retryBudgetMax: number;
  runningCount: number;
  failedCount: number;
  state: "running" | "failed" | "waiting";
  stateText: string;
};

type RuntimeRiskSignalRow = {
  id: number;
  ts: string;
  eventType: "runtime.session.risk" | "runtime.session.rotate.recommended";
  severity: "risk" | "rotate";
  stepId: string;
  stepKey: string;
  threadId: string;
  turnId: string;
  reason: string;
  recommendedAction: string;
  evidence: string[];
};

type PlatformGateSignalRow = {
  id: number;
  ts: string;
  eventType: "platform.gate.checked" | "platform.gate.failed";
  stepId: string;
  stepKey: string;
  gate: string;
  ok: boolean;
  productType: string;
  scriptPath: string;
  failedRequiredCount: number;
  reason: string;
  error: string;
  stderr: string;
};

type PlatformGateRollupRow = {
  gate: string;
  status: "done" | "failed" | "pending";
  statusText: string;
  latestEventId: number;
  latestTs: string;
  stepLabel: string;
  reason: string;
};

@customElement("forgeops-app")
export class ForgeOpsApp extends LitElement {
  @state() private projects: Project[] = [];
  @state() private issues: Issue[] = [];
  @state() private runs: RunRow[] = [];
  @state() private runDetail: RunDetail | null = null;
  @state() private engine: EngineState | null = null;
  @state() private selectedProjectId = "";
  @state() private selectedRunId = "";
  @state() private message = "";
  @state() private messageTone: "success" | "error" | "info" = "info";
  @state() private loading = false;
  @state() private projectDataLoading = false;
  @state() private projectMetricsLoading = false;
  @state() private projectMetrics: ProjectMetrics | null = null;
  @state() private sidebarWidth = 320;
  @state() private desiredConcurrency = 2;
  @state() private schedulerConfig: SchedulerConfig | null = null;
  @state() private workflowConfig: WorkflowConfigDoc | null = null;
  @state() private workflowYamlDraft = "";
  @state() private doctor: DoctorReport | null = null;
  @state() private systemConfig: SystemConfig | null = null;
  @state() private globalTokenUsage: GlobalTokenUsage | null = null;
  @state() private globalTokenUsageUnsupported = false;
  @state() private currentPage: "project_overview" | "project_issues" | "project_runs" | "project_workflow" | "project_scheduler" | "system" = "project_overview";
  @state() private showCreateProjectModal = false;
  @state() private showGlobalTokenUsageModal = false;
  @state() private pipelineSelectedStepKey = "";
  @state() private pipelineFullscreenSource: "project" | "run" | "" = "";
  @state() private expandRelatedProcesses = false;
  @state() private issuePrView: "all" | "open" | "closed" = "all";
  @state() private runInsightTab: "events" | "artifacts" = "events";
  @state() private runtimeFocusTab: "session" | "step" = "session";
  @state() private platformGateOnlyFailed = false;
  @state() private runTaskDraft = "";
  @state() private runIssueDraft = "";
  @state() private runModeDraft: "standard" | "quick" = "standard";
  @state() private runLaunchPanelOpen = false;
  @state() private agentTeam3DReady = false;
  @state() private showAgentTeam3DModal = false;
  @state() private schedulerJobFilter: "all" | "cleanup" | "issueAutoRun" | "skillPromotion" | "globalSkillPromotion" = "all";
  @state() private createProjectInFlight = false;
  @state() private createProjectProgress: ProjectCreateProgressRow[] = [];
  @state() private createProjectRootPath = "";

  private eventsSource: EventSource | null = null;
  private createProjectSource: EventSource | null = null;
  private createProjectProgressSeq = 0;
  private refreshTimer: number | null = null;
  private messageAutoDismissTimer: number | null = null;
  private projectLoadToken = 0;

  static styles = css`
    :host {
      --bg-primary: #12141a;
      --bg-elev-1: #14161d;
      --bg-elev-2: #1a1d25;
      --bg-elev-3: #20242e;
      --panel: #171b23;
      --panel-alt: #151820;
      --text-primary: #f4f4f5;
      --text-muted: #a1a1aa;
      --text-soft: #71717a;
      --border-subtle: #27272a;
      --border-strong: #3f3f46;
      --accent: #ff5c5c;
      --accent-soft: rgba(255, 92, 92, 0.16);
      --accent-warn: #f59e0b;
      --accent-danger: #ef4444;
      --accent-ok: #22c55e;
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-pill: 999px;
      --font-ui: "Space Grotesk", "Inter", "Geist Sans", sans-serif;
      --font-mono: "JetBrains Mono", "Fira Code", monospace;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2);
      --shadow-md: 0 10px 30px rgba(0, 0, 0, 0.22);
      --focus-ring: 0 0 0 1px color-mix(in srgb, var(--accent), transparent 20%);

      display: block;
      width: 100vw;
      height: 100vh;
      color: var(--text-primary);
      background:
        radial-gradient(950px 580px at 87% -14%, rgba(255, 92, 92, 0.16), transparent 63%),
        radial-gradient(740px 460px at -12% 112%, rgba(20, 184, 166, 0.14), transparent 58%),
        linear-gradient(180deg, #171a23 0%, var(--bg-primary) 66%);
      font-family: var(--font-ui);
      overflow: hidden;
      position: relative;
    }

    :host::before {
      content: "";
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255, 255, 255, 0.024) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.024) 1px, transparent 1px);
      background-size: 34px 34px;
      opacity: 0.35;
      pointer-events: none;
      z-index: 0;
    }

    * {
      box-sizing: border-box;
      scrollbar-color: var(--border-strong) transparent;
    }

    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--border-strong), transparent 35%);
      border-radius: var(--radius-pill);
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    .shell {
      display: grid;
      grid-template-columns: var(--sidebar-width) 8px 1fr;
      gap: 0;
      height: 100%;
      padding: 12px;
      position: relative;
      z-index: 1;
    }

    .sidebar {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 25%),
        var(--panel-alt);
      display: flex;
      flex-direction: column;
      min-width: 240px;
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }

    .splitter {
      cursor: col-resize;
      margin: 0;
      position: relative;
      background: transparent;
    }

    .splitter::before {
      content: "";
      position: absolute;
      inset: 0;
      width: 2px;
      margin: 0 auto;
      border-radius: var(--radius-pill);
      background:
        linear-gradient(180deg, transparent 0%, var(--border-subtle) 45%, transparent 100%);
      transition: background 120ms ease;
    }

    .splitter:hover::before {
      background:
        linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--accent), transparent 50%) 45%, transparent 100%);
    }

    .main {
      display: grid;
      grid-template-rows: 58px 1fr;
      min-width: 0;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      overflow: hidden;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 35%),
        var(--panel);
      box-shadow: var(--shadow-md);
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      border-bottom: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-1), black 4%);
      padding: 0 16px;
      gap: 10px;
      font-size: 12px;
      min-height: 58px;
    }

    .topbar-center {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .topbar-right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      min-width: 0;
      flex-wrap: nowrap;
    }

    .top-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 6px 10px;
      white-space: nowrap;
    }

    .top-action-btn.icon-only {
      width: 34px;
      min-width: 34px;
      padding: 0;
      justify-content: center;
      gap: 0;
    }

    .action-icon {
      width: 14px;
      height: 14px;
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      position: relative;
      display: inline-block;
      flex: none;
      background: color-mix(in srgb, var(--bg-elev-2), transparent 8%);
    }

    .action-icon-plus::before {
      content: "";
      position: absolute;
      left: 3px;
      right: 3px;
      top: 6px;
      height: 1px;
      background: var(--text-primary);
    }

    .action-icon-plus::after {
      content: "";
      position: absolute;
      top: 3px;
      bottom: 3px;
      left: 6px;
      width: 1px;
      background: var(--text-primary);
    }

    .action-icon-system::before {
      content: "";
      position: absolute;
      left: 3px;
      right: 3px;
      top: 4px;
      height: 1px;
      background: var(--text-primary);
      box-shadow: 0 3px 0 var(--text-primary), 0 6px 0 var(--text-primary);
    }

    .action-icon-system::after {
      content: "";
      position: absolute;
      width: 3px;
      height: 3px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      background: var(--text-primary);
      top: 3px;
      left: 4px;
      box-shadow: 2px 3px 0 var(--text-primary), -2px 6px 0 var(--text-primary);
    }

    .brand {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 10px;
    }

    .brand-mark {
      width: 10px;
      height: 10px;
      border-radius: var(--radius-pill);
      background: var(--accent);
      box-shadow: 0 0 18px color-mix(in srgb, var(--accent), transparent 40%);
      flex: none;
    }

    .brand-text {
      display: grid;
      gap: 1px;
      min-width: 0;
    }

    .brand-title {
      font-size: 14px;
      font-weight: 650;
      letter-spacing: -0.01em;
      line-height: 1.15;
    }

    .brand-sub {
      color: var(--text-soft);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      line-height: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .topbar-status {
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 6px;
      min-width: 0;
      flex: none;
    }

    .menu-group {
      display: grid;
      gap: 6px;
    }

    .menu-title {
      font-size: 10px;
      color: var(--text-soft);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: var(--font-mono);
    }

    .menu-btn {
      min-height: 32px;
      text-align: left;
      padding: 7px 10px;
      font-size: 12px;
      color: var(--text-muted);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 6%);
    }

    .menu-btn.active {
      border-color: color-mix(in srgb, var(--accent), transparent 30%);
      color: var(--text-primary);
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-3) 75%);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent), transparent 50%);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 6px 10px;
      background: color-mix(in srgb, var(--bg-elev-3), transparent 10%);
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1;
      white-space: nowrap;
      min-height: 30px;
    }

    .pill input {
      width: 56px;
      min-height: 26px;
      padding: 4px 6px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 8%);
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 12px;
    }

    .pill button {
      min-height: 26px;
      padding: 4px 8px;
      font-size: 11px;
    }

    .pill strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .pill.status {
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-2) 70%);
      border-color: color-mix(in srgb, var(--accent), transparent 45%);
      color: var(--text-primary);
    }

    .workspace {
      display: grid;
      grid-template-rows: 1fr;
      min-height: 0;
      gap: 12px;
      padding: 12px;
    }

    .panel {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.015), transparent 32%),
        var(--bg-elev-2);
      min-height: 0;
      overflow: auto;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }

    .panel.workflow-panel {
      display: grid;
      grid-template-rows: auto 1fr;
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 12px;
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      background: color-mix(in srgb, var(--bg-elev-2), black 2%);
      z-index: 1;
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .panel-header-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }

    .panel-header-actions button {
      min-height: 28px;
      padding: 0 10px;
      font-size: 11px;
      letter-spacing: 0.02em;
      text-transform: none;
    }

    .panel-body {
      padding: 12px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }

    .panel-body.workflow-panel-body {
      min-height: 0;
      overflow: hidden;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .panel-body form {
      display: grid;
      gap: 10px;
    }

    .button-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .button-row > button {
      flex: 1 1 180px;
    }

    .button-row > input,
    .button-row > select {
      flex: 0 0 120px;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: repeat(2, minmax(180px, 1fr));
      gap: 10px;
    }

    label {
      display: grid;
      gap: 6px;
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    input,
    select,
    textarea {
      font: inherit;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 2%);
      color: var(--text-primary);
      padding: 9px 11px;
      outline: none;
      min-height: 36px;
      font-size: 13px;
      transition:
        border-color 120ms ease,
        box-shadow 120ms ease,
        background 120ms ease;
    }

    textarea {
      min-height: 76px;
      resize: vertical;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: color-mix(in srgb, var(--accent), transparent 30%);
      box-shadow: var(--focus-ring);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 5%);
    }

    button {
      font: inherit;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 2%);
      color: var(--text-primary);
      min-height: 35px;
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition:
        border-color 120ms ease,
        transform 120ms ease,
        background 120ms ease,
        box-shadow 120ms ease;
    }

    button.primary {
      background: color-mix(in srgb, var(--accent), black 34%);
      border-color: color-mix(in srgb, var(--accent), transparent 12%);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent), transparent 30%);
    }

    button:not(:disabled):hover {
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }

    button.primary:not(:disabled):hover {
      border-color: color-mix(in srgb, var(--accent), transparent 0%);
      box-shadow:
        0 0 20px color-mix(in srgb, var(--accent), transparent 82%),
        inset 0 0 0 1px color-mix(in srgb, var(--accent), transparent 25%);
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }

    .run-list,
    .steps,
    .team-grid,
    .artifacts,
    .events {
      display: grid;
      gap: 6px;
    }

    .run-group-list {
      display: grid;
      gap: 8px;
    }

    .run-group {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      overflow: hidden;
    }

    .run-group > summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px;
      cursor: pointer;
      color: var(--text-primary);
      font-size: 12px;
      font-weight: 650;
      border-bottom: 1px solid transparent;
    }

    .run-group > summary::-webkit-details-marker {
      display: none;
    }

    .run-group[open] > summary {
      border-bottom-color: var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 2%);
    }

    .run-group-body {
      display: grid;
      gap: 6px;
      padding: 10px;
    }

    .issue-card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .issue-chip-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .issue-status-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 2px 8px;
      font-size: 10px;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      white-space: nowrap;
      background: color-mix(in srgb, var(--bg-elev-2), transparent 5%);
      color: var(--text-muted);
    }

    .issue-status-chip.open {
      border-color: color-mix(in srgb, var(--accent-ok), transparent 56%);
      background: color-mix(in srgb, var(--accent-ok), transparent 90%);
      color: color-mix(in srgb, var(--accent-ok), white 14%);
    }

    .issue-status-chip.in-progress {
      border-color: color-mix(in srgb, var(--accent), transparent 54%);
      background: color-mix(in srgb, var(--accent), transparent 90%);
      color: color-mix(in srgb, var(--accent), white 14%);
    }

    .issue-status-chip.blocked {
      border-color: color-mix(in srgb, var(--accent-warn), transparent 50%);
      background: color-mix(in srgb, var(--accent-warn), transparent 88%);
      color: color-mix(in srgb, var(--accent-warn), white 10%);
    }

    .issue-status-chip.closed {
      border-color: color-mix(in srgb, var(--text-soft), transparent 54%);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 3%);
      color: var(--text-soft);
    }

    .issue-run-chip {
      min-height: 0;
      border-radius: var(--radius-pill);
      padding: 2px 9px;
      font-size: 10px;
      font-family: var(--font-mono);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      white-space: nowrap;
      border-color: color-mix(in srgb, var(--accent), transparent 52%);
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-3) 72%);
      color: var(--text-primary);
      box-shadow: none;
      transform: none;
    }

    .issue-run-chip:not(:disabled):hover {
      border-color: color-mix(in srgb, var(--accent), transparent 18%);
      transform: none;
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-3) 62%);
    }

    .issue-label-chip {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 2px 8px;
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--text-muted);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 5%);
      white-space: nowrap;
    }

    .overview-running-list {
      display: grid;
      gap: 6px;
    }

    .overview-running-item {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      padding: 8px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
    }

    .overview-running-copy {
      min-width: 0;
      display: grid;
      gap: 4px;
    }

    .overview-running-copy .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .overview-running-item button {
      min-height: 28px;
      padding: 0 10px;
      font-size: 11px;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }

    .run-launch-card {
      display: grid;
      gap: 10px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 10px;
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
    }

    .run-launch-source {
      display: grid;
      grid-template-columns: repeat(2, minmax(160px, 1fr));
      gap: 10px;
    }

    .run-launch-secondary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .run-launch-health {
      display: grid;
      gap: 6px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 8px;
      background: color-mix(in srgb, var(--bg-elev-2), transparent 3%);
    }

    .run-launch-health-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(120px, 1fr));
      gap: 8px;
    }

    .run-launch-health-item {
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 4px 8px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 6%);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .team-grid {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }

    .agent-card {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 10px;
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      display: grid;
      gap: 6px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
    }

    .agent-card.running {
      border-color: color-mix(in srgb, var(--accent), transparent 45%);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--accent), transparent 70%),
        0 0 18px color-mix(in srgb, var(--accent), transparent 85%);
    }

    .row {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 10px;
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      display: grid;
      gap: 6px;
      font-size: 12px;
      line-height: 1.45;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
      transition:
        border-color 120ms ease,
        background 120ms ease,
        transform 120ms ease;
    }

    .row-button {
      width: 100%;
      text-align: left;
      appearance: none;
      min-height: 0;
    }

    .row.selected {
      border-color: color-mix(in srgb, var(--accent), transparent 22%);
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-3) 72%);
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--accent), transparent 46%),
        0 0 0 1px color-mix(in srgb, var(--accent), transparent 85%);
    }

    .row-button:hover {
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }

    .overview-project-card {
      padding: 0;
      overflow: hidden;
    }

    .overview-project-card > summary {
      list-style: none;
      cursor: pointer;
      display: grid;
      gap: 6px;
      padding: 10px;
    }

    .overview-project-card > summary::-webkit-details-marker {
      display: none;
    }

    .overview-project-summary-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .overview-project-summary-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .overview-project-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 2px 8px;
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: color-mix(in srgb, var(--bg-elev-2), transparent 6%);
      user-select: none;
    }

    .overview-project-toggle .when-open {
      display: none;
    }

    .overview-project-card[open] .overview-project-toggle .when-open {
      display: inline;
    }

    .overview-project-card[open] .overview-project-toggle .when-closed {
      display: none;
    }

    .overview-project-chevron {
      display: inline-block;
      transition: transform 120ms ease;
    }

    .overview-project-card[open] .overview-project-chevron {
      transform: rotate(180deg);
    }

    .github-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 2px 8px;
      color: var(--text-primary);
      text-decoration: none;
      font-size: 10px;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: color-mix(in srgb, var(--bg-elev-2), transparent 4%);
    }

    .github-link:hover {
      border-color: var(--border-strong);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 0%);
    }

    .github-link svg {
      width: 13px;
      height: 13px;
      fill: currentColor;
      display: block;
    }

    .overview-project-card-body {
      display: grid;
      gap: 6px;
      padding: 0 10px 10px;
      border-top: 1px solid var(--border-subtle);
    }

    .row .title {
      font-weight: 650;
      color: var(--text-primary);
      font-size: 12px;
      letter-spacing: -0.01em;
      overflow-wrap: anywhere;
    }

    .run-gates {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .run-gate-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 10%);
    }

    .run-gate-item .label {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.06em;
      color: var(--text-soft);
      text-transform: uppercase;
      white-space: nowrap;
    }

    .process-title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .process-title-row .title {
      flex: 1 1 260px;
      min-width: 180px;
    }

    .process-tag-list {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
    }

    .scheduler-job-tags {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
    }

    .scheduler-job-header-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .scheduler-job-filter {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .scheduler-job-filter select {
      min-height: 24px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 6%);
      color: var(--text-primary);
      padding: 2px 8px;
      font-size: 11px;
      font-family: var(--font-mono);
    }

    .scheduler-mode-tag.mode-deep {
      border-color: color-mix(in srgb, #22c55e, transparent 45%);
      color: color-mix(in srgb, #bbf7d0, #ffffff 12%);
      background: color-mix(in srgb, #22c55e, transparent 86%);
    }

    .scheduler-mode-tag.mode-lite {
      border-color: color-mix(in srgb, #f59e0b, transparent 45%);
      color: color-mix(in srgb, #fde68a, #ffffff 12%);
      background: color-mix(in srgb, #f59e0b, transparent 86%);
    }

    .process-chip {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 2px 8px;
      font-size: 10px;
      font-family: var(--font-mono);
      letter-spacing: 0.02em;
      color: var(--text-muted);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 4%);
      text-transform: uppercase;
      white-space: nowrap;
    }

    .process-chip.role-core-control-plane {
      border-color: color-mix(in srgb, var(--accent-danger), transparent 42%);
      color: color-mix(in srgb, #fecaca, #ffffff 16%);
      background: color-mix(in srgb, var(--accent-danger), transparent 82%);
      font-weight: 600;
    }

    .process-chip.role-core-executor {
      border-color: color-mix(in srgb, #fb923c, transparent 42%);
      color: color-mix(in srgb, #ffedd5, #ffffff 16%);
      background: color-mix(in srgb, #fb923c, transparent 82%);
      font-weight: 600;
    }

    .process-chip.role-agent-worker {
      border-color: color-mix(in srgb, #f97316, transparent 42%);
      color: color-mix(in srgb, #ffedd5, #ffffff 16%);
      background: color-mix(in srgb, #f97316, transparent 82%);
      font-weight: 600;
    }

    .process-chip.role-runtime {
      border-color: color-mix(in srgb, #22c55e, transparent 42%);
      color: color-mix(in srgb, #dcfce7, #ffffff 16%);
      background: color-mix(in srgb, #22c55e, transparent 82%);
      font-weight: 600;
    }

    .process-chip.role-scm {
      border-color: color-mix(in srgb, #38bdf8, transparent 42%);
      color: color-mix(in srgb, #e0f2fe, #ffffff 16%);
      background: color-mix(in srgb, #38bdf8, transparent 82%);
      font-weight: 600;
    }

    .process-chip.role-tooling {
      border-color: color-mix(in srgb, #f59e0b, transparent 42%);
      color: color-mix(in srgb, #fef3c7, #ffffff 16%);
      background: color-mix(in srgb, #f59e0b, transparent 82%);
      font-weight: 600;
    }

    .process-chip.role-unknown {
      border-color: color-mix(in srgb, var(--border-strong), transparent 15%);
      color: var(--text-soft);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 2%);
      font-weight: 600;
    }

    .process-chip.tag-core {
      border-color: color-mix(in srgb, var(--accent-danger), transparent 45%);
      color: color-mix(in srgb, #fecaca, #ffffff 18%);
      background: color-mix(in srgb, var(--accent-danger), transparent 84%);
    }

    .process-chip.tag-agent {
      border-color: color-mix(in srgb, #f97316, transparent 45%);
      color: color-mix(in srgb, #fed7aa, #ffffff 14%);
      background: color-mix(in srgb, #f97316, transparent 84%);
    }

    .process-chip.tag-runtime {
      border-color: color-mix(in srgb, #22c55e, transparent 45%);
      color: color-mix(in srgb, #bbf7d0, #ffffff 14%);
      background: color-mix(in srgb, #22c55e, transparent 84%);
    }

    .process-chip.tag-scm {
      border-color: color-mix(in srgb, #38bdf8, transparent 45%);
      color: color-mix(in srgb, #bae6fd, #ffffff 14%);
      background: color-mix(in srgb, #38bdf8, transparent 84%);
    }

    .process-chip.tag-tooling {
      border-color: color-mix(in srgb, #f59e0b, transparent 45%);
      color: color-mix(in srgb, #fde68a, #ffffff 14%);
      background: color-mix(in srgb, #f59e0b, transparent 84%);
    }

    .process-chip.tag-unknown {
      border-color: color-mix(in srgb, var(--border-strong), transparent 20%);
      color: var(--text-soft);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 2%);
    }

    .mono {
      font-family: var(--font-mono);
      color: var(--text-muted);
      font-size: 11px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
    }

    .details {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      min-height: 0;
      gap: 12px;
    }

    .details.run-details-layout {
      height: 100%;
    }

    .subpanel {
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.015), transparent 28%),
        var(--bg-elev-2);
    }

    .subpanel .panel-header {
      border-radius: var(--radius-md) var(--radius-md) 0 0;
    }

    .run-inspector {
      display: grid;
      grid-template-rows: auto auto 1fr;
      overflow: hidden;
    }

    .run-inspector-tabs {
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--border-subtle);
      padding: 8px 10px;
      background: color-mix(in srgb, var(--bg-elev-2), black 2%);
    }

    .run-inspector-tabs button {
      min-height: 28px;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 0 10px;
    }

    .run-inspector-tabs button.active {
      border-color: color-mix(in srgb, var(--accent), transparent 32%);
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-3) 72%);
      color: var(--text-primary);
    }

    .run-inspector-window {
      min-height: 0;
      overflow: auto;
      padding: 10px;
      display: grid;
      gap: 8px;
    }

    .run-inspector-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 4px 8px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 5%);
    }

    .project-switch-tag {
      padding: 2px 8px;
      min-width: 0;
      max-width: 100%;
    }

    .project-switch-tag select {
      min-height: 24px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 6%);
      color: var(--text-primary);
      padding: 2px 8px;
      font-size: 11px;
      font-family: var(--font-mono);
      min-width: 180px;
      max-width: min(280px, 38vw);
    }

    .project-switch-tag select:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
    }

    .metric {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 6%);
      padding: 10px;
      display: grid;
      gap: 4px;
    }

    .metric .label {
      color: var(--text-soft);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .metric .value {
      font-family: var(--font-mono);
      color: var(--text-primary);
      font-size: 13px;
      line-height: 1.2;
    }

    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
    }

    .metric-block {
      display: grid;
      gap: 8px;
      align-content: start;
      min-height: 180px;
    }

    .metric-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .metric-block-title {
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    .metric-kv {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }

    .metric-kv .value {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .segmented {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 6%);
      overflow: hidden;
    }

    .segmented button {
      min-height: 24px;
      border: none;
      border-right: 1px solid var(--border-subtle);
      border-radius: 0;
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 0 10px;
    }

    .segmented button:last-child {
      border-right: none;
    }

    .segmented button.active {
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-3) 70%);
      color: var(--text-primary);
    }

    .lang-list {
      display: grid;
      gap: 6px;
    }

    .lang-row {
      display: grid;
      grid-template-columns: minmax(72px, auto) minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      color: var(--text-muted);
    }

    .lang-track {
      height: 8px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 6%);
      overflow: hidden;
      position: relative;
    }

    .lang-fill {
      width: var(--lang-value, 0%);
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, color-mix(in srgb, #14b8a6, white 5%), color-mix(in srgb, #22c55e, white 8%));
    }

    .trend-strip {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 6px;
      align-items: end;
    }

    .trend-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      color: var(--text-muted);
      font-size: 11px;
      font-family: var(--font-mono);
    }

    .trend-summary-item {
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: normal;
    }

    .trend-chip {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 5%);
      padding: 6px 5px;
      display: grid;
      gap: 4px;
      justify-items: center;
      min-height: 74px;
    }

    .trend-chip.up {
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-ok), transparent 80%);
    }

    .trend-chip.down {
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-danger), transparent 82%);
    }

    .trend-date {
      color: var(--text-soft);
      font-size: 10px;
      font-family: var(--font-mono);
    }

    .trend-bar {
      width: 100%;
      height: 30px;
      display: grid;
      align-items: end;
      justify-items: center;
    }

    .trend-bar span {
      width: 70%;
      min-height: 4px;
      height: var(--trend-size, 0%);
      border-radius: 6px 6px 0 0;
      background: color-mix(in srgb, var(--accent-ok), white 8%);
    }

    .trend-chip.down .trend-bar span {
      background: color-mix(in srgb, var(--accent-danger), white 6%);
    }

    .trend-net-value {
      color: var(--text-muted);
      font-size: 10px;
      font-family: var(--font-mono);
      white-space: nowrap;
      overflow-wrap: normal;
      word-break: normal;
      line-height: 1;
      max-width: 100%;
    }

    .system-token-card {
      border: 1px solid color-mix(in srgb, var(--accent), transparent 60%);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 2%);
      padding: 10px;
      display: grid;
      gap: 8px;
    }

    .system-token-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 20px;
    }

    .token-unit-summary {
      color: var(--text-muted);
      font-size: 10px;
      font-family: var(--font-mono);
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .token-unit-chip {
      display: none;
    }

    .token-chart-grid {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(360px, 1.45fr);
      gap: 10px;
      align-items: stretch;
    }

    .token-chart-card {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      padding: 8px;
      display: grid;
      gap: 8px;
    }

    .token-chart-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .token-pie-layout {
      display: grid;
      grid-template-columns: 180px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }

    .token-pie {
      --token-pie-gradient: conic-gradient(var(--accent) 0turn, var(--accent) 1turn);
      width: 180px;
      aspect-ratio: 1;
      border-radius: 50%;
      background: var(--token-pie-gradient);
      position: relative;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong), transparent 38%);
    }

    .token-pie::after {
      content: "";
      position: absolute;
      inset: 24%;
      border-radius: 50%;
      background: color-mix(in srgb, var(--bg-elev-2), black 6%);
      border: 1px solid color-mix(in srgb, var(--border-subtle), transparent 12%);
    }

    .token-pie-center {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      z-index: 1;
      text-align: center;
      gap: 2px;
    }

    .token-pie-center .value {
      font-size: 16px;
      font-weight: 650;
      color: var(--text-primary);
      font-family: var(--font-mono);
      line-height: 1;
    }

    .token-pie-center .label {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      line-height: 1;
    }

    .token-legend {
      display: grid;
      gap: 6px;
      align-content: start;
    }

    .token-legend-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      color: var(--text-muted);
      min-width: 0;
    }

    .token-legend-main {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .token-legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--dot-color, var(--accent));
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--dot-color, var(--accent)), transparent 45%);
      flex: none;
    }

    .token-legend-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .token-legend-value {
      color: var(--text-primary);
      font-size: 10px;
      font-family: var(--font-mono);
      white-space: nowrap;
      line-height: 1;
    }

    .token-line-wrap {
      border: 1px solid color-mix(in srgb, var(--border-subtle), transparent 10%);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--bg-elev-2), black 8%);
      padding: 6px;
      display: grid;
      gap: 6px;
    }

    .token-line-svg {
      width: 100%;
      height: 220px;
      display: block;
    }

    .token-line-axis-labels {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 4px;
      color: var(--text-soft);
      font-size: 10px;
      font-family: var(--font-mono);
    }

    .token-line-axis-labels span {
      text-align: center;
      white-space: nowrap;
    }

    @media (max-width: 1000px) {
      .token-chart-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 620px) {
      .token-pie-layout {
        grid-template-columns: 1fr;
        justify-items: center;
      }
    }

    .system-visual-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }

    .visual-card {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.012), transparent 34%),
        color-mix(in srgb, var(--bg-elev-3), transparent 6%);
      padding: 14px;
      display: grid;
      gap: 10px;
      min-height: 170px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
      transition: border-color 120ms ease;
    }

    .visual-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }

    .visual-copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .gauge {
      --gauge-value: 0%;
      --pressure-color: var(--accent);
      width: 100px;
      aspect-ratio: 1;
      border-radius: 50%;
      display: grid;
      place-items: center;
      flex: none;
      background:
        radial-gradient(circle at center, color-mix(in srgb, var(--bg-elev-2), black 8%) 56%, transparent 57%),
        conic-gradient(var(--pressure-color) var(--gauge-value), color-mix(in srgb, var(--border-strong), transparent 42%) 0);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pressure-color), transparent 72%);
    }

    .gauge-value {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
    }

    @media (max-width: 1320px) {
      .system-visual-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 760px) {
      .system-visual-grid {
        grid-template-columns: 1fr;
      }
    }

    .pressure-pill {
      justify-self: start;
      border: 1px solid color-mix(in srgb, var(--pressure-color), transparent 52%);
      border-radius: var(--radius-pill);
      padding: 3px 8px;
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--pressure-color), white 22%);
      font-family: var(--font-mono);
      background: color-mix(in srgb, var(--pressure-color), transparent 90%);
    }

    .pressure-bar {
      --pressure-color: var(--accent);
      display: grid;
      gap: 6px;
    }

    .pressure-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      min-width: 0;
    }

    .pressure-track {
      height: 8px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      overflow: hidden;
      background: color-mix(in srgb, var(--bg-elev-2), black 6%);
    }

    .pressure-fill {
      width: var(--pressure-value, 0%);
      height: 100%;
      background: linear-gradient(90deg, color-mix(in srgb, var(--pressure-color), black 20%), var(--pressure-color));
      transition: width 220ms ease;
    }

    .pressure-low {
      --pressure-color: var(--accent-ok);
    }

    .pressure-mid {
      --pressure-color: var(--accent-warn);
    }

    .pressure-high {
      --pressure-color: var(--accent-danger);
    }

    .visual-card.pressure-low,
    .visual-card.pressure-mid,
    .visual-card.pressure-high {
      border-color: color-mix(in srgb, var(--pressure-color), transparent 58%);
    }

    .session-grid {
      display: grid;
      gap: 8px;
    }

    .runtime-risk-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 2px;
    }

    .runtime-risk-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 8px;
    }

    .runtime-risk-card {
      border: 1px solid color-mix(in srgb, var(--accent-warn), transparent 60%);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--accent-warn), transparent 92%);
      padding: 10px;
      display: grid;
      gap: 6px;
    }

    .runtime-risk-card.rotate {
      border-color: color-mix(in srgb, var(--accent-danger), transparent 56%);
      background: color-mix(in srgb, var(--accent-danger), transparent 92%);
    }

    .runtime-risk-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .runtime-risk-title {
      font-size: 12px;
      font-weight: 650;
      color: var(--text-primary);
      line-height: 1.2;
    }

    .platform-gate-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 4px;
    }

    .platform-gate-filters {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .platform-gate-filters button {
      min-height: 26px;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 0 10px;
    }

    .platform-gate-filters button.active {
      border-color: color-mix(in srgb, var(--accent), transparent 32%);
      background: color-mix(in srgb, var(--accent-soft), var(--bg-elev-3) 72%);
      color: var(--text-primary);
    }

    .platform-gate-rollup {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px;
    }

    .platform-gate-pill {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: color-mix(in srgb, var(--bg-elev-2), black 6%);
    }

    .platform-gate-pill.done {
      border-color: color-mix(in srgb, var(--accent-ok), transparent 58%);
      background: color-mix(in srgb, var(--accent-ok), transparent 92%);
    }

    .platform-gate-pill.failed {
      border-color: color-mix(in srgb, var(--accent-danger), transparent 56%);
      background: color-mix(in srgb, var(--accent-danger), transparent 92%);
    }

    .platform-gate-pill.pending {
      border-color: color-mix(in srgb, var(--accent-warn), transparent 58%);
      background: color-mix(in srgb, var(--accent-warn), transparent 92%);
    }

    .platform-gate-pill-main {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .platform-gate-pill-title {
      font-size: 12px;
      font-weight: 650;
      color: var(--text-primary);
      line-height: 1.2;
    }

    .platform-gate-pill-meta {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
    }

    .platform-gate-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 8px;
    }

    .platform-gate-card {
      border: 1px solid color-mix(in srgb, var(--accent-ok), transparent 60%);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--accent-ok), transparent 92%);
      padding: 10px;
      display: grid;
      gap: 6px;
    }

    .platform-gate-card.failed {
      border-color: color-mix(in srgb, var(--accent-danger), transparent 56%);
      background: color-mix(in srgb, var(--accent-danger), transparent 92%);
    }

    .platform-gate-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .platform-gate-title {
      font-size: 12px;
      font-weight: 650;
      color: var(--text-primary);
      line-height: 1.2;
    }

    .pipeline-live-panel {
      display: grid;
      gap: 8px;
      min-width: 0;
    }

    .pipeline-live-panel.fill-height {
      min-height: 0;
      height: 100%;
      overflow: hidden;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
    }

    .pipeline-live-panel.fill-height .pipeline-wrap-shell,
    .pipeline-live-panel.fill-height .pipeline-wrap {
      min-height: 0;
      height: 100%;
    }

    .pipeline-wrap-shell {
      position: relative;
      min-height: 260px;
      min-width: 0;
      width: 100%;
    }

    .pipeline-wrap-shell.fullscreen-fill {
      min-height: 0;
      height: 100%;
    }

    .pipeline-wrap {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow: auto;
      background: color-mix(in srgb, var(--bg-elev-3), transparent 6%);
      padding: 8px;
      min-height: 260px;
      max-width: 100%;
      position: relative;
    }

    .pipeline-wrap.fullscreen-fill {
      min-height: 0;
      height: 100%;
    }

    .pipeline-wrap-shell.has-corner-action .pipeline-wrap {
      padding-top: 34px;
    }

    .pipeline-corner-action {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      min-width: 24px;
      min-height: 24px;
      padding: 0;
      border-radius: var(--radius-sm);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--bg-elev-2), black 4%);
      z-index: 2;
    }

    .pipeline-corner-icon {
      width: 10px;
      height: 10px;
      border: 1px solid var(--text-muted);
      border-radius: 2px;
      position: relative;
      display: inline-block;
    }

    .pipeline-corner-icon::before,
    .pipeline-corner-icon::after {
      content: "";
      position: absolute;
      width: 4px;
      height: 1px;
      background: var(--text-muted);
    }

    .pipeline-corner-icon::before {
      top: -3px;
      right: -2px;
      transform: rotate(45deg);
    }

    .pipeline-corner-icon::after {
      bottom: -3px;
      left: -2px;
      transform: rotate(45deg);
    }

    .pipeline-svg {
      display: block;
      min-width: 100%;
      height: auto;
    }

    .pipeline-edge {
      stroke: color-mix(in srgb, var(--border-strong), transparent 20%);
      stroke-width: 1.5;
      fill: none;
      opacity: 0.9;
    }

    .pipeline-node-box {
      rx: 8;
      ry: 8;
      stroke-width: 1.4;
    }

    .pipeline-node-default {
      fill: #1a1f2a;
      stroke: #3f3f46;
    }

    .pipeline-node-running {
      fill: #311f22;
      stroke: #ff5c5c;
    }

    .pipeline-node-done {
      fill: #152622;
      stroke: #22c55e;
    }

    .pipeline-node-failed {
      fill: #2d1b22;
      stroke: #ef4444;
    }

    .pipeline-node-pending {
      fill: #2f2718;
      stroke: #f59e0b;
    }

    .pipeline-node-title {
      fill: #f4f4f5;
      font-size: 12px;
      font-weight: 600;
      font-family: var(--font-ui);
    }

    .pipeline-node-meta {
      fill: #a1a1aa;
      font-size: 10px;
      font-family: var(--font-mono);
    }

    .pipeline-node-hit {
      cursor: pointer;
    }

    .pipeline-node-selected {
      stroke-width: 2.2;
      filter: drop-shadow(0 0 6px rgba(255, 92, 92, 0.22));
    }

    .pipeline-live-grid {
      display: grid;
      grid-template-columns: 1.45fr 1fr;
      gap: 10px;
      min-height: 0;
    }

    .pipeline-live-grid.without-events {
      grid-template-columns: 1fr;
    }

    .pipeline-live-grid.fullscreen-fill {
      height: 100%;
    }

    .pipeline-live-grid.fullscreen-fill .pipeline-wrap {
      height: 100%;
      min-height: 0;
    }

    .pipeline-live-grid.fullscreen-fill .pipeline-events {
      height: 100%;
      max-height: none;
    }

    .pipeline-events {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      min-height: 0;
      max-height: 560px;
      overflow: hidden;
      padding: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 0;
    }

    .pipeline-events-header {
      border-bottom: 1px solid var(--border-subtle);
      background: color-mix(in srgb, var(--bg-elev-2), black 3%);
    }

    .pipeline-events .panel-header {
      position: static;
      border-bottom: none;
    }

    .pipeline-events-header .button-row {
      padding: 0 8px 8px;
    }

    .pipeline-events-list {
      min-height: 0;
      overflow: auto;
      padding: 8px;
      display: grid;
      gap: 6px;
    }

    .create-progress-events {
      max-height: 220px;
      overflow: auto;
      padding-right: 2px;
    }

    .create-progress-summary {
      display: grid;
      gap: 4px;
      margin-bottom: 2px;
    }

    .create-progress-meter-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .create-progress-meter {
      width: 100%;
      height: 6px;
      border-radius: var(--radius-pill);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 12%);
      border: 1px solid color-mix(in srgb, var(--border-subtle), transparent 22%);
      overflow: hidden;
    }

    .create-progress-meter > span {
      display: block;
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, color-mix(in srgb, var(--accent), white 8%), color-mix(in srgb, var(--accent-ok), transparent 18%));
      transition: width 160ms ease;
    }

    .create-progress-group-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .error {
      color: var(--accent-danger);
      font-size: 12px;
      font-family: var(--font-mono);
    }

    .toast-stack {
      position: fixed;
      top: 74px;
      right: 20px;
      z-index: 30;
      width: min(520px, calc(100vw - 28px));
      pointer-events: none;
    }

    .toast {
      pointer-events: auto;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 22%),
        color-mix(in srgb, var(--bg-elev-2), black 2%);
      box-shadow: var(--shadow-md);
      display: grid;
      gap: 8px;
      padding: 10px 12px;
      animation: toast-in 120ms ease;
    }

    .toast.success {
      border-color: color-mix(in srgb, var(--accent-ok), transparent 58%);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--accent-ok), transparent 88%),
        var(--shadow-md);
    }

    .toast.error {
      border-color: color-mix(in srgb, var(--accent-danger), transparent 52%);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--accent-danger), transparent 86%),
        var(--shadow-md);
    }

    .toast.info {
      border-color: color-mix(in srgb, var(--accent), transparent 64%);
    }

    .toast-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--text-soft);
    }

    .toast.success .toast-head {
      color: color-mix(in srgb, var(--accent-ok), white 12%);
    }

    .toast.error .toast-head {
      color: color-mix(in srgb, var(--accent-danger), white 12%);
    }

    .toast-body {
      color: var(--text-primary);
      font-size: 12px;
      line-height: 1.45;
      word-break: break-word;
      font-family: var(--font-mono);
    }

    .toast-close {
      min-height: 24px;
      min-width: 24px;
      width: 24px;
      padding: 0;
      border-radius: var(--radius-sm);
      font-size: 14px;
      line-height: 1;
      font-family: var(--font-ui);
      font-weight: 700;
    }

    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }

      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .hint {
      color: var(--text-soft);
      font-size: 11px;
    }

    .loading-state {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px dashed color-mix(in srgb, var(--border-strong), transparent 25%);
      border-radius: var(--radius-md);
      color: var(--text-muted);
      background: color-mix(in srgb, var(--bg-elev-2), transparent 12%);
      font-size: 12px;
    }

    .loading-spinner {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 2px solid color-mix(in srgb, var(--border-strong), transparent 25%);
      border-top-color: var(--accent);
      animation: loading-spin 0.9s linear infinite;
      flex: 0 0 auto;
    }

    @keyframes loading-spin {
      to {
        transform: rotate(360deg);
      }
    }

    .skeleton-stack {
      display: grid;
      gap: 10px;
    }

    .skeleton-grid-2 {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .skeleton-grid-3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .skeleton-card {
      min-height: 84px;
      border-radius: var(--radius-md);
      border: 1px solid color-mix(in srgb, var(--border-subtle), transparent 12%);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      padding: 10px;
      display: grid;
      gap: 8px;
      align-content: start;
    }

    .skeleton-row {
      height: 40px;
      border-radius: var(--radius-md);
      border: 1px solid color-mix(in srgb, var(--border-subtle), transparent 12%);
      background: color-mix(in srgb, var(--bg-elev-3), transparent 8%);
      padding: 10px;
      display: grid;
      align-content: center;
    }

    .skeleton-line {
      height: 10px;
      width: var(--skeleton-w, 100%);
      border-radius: 999px;
      background:
        linear-gradient(
          90deg,
          color-mix(in srgb, var(--border-subtle), transparent 25%) 25%,
          color-mix(in srgb, var(--border-strong), transparent 15%) 45%,
          color-mix(in srgb, var(--border-subtle), transparent 25%) 65%
        );
      background-size: 220% 100%;
      animation: skeleton-shimmer 1.3s ease-in-out infinite;
    }

    @keyframes skeleton-shimmer {
      0% {
        background-position: 100% 0;
      }
      100% {
        background-position: -120% 0;
      }
    }

    .page-loading-shell {
      position: relative;
      min-height: 0;
    }

    .page-loading-content {
      transition: opacity 240ms ease, transform 240ms ease, filter 240ms ease;
    }

    .page-loading-content.dim {
      opacity: 0.46;
      filter: saturate(0.84);
      transform: translateY(2px);
    }

    .page-loading-content.ready {
      opacity: 1;
      filter: none;
      transform: translateY(0);
    }

    .page-loading-overlay {
      position: absolute;
      inset: 0;
      z-index: 2;
      border-radius: var(--radius-md);
      padding: 2px;
      background: color-mix(in srgb, var(--bg-primary), transparent 26%);
      backdrop-filter: blur(1px);
      transition: opacity 240ms ease, transform 240ms ease;
      transform: translateY(4px);
      opacity: 0;
      pointer-events: none;
      display: grid;
      align-content: start;
    }

    .page-loading-overlay.visible {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }

    .page-loading-overlay.hidden {
      opacity: 0;
      transform: translateY(4px);
      pointer-events: none;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.62);
      backdrop-filter: blur(2px);
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 16px;
    }

    .modal {
      width: min(760px, 100%);
      max-height: 92vh;
      overflow: auto;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.015), transparent 24%),
        var(--bg-elev-2);
      box-shadow: var(--shadow-md);
    }

    .modal.pipeline-fullscreen-modal {
      width: min(1600px, calc(100vw - 36px));
      height: calc(100vh - 36px);
      max-height: calc(100vh - 36px);
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .modal.agent-team-3d-modal {
      width: min(1300px, calc(100vw - 42px));
      height: min(860px, calc(100vh - 42px));
      max-height: calc(100vh - 42px);
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .modal.token-usage-modal {
      width: min(1200px, calc(100vw - 42px));
      height: min(860px, calc(100vh - 42px));
      max-height: calc(100vh - 42px);
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .modal-body-scroll {
      overflow: auto;
      min-height: 0;
      padding: 12px;
      display: grid;
      gap: 12px;
    }

    .modal-body-scroll.pipeline-fullscreen-body {
      padding: 8px;
      gap: 8px;
      grid-template-rows: 1fr;
      align-content: stretch;
    }

    .modal-body-scroll.agent-team-3d-body {
      padding: 10px;
      grid-template-rows: 1fr;
      align-content: stretch;
      overflow: hidden;
    }

    .modal-body-scroll.agent-team-3d-body > agent-team-3d {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    .pipeline-fullscreen-stage {
      min-height: 0;
      height: 100%;
      display: grid;
      grid-template-rows: 1fr;
      gap: 8px;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      background: color-mix(in srgb, var(--bg-elev-2), black 3%);
      z-index: 1;
    }

    @media (max-width: 1000px) {
      .shell {
        grid-template-columns: 1fr;
        padding: 8px;
      }

      .splitter,
      .sidebar {
        display: none;
      }

      .main {
        border-radius: var(--radius-md);
      }

      .topbar {
        grid-template-columns: 1fr;
        height: auto;
        min-height: 58px;
        padding: 10px 12px;
      }

      .brand {
        width: auto;
      }

      .topbar-center {
        width: 100%;
      }

      .topbar-right {
        width: 100%;
        justify-content: flex-start;
        flex-wrap: wrap;
      }

      .topbar-status {
        width: auto;
      }

      .details {
        grid-template-columns: 1fr;
      }

      .details.run-details-layout {
        height: auto;
      }

      .workspace {
        grid-template-rows: 1fr;
        padding: 8px;
        gap: 8px;
      }

      .grid-2 {
        grid-template-columns: 1fr;
      }

      .run-launch-source {
        grid-template-columns: 1fr;
      }

      .run-launch-health-grid {
        grid-template-columns: 1fr;
      }

      .pipeline-live-grid {
        grid-template-columns: 1fr;
      }

      .toast-stack {
        top: 66px;
        right: 10px;
        width: calc(100vw - 20px);
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    const storedProjectId = this.readStoredSelectedProjectId();
    if (storedProjectId) {
      this.selectedProjectId = storedProjectId;
    }
    void this.refreshAll();
    this.refreshTimer = window.setInterval(() => {
      const tasks: Array<Promise<unknown>> = [
        this.refreshEngineState(),
        this.refreshSystemConfig(),
      ];
      if (this.selectedProjectId) {
        tasks.push(this.refreshProjectMetrics());
      }
      void Promise.all(tasks);
    }, 5000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.eventsSource) {
      this.eventsSource.close();
      this.eventsSource = null;
    }
    this.closeCreateProjectStream();
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.clearMessageAutoDismissTimer();
  }

  protected updated(changedProps: Map<PropertyKey, unknown>): void {
    super.updated(changedProps);
    if (changedProps.has("selectedProjectId")) {
      this.writeStoredSelectedProjectId(this.selectedProjectId);
      this.platformGateOnlyFailed = this.readStoredPlatformGateOnlyFailed(this.selectedProjectId);
    }
    if (changedProps.has("platformGateOnlyFailed")) {
      this.writeStoredPlatformGateOnlyFailed(this.selectedProjectId, this.platformGateOnlyFailed);
    }
    if (changedProps.has("createProjectProgress") && this.showCreateProjectModal) {
      this.scrollCreateProjectProgressToBottom();
    }
    if (changedProps.has("message")) {
      const current = String(this.message ?? "").trim();
      this.messageTone = current ? this.getMessageTone(current) : "info";
      this.clearMessageAutoDismissTimer();
      if (current) {
        this.messageAutoDismissTimer = window.setTimeout(() => {
          this.message = "";
          this.messageAutoDismissTimer = null;
        }, 4200);
      }
    }
  }

  private clearMessageAutoDismissTimer(): void {
    if (this.messageAutoDismissTimer !== null) {
      window.clearTimeout(this.messageAutoDismissTimer);
      this.messageAutoDismissTimer = null;
    }
  }

  private dismissMessageToast(): void {
    this.clearMessageAutoDismissTimer();
    this.message = "";
    this.messageTone = "info";
  }

  private readStoredSelectedProjectId(): string {
    try {
      const raw = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
      return String(raw ?? "").trim();
    } catch {
      return "";
    }
  }

  private writeStoredSelectedProjectId(projectId: string): void {
    const normalized = String(projectId ?? "").trim();
    try {
      if (normalized) {
        window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, normalized);
      } else {
        window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
      }
    } catch {}
  }

  private buildPlatformGateOnlyFailedStorageKey(projectId: string): string {
    const normalized = String(projectId ?? "").trim();
    return `${PLATFORM_GATE_ONLY_FAILED_STORAGE_KEY_PREFIX}${normalized}`;
  }

  private readStoredPlatformGateOnlyFailed(projectId: string): boolean {
    const normalized = String(projectId ?? "").trim();
    if (!normalized) return false;
    try {
      const raw = String(window.localStorage.getItem(this.buildPlatformGateOnlyFailedStorageKey(normalized)) ?? "").trim().toLowerCase();
      return raw === "1" || raw === "true";
    } catch {
      return false;
    }
  }

  private writeStoredPlatformGateOnlyFailed(projectId: string, onlyFailed: boolean): void {
    const normalized = String(projectId ?? "").trim();
    if (!normalized) return;
    try {
      window.localStorage.setItem(
        this.buildPlatformGateOnlyFailedStorageKey(normalized),
        onlyFailed ? "1" : "0",
      );
    } catch {}
  }

  private setMessageToast(message: string, tone?: "success" | "error" | "info"): void {
    const text = String(message ?? "").trim();
    this.messageTone = tone ?? this.getMessageTone(text);
    this.message = text;
  }

  private getMessageTone(message: string): "success" | "error" | "info" {
    const text = String(message ?? "");
    if (/^\s*已打开\s+/i.test(text)) {
      return "success";
    }
    if (/失败|错误|error|invalid|not found|不能为空|阻塞|断开|failed|forbidden|denied|异常/i.test(text)) {
      return "error";
    }
    if (/已|成功|通过|就绪|完成|opened|saved|created|resumed|ok/i.test(text)) {
      return "success";
    }
    return "info";
  }

  private renderMessageToast() {
    const text = String(this.message ?? "").trim();
    if (!text) return null;
    const tone = this.messageTone;
    const title = tone === "error" ? "操作失败" : tone === "success" ? "操作成功" : "系统提示";
    return html`
      <div class="toast-stack" role="status" aria-live="polite">
        <div class=${`toast ${tone}`}>
          <div class="toast-head">
            <span>${title}</span>
            <button type="button" class="toast-close" @click=${() => this.dismissMessageToast()} aria-label="关闭提示">
              ×
            </button>
          </div>
          <div class="toast-body">${text}</div>
        </div>
      </div>
    `;
  }

  private nextProjectLoadToken(): number {
    this.projectLoadToken += 1;
    return this.projectLoadToken;
  }

  private isProjectLoadCurrent(projectId: string, token?: number): boolean {
    const target = String(projectId ?? "").trim();
    if (!target || target !== this.selectedProjectId) return false;
    if (typeof token === "number") {
      return token === this.projectLoadToken;
    }
    return true;
  }

  private renderProjectLoadingHint(detail = "正在加载项目最新数据…", skeleton: unknown = null) {
    return html`
      <div class="loading-state" role="status" aria-live="polite">
        <span class="loading-spinner" aria-hidden="true"></span>
        <span>${detail}</span>
      </div>
      ${skeleton}
    `;
  }

  private renderProjectLoadingOverlay(
    visible: boolean,
    detail: string,
    kind: "overview" | "issues" | "runs" | "workflow" | "scheduler",
  ) {
    return html`
      <div class=${`page-loading-overlay ${visible ? "visible" : "hidden"}`} aria-hidden=${visible ? "false" : "true"}>
        ${this.renderProjectLoadingHint(detail, this.renderProjectLoadingSkeleton(kind))}
      </div>
    `;
  }

  private renderSkeletonLines(widths: number[]) {
    return widths.map((width) => html`<div class="skeleton-line" style=${`--skeleton-w:${Math.max(20, Math.min(100, width))}%;`}></div>`);
  }

  private renderProjectLoadingSkeleton(kind: "overview" | "issues" | "runs" | "workflow" | "scheduler") {
    if (kind === "overview") {
      return html`
        <div class="skeleton-stack">
          <div class="skeleton-grid-3">
            <div class="skeleton-card">${this.renderSkeletonLines([58, 86, 44])}</div>
            <div class="skeleton-card">${this.renderSkeletonLines([52, 78, 40])}</div>
            <div class="skeleton-card">${this.renderSkeletonLines([49, 82, 42])}</div>
          </div>
          <div class="skeleton-card">${this.renderSkeletonLines([36, 94, 91, 76, 62])}</div>
        </div>
      `;
    }
    if (kind === "issues") {
      return html`
        <div class="skeleton-stack">
          <div class="skeleton-card">${this.renderSkeletonLines([42, 94, 88])}</div>
          <div class="skeleton-row">${this.renderSkeletonLines([72])}</div>
          <div class="skeleton-row">${this.renderSkeletonLines([66])}</div>
          <div class="skeleton-row">${this.renderSkeletonLines([78])}</div>
        </div>
      `;
    }
    if (kind === "runs") {
      return html`
        <div class="skeleton-stack">
          <div class="skeleton-card">${this.renderSkeletonLines([52, 90, 72])}</div>
          <div class="skeleton-row">${this.renderSkeletonLines([64])}</div>
          <div class="skeleton-row">${this.renderSkeletonLines([70])}</div>
          <div class="skeleton-row">${this.renderSkeletonLines([58])}</div>
        </div>
      `;
    }
    if (kind === "workflow") {
      return html`
        <div class="skeleton-stack">
          <div class="skeleton-card">${this.renderSkeletonLines([38, 100, 100, 100, 84])}</div>
          <div class="skeleton-card">${this.renderSkeletonLines([34, 92, 88, 77])}</div>
        </div>
      `;
    }
    return html`
      <div class="skeleton-stack">
        <div class="skeleton-grid-2">
          <div class="skeleton-card">${this.renderSkeletonLines([44, 94, 66])}</div>
          <div class="skeleton-card">${this.renderSkeletonLines([40, 92, 70])}</div>
        </div>
        <div class="skeleton-card">${this.renderSkeletonLines([30, 88, 84, 68])}</div>
      </div>
    `;
  }

  private async refreshAll(): Promise<void> {
    this.loading = true;
    this.message = "";
    try {
      await Promise.all([
        this.refreshProjects(),
        this.refreshEngineState(),
        this.refreshSystemConfig(),
        this.refreshGlobalTokenUsage(),
      ]);
      if (this.selectedProjectId) {
        const projectId = this.selectedProjectId;
        const loadToken = this.nextProjectLoadToken();
        this.projectDataLoading = true;
        const metricsTask = this.refreshProjectMetrics(projectId, loadToken);
        try {
          await Promise.all([
            this.refreshIssues(projectId, loadToken),
            this.refreshRuns(projectId, loadToken),
            this.refreshSchedulerConfig(projectId, loadToken),
            this.refreshWorkflowConfig(projectId, loadToken),
          ]);
        } finally {
          if (this.isProjectLoadCurrent(projectId, loadToken)) {
            this.projectDataLoading = false;
          }
        }
        void metricsTask;
      } else {
        this.projectDataLoading = false;
        this.projectMetricsLoading = false;
      }
      if (this.selectedRunId) {
        await this.refreshRunDetail();
      }
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private async refreshProjects(): Promise<void> {
    this.projects = await listProjects();
    if (this.selectedProjectId && !this.projects.some((project) => project.id === this.selectedProjectId)) {
      this.selectedProjectId = "";
    }
    if (!this.selectedProjectId && this.projects.length > 0) {
      this.selectedProjectId = this.projects[0].id;
    }
    if (!this.selectedProjectId) {
      this.projectMetrics = null;
    }
  }

  private async refreshIssues(projectId = this.selectedProjectId, loadToken?: number): Promise<void> {
    const targetProjectId = String(projectId ?? "").trim();
    if (!targetProjectId) {
      this.issues = [];
      return;
    }
    const loaded = await listIssues(targetProjectId);
    if (!this.isProjectLoadCurrent(targetProjectId, loadToken)) return;
    this.issues = loaded;
    this.ensureRunLaunchDrafts();
  }

  private async refreshProjectMetrics(projectId = this.selectedProjectId, loadToken?: number): Promise<void> {
    const targetProjectId = String(projectId ?? "").trim();
    if (!targetProjectId) {
      this.projectMetrics = null;
      this.projectMetricsLoading = false;
      return;
    }
    if (this.projects.length > 0 && !this.projects.some((project) => project.id === targetProjectId)) {
      this.projectMetrics = null;
      this.projectMetricsLoading = false;
      return;
    }
    const trackLoading = this.isProjectLoadCurrent(targetProjectId, loadToken);
    if (trackLoading) {
      this.projectMetricsLoading = true;
    }
    try {
      const loaded = await getProjectMetrics(targetProjectId);
      if (!this.isProjectLoadCurrent(targetProjectId, loadToken)) return;
      this.projectMetrics = loaded;
    } catch {
      if (!this.isProjectLoadCurrent(targetProjectId, loadToken)) return;
      this.projectMetrics = null;
    } finally {
      if (this.isProjectLoadCurrent(targetProjectId, loadToken)) {
        this.projectMetricsLoading = false;
      }
    }
  }

  private async refreshSchedulerConfig(projectId = this.selectedProjectId, loadToken?: number): Promise<void> {
    const targetProjectId = String(projectId ?? "").trim();
    if (!targetProjectId) {
      this.schedulerConfig = null;
      return;
    }
    const loaded = await getProjectSchedulerConfig(targetProjectId);
    if (!this.isProjectLoadCurrent(targetProjectId, loadToken)) return;
    this.schedulerConfig = {
      ...loaded,
      timezone: this.normalizeSchedulerTimezone(String(loaded.timezone ?? "")),
    };
  }

  private async refreshWorkflowConfig(projectId = this.selectedProjectId, loadToken?: number): Promise<void> {
    const targetProjectId = String(projectId ?? "").trim();
    if (!targetProjectId) {
      this.workflowConfig = null;
      this.workflowYamlDraft = "";
      return;
    }
    const loaded = await getProjectWorkflowConfig(targetProjectId);
    if (!this.isProjectLoadCurrent(targetProjectId, loadToken)) return;
    this.workflowConfig = loaded;
    this.workflowYamlDraft = loaded.yaml;
  }

  private async refreshRuns(projectId = this.selectedProjectId, loadToken?: number): Promise<void> {
    const targetProjectId = String(projectId ?? "").trim();
    if (!targetProjectId) {
      this.runs = [];
      return;
    }
    const loaded = await listRuns(targetProjectId);
    if (!this.isProjectLoadCurrent(targetProjectId, loadToken)) return;
    this.runs = loaded;
    this.ensureRunLaunchDrafts();
    if (!this.selectedRunId && this.runs.length > 0) {
      this.selectedRunId = this.runs[0].id;
      this.runInsightTab = "events";
      this.connectRunEvents();
    }
  }

  private async refreshRunDetail(): Promise<void> {
    if (!this.selectedRunId) {
      this.runDetail = null;
      return;
    }
    this.runDetail = await getRunDetail(this.selectedRunId);
  }

  private async refreshEngineState(): Promise<void> {
    this.engine = await getEngineState();
    if (this.engine?.concurrency && !Number.isNaN(this.engine.concurrency)) {
      this.desiredConcurrency = this.engine.concurrency;
    }
  }

  private async refreshSystemConfig(): Promise<void> {
    this.systemConfig = await getSystemConfig();
    this.doctor = this.systemConfig.doctor;
  }

  private async refreshGlobalTokenUsage(): Promise<void> {
    if (this.globalTokenUsageUnsupported) return;
    try {
      const loaded = await getGlobalTokenUsage();
      if (!loaded) {
        this.globalTokenUsage = null;
        this.globalTokenUsageUnsupported = true;
        return;
      }
      this.globalTokenUsage = loaded;
    } catch {
      this.globalTokenUsage = null;
    }
  }

  private async onApplyConcurrency(): Promise<void> {
    const value = Number(this.desiredConcurrency);
    if (!Number.isFinite(value) || value <= 0) {
      this.message = "并发度必须是正整数。";
      return;
    }
    this.engine = await updateEngineState({
      concurrency: Math.max(1, Math.floor(value)),
    });
  }

  private connectRunEvents(): void {
    if (!this.selectedRunId) return;
    if (this.eventsSource) {
      this.eventsSource.close();
      this.eventsSource = null;
    }

    const source = new EventSource(`/api/events/stream?runId=${encodeURIComponent(this.selectedRunId)}`);
    source.addEventListener("event", () => {
      void this.refreshRunDetail();
      void this.refreshRuns();
      void this.refreshProjectMetrics();
      void this.refreshGlobalTokenUsage();
    });
    source.onerror = () => {
      this.message = "运行事件流已断开，正在后台自动重连。";
    };
    this.eventsSource = source;
  }

  private closeCreateProjectStream(): void {
    if (this.createProjectSource) {
      this.createProjectSource.close();
      this.createProjectSource = null;
    }
  }

  private nextCreateProjectProgressId(): number {
    this.createProjectProgressSeq += 1;
    return this.createProjectProgressSeq;
  }

  private appendCreateProjectProgress(row: Omit<ProjectCreateProgressRow, "id"> & { id?: number }): void {
    const next: ProjectCreateProgressRow = {
      id: Number(row.id ?? this.nextCreateProjectProgressId()),
      stage: String(row.stage ?? ""),
      detail: String(row.detail ?? ""),
      at: String(row.at ?? new Date().toISOString()),
      status: row.status,
    };
    this.createProjectProgress = [...this.createProjectProgress, next].slice(-120);
  }

  private scrollCreateProjectProgressToBottom(): void {
    const panel = this.renderRoot.querySelector<HTMLElement>(".create-progress-events");
    if (!panel) return;
    panel.scrollTop = panel.scrollHeight;
  }

  private formatCreateProjectStage(stage: string): string {
    const key = String(stage ?? "").trim();
    const map: Record<string, string> = {
      "request.accepted": "请求已接收",
      "preflight.start": "平台工具链预检查",
      "preflight.check": "预检查项执行",
      "preflight.done": "预检查通过",
      "scaffold.start": "开始初始化",
      "scaffold.dirs.ready": "目录初始化",
      "scaffold.files.core": "核心文件",
      "scaffold.files.invariants": "不变量文件",
      "scaffold.files.platform": "平台验收脚本",
      "scaffold.files.docs": "文档骨架",
      "scaffold.skills": "技能模板",
      "scaffold.git": "Git/GitHub 初始化",
      "git.precheck": "Git 预检查",
      "git.repo.ensure": "本地仓库检查",
      "git.remote.detect": "检测远程绑定",
      "git.remote.exists": "远程已存在",
      "git.remote.skip": "跳过远程创建",
      "git.remote.create.prepare": "准备创建远程",
      "git.remote.commit.ensure": "准备初始提交",
      "git.remote.check": "检查远程仓库",
      "git.remote.bind": "绑定已有仓库",
      "git.remote.create": "创建远程仓库",
      "git.remote.verify": "校验远程绑定",
      "git.done": "Git 完成",
      "scaffold.done": "脚手架完成",
      "project.done": "项目创建完成",
      "project.failed": "项目创建失败",
    };
    return map[key] ?? (key || "阶段更新");
  }

  private resolveCreateProjectStageGroup(stage: string): ProjectCreateProgressGroupKey {
    const key = String(stage ?? "").trim();
    if (key === "request.accepted" || key.startsWith("preflight.")) return "precheck";
    if (key.startsWith("scaffold.") && key !== "scaffold.git") return "scaffold";
    if (key === "scaffold.git" || key.startsWith("git.")) return "git";
    if (key === "project.done" || key === "project.failed") return "finalize";
    return "unknown";
  }

  private formatCreateProjectStageGroup(group: ProjectCreateProgressGroupKey): string {
    if (group === "precheck") return "预检查";
    if (group === "scaffold") return "脚手架";
    if (group === "git") return "Git/GitHub";
    if (group === "finalize") return "收尾";
    return "其他";
  }

  private buildCreateProjectProgressGroups(rows: ProjectCreateProgressRow[]): Array<{
    key: ProjectCreateProgressGroupKey;
    label: string;
    rows: ProjectCreateProgressRow[];
  }> {
    const grouped = new Map<ProjectCreateProgressGroupKey, ProjectCreateProgressRow[]>();
    for (const row of rows) {
      const group = this.resolveCreateProjectStageGroup(row.stage);
      const bucket = grouped.get(group) ?? [];
      bucket.push(row);
      grouped.set(group, bucket);
    }
    const ordered: ProjectCreateProgressGroupKey[] = ["precheck", "scaffold", "git", "finalize", "unknown"];
    return ordered
      .filter((key) => (grouped.get(key)?.length ?? 0) > 0)
      .map((key) => ({
        key,
        label: this.formatCreateProjectStageGroup(key),
        rows: grouped.get(key) ?? [],
      }));
  }

  private summarizeCreateProjectGroupCompletion(rows: ProjectCreateProgressRow[]): {
    completed: number;
    total: number;
    percent: number;
  } {
    const total = CREATE_PROJECT_PROGRESS_GROUP_ORDER.length;
    if (rows.length === 0) {
      return { completed: 0, total, percent: 0 };
    }

    let hasPrecheck = false;
    let hasScaffold = false;
    let hasGit = false;
    let hasFinalize = false;
    let hasTerminal = false;

    for (const row of rows) {
      const group = this.resolveCreateProjectStageGroup(row.stage);
      if (group === "precheck") hasPrecheck = true;
      if (group === "scaffold") hasScaffold = true;
      if (group === "git") hasGit = true;
      if (group === "finalize") {
        hasFinalize = true;
        if (
          row.stage === "project.done"
          || row.stage === "project.failed"
          || row.status === "done"
          || row.status === "error"
        ) {
          hasTerminal = true;
        }
      }
    }

    let completed = 0;
    if (hasPrecheck || hasScaffold || hasGit || hasFinalize) completed = 1;
    if (hasScaffold || hasGit || hasFinalize) completed = 2;
    if (hasGit || hasFinalize) completed = 3;
    if (hasFinalize) completed = 4;
    if (hasTerminal) completed = total;

    const percent = Math.round((Math.max(0, Math.min(completed, total)) / total) * 100);
    return { completed, total, percent };
  }

  private createProjectStatusDot(status: ProjectCreateProgressRow["status"]): "running" | "done" | "failed" {
    if (status === "done") return "done";
    if (status === "error") return "failed";
    return "running";
  }

  private createProjectSessionId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `pcs-${Date.now()}-${rand}`;
  }

  private async connectCreateProjectProgressStream(sessionId: string): Promise<void> {
    this.closeCreateProjectStream();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };

      const source = new EventSource(`/api/projects/create/stream?sessionId=${encodeURIComponent(sessionId)}`);
      this.createProjectSource = source;

      source.onopen = () => {
        finish();
      };
      source.addEventListener("project-create-progress", (ev: Event) => {
        try {
          const message = ev as MessageEvent<string>;
          const payload = JSON.parse(String(message.data ?? "{}"));
          const status = payload?.status === "done"
            ? "done"
            : payload?.status === "error"
              ? "error"
              : "progress";
          this.appendCreateProjectProgress({
            id: Number(payload?.id ?? this.nextCreateProjectProgressId()),
            stage: String(payload?.stage ?? ""),
            detail: String(payload?.detail ?? ""),
            at: String(payload?.at ?? new Date().toISOString()),
            status,
          });
        } catch {
          // ignore malformed progress payload
        }
        finish();
      });
      source.onerror = () => {
        finish();
      };

      const timer = window.setTimeout(() => {
        finish();
      }, 1200);
    });
  }

  private async onPickProjectRootPath(): Promise<void> {
    if (this.createProjectInFlight) return;
    try {
      const startPath = this.createProjectRootPath.trim() || "~/";
      const picked = await pickProjectRootDirectory(startPath);
      if (picked.cancelled) {
        this.message = "已取消目录选择。";
        return;
      }
      this.createProjectRootPath = String(picked.path ?? "").trim();
      if (!this.createProjectRootPath) {
        this.message = "未选择有效目录，请重试或手动填写。";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.message = `目录选择失败：${message}`;
    }
  }

  private async onCreateProject(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const rootPath = this.createProjectRootPath.trim() || String(data.get("rootPath") ?? "").trim();
    const productType = String(data.get("productType") ?? "web");
    const problemStatement = String(data.get("problemStatement") ?? "");

    if (!name || !rootPath) {
      this.message = "项目名称和根路径为必填项。";
      return;
    }

    this.message = "";
    this.createProjectInFlight = true;
    this.createProjectProgress = [];
    const sessionId = this.createProjectSessionId();

    try {
      await this.connectCreateProjectProgressStream(sessionId);
      this.appendCreateProjectProgress({
        stage: "request.accepted",
        detail: "正在发送创建请求...",
        at: new Date().toISOString(),
        status: "progress",
      });

      const created = await createProject({
        name,
        rootPath,
        productType,
        problemStatement,
        createSessionId: sessionId,
      });
      this.appendCreateProjectProgress({
        stage: "project.done",
        detail: `项目创建完成，projectId=${created.id}`,
        at: new Date().toISOString(),
        status: "done",
      });

      form.reset();
      this.createProjectRootPath = "";
      this.currentPage = "project_overview";
      await this.refreshProjects();
      this.selectedProjectId = created.id;
      await this.refreshIssues();
      await this.refreshRuns();
      await this.refreshProjectMetrics();
      await this.refreshSchedulerConfig();
      await this.refreshWorkflowConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.message = message;
      this.appendCreateProjectProgress({
        stage: "project.failed",
        detail: message,
        at: new Date().toISOString(),
        status: "error",
      });
    } finally {
      this.createProjectInFlight = false;
      this.closeCreateProjectStream();
    }
  }

  private async onCreateIssue(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();
    if (!title) {
      this.message = "GitHub Issue 标题不能为空。";
      return;
    }
    const created = await createIssue({ projectId: this.selectedProjectId, title, description, autoRun: true });
    form.reset();
    await this.refreshIssues();
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    if (created.run) {
      this.message = `GitHub Issue #${created.issue.id} 已创建，并自动触发 Run: ${created.run.id}`;
      this.selectedRunId = created.run.id;
      this.runInsightTab = "events";
      this.connectRunEvents();
      await this.refreshRunDetail();
      return;
    }
    if (created.autoRunEnabled && created.autoRunError) {
      this.message = `GitHub Issue 已创建，但自动触发 Run 失败：${created.autoRunError}`;
      return;
    }
    this.message = `GitHub Issue #${created.issue.id} 已创建。`;
  }

  private getIssueById(issueId: string): Issue | null {
    if (!issueId) return null;
    return this.issues.find((issue) => issue.id === issueId) ?? null;
  }

  private composeTaskFromIssue(issue: Issue): string {
    const title = String(issue.title ?? "").trim();
    return `处理 GitHub Issue #${issue.id}：${title}（含实现、验证、文档更新）`;
  }

  private getRunLaunchHealth() {
    const cfg = this.systemConfig;
    const runtimeReady = Boolean(cfg?.runtime?.ready);
    const gitReady = Boolean(cfg?.git?.available && cfg?.git?.configured);
    const githubReady = cfg
      ? (!cfg.github.patRequired || (cfg.github.patConfigured && cfg.github.validated))
      : false;
    return {
      runtimeReady,
      gitReady,
      githubReady,
      ready: runtimeReady && gitReady && githubReady,
    };
  }

  private ensureRunLaunchDrafts(): void {
    const prevIssueDraft = this.runIssueDraft;
    if (!this.runIssueDraft || !this.issues.some((issue) => issue.id === this.runIssueDraft)) {
      this.runIssueDraft = this.issues[0]?.id ?? "";
    }
    const issue = this.getIssueById(this.runIssueDraft);
    if (!issue) {
      this.runTaskDraft = "";
      return;
    }
    if (!this.runTaskDraft || prevIssueDraft !== this.runIssueDraft) {
      this.runTaskDraft = this.composeTaskFromIssue(issue);
    }
  }

  private onRunIssueDraftChange(ev: Event): void {
    const issueId = String((ev.currentTarget as HTMLSelectElement).value ?? "").trim();
    this.runIssueDraft = issueId;
    const issue = this.getIssueById(issueId);
    this.runTaskDraft = issue ? this.composeTaskFromIssue(issue) : "";
  }

  private onRunTaskDraftInput(ev: InputEvent): void {
    this.runTaskDraft = (ev.currentTarget as HTMLTextAreaElement).value;
  }

  private onRunModeDraftChange(ev: Event): void {
    const raw = String((ev.currentTarget as HTMLSelectElement).value ?? "").trim().toLowerCase();
    if (raw === "quick") {
      this.runModeDraft = raw;
      return;
    }
    this.runModeDraft = "standard";
  }

  private renderRunLaunchCard(options?: { showResume?: boolean }) {
    const showResume = options?.showResume !== false;
    const issueDraft = this.runIssueDraft || this.issues[0]?.id || "";
    const launchHealth = this.getRunLaunchHealth();
    const noIssues = this.issues.length === 0;
    const selectedRun = this.runs.find((run) => run.id === this.selectedRunId) ?? null;
    const selectedRunStatus = String(selectedRun?.status ?? "").trim().toLowerCase();
    const canStopSelectedRun = selectedRunStatus === "running";
    const canResumeSelectedRun = selectedRunStatus === "failed" || selectedRunStatus === "paused";
    const canStopProjectRuns = this.runs.some((run) => String(run.status ?? "").trim().toLowerCase() === "running");
    const canResumeProjectRuns = this.runs.some((run) => String(run.status ?? "").trim().toLowerCase() === "paused");

    return html`
      <form @submit=${this.onCreateRun}>
        <div class="run-launch-card">
          <div class="hint">Run 必须绑定 GitHub Issue（Issue-Only 模式）。</div>

          <label>
            选择 Issue
            <select
              name="issueDraft"
              .value=${issueDraft}
              @change=${this.onRunIssueDraftChange}
              ?disabled=${noIssues}
              required
            >
              ${noIssues
                ? html`<option value="">暂无可选 Issue，请先创建 Issue</option>`
                : this.issues.map((issue) => html`
                    <option value=${issue.id}>#${issue.id} · ${issue.title}</option>
                  `)}
            </select>
          </label>

          <label>
            运行任务（可选覆盖）
            <textarea
              name="taskDraft"
              placeholder="默认会基于 Issue 自动生成任务描述"
              .value=${this.runTaskDraft}
              @input=${this.onRunTaskDraftInput}
            ></textarea>
          </label>

          <label>
            执行模式
            <select
              name="modeDraft"
              .value=${this.runModeDraft}
              @change=${this.onRunModeDraftChange}
            >
              <option value="standard">standard（默认，按项目 workflow）</option>
              <option value="quick">quick（implement -> test -> cleanup）</option>
            </select>
          </label>
          <div class="hint">
            quick 适合小改动与快速验收；若项目 workflow 缺少 quick 关键 step，会自动回落 standard。
          </div>

          <div class="run-launch-health">
            <div class="run-launch-health-grid">
              <span class="run-launch-health-item">
                runtime
                <status-dot status=${launchHealth.runtimeReady ? "done" : "failed"}></status-dot>
              </span>
              <span class="run-launch-health-item">
                git
                <status-dot status=${launchHealth.gitReady ? "done" : "failed"}></status-dot>
              </span>
              <span class="run-launch-health-item">
                github
                <status-dot status=${launchHealth.githubReady ? "done" : "failed"}></status-dot>
              </span>
            </div>
            <div class="hint">${launchHealth.ready ? "环境检查通过，可直接启动 Run。" : "建议先在「系统配置」补齐 runtime / git / github 准备项。"}</div>
          </div>

          <div class="button-row">
            <button class="primary" type="submit" ?disabled=${noIssues}>启动 Run</button>
          </div>
          ${showResume
            ? html`
                <div class="run-launch-secondary">
                  <span class="hint">恢复旧运行请使用次级入口（不影响新 Run 启动流程）。</span>
                  <button type="button" @click=${this.onStopRun} ?disabled=${!canStopSelectedRun}>停止选中 Run</button>
                  <button type="button" @click=${this.onResumeRun} ?disabled=${!canResumeSelectedRun}>恢复选中 Run</button>
                  <button type="button" @click=${this.onStopProjectRuns} ?disabled=${!canStopProjectRuns}>停止当前项目全部 Run</button>
                  <button type="button" @click=${this.onResumeProjectRuns} ?disabled=${!canResumeProjectRuns}>恢复当前项目全部 Run</button>
                </div>
              `
            : null}
        </div>
      </form>
    `;
  }

  private async onCreateRun(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const data = new FormData(ev.currentTarget as HTMLFormElement);
    const issueDraft = String(data.get("issueDraft") ?? this.runIssueDraft).trim();
    const issue = this.getIssueById(issueDraft);
    if (!issue) {
      this.message = "请先选择有效的 GitHub Issue。";
      return;
    }
    const taskDraft = String(data.get("taskDraft") ?? this.runTaskDraft).trim();
    const task = taskDraft || this.composeTaskFromIssue(issue);
    const modeRaw = String(data.get("modeDraft") ?? this.runModeDraft).trim().toLowerCase();
    const runMode = modeRaw === "quick" ? "quick" : "standard";

    const run = await createRun({
      projectId: this.selectedProjectId,
      issueId: issue.id,
      task,
      runMode,
    });

    this.runIssueDraft = issue.id;
    this.runTaskDraft = task;
    this.runModeDraft = runMode;
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    this.selectedRunId = run.id;
    this.runInsightTab = "events";
    this.runtimeFocusTab = "session";
    this.runLaunchPanelOpen = false;
    this.connectRunEvents();
    await this.refreshRunDetail();
  }

  private async onResumeRun(): Promise<void> {
    if (!this.selectedRunId) return;
    await resumeRun(this.selectedRunId);
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    await this.refreshRunDetail();
  }

  private async onStopRun(): Promise<void> {
    if (!this.selectedRunId) return;
    await stopRun(this.selectedRunId);
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    await this.refreshRunDetail();
  }

  private async onStopProjectRuns(): Promise<void> {
    if (!this.selectedProjectId) return;
    const result = await stopAllRuns(this.selectedProjectId);
    this.message = `已停止当前项目运行：${result.changed}/${result.total}`;
    this.messageTone = result.failed.length > 0 ? "error" : "success";
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    await this.refreshRunDetail();
  }

  private async onResumeProjectRuns(): Promise<void> {
    if (!this.selectedProjectId) return;
    const result = await resumeAllPausedRuns(this.selectedProjectId);
    this.message = `已恢复当前项目运行：${result.changed}/${result.total}`;
    this.messageTone = result.failed.length > 0 ? "error" : "success";
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    await this.refreshRunDetail();
  }

  private async onStopAllRunsGlobal(): Promise<void> {
    const result = await stopAllRuns();
    this.message = `已停止全局运行：${result.changed}/${result.total}`;
    this.messageTone = result.failed.length > 0 ? "error" : "success";
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    await this.refreshRunDetail();
  }

  private async onResumeAllRunsGlobal(): Promise<void> {
    const result = await resumeAllPausedRuns();
    this.message = `已恢复全局运行：${result.changed}/${result.total}`;
    this.messageTone = result.failed.length > 0 ? "error" : "success";
    await this.refreshRuns();
    await this.refreshProjectMetrics();
    await this.refreshRunDetail();
  }

  private async onAttachRunTerminal(options?: {
    runId?: string;
    stepKey?: string;
    sessionId?: string;
    threadId?: string;
  }): Promise<void> {
    const runId = String(options?.runId ?? this.selectedRunId ?? "").trim();
    if (!runId) {
      this.message = "请先选择 Run，再打开终端旁观。";
      return;
    }
    try {
      const opened = await attachRunTerminal({
        runId,
        stepKey: options?.stepKey,
        sessionId: options?.sessionId,
        threadId: options?.threadId,
      });
      const base = `已打开 ${opened.terminal}：thread=${opened.threadId}`;
      const stepText = opened.stepKey ? ` · step=${opened.stepKey}` : "";
      const sessionText = opened.sessionId ? ` · session=${opened.sessionId}` : "";
      this.setMessageToast(`${base}${stepText}${sessionText}`, "success");
      if (opened.notice) {
        this.setMessageToast(`${base}${stepText}${sessionText} · ${opened.notice}`, "success");
      }
    } catch (err) {
      this.setMessageToast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private onSelectProject(projectId: string): void {
    const nextProjectId = String(projectId ?? "").trim();
    this.selectedProjectId = nextProjectId;
    this.selectedRunId = "";
    this.runInsightTab = "events";
    this.runtimeFocusTab = "session";
    this.runLaunchPanelOpen = false;
    this.showAgentTeam3DModal = false;
    this.runTaskDraft = "";
    this.runIssueDraft = "";
    this.runModeDraft = "standard";
    this.runDetail = null;
    this.pipelineSelectedStepKey = "";
    this.issues = [];
    this.runs = [];
    this.projectMetrics = null;
    this.projectMetricsLoading = false;
    this.schedulerConfig = null;
    this.workflowConfig = null;
    this.workflowYamlDraft = "";
    if (!nextProjectId) {
      this.projectDataLoading = false;
      return;
    }
    const loadToken = this.nextProjectLoadToken();
    this.projectDataLoading = true;
    void (async () => {
      const metricsTask = this.refreshProjectMetrics(nextProjectId, loadToken);
      try {
        await Promise.all([
          this.refreshIssues(nextProjectId, loadToken),
          this.refreshRuns(nextProjectId, loadToken),
          this.refreshSchedulerConfig(nextProjectId, loadToken),
          this.refreshWorkflowConfig(nextProjectId, loadToken),
        ]);
      } catch (err) {
        if (this.isProjectLoadCurrent(nextProjectId, loadToken)) {
          this.setMessageToast(err instanceof Error ? err.message : String(err), "error");
        }
      } finally {
        if (this.isProjectLoadCurrent(nextProjectId, loadToken)) {
          this.projectDataLoading = false;
        }
      }
      void metricsTask;
    })();
  }

  private onProjectMenuChange(ev: Event): void {
    const projectId = (ev.currentTarget as HTMLSelectElement).value;
    if (!projectId || projectId === this.selectedProjectId) return;
    this.onSelectProject(projectId);
  }

  private async onSaveScheduler(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const enabled = String(data.get("enabled") ?? "true") === "true";
    const cleanupEnabled = String(data.get("cleanupEnabled") ?? "true") === "true";
    const cleanupModeRaw = String(data.get("cleanupMode") ?? "deep").trim().toLowerCase();
    const cleanupMode = cleanupModeRaw === "lite" ? "lite" : "deep";
    const cron = String(data.get("cron") ?? "").trim();
    const timezone = this.normalizeSchedulerTimezone(data.get("timezone"));
    const task = String(data.get("task") ?? "").trim();
    const onlyWhenIdle = String(data.get("onlyWhenIdle") ?? "true") === "true";
    const issueAutoRunEnabled = String(data.get("issueAutoRunEnabled") ?? "true") === "true";
    const issueAutoRunCron = String(data.get("issueAutoRunCron") ?? "").trim();
    const issueAutoRunLabel = String(data.get("issueAutoRunLabel") ?? "").trim();
    const issueAutoRunOnlyWhenIdle = String(data.get("issueAutoRunOnlyWhenIdle") ?? "true") === "true";
    const issueAutoRunMaxRunsPerTickRaw = Number(String(data.get("issueAutoRunMaxRunsPerTick") ?? "3").trim());
    const issueAutoRunMaxRunsPerTick = Number.isFinite(issueAutoRunMaxRunsPerTickRaw)
      ? Math.max(1, Math.floor(issueAutoRunMaxRunsPerTickRaw))
      : 3;

    if (!cron || !timezone || !task || !issueAutoRunCron || !issueAutoRunLabel) {
      this.message = "Cron、时区、任务文案、Issue Auto-Run 的 Cron/标签不能为空（标签可填 forgeops:ready 或 *）。";
      return;
    }

    this.schedulerConfig = await updateProjectSchedulerConfig(this.selectedProjectId, {
      enabled,
      timezone,
      cleanup: {
        enabled: cleanupEnabled,
        mode: cleanupMode,
        cron,
        task,
        onlyWhenIdle,
      },
      issueAutoRun: {
        enabled: issueAutoRunEnabled,
        cron: issueAutoRunCron,
        label: issueAutoRunLabel,
        onlyWhenIdle: issueAutoRunOnlyWhenIdle,
        maxRunsPerTick: issueAutoRunMaxRunsPerTick,
      },
    });
    await this.refreshEngineState();
    this.message = "调度配置已保存并生效。";
  }

  private async onSaveSchedulerBase(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const enabled = String(data.get("enabled") ?? "true") === "true";
    const timezone = this.normalizeSchedulerTimezone(data.get("timezone"));

    this.schedulerConfig = await updateProjectSchedulerConfig(this.selectedProjectId, {
      enabled,
      timezone,
    });
    await this.refreshEngineState();
    this.message = "基础调度配置已保存。";
  }

  private async onSaveSchedulerCleanupCard(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const enabled = String(data.get("cleanupEnabled") ?? "true") === "true";
    const modeRaw = String(data.get("cleanupMode") ?? "deep").trim().toLowerCase();
    const mode = modeRaw === "lite" ? "lite" : "deep";
    const cron = String(data.get("cleanupCron") ?? "").trim();
    const task = String(data.get("cleanupTask") ?? "").trim();
    const onlyWhenIdle = String(data.get("cleanupOnlyWhenIdle") ?? "true") === "true";

    if (!cron || !task) {
      this.message = "Cleanup 的 Cron 与任务文案不能为空。";
      return;
    }

    this.schedulerConfig = await updateProjectSchedulerConfig(this.selectedProjectId, {
      cleanup: {
        enabled,
        mode,
        cron,
        task,
        onlyWhenIdle,
      },
    });
    await this.refreshEngineState();
    this.message = "Cleanup Job 配置已保存。";
  }

  private async onSaveSchedulerIssueCard(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const enabled = String(data.get("issueEnabled") ?? "true") === "true";
    const cron = String(data.get("issueCron") ?? "").trim();
    const label = String(data.get("issueLabel") ?? "").trim();
    const onlyWhenIdle = String(data.get("issueOnlyWhenIdle") ?? "true") === "true";
    const maxRunsRaw = Number(String(data.get("issueMaxRunsPerTick") ?? "3").trim());
    const maxRunsPerTick = Number.isFinite(maxRunsRaw) ? Math.max(1, Math.floor(maxRunsRaw)) : 3;

    if (!cron || !label) {
      this.message = "Issue Auto-Run 的 Cron 与标签不能为空（标签可填 forgeops:ready 或 *）。";
      return;
    }

    this.schedulerConfig = await updateProjectSchedulerConfig(this.selectedProjectId, {
      issueAutoRun: {
        enabled,
        cron,
        label,
        onlyWhenIdle,
        maxRunsPerTick,
      },
    });
    await this.refreshEngineState();
    this.message = "Issue Auto-Run Job 配置已保存。";
  }

  private async onSaveSchedulerSkillPromotionCard(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const enabled = String(data.get("skillEnabled") ?? "true") === "true";
    const cron = String(data.get("skillCron") ?? "").trim();
    const onlyWhenIdle = String(data.get("skillOnlyWhenIdle") ?? "true") === "true";
    const draft = String(data.get("skillDraft") ?? "true") === "true";
    const maxPromotionsRaw = Number(String(data.get("skillMaxPromotionsPerTick") ?? "1").trim());
    const minOccurrencesRaw = Number(String(data.get("skillMinOccurrences") ?? "2").trim());
    const lookbackDaysRaw = Number(String(data.get("skillLookbackDays") ?? "14").trim());
    const minScoreRaw = Number(String(data.get("skillMinScore") ?? "0.6").trim());
    const rolesRaw = String(data.get("skillRoles") ?? "");
    const roles = rolesRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (!cron) {
      this.message = "Skill Promotion 的 Cron 不能为空。";
      return;
    }
    if (!Number.isFinite(maxPromotionsRaw) || maxPromotionsRaw < 1) {
      this.message = "maxPromotionsPerTick 必须是大于等于 1 的整数。";
      return;
    }
    if (!Number.isFinite(minOccurrencesRaw) || minOccurrencesRaw < 1) {
      this.message = "minCandidateOccurrences 必须是大于等于 1 的整数。";
      return;
    }
    if (!Number.isFinite(lookbackDaysRaw) || lookbackDaysRaw < 1) {
      this.message = "lookbackDays 必须是大于等于 1 的整数。";
      return;
    }
    if (!Number.isFinite(minScoreRaw) || minScoreRaw < 0 || minScoreRaw > 1) {
      this.message = "minScore 必须在 0 到 1 之间。";
      return;
    }

    this.schedulerConfig = await updateProjectSchedulerConfig(this.selectedProjectId, {
      skillPromotion: {
        enabled,
        cron,
        onlyWhenIdle,
        maxPromotionsPerTick: Math.max(1, Math.floor(maxPromotionsRaw)),
        minCandidateOccurrences: Math.max(1, Math.floor(minOccurrencesRaw)),
        lookbackDays: Math.max(1, Math.floor(lookbackDaysRaw)),
        minScore: Number(minScoreRaw.toFixed(3)),
        draft,
        roles,
      },
    });
    await this.refreshEngineState();
    this.message = "Skill Promotion Job 配置已保存。";
  }

  private async onSaveSchedulerGlobalSkillPromotionCard(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const enabled = String(data.get("globalSkillEnabled") ?? "true") === "true";
    const cron = String(data.get("globalSkillCron") ?? "").trim();
    const onlyWhenIdle = String(data.get("globalSkillOnlyWhenIdle") ?? "true") === "true";
    const draft = String(data.get("globalSkillDraft") ?? "true") === "true";
    const requireProjectSkill = String(data.get("globalSkillRequireProjectSkill") ?? "true") === "true";
    const maxPromotionsRaw = Number(String(data.get("globalSkillMaxPromotionsPerTick") ?? "1").trim());
    const minOccurrencesRaw = Number(String(data.get("globalSkillMinOccurrences") ?? "3").trim());
    const lookbackDaysRaw = Number(String(data.get("globalSkillLookbackDays") ?? "30").trim());
    const minScoreRaw = Number(String(data.get("globalSkillMinScore") ?? "0.75").trim());

    if (!cron) {
      this.message = "Global Skill Promotion 的 Cron 不能为空。";
      return;
    }
    if (!Number.isFinite(maxPromotionsRaw) || maxPromotionsRaw < 1) {
      this.message = "maxPromotionsPerTick 必须是大于等于 1 的整数。";
      return;
    }
    if (!Number.isFinite(minOccurrencesRaw) || minOccurrencesRaw < 1) {
      this.message = "minCandidateOccurrences 必须是大于等于 1 的整数。";
      return;
    }
    if (!Number.isFinite(lookbackDaysRaw) || lookbackDaysRaw < 1) {
      this.message = "lookbackDays 必须是大于等于 1 的整数。";
      return;
    }
    if (!Number.isFinite(minScoreRaw) || minScoreRaw < 0 || minScoreRaw > 1) {
      this.message = "minScore 必须在 0 到 1 之间。";
      return;
    }

    this.schedulerConfig = await updateProjectSchedulerConfig(this.selectedProjectId, {
      globalSkillPromotion: {
        enabled,
        cron,
        onlyWhenIdle,
        maxPromotionsPerTick: Math.max(1, Math.floor(maxPromotionsRaw)),
        minCandidateOccurrences: Math.max(1, Math.floor(minOccurrencesRaw)),
        lookbackDays: Math.max(1, Math.floor(lookbackDaysRaw)),
        minScore: Number(minScoreRaw.toFixed(3)),
        requireProjectSkill,
        draft,
      },
    });
    await this.refreshEngineState();
    this.message = "Global Skill Promotion Job 配置已保存。";
  }

  private async onSaveWorkflow(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const yaml = String(data.get("workflowYaml") ?? "");
    if (!yaml.trim()) {
      this.message = "workflow.yaml 内容不能为空。";
      return;
    }

    this.workflowConfig = await updateProjectWorkflowConfig(this.selectedProjectId, { yaml });
    this.workflowYamlDraft = this.workflowConfig.yaml;
    this.message = "工作流配置已保存。";
  }

  private async onResetWorkflow(): Promise<void> {
    if (!this.selectedProjectId) {
      this.message = "请先选择项目。";
      return;
    }
    this.workflowConfig = await updateProjectWorkflowConfig(this.selectedProjectId, { resetDefault: true });
    this.workflowYamlDraft = this.workflowConfig.yaml;
    this.message = "工作流已恢复默认。";
  }

  private async onRefreshDoctor(): Promise<void> {
    await this.refreshSystemConfig();
    this.message = this.doctor?.ok ? "环境检查通过。" : "环境检查存在未通过项。";
  }

  private async onSaveSystemGit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const userName = String(data.get("gitUserName") ?? "").trim();
    const userEmail = String(data.get("gitUserEmail") ?? "").trim();
    if (!userName || !userEmail) {
      this.message = "Git user.name 和 user.email 不能为空。";
      return;
    }
    this.systemConfig = await updateSystemConfig({
      git: {
        userName,
        userEmail,
      },
    });
    this.doctor = this.systemConfig.doctor;
    this.message = "系统配置已保存。";
  }

  private async onSaveSystemGitHubPat(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const patToken = String(data.get("githubPatToken") ?? "").trim();
    if (!patToken) {
      this.message = "PAT 不能为空。";
      return;
    }
    try {
      this.systemConfig = await updateSystemConfig({
        github: {
          patToken,
        },
      });
      this.doctor = this.systemConfig.doctor;
      form.reset();
      this.message = this.systemConfig.github.validated
        ? "GitHub PAT 已保存并通过 scope 校验。"
        : "GitHub PAT 已保存，但 scope 校验未通过。";
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      await this.refreshSystemConfig();
    }
  }

  private async onClearSystemGitHubPat(): Promise<void> {
    try {
      this.systemConfig = await updateSystemConfig({
        github: {
          clearPat: true,
        },
      });
      this.doctor = this.systemConfig.doctor;
      this.message = "GitHub PAT 已清空。";
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      await this.refreshSystemConfig();
    }
  }

  private onSelectRun(runId: string): void {
    this.selectedRunId = runId;
    this.runInsightTab = "events";
    this.runtimeFocusTab = "session";
    this.pipelineSelectedStepKey = "";
    this.connectRunEvents();
    void this.refreshRunDetail();
  }

  private onOpenCreateProjectModal(): void {
    this.createProjectProgress = [];
    this.createProjectInFlight = false;
    this.createProjectRootPath = "";
    this.closeCreateProjectStream();
    this.showCreateProjectModal = true;
  }

  private onCloseCreateProjectModal(): void {
    if (this.createProjectInFlight) return;
    this.createProjectProgress = [];
    this.createProjectRootPath = "";
    this.closeCreateProjectStream();
    this.showCreateProjectModal = false;
  }

  private onOpenGlobalTokenUsageModal(): void {
    this.globalTokenUsageUnsupported = false;
    void this.refreshGlobalTokenUsage();
    this.showGlobalTokenUsageModal = true;
  }

  private onCloseGlobalTokenUsageModal(): void {
    this.showGlobalTokenUsageModal = false;
  }

  private onOpenPipelineFullscreen(source: "project" | "run"): void {
    this.pipelineFullscreenSource = source;
  }

  private onClosePipelineFullscreen(): void {
    this.pipelineFullscreenSource = "";
  }

  private onSplitterPointerDown(ev: PointerEvent): void {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = this.sidebarWidth;

    const onMove = (moveEv: PointerEvent) => {
      const delta = moveEv.clientX - startX;
      const width = Math.max(250, Math.min(520, startWidth + delta));
      this.sidebarWidth = width;
      this.style.setProperty("--sidebar-width", `${width}px`);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private renderRunRow(run: RunRow) {
    const selected = run.id === this.selectedRunId;
    const gates = this.getRunQualityGates(run);
    return html`
      <button class="row row-button ${selected ? "selected" : ""}" @click=${() => this.onSelectRun(run.id)}>
        <span class="title">${run.task}</span>
        <span class="mono">${run.id}</span>
        <span class="mono">分支: ${run.worktree_branch ?? "-"}</span>
        <span class="mono">步骤: ${run.running_step ?? "-"} · tokens: ${run.total_tokens ?? 0}</span>
        <div class="run-gates">
          <span class="run-gate-item">
            <span class="label">CI Gate</span>
            <status-dot status=${this.gateStatusToDot(gates.ci.status)}></status-dot>
          </span>
          <span class="run-gate-item">
            <span class="label">Platform Gate</span>
            <status-dot status=${this.gateStatusToDot(gates.platform.status)}></status-dot>
          </span>
        </div>
        <status-dot status=${run.status}></status-dot>
      </button>
    `;
  }

  private normalizeRunStatus(status: string): "running" | "failed" | "completed" | "pending" {
    const key = String(status ?? "").trim().toLowerCase();
    if (key === "running" || key === "resuming" || key === "retry") return "running";
    if (key === "paused") return "pending";
    if (key === "failed" || key === "error" || key === "aborted") return "failed";
    if (key === "completed" || key === "done" || key === "success") return "completed";
    return "pending";
  }

  private renderRunGroups() {
    if (this.runs.length === 0) {
      return html`<div class="hint">当前项目暂无 Run，先在上方启动一个吧。</div>`;
    }
    const grouped = {
      running: [] as RunRow[],
      failed: [] as RunRow[],
      completed: [] as RunRow[],
      pending: [] as RunRow[],
    };
    for (const run of this.runs) {
      grouped[this.normalizeRunStatus(run.status)].push(run);
    }
    const groups: Array<{ id: keyof typeof grouped; title: string; rows: RunRow[] }> = [
      { id: "running", title: "运行中", rows: grouped.running },
      { id: "failed", title: "失败", rows: grouped.failed },
      { id: "pending", title: "待执行/其他", rows: grouped.pending },
      { id: "completed", title: "已完成", rows: grouped.completed },
    ];
    return html`
      <div class="run-group-list">
        ${groups
          .filter((group) => group.rows.length > 0)
          .map((group) => {
            const selectedInGroup = group.rows.some((run) => run.id === this.selectedRunId);
            const openByDefault = group.id !== "completed" || selectedInGroup;
            return html`
              <details class="run-group" ?open=${openByDefault}>
                <summary>
                  <span>${group.title}</span>
                  <span class="tag">${group.rows.length}</span>
                </summary>
                <div class="run-group-body">
                  <div class="run-list">
                    ${group.rows.map((run) => this.renderRunRow(run))}
                  </div>
                </div>
              </details>
            `;
          })}
      </div>
    `;
  }

  private parseDepends(dependsOnJson: string): string[] {
    try {
      const parsed = JSON.parse(dependsOnJson);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      return [];
    }
  }

  private toNonNegativeInt(value: unknown, fallback = 0): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const out = Math.floor(num);
    return out >= 0 ? out : fallback;
  }

  private parseBoolLike(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value;
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) return fallback;
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    return fallback;
  }

  private getStepPolicy(stepKey: string): Record<string, unknown> {
    const context = this.runDetail?.context;
    if (!context || typeof context !== "object") return {};
    const policies = (context as Record<string, unknown>).stepPolicies;
    if (!policies || typeof policies !== "object") return {};
    const policy = (policies as Record<string, unknown>)[stepKey];
    if (!policy || typeof policy !== "object") return {};
    return policy as Record<string, unknown>;
  }

  private formatStepRetryText(step: StepRow): string {
    const base = `重试=${step.retry_count}/${step.max_retries}`;
    const policy = this.getStepPolicy(step.step_key);
    const autoFix = policy.reviewAutoFix;
    const isReviewTemplate = step.template_key === "review" || step.step_key === "review";
    if ((!autoFix || typeof autoFix !== "object") && !isReviewTemplate) return base;
    if (!autoFix || typeof autoFix !== "object") return `${base} · 自愈=on`;
    const enabled = this.parseBoolLike((autoFix as Record<string, unknown>).enabled, false);
    if (!enabled) return `${base} · 自愈=off`;
    const maxTurns = this.toNonNegativeInt(
      (autoFix as Record<string, unknown>).maxTurns,
      this.toNonNegativeInt(step.max_retries, 0),
    );
    return `${base} · 自愈turn=${step.retry_count}/${maxTurns}`;
  }

  private formatStepTokenText(step: StepRow): string {
    const input = Number(step.token_input ?? 0);
    const cached = Number(step.token_cached_input ?? 0);
    const output = Number(step.token_output ?? 0);
    const total = input + cached + output;
    const prompt = input + cached;
    const hit = prompt > 0 ? (cached / prompt) * 100 : 0;
    return `tokens=${this.formatNumber(total)} (in=${this.formatNumber(input)} out=${this.formatNumber(output)} cached=${this.formatNumber(cached)} hit=${this.formatPercent(hit)})`;
  }

  private findLatestSessionByStep(stepId: string) {
    if (!this.runDetail) return null;
    const rows = this.runDetail.sessions.filter((session) => session.step_id === stepId);
    if (rows.length === 0) return null;
    return rows[rows.length - 1];
  }

  private findSessionsByStep(stepId: string): SessionRow[] {
    if (!this.runDetail) return [];
    return this.runDetail.sessions.filter((session) => session.step_id === stepId);
  }

  private findStepById(stepId: string): StepRow | null {
    if (!this.runDetail) return null;
    return this.runDetail.steps.find((step) => step.id === stepId) ?? null;
  }

  private eventPayloadAsRecord(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {};
    }
    return payload as Record<string, unknown>;
  }

  private toEventStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item ?? "").trim()).filter(Boolean);
    }
    const text = String(value ?? "").trim();
    return text ? [text] : [];
  }

  private toEventBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value;
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) return fallback;
    if (["1", "true", "yes", "ok", "pass", "passed"].includes(text)) return true;
    if (["0", "false", "no", "fail", "failed"].includes(text)) return false;
    return fallback;
  }

  private toEventInt(value: unknown, fallback = 0): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.floor(num));
  }

  private collectRuntimeRiskSignals(detail: RunDetail): RuntimeRiskSignalRow[] {
    const stepKeyById = new Map(detail.steps.map((step) => [step.id, step.step_key]));
    const out: RuntimeRiskSignalRow[] = [];
    for (const event of detail.events) {
      const eventType = String(event.event_type ?? "").trim();
      if (eventType !== "runtime.session.risk" && eventType !== "runtime.session.rotate.recommended") {
        continue;
      }
      const payload = this.eventPayloadAsRecord(event.payload);
      const stepId = String(payload.stepId ?? event.step_id ?? "").trim();
      const stepKeyFromPayload = String(payload.stepKey ?? "").trim();
      const stepKey = stepKeyFromPayload || (stepId ? String(stepKeyById.get(stepId) ?? "").trim() : "");
      out.push({
        id: Number(event.id ?? 0),
        ts: String(event.ts ?? ""),
        eventType: eventType as RuntimeRiskSignalRow["eventType"],
        severity: eventType === "runtime.session.rotate.recommended" ? "rotate" : "risk",
        stepId,
        stepKey,
        threadId: String(payload.threadId ?? "").trim(),
        turnId: String(payload.turnId ?? "").trim(),
        reason: String(payload.reason ?? "").trim(),
        recommendedAction: String(payload.recommendedAction ?? "").trim(),
        evidence: this.toEventStringList(payload.evidence),
      });
    }

    return out.sort((left, right) => right.id - left.id);
  }

  private collectPlatformGateSignals(detail: RunDetail): PlatformGateSignalRow[] {
    const stepKeyById = new Map(detail.steps.map((step) => [step.id, step.step_key]));
    const out: PlatformGateSignalRow[] = [];
    for (const event of detail.events) {
      const eventType = String(event.event_type ?? "").trim();
      if (eventType !== "platform.gate.checked" && eventType !== "platform.gate.failed") {
        continue;
      }
      const payload = this.eventPayloadAsRecord(event.payload);
      const stepId = String(payload.stepId ?? event.step_id ?? "").trim();
      const stepKeyFromPayload = String(payload.stepKey ?? "").trim();
      const stepKey = stepKeyFromPayload || (stepId ? String(stepKeyById.get(stepId) ?? "").trim() : "");
      const ok = eventType === "platform.gate.failed"
        ? false
        : this.toEventBoolean(payload.ok, false);
      out.push({
        id: Number(event.id ?? 0),
        ts: String(event.ts ?? ""),
        eventType: eventType as PlatformGateSignalRow["eventType"],
        stepId,
        stepKey,
        gate: String(payload.gate ?? "").trim(),
        ok,
        productType: String(payload.productType ?? "").trim(),
        scriptPath: String(payload.scriptPath ?? "").trim(),
        failedRequiredCount: this.toEventInt(payload.failedRequiredCount, 0),
        reason: String(payload.reason ?? "").trim(),
        error: String(payload.error ?? "").trim(),
        stderr: String(payload.stderr ?? "").trim(),
      });
    }
    return out.sort((left, right) => right.id - left.id);
  }

  private renderRuntimeRiskSignals(detail: RunDetail) {
    const signals = this.collectRuntimeRiskSignals(detail);
    const riskCount = signals.filter((item) => item.severity === "risk").length;
    const rotateCount = signals.filter((item) => item.severity === "rotate").length;
    const uniqueSteps = new Set(signals.map((item) => item.stepKey || item.stepId).filter(Boolean)).size;
    const visibleSignals = signals.slice(0, 6);
    return html`
      <div class="runtime-risk-summary">
        <span class="tag">risk=${riskCount} · rotate_recommended=${rotateCount} · steps=${uniqueSteps}</span>
        <span class="hint">长会话风险信号（最近 ${visibleSignals.length} 条）</span>
      </div>
      ${visibleSignals.length === 0
        ? html`<div class="hint">暂无长会话风险信号。</div>`
        : html`
            <div class="runtime-risk-grid">
              ${visibleSignals.map((signal) => {
                const severityStatus = signal.severity === "rotate" ? "failed" : "pending";
                const signalTitle = signal.severity === "rotate" ? "建议切新线程" : "会话风险";
                const stepLabel = signal.stepKey || signal.stepId || "-";
                return html`
                  <div class=${`runtime-risk-card ${signal.severity === "rotate" ? "rotate" : ""}`}>
                    <div class="runtime-risk-head">
                      <div class="runtime-risk-title">${signalTitle} · step=${stepLabel}</div>
                      <status-dot status=${severityStatus}></status-dot>
                    </div>
                    <div class="mono">${signal.ts}</div>
                    <div class="mono">thread=${signal.threadId || "-"} turn=${signal.turnId || "-"}</div>
                    ${signal.reason ? html`<div class="mono">reason=${signal.reason}</div>` : null}
                    ${signal.recommendedAction ? html`<div class="hint">建议：${signal.recommendedAction}</div>` : null}
                    ${signal.evidence.length > 0
                      ? html`<div class="mono">evidence=${signal.evidence.slice(0, 3).join(" | ")}</div>`
                      : null}
                  </div>
                `;
              })}
            </div>
          `}
    `;
  }

  private renderPlatformGateSignals(detail: RunDetail) {
    const signals = this.collectPlatformGateSignals(detail);
    const displayedSignals = this.platformGateOnlyFailed
      ? signals.filter((item) => item.eventType === "platform.gate.failed")
      : signals;
    const checkedCount = signals.filter((item) => item.eventType === "platform.gate.checked").length;
    const failedCount = signals.filter((item) => item.eventType === "platform.gate.failed").length;
    const uniqueGates = new Set(signals.map((item) => item.gate).filter(Boolean)).size;
    const visibleSignals = displayedSignals.slice(0, 6);
    const rollup = this.buildPlatformGateRollup(signals);
    return html`
      <div class="platform-gate-summary">
        <span class="tag">checked=${checkedCount} · failed=${failedCount} · gates=${uniqueGates}</span>
        <div class="platform-gate-filters">
          <button
            type="button"
            class=${this.platformGateOnlyFailed ? "" : "active"}
            @click=${() => { this.platformGateOnlyFailed = false; }}
          >
            全部
          </button>
          <button
            type="button"
            class=${this.platformGateOnlyFailed ? "active" : ""}
            @click=${() => { this.platformGateOnlyFailed = true; }}
            ?disabled=${failedCount === 0}
          >
            仅失败
          </button>
          <span class="hint">最近 ${visibleSignals.length} 条</span>
        </div>
      </div>
      ${rollup.length > 0
        ? html`
            <div class="platform-gate-rollup">
              ${rollup.map((item) => html`
                <div class=${`platform-gate-pill ${item.status}`}>
                  <div class="platform-gate-pill-main">
                    <div class="platform-gate-pill-title">${item.gate} · ${item.statusText}</div>
                    <div class="platform-gate-pill-meta">step=${item.stepLabel || "-"} · ${item.latestTs || "-"}</div>
                  </div>
                  <status-dot status=${item.status}></status-dot>
                </div>
              `)}
            </div>
          `
        : null}
      ${visibleSignals.length === 0
        ? html`<div class="hint">${this.platformGateOnlyFailed ? "暂无失败的闸门事件。" : "暂无平台闸门事件。"}</div>`
        : html`
            <div class="platform-gate-grid">
              ${visibleSignals.map((signal) => {
                const status = signal.ok ? "done" : "failed";
                const signalTitle = signal.ok ? "平台闸门通过" : "平台闸门失败";
                const gateLabel = signal.gate || "-";
                const stepLabel = signal.stepKey || signal.stepId || "-";
                return html`
                  <div class=${`platform-gate-card ${signal.ok ? "" : "failed"}`}>
                    <div class="platform-gate-head">
                      <div class="platform-gate-title">${signalTitle} · gate=${gateLabel} · step=${stepLabel}</div>
                      <status-dot status=${status}></status-dot>
                    </div>
                    <div class="mono">${signal.ts}</div>
                    ${signal.productType ? html`<div class="mono">product_type=${signal.productType}</div>` : null}
                    ${signal.scriptPath ? html`<div class="mono">script=${signal.scriptPath}</div>` : null}
                    ${signal.failedRequiredCount > 0
                      ? html`<div class="mono">failed_required=${signal.failedRequiredCount}</div>`
                      : null}
                    ${signal.reason ? html`<div class="mono">reason=${signal.reason}</div>` : null}
                    ${signal.error ? html`<div class="error">${signal.error}</div>` : null}
                    ${signal.stderr ? html`<div class="mono">stderr=${signal.stderr.slice(0, 220)}</div>` : null}
                  </div>
                `;
              })}
            </div>
          `}
    `;
  }

  private buildPlatformGateRollup(signals: PlatformGateSignalRow[]): PlatformGateRollupRow[] {
    if (signals.length === 0) return [];
    const preferredGateOrder = ["preflight", "smoke"];
    const latestByGate = new Map<string, PlatformGateSignalRow>();
    for (const signal of signals) {
      const key = signal.gate || "unknown";
      if (!latestByGate.has(key)) {
        latestByGate.set(key, signal);
      }
    }

    const gateKeys = [
      ...preferredGateOrder.filter((item) => latestByGate.has(item)),
      ...Array.from(latestByGate.keys()).filter((item) => !preferredGateOrder.includes(item)),
    ];

    return gateKeys.map((gate) => {
      const latest = latestByGate.get(gate);
      const status: PlatformGateRollupRow["status"] = latest
        ? (latest.ok ? "done" : "failed")
        : "pending";
      const statusText = status === "done"
        ? "通过"
        : status === "failed"
          ? "失败"
          : "待执行";
      return {
        gate,
        status,
        statusText,
        latestEventId: Number(latest?.id ?? 0),
        latestTs: String(latest?.ts ?? ""),
        stepLabel: String(latest?.stepKey ?? latest?.stepId ?? ""),
        reason: String(latest?.reason ?? ""),
      };
    });
  }

  private calcDurationMs(startedAt: string | null, endedAt: string | null): number {
    if (!startedAt) return 0;
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) return 0;
    const end = endedAt ? Date.parse(endedAt) : Date.now();
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, end - start);
  }

  private formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const remSec = Math.round(sec % 60);
    return `${min}m${String(remSec).padStart(2, "0")}s`;
  }

  private formatNumber(n: number): string {
    return Number(n || 0).toLocaleString("en-US");
  }

  private formatTokenCompact(n: number): string {
    const value = Number(n || 0);
    if (!Number.isFinite(value)) return "-";
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    const units = [
      { unit: "T", value: 1_000_000_000_000 },
      { unit: "B", value: 1_000_000_000 },
      { unit: "M", value: 1_000_000 },
      { unit: "K", value: 1_000 },
    ];
    for (const item of units) {
      if (abs < item.value) continue;
      const scaled = abs / item.value;
      const digits = scaled >= 100 ? 0 : (scaled >= 10 ? 1 : 2);
      return `${sign}${scaled.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1")}${item.unit}`;
    }
    return `${sign}${Math.round(abs)}`;
  }

  private formatTokenWithRaw(n: number): string {
    return `${this.formatTokenCompact(n)} (${this.formatNumber(n)} tokens)`;
  }

  private tokenMetricColor(key: string, index: number): string {
    const palette = [
      "#22c55e",
      "#3b82f6",
      "#f59e0b",
      "#a855f7",
      "#14b8a6",
      "#ef4444",
      "#84cc16",
      "#06b6d4",
    ];
    const text = String(key ?? "").trim();
    if (!text) return palette[index % palette.length];
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  private tokenRuntimeColor(runtime: string, index: number): string {
    return this.tokenMetricColor(runtime, index);
  }

  private formatCompactTrendNumber(n: number, options?: { signed?: boolean }): string {
    const value = Number(n || 0);
    if (!Number.isFinite(value)) return "-";
    const signed = options?.signed === true;
    const abs = Math.abs(value);

    let unitValue = abs;
    let unit = "";
    let digits = 0;
    if (abs >= 100_000_000) {
      unitValue = abs / 100_000_000;
      unit = "亿";
      digits = unitValue >= 10 ? 0 : 1;
    } else if (abs >= 10_000) {
      unitValue = abs / 10_000;
      unit = "万";
      digits = unitValue >= 10 ? 0 : 1;
    } else if (abs >= 1_000) {
      unitValue = abs / 1_000;
      unit = "k";
      digits = unitValue >= 10 ? 0 : 1;
    }

    const core = digits > 0
      ? `${unitValue.toFixed(digits).replace(/\.0$/, "")}${unit}`
      : `${Math.round(unitValue)}${unit}`;
    if (signed) {
      if (value > 0) return `+${core}`;
      if (value < 0) return `-${core}`;
      return core;
    }
    return value < 0 ? `-${core}` : core;
  }

  private formatPercent(n: number): string {
    const value = Number(n);
    if (!Number.isFinite(value)) return "-";
    return `${value.toFixed(1)}%`;
  }

  private defaultRunQualityGates(): RunQualityGates {
    return {
      ci: {
        status: "not_configured",
        stepKey: null,
        templateKey: null,
        summary: "",
        error: "",
        updatedAt: null,
      },
      platform: {
        status: "not_configured",
        stepKey: null,
        templateKey: null,
        summary: "",
        error: "",
        updatedAt: null,
      },
      overall: "not_configured",
    };
  }

  private getRunQualityGates(run: RunRow | null | undefined): RunQualityGates {
    const gates = run?.quality_gates;
    if (!gates || typeof gates !== "object") {
      return this.defaultRunQualityGates();
    }
    return {
      ...this.defaultRunQualityGates(),
      ...gates,
      ci: {
        ...this.defaultRunQualityGates().ci,
        ...(gates.ci ?? {}),
      },
      platform: {
        ...this.defaultRunQualityGates().platform,
        ...(gates.platform ?? {}),
      },
    };
  }

  private gateStatusToDot(status: RunQualityGateStatus | string): string {
    const key = String(status ?? "").trim().toLowerCase();
    if (key === "passed") return "done";
    if (key === "failed") return "failed";
    if (key === "running") return "running";
    if (key === "pending") return "pending";
    if (key === "skipped") return "skipped";
    return "waiting";
  }

  private formatBytes(bytes: number): string {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "-";
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = n / 1024;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[idx]}`;
  }

  private formatUptime(seconds: number): string {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const day = Math.floor(total / 86400);
    const hour = Math.floor((total % 86400) / 3600);
    const minute = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (day > 0) return `${day}d ${hour}h ${minute}m`;
    if (hour > 0) return `${hour}h ${minute}m ${sec}s`;
    if (minute > 0) return `${minute}m ${sec}s`;
    return `${sec}s`;
  }

  private getProductTypeLabel(type: string): string {
    const key = String(type ?? "").trim().toLowerCase();
    const labels: Record<string, string> = {
      web: "WEB应用",
      miniapp: "微信小程序",
      ios: "IOS APP",
      microservice: "微服务后端",
      android: "Android APP",
      serverless: "Serverless 后端",
      other: "其他类型",
    };
    return labels[key] ?? (type || "-");
  }

  private resolveGitHubRepoUrl(repo: string): string {
    const raw = String(repo ?? "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }
    const normalized = raw
      .replace(/^github\.com\//i, "")
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "");
    if (/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
      return `https://github.com/${normalized}`;
    }
    return "";
  }

  private normalizeProcessTags(tags: ProcessTag[] | null | undefined): ProcessTag[] {
    if (!Array.isArray(tags) || tags.length === 0) return ["unknown"];
    return Array.from(new Set(tags));
  }

  private inferCoreRole(command: string | null | undefined, args: string | null | undefined): ProcessRole {
    const commandText = String(command ?? "").trim().toLowerCase();
    const argsText = String(args ?? "").trim().toLowerCase();
    const combined = `${commandText} ${argsText}`.trim();
    if (
      /\/src\/worker\//.test(combined)
      || /\b(worker|engine|scheduler)\b/.test(combined)
      || /\/worker\/(engine|scheduler)\.js\b/.test(combined)
    ) {
      return "core-executor";
    }
    return "core-control-plane";
  }

  private normalizeProcessRole(
    role: ProcessRole | null | undefined,
    tags: ProcessTag[] | null | undefined,
    command: string | null | undefined,
    args: string | null | undefined
  ): ProcessRole {
    if (role) return role;
    const normalizedTags = this.normalizeProcessTags(tags);
    if (normalizedTags.includes("core")) return this.inferCoreRole(command, args);
    if (normalizedTags.includes("agent")) return "agent-worker";
    if (normalizedTags.includes("runtime")) return "runtime";
    if (normalizedTags.includes("scm")) return "scm";
    if (normalizedTags.includes("tooling")) return "tooling";
    return "unknown";
  }

  private processRoleLabel(role: ProcessRole): string {
    if (role === "core-control-plane") return "核心控制面";
    if (role === "core-executor") return "核心执行器";
    if (role === "agent-worker") return "Agent Worker";
    if (role === "runtime") return "运行时";
    if (role === "scm") return "版本控制";
    if (role === "tooling") return "工具链";
    return "未知";
  }

  private processRoleBaseTag(role: ProcessRole): ProcessTag {
    if (role === "core-control-plane" || role === "core-executor") return "core";
    if (role === "agent-worker") return "agent";
    if (role === "runtime") return "runtime";
    if (role === "scm") return "scm";
    if (role === "tooling") return "tooling";
    return "unknown";
  }

  private processRoleClass(role: ProcessRole): string {
    return `process-chip role-${role}`;
  }

  private processTagLabel(tag: ProcessTag): string {
    if (tag === "core") return "核心进程";
    if (tag === "agent") return "Agent";
    if (tag === "runtime") return "运行时";
    if (tag === "scm") return "版本控制";
    if (tag === "tooling") return "工具链";
    return "未知";
  }

  private processTagClass(tag: ProcessTag): string {
    return `process-chip tag-${tag}`;
  }

  private processSecondaryTags(tags: ProcessTag[] | null | undefined, role: ProcessRole): ProcessTag[] {
    const normalized = this.normalizeProcessTags(tags);
    const covered = this.processRoleBaseTag(role);
    return normalized.filter((tag) => tag !== covered);
  }

  private clampPercent(n: number): number {
    const value = Number(n);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
  }

  private getPressureLevel(percent: number): "low" | "mid" | "high" {
    if (percent >= 80) return "high";
    if (percent >= 55) return "mid";
    return "low";
  }

  private getPressureClass(percent: number): "pressure-low" | "pressure-mid" | "pressure-high" {
    const level = this.getPressureLevel(percent);
    if (level === "high") return "pressure-high";
    if (level === "mid") return "pressure-mid";
    return "pressure-low";
  }

  private getPressureLabel(percent: number): string {
    const level = this.getPressureLevel(percent);
    if (level === "high") return "高压";
    if (level === "mid") return "中压";
    return "低压";
  }

  private calcCpuPressurePercent(loadAvg1: number, cores: number): number {
    const load = Number(loadAvg1);
    const coreCount = Number(cores);
    if (!Number.isFinite(load) || !Number.isFinite(coreCount) || coreCount <= 0) return 0;
    return this.clampPercent((load / coreCount) * 100);
  }

  private renderPressureGauge(label: string, percent: number, detail: string) {
    const value = this.clampPercent(percent);
    const pressureClass = this.getPressureClass(value);
    return html`
      <div class="visual-card ${pressureClass}">
        <div class="visual-top">
          <div class="visual-copy">
            <span class="label">${label}</span>
            <span class="value">${this.formatPercent(value)}</span>
          </div>
          <div class="gauge ${pressureClass}" style=${`--gauge-value:${value}%;`}>
            <span class="gauge-value">${Math.round(value)}%</span>
          </div>
        </div>
        <div class="mono">${detail}</div>
        <span class="pressure-pill ${pressureClass}">${this.getPressureLabel(value)}</span>
      </div>
    `;
  }

  private renderPressureBar(label: string, percent: number, detail?: string) {
    const value = this.clampPercent(percent);
    const pressureClass = this.getPressureClass(value);
    return html`
      <div class="pressure-bar ${pressureClass}">
        <div class="pressure-meta">
          <span>${label}</span>
          <span>${this.formatPercent(value)} · ${this.getPressureLabel(value)}</span>
        </div>
        <div class="pressure-track">
          <div class="pressure-fill" style=${`--pressure-value:${value}%;`}></div>
        </div>
        ${detail ? html`<div class="mono">${detail}</div>` : null}
      </div>
    `;
  }

  private calcSessionTokens(session: SessionRow): number {
    const input = Number(session.token_input ?? 0);
    const cached = Number(session.token_cached_input ?? 0);
    const output = Number(session.token_output ?? 0);
    return input + cached + output;
  }

  private isRecoveredSession(session: SessionRow): boolean {
    const status = String(session.status ?? "").toLowerCase();
    if (status !== "failed") return false;
    const errorText = String(session.error ?? "").toLowerCase();
    return errorText.includes("recovered orphaned step after engine restart");
  }

  private getSessionUiStatus(session: SessionRow): string {
    if (this.isRecoveredSession(session)) return "recovered";
    return session.status === "completed" ? "done" : session.status;
  }

  private renderRuntimeSessionList() {
    if (!this.runDetail) return null;
    const sessions = this.runDetail.sessions;
    const runId = this.runDetail.run.id;
    return html`
      <div class="session-grid">
        ${sessions.length === 0
          ? html`<div class="hint">暂无会话数据。</div>`
          : sessions.map((session) => {
            const step = this.findStepById(session.step_id);
            const duration = this.calcDurationMs(session.started_at, session.ended_at);
            const tokens = this.calcSessionTokens(session);
            const recovered = this.isRecoveredSession(session);
            const sessionThreadId = String(session.thread_id ?? "").trim();
            return html`
              <div class="row">
                <div class="title">${step?.step_key ?? "unknown-step"} · ${session.runtime}</div>
                <div class="mono">session=${session.id} thread=${session.thread_id ?? "-"} turn=${session.turn_id ?? "-"}</div>
                <div class="mono">model=${session.effective_model ?? session.requested_model ?? "-"} provider=${session.model_provider ?? "-"}</div>
                <div class="mono">pid=${session.process_pid ?? "-"} duration=${this.formatDuration(duration)} tokens=${this.formatNumber(tokens)}</div>
                <div class="button-row">
                  <button
                    type="button"
                    @click=${() => {
                      void this.onAttachRunTerminal({
                        runId,
                        sessionId: session.id,
                      });
                    }}
                    ?disabled=${!sessionThreadId}
                  >
                    旁观该会话
                  </button>
                </div>
                ${recovered
                  ? html`
                      <div class="hint">中断已恢复：服务重启后会话自动回收并重试，不计入业务失败。</div>
                      <div class="mono">recover_reason=${session.error ?? "-"}</div>
                    `
                  : session.error
                    ? html`<div class="error">${session.error}</div>`
                    : null}
                <status-dot status=${this.getSessionUiStatus(session)}></status-dot>
              </div>
            `;
          })}
      </div>
    `;
  }

  private renderRuntimeStepList() {
    if (!this.runDetail) return null;
    const steps = this.runDetail.steps;
    const runId = this.runDetail.run.id;
    if (steps.length === 0) {
      return html`<div class="hint">当前 Run 尚未生成步骤，或步骤数据仍在同步中。</div>`;
    }
    return html`
      <div class="steps">
        ${steps.map((step) => {
          const stepSessions = this.findSessionsByStep(step.id);
          const sessionCount = stepSessions.length;
          const latestSession = this.findLatestSessionByStep(step.id);
          const latestThread = String(latestSession?.thread_id ?? "").trim();
          return html`
            <div class="row">
              <div class="title">${step.step_index + 1}. ${step.step_key} (${step.agent_id})</div>
              <div class="mono">runtime=${step.runtime} model=${step.effective_model ?? step.requested_model ?? "-"}</div>
              <div class="mono">sessions=${sessionCount} latest_session=${latestSession?.id ?? "-"} thread=${latestSession?.thread_id ?? "-"}</div>
              <div class="mono">${this.formatStepRetryText(step)} ${this.formatStepTokenText(step)}</div>
              <div class="button-row">
                <button
                  type="button"
                  @click=${() => {
                    void this.onAttachRunTerminal({
                      runId,
                      stepKey: step.step_key,
                      sessionId: latestSession?.id,
                    });
                  }}
                  ?disabled=${!latestThread}
                >
                  旁观该 Step 最新会话
                </button>
              </div>
              ${step.error ? html`<div class="error">${step.error}</div>` : null}
              ${step.summary ? html`<div class="hint">${step.summary}</div>` : null}
              <status-dot status=${step.status}></status-dot>
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderRuntimeObservability() {
    if (!this.runDetail) return null;
    const sessions = this.runDetail.sessions;
    const totalSteps = this.runDetail.steps.length;
    const runningSessions = sessions.filter((item) => item.status === "running").length;
    const totalStepTokens = this.runDetail.steps.reduce(
      (sum, step) => sum + Number(step.token_input ?? 0) + Number(step.token_cached_input ?? 0) + Number(step.token_output ?? 0),
      0,
    );
    const totalSessionTokens = sessions.reduce(
      (sum, session) => sum + this.calcSessionTokens(session),
      0,
    );

    const durationRows = sessions.map((item) => this.calcDurationMs(item.started_at, item.ended_at));
    const durationTotal = durationRows.reduce((sum, ms) => sum + ms, 0);
    const durationAvg = durationRows.length > 0 ? Math.round(durationTotal / durationRows.length) : 0;
    const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;

    return html`
      <div class="panel-header">
        <span>执行实况（Session / Step）</span>
        <span class="tag">${sessions.length} sessions · ${totalSteps} steps</span>
      </div>
      <div class="metrics">
        <div class="metric">
          <span class="label">活跃 / 步骤</span>
          <span class="value">${runningSessions} / ${totalSteps}</span>
        </div>
        <div class="metric">
          <span class="label">执行 Tokens（Session）</span>
          <span class="value">${this.formatNumber(totalSessionTokens)}</span>
        </div>
        <div class="metric">
          <span class="label">业务 Tokens（Step）</span>
          <span class="value">${this.formatNumber(totalStepTokens)}</span>
        </div>
        <div class="metric">
          <span class="label">平均会话耗时</span>
          <span class="value">${this.formatDuration(durationAvg)}</span>
        </div>
        <div class="metric">
          <span class="label">最近会话</span>
          <span class="value">${latestSession?.id ?? "-"}</span>
        </div>
      </div>
      ${this.renderRuntimeRiskSignals(this.runDetail)}
      ${this.renderPlatformGateSignals(this.runDetail)}
      <div class="run-inspector-tabs">
        <button
          type="button"
          class=${this.runtimeFocusTab === "session" ? "active" : ""}
          @click=${() => { this.runtimeFocusTab = "session"; }}
        >
          Session（执行实例）
        </button>
        <button
          type="button"
          class=${this.runtimeFocusTab === "step" ? "active" : ""}
          @click=${() => { this.runtimeFocusTab = "step"; }}
        >
          Step（业务节点）
        </button>
        <span class="tag">${this.runtimeFocusTab === "session" ? "执行实例视角" : "业务节点视角"}</span>
      </div>
      <div class="hint">说明：Step 是业务节点；Session 是执行实例（同一 Step 可能因重试/恢复产生多个 Session）。</div>
      ${this.runtimeFocusTab === "session" ? this.renderRuntimeSessionList() : this.renderRuntimeStepList()}
    `;
  }

  private renderGlobalTokenUsageCard() {
    const globalTokenUsage = this.globalTokenUsage;
    const globalTokenTrend = globalTokenUsage?.trend_7d ?? null;
    const globalTokenTrendRows = Array.isArray(globalTokenTrend?.days) ? globalTokenTrend.days : [];
    const projectRowsRaw = Array.isArray(globalTokenUsage?.project_totals)
      ? globalTokenUsage.project_totals
      : [];
    const projectRows = projectRowsRaw
      .map((row) => ({
        key: String(row.project_id ?? row.project_name ?? "").trim(),
        name: String(row.project_name ?? row.project_id ?? "").trim() || "unknown-project",
        total: Number(row.total_tokens ?? 0),
      }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total);
    const pieSourceRows = (() => {
      const topRows = projectRows.slice(0, 5);
      const otherTotal = projectRows.slice(5).reduce((sum, row) => sum + row.total, 0);
      if (otherTotal > 0) {
        topRows.push({
          key: "other-projects",
          name: "Other Projects",
          total: otherTotal,
        });
      }
      return topRows;
    })();
    const pieTotal = pieSourceRows.reduce((sum, row) => sum + row.total, 0);
    const pieRows = pieSourceRows.map((row, index) => {
      const color = this.tokenMetricColor(row.key, index);
      const shareRate = pieTotal > 0 ? (row.total / pieTotal) * 100 : 0;
      return {
        ...row,
        color,
        shareRate,
      };
    });
    const pieGradient = (() => {
      if (pieRows.length === 0) {
        return "conic-gradient(#3b82f6 0turn, #3b82f6 1turn)";
      }
      let cursor = 0;
      const parts = [];
      for (const row of pieRows) {
        const next = cursor + row.shareRate;
        parts.push(`${row.color} ${cursor.toFixed(3)}% ${Math.min(100, next).toFixed(3)}%`);
        cursor = next;
      }
      if (cursor < 100) {
        const lastColor = pieRows[pieRows.length - 1].color;
        parts.push(`${lastColor} ${cursor.toFixed(3)}% 100%`);
      }
      return `conic-gradient(${parts.join(", ")})`;
    })();

    const chartWidth = 720;
    const chartHeight = 240;
    const paddingLeft = 40;
    const paddingRight = 14;
    const paddingTop = 12;
    const paddingBottom = 28;
    const plotWidth = chartWidth - paddingLeft - paddingRight;
    const plotHeight = chartHeight - paddingTop - paddingBottom;
    const trendMax = Math.max(1, ...globalTokenTrendRows.map((row) => Number(row.total_tokens ?? 0)));
    const chartPoints = globalTokenTrendRows.map((row, index) => {
      const value = Number(row.total_tokens ?? 0);
      const ratio = trendMax > 0 ? value / trendMax : 0;
      const x = globalTokenTrendRows.length <= 1
        ? paddingLeft + (plotWidth / 2)
        : paddingLeft + (plotWidth * (index / (globalTokenTrendRows.length - 1)));
      const y = paddingTop + ((1 - ratio) * plotHeight);
      return {
        date: String(row.date ?? ""),
        value,
        x,
        y,
      };
    });
    const linePath = chartPoints.length > 0
      ? chartPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ")
      : "";
    const areaPath = chartPoints.length > 0
      ? `M ${chartPoints[0].x.toFixed(2)} ${(chartHeight - paddingBottom).toFixed(2)} `
        + chartPoints.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ")
        + ` L ${chartPoints[chartPoints.length - 1].x.toFixed(2)} ${(chartHeight - paddingBottom).toFixed(2)} Z`
      : "";
    const yAxisTicks = [1, 0.5, 0].map((ratio) => {
      const y = paddingTop + ((1 - ratio) * plotHeight);
      return {
        y,
        label: this.formatTokenCompact(Math.round(trendMax * ratio)),
      };
    });
    const latestTrendValue = chartPoints.length > 0 ? chartPoints[chartPoints.length - 1].value : 0;

    return html`
      <div class="system-token-card">
        <div class="system-token-header">
          <span class="tag">collected_at=${globalTokenUsage?.collected_at ?? "-"}</span>
          <span class="token-unit-summary">units=tokens · 1K=1,000 · 1M=1,000,000 · 1B=1,000,000,000 · 1T=1,000,000,000,000</span>
        </div>
        ${globalTokenUsage
          ? html`
              <div class="metrics">
                <div class="metric">
                  <span class="label">Token 总量</span>
                  <span class="value">${this.formatTokenCompact(globalTokenUsage.total_tokens)}</span>
                  <span class="mono">${this.formatTokenWithRaw(globalTokenUsage.total_tokens)}</span>
                </div>
                <div class="metric">
                  <span class="label">输入 / 缓存 / 输出</span>
                  <span class="value">${this.formatTokenCompact(globalTokenUsage.token_input_total)} / ${this.formatTokenCompact(globalTokenUsage.token_cached_input_total)} / ${this.formatTokenCompact(globalTokenUsage.token_output_total)}</span>
                  <span class="mono">in=${this.formatNumber(globalTokenUsage.token_input_total)} · cached=${this.formatNumber(globalTokenUsage.token_cached_input_total)} · out=${this.formatNumber(globalTokenUsage.token_output_total)}</span>
                </div>
                <div class="metric">
                  <span class="label">缓存命中率</span>
                  <span class="value">${this.formatPercent(globalTokenUsage.token_cache_hit_rate)}</span>
                  <span class="mono">prompt_total=${this.formatTokenCompact(globalTokenUsage.token_input_total + globalTokenUsage.token_cached_input_total)}</span>
                </div>
              </div>
              <div class="token-chart-grid">
                <div class="token-chart-card">
                  <div class="token-chart-head">
                    <span>项目 Token 消耗占比</span>
                    <span class="tag">${pieRows.length} slices</span>
                  </div>
                  ${pieRows.length === 0
                    ? html`<div class="hint">暂无项目 Token 消耗数据。</div>`
                    : html`
                        <div class="token-pie-layout">
                          <div class="token-pie" style=${`--token-pie-gradient:${pieGradient};`}>
                            <div class="token-pie-center">
                              <span class="value">${this.formatTokenCompact(pieTotal)}</span>
                              <span class="label">project total</span>
                            </div>
                          </div>
                          <div class="token-legend">
                            ${pieRows.map((row) => html`
                              <div class="token-legend-row">
                                <div class="token-legend-main">
                                  <span class="token-legend-dot" style=${`--dot-color:${row.color};`}></span>
                                  <span class="token-legend-name">${row.name}</span>
                                </div>
                                <span class="token-legend-value">${this.formatTokenCompact(row.total)} · ${this.formatPercent(row.shareRate)}</span>
                              </div>
                            `)}
                          </div>
                        </div>
                      `}
                </div>
                <div class="token-chart-card">
                  <div class="token-chart-head">
                    <span>全局 7 日 Token 趋势（时序曲线）</span>
                    <span class="tag">latest=${this.formatTokenCompact(latestTrendValue)}</span>
                  </div>
                  ${globalTokenTrend && globalTokenTrend.available && chartPoints.length > 0
                    ? html`
                        <div class="token-line-wrap">
                          <svg class="token-line-svg" viewBox=${`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" aria-label="Global token trend line">
                            ${yAxisTicks.map((tick) => html`
                              <line
                                x1=${paddingLeft}
                                y1=${tick.y}
                                x2=${chartWidth - paddingRight}
                                y2=${tick.y}
                                stroke="color-mix(in srgb, var(--border-subtle), transparent 22%)"
                                stroke-width="1"
                              ></line>
                              <text
                                x=${paddingLeft - 6}
                                y=${tick.y - 2}
                                fill="var(--text-soft)"
                                font-size="10"
                                font-family="var(--font-mono)"
                                text-anchor="end"
                              >${tick.label}</text>
                            `)}
                            <line
                              x1=${paddingLeft}
                              y1=${paddingTop}
                              x2=${paddingLeft}
                              y2=${chartHeight - paddingBottom}
                              stroke="color-mix(in srgb, var(--border-subtle), transparent 18%)"
                              stroke-width="1"
                            ></line>
                            <line
                              x1=${paddingLeft}
                              y1=${chartHeight - paddingBottom}
                              x2=${chartWidth - paddingRight}
                              y2=${chartHeight - paddingBottom}
                              stroke="color-mix(in srgb, var(--border-subtle), transparent 18%)"
                              stroke-width="1"
                            ></line>
                            <path
                              d=${areaPath}
                              fill="color-mix(in srgb, var(--accent), transparent 86%)"
                              stroke="none"
                            ></path>
                            <path
                              d=${linePath}
                              fill="none"
                              stroke="var(--accent)"
                              stroke-width="2.2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            ></path>
                            ${chartPoints.map((point) => html`
                              <circle
                                cx=${point.x}
                                cy=${point.y}
                                r="3"
                                fill="var(--accent)"
                                stroke="color-mix(in srgb, var(--bg-elev-2), black 12%)"
                                stroke-width="1"
                              ></circle>
                            `)}
                          </svg>
                          <div class="token-line-axis-labels">
                            ${chartPoints.map((point) => html`<span>${point.date.slice(5)}</span>`)}
                          </div>
                        </div>
                        <div class="trend-summary">
                          <span class="trend-summary-item">source=${globalTokenTrend.source}</span>
                          <span class="trend-summary-item">peak=${this.formatTokenCompact(trendMax)}</span>
                          <span class="trend-summary-item">latest=${this.formatTokenCompact(latestTrendValue)}</span>
                        </div>
                      `
                    : html`<div class="hint">7 日趋势暂无可用数据。${globalTokenTrend?.warning ? `原因：${globalTokenTrend.warning}` : ""}</div>`}
                </div>
              </div>
            `
          : this.globalTokenUsageUnsupported
            ? html`<div class="hint">当前服务端版本暂不支持全局 Token API（/api/system/token-usage）。请重启到最新 ForgeOps 服务后启用。</div>`
            : html`<div class="hint">正在加载全局 Token 指标…</div>`}
      </div>
    `;
  }

  private renderSystemConfigPanel() {
    const cfg = this.systemConfig;
    if (!cfg) {
      return html`<div class="hint">正在加载系统配置...</div>`;
    }

    const doctor = cfg.doctor ?? {
      ok: false,
      checkedAt: "-",
      checks: [],
    };
    const git = cfg.git ?? {
      userName: "",
      userEmail: "",
      configured: false,
      available: false,
    };
    const runtime = cfg.runtime ?? {
      selected: "codex-exec-json",
      supported: [],
      modelDefault: "gpt-5.3-codex",
      codexBin: "codex",
      codexVersion: "",
      ready: false,
      error: "",
    };
    const github = cfg.github ?? {
      patRequired: true,
      patConfigured: false,
      patMasked: "",
      updatedAt: null,
      validated: false,
      detail: "",
    };

    const passedCount = doctor.checks.filter((item) => item.ok).length;
    const failedCount = Math.max(0, doctor.checks.length - passedCount);
    const machine = cfg.machine ?? {
      collectedAt: "-",
      device: {
        hostname: "-",
        platform: "-",
        arch: "-",
        release: "-",
        nodeVersion: "-",
        uptimeSec: 0,
      },
      cpu: {
        model: "-",
        cores: 0,
        speedMHz: 0,
        loadAvg1: 0,
        loadAvg5: 0,
        loadAvg15: 0,
      },
      memory: {
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        usedPercent: 0,
      },
      gpu: {
        available: false,
        source: "none",
        model: "",
        vendor: "",
        coreCount: 0,
        utilizationPercent: 0,
        frequencyMHz: 0,
        powerW: 0,
        temperatureC: 0,
        memoryTotalBytes: 0,
        warning: "当前服务端尚未提供 GPU telemetry（请重启服务）。",
      },
      disks: [],
      currentProcess: {
        pid: 0,
        ppid: 0,
        cwd: "-",
        uptimeSec: 0,
        rssBytes: 0,
        heapUsedBytes: 0,
        heapTotalBytes: 0,
      },
      processes: {
        totalCount: 0,
        nodeCount: 0,
        forgeopsCount: 0,
        warning: "当前服务端尚未提供 machine telemetry（请重启服务）。",
        related: [],
        topByCpu: [],
      },
    };
    const cpuLoad1 = Number(machine.cpu.loadAvg1 || 0);
    const cpuLoad5 = Number(machine.cpu.loadAvg5 || 0);
    const cpuLoad15 = Number(machine.cpu.loadAvg15 || 0);
    const cpuPressure = this.calcCpuPressurePercent(cpuLoad1, machine.cpu.cores);
    const memoryPressure = this.clampPercent(machine.memory.usedPercent);
    const heapPressure = machine.currentProcess.heapTotalBytes > 0
      ? this.clampPercent((machine.currentProcess.heapUsedBytes / machine.currentProcess.heapTotalBytes) * 100)
      : 0;
    const diskPeak = machine.disks.length > 0
      ? machine.disks.slice().sort((a, b) => Number(b.usedPercent) - Number(a.usedPercent))[0]
      : null;
    const diskPressure = diskPeak ? this.clampPercent(diskPeak.usedPercent) : 0;
    const engineSlots = Math.max(0, Number(this.engine?.concurrency ?? 0));
    const activeSessions = Math.max(0, Number(this.engine?.activeSessions ?? 0));
    const sessionPressure = engineSlots > 0 ? this.clampPercent((activeSessions / engineSlots) * 100) : 0;
    const doctorRiskPressure = doctor.checks.length > 0
      ? this.clampPercent((failedCount / doctor.checks.length) * 100)
      : 0;
    const gpuUtilPressure = machine.gpu.available ? this.clampPercent(machine.gpu.utilizationPercent) : 0;
    const gpuFreqText = machine.gpu.frequencyMHz > 0 ? `${machine.gpu.frequencyMHz.toFixed(0)} MHz` : "-";
    const gpuPowerText = machine.gpu.powerW > 0 ? `${machine.gpu.powerW.toFixed(2)} W` : "-";
    const gpuTempText = machine.gpu.temperatureC > 0 ? `${machine.gpu.temperatureC.toFixed(1)} C` : "-";
    const gpuMemoryText = machine.gpu.memoryTotalBytes > 0 ? this.formatBytes(machine.gpu.memoryTotalBytes) : "-";
    const relatedProcesses = (machine.processes.related ?? [])
      .slice()
      .sort((a, b) => (Number(b.cpuPercent) + Number(b.memPercent)) - (Number(a.cpuPercent) + Number(a.memPercent)));
    const relatedCollapsed = !this.expandRelatedProcesses && relatedProcesses.length > 5;
    const visibleRelatedProcesses = relatedCollapsed ? relatedProcesses.slice(0, 5) : relatedProcesses;

    return html`
      <div class="panel-header">
        <span>系统配置</span>
        <span class="tag">${passedCount}/${doctor.checks.length}</span>
      </div>
      <div class="panel-body">
        <div class="panel-header">
          <span>压力总览</span>
          <span class="tag">${machine.collectedAt}</span>
        </div>
        <div class="system-visual-grid">
          ${this.renderPressureGauge(
            "CPU 1m 负载",
            cpuPressure,
            `load=${cpuLoad1.toFixed(2)} · cores=${machine.cpu.cores}`
          )}
          ${this.renderPressureGauge(
            "内存占用",
            memoryPressure,
            `${this.formatBytes(machine.memory.usedBytes)} / ${this.formatBytes(machine.memory.totalBytes)}`
          )}
          ${this.renderPressureGauge(
            "磁盘占用峰值",
            diskPressure,
            diskPeak
              ? `${diskPeak.mountPoint} · used=${this.formatPercent(diskPeak.usedPercent)}`
              : "暂无磁盘采样"
          )}
          ${this.renderPressureGauge(
            "进程 Heap 压力",
            heapPressure,
            `${this.formatBytes(machine.currentProcess.heapUsedBytes)} / ${this.formatBytes(machine.currentProcess.heapTotalBytes)}`
          )}
          ${this.renderPressureGauge(
            "会话并发占用",
            sessionPressure,
            engineSlots > 0
              ? `active=${activeSessions} / slots=${engineSlots}`
              : `active=${activeSessions} · slots=未上报`
          )}
          ${this.renderPressureGauge(
            "GPU 占用",
            gpuUtilPressure,
            machine.gpu.available
              ? `source=${machine.gpu.source} · model=${machine.gpu.model || "-"}`
              : (machine.gpu.warning || "GPU telemetry unavailable")
          )}
        </div>
        <div class="hint">颜色分级：绿色低压 · 橙色中压 · 红色高压。</div>

        <div class="panel-header"><span>机器观测明细</span></div>
        <div class="metrics">
          <div class="metric">
            <span class="label">设备</span>
            <span class="value">${machine.device.hostname}</span>
            <span class="mono">${machine.device.platform}/${machine.device.arch} · ${machine.device.release}</span>
          </div>
          <div class="metric">
            <span class="label">CPU</span>
            <span class="value">${machine.cpu.cores} Cores</span>
            <span class="mono">load ${cpuLoad1.toFixed(2)} / ${cpuLoad5.toFixed(2)} / ${cpuLoad15.toFixed(2)}</span>
          </div>
          <div class="metric">
            <span class="label">内存</span>
            <span class="value">${this.formatBytes(machine.memory.usedBytes)} / ${this.formatBytes(machine.memory.totalBytes)}</span>
            <span class="mono">${this.formatPercent(machine.memory.usedPercent)} used</span>
          </div>
          <div class="metric">
            <span class="label">系统运行时长</span>
            <span class="value">${this.formatUptime(machine.device.uptimeSec)}</span>
            <span class="mono">node ${machine.device.nodeVersion}</span>
          </div>
          <div class="metric">
            <span class="label">GPU</span>
            <span class="value">${machine.gpu.model || "-"}</span>
            <span class="mono">
              util=${machine.gpu.available ? this.formatPercent(machine.gpu.utilizationPercent) : "-"} · cores=${machine.gpu.coreCount || "-"} · source=${machine.gpu.source}
            </span>
          </div>
        </div>

        <div class="row">
          <div class="title">GPU 观测</div>
          ${this.renderPressureBar(
            "GPU 占用",
            gpuUtilPressure,
            `source=${machine.gpu.source} · ${machine.gpu.vendor ? `vendor=${machine.gpu.vendor}` : "vendor=-"}`
          )}
          <div class="mono">model=${machine.gpu.model || "-"} · cores=${machine.gpu.coreCount || "-"} · memory=${gpuMemoryText}</div>
          <div class="mono">freq=${gpuFreqText} · power=${gpuPowerText} · temp=${gpuTempText}</div>
          ${machine.gpu.warning ? html`<div class="hint">${machine.gpu.warning}</div>` : null}
        </div>

        <div class="events">
          ${machine.disks.length === 0
            ? html`<div class="hint">暂无磁盘数据（当前平台可能不支持 df 采集）。</div>`
            : machine.disks.map((disk) => html`
                <div class="row">
                  <div class="title">磁盘 ${disk.mountPoint}</div>
                  ${this.renderPressureBar(
                    "占用率",
                    disk.usedPercent,
                    `${this.formatBytes(disk.usedBytes)} / ${this.formatBytes(disk.totalBytes)} · free=${this.formatBytes(disk.freeBytes)}`
                  )}
                  <div class="mono">path=${disk.path}</div>
                </div>
              `)}
        </div>

        <div class="panel-header">
          <span>进程观测</span>
          <span class="tag">${machine.processes.totalCount}</span>
        </div>
        <div class="metrics">
          <div class="metric">
            <span class="label">ForgeOps 主进程</span>
            <span class="value">PID ${machine.currentProcess.pid}</span>
            <span class="mono">ppid=${machine.currentProcess.ppid} · uptime=${this.formatUptime(machine.currentProcess.uptimeSec)}</span>
          </div>
          <div class="metric">
            <span class="label">主进程内存</span>
            <span class="value">rss ${this.formatBytes(machine.currentProcess.rssBytes)}</span>
            <span class="mono">heap=${this.formatBytes(machine.currentProcess.heapUsedBytes)} / ${this.formatBytes(machine.currentProcess.heapTotalBytes)}</span>
          </div>
          <div class="metric">
            <span class="label">Node 进程数</span>
            <span class="value">${machine.processes.nodeCount}</span>
            <span class="mono">forgeops keyword=${machine.processes.forgeopsCount}</span>
          </div>
          <div class="metric">
            <span class="label">工作目录</span>
            <span class="value">cwd</span>
            <span class="mono">${machine.currentProcess.cwd}</span>
          </div>
        </div>

        ${machine.processes.warning
          ? html`<div class="hint">${machine.processes.warning}</div>`
          : null}

        <div class="panel-header">
          <span>相关进程（默认仅显示 Top 5）</span>
          <span class="tag">${visibleRelatedProcesses.length}/${relatedProcesses.length || 0}</span>
        </div>
        <div class="events">
          ${visibleRelatedProcesses.length === 0
            ? html`<div class="hint">暂无相关进程。</div>`
            : visibleRelatedProcesses.map((item) => {
                const role = this.normalizeProcessRole(item.role, item.tags, item.command, item.args);
                const secondaryTags = this.processSecondaryTags(item.tags, role);
                return html`
                <div class="row">
                  <div class="process-title-row">
                    <div class="title">pid=${item.pid} ${item.command}</div>
                    <div class="process-tag-list">
                      <span class=${this.processRoleClass(role)}>${this.processRoleLabel(role)}</span>
                      ${secondaryTags.map((tag) => html`
                          <span class=${this.processTagClass(tag)}>${this.processTagLabel(tag)}</span>
                        `)}
                    </div>
                  </div>
                  ${this.renderPressureBar("CPU", item.cpuPercent, `etime=${item.elapsed} · ppid=${item.ppid}`)}
                  ${this.renderPressureBar("MEM", item.memPercent, `rss=${this.formatBytes(item.rssBytes)}`)}
                  <div class="mono">${item.args || "-"}</div>
                </div>
              `;
              })}
        </div>
        <div class="hint">角色标签：核心控制面 / 核心执行器 / Agent Worker；补充标签：运行时 / 版本控制 / 工具链 / 未知。</div>
        ${relatedProcesses.length > 5
          ? html`
              <div class="button-row">
                <button type="button" @click=${() => { this.expandRelatedProcesses = !this.expandRelatedProcesses; }}>
                  ${this.expandRelatedProcesses ? "收起相关进程" : `展开全部 (${relatedProcesses.length})`}
                </button>
              </div>
            `
          : null}

        <div class="row">
          <div class="title">引擎控制</div>
          ${this.renderPressureBar(
            "会话并发占用",
            sessionPressure,
            engineSlots > 0 ? `active=${activeSessions} / slots=${engineSlots}` : `active=${activeSessions} · slots=未上报`
          )}
          <div class="mono">状态=${this.engine?.running ? "running" : "stopped"} · 活跃会话=${activeSessions}</div>
          <div class="mono">清理接管项目=${this.engine?.scheduler?.managedProjects ?? 0}</div>
          <status-dot status=${this.engine?.running ? "running" : "failed"}></status-dot>
          <div class="button-row">
            <input
              type="number"
              min="1"
              .value=${String(this.desiredConcurrency)}
              @input=${(ev: InputEvent) => {
                const target = ev.currentTarget as HTMLInputElement;
                this.desiredConcurrency = Number(target.value || "1");
              }}
            />
            <button type="button" @click=${this.onApplyConcurrency}>应用并发槽位</button>
            <button type="button" @click=${this.onStopAllRunsGlobal}>停止全部运行</button>
            <button type="button" @click=${this.onResumeAllRunsGlobal}>恢复全部暂停</button>
          </div>
        </div>

        <div class="row">
          <div class="title">系统健康总览</div>
          ${this.renderPressureBar("Doctor 风险压力", doctorRiskPressure, `通过 ${passedCount}/${doctor.checks.length}`)}
          <div class="mono">通过率=${this.formatPercent(this.clampPercent((passedCount / Math.max(1, doctor.checks.length)) * 100))}</div>
          <status-dot status=${doctor.ok ? "done" : "failed"}></status-dot>
        </div>

        <div class="row">
          <div class="title">Runtime</div>
          <div class="mono">selected=${runtime.selected}</div>
          <div class="mono">supported=${runtime.supported.join(", ")}</div>
          <div class="mono">model=${runtime.modelDefault}</div>
          <div class="mono">bin=${runtime.codexBin} version=${runtime.codexVersion || "-"}</div>
          ${runtime.error ? html`<div class="error">${runtime.error}</div>` : null}
          <status-dot status=${runtime.ready ? "done" : "failed"}></status-dot>
        </div>

        <form @submit=${this.onSaveSystemGit}>
          <div class="panel-header"><span>Git（系统级）</span></div>
          <div class="grid-2">
            <label>
              user.name
              <input name="gitUserName" .value=${git.userName} placeholder="Your Name" />
            </label>
            <label>
              user.email
              <input name="gitUserEmail" .value=${git.userEmail} placeholder="you@example.com" />
            </label>
          </div>
          <div class="hint">
            当前状态: ${git.configured ? "已配置" : "未配置"} · 命令可用: ${git.available ? "是" : "否"}
          </div>
          <div class="button-row">
            <button type="submit">保存 Git 配置</button>
          </div>
        </form>

        <form @submit=${this.onSaveSystemGitHubPat}>
          <div class="panel-header"><span>GitHub PAT（Classic，系统强制）</span></div>
          <label>
            Personal access token (classic)
            <input
              name="githubPatToken"
              type="password"
              placeholder="ghp_xxx..."
              autocomplete="off"
            />
          </label>
          <div class="hint">
            当前状态: ${github.patConfigured ? "已配置" : "未配置"}${github.patMasked ? ` (${github.patMasked})` : ""}
            · required=${github.patRequired ? "yes" : "no"}
            · scope校验=${github.validated ? "通过" : "未通过"}
          </div>
          <div class="mono">${github.detail || "-"}</div>
          <div class="mono">updated=${github.updatedAt ?? "-"}</div>
          <div class="button-row">
            <button type="submit">保存 PAT</button>
            <button type="button" @click=${() => { void this.onClearSystemGitHubPat(); }}>清空 PAT</button>
          </div>
          <status-dot status=${github.patConfigured && github.validated ? "done" : "failed"}></status-dot>
        </form>

        <div class="panel-header"><span>Doctor 检查明细</span></div>
        <div class="events">
          ${doctor.checks.map((check) => html`
            <div class="row">
              <div class="title">${check.id} · ${check.title}</div>
              <status-dot status=${check.ok ? "done" : "failed"}></status-dot>
              <div class="mono">${check.detail}</div>
              ${!check.ok && check.hint ? html`<div class="hint">${check.hint}</div>` : null}
            </div>
          `)}
        </div>
        <div class="button-row">
          <button type="button" @click=${this.onRefreshDoctor}>刷新系统检查</button>
        </div>
      </div>
    `;
  }

  private onOpenRunFromOverview(runId: string): void {
    if (!runId) return;
    this.currentPage = "project_runs";
    this.onSelectRun(runId);
  }

  private getIssueRunSummary(issueId: string): {
    total: number;
    running: number;
    target: RunRow | null;
  } {
    const key = String(issueId ?? "").trim();
    if (!key) {
      return { total: 0, running: 0, target: null };
    }
    const rows = this.runs
      .filter((run) => String(run.github_issue_id ?? "").trim() === key)
      .sort((left, right) => {
        const rightTs = new Date(right.updated_at || right.created_at || 0).getTime();
        const leftTs = new Date(left.updated_at || left.created_at || 0).getTime();
        return rightTs - leftTs;
      });
    if (rows.length === 0) {
      return { total: 0, running: 0, target: null };
    }
    const runningRows = rows.filter((run) => this.normalizeRunStatus(run.status) === "running");
    const target = runningRows[0] ?? rows[0];
    return {
      total: rows.length,
      running: runningRows.length,
      target,
    };
  }

  private onOpenRunFromIssue(issueId: string): void {
    const summary = this.getIssueRunSummary(issueId);
    if (!summary.target) return;
    this.currentPage = "project_runs";
    this.onSelectRun(summary.target.id);
  }

  private renderProjectRunningPipelines() {
    const runningRuns = this.runs.filter((run) => this.normalizeRunStatus(run.status) === "running");
    return html`
      <div class="panel-header">
        <span>运行中流水线</span>
        <span class="tag">${runningRuns.length}</span>
      </div>
      <div class="overview-running-list">
        ${runningRuns.length === 0
          ? html`<div class="hint">当前没有运行中的 Run。</div>`
          : runningRuns.map((run) => html`
              <div class="overview-running-item">
                <div class="overview-running-copy">
                  <div class="title">${run.task}</div>
                  <div class="mono">run=${run.id} · step=${run.running_step ?? "-"}</div>
                </div>
                <button type="button" @click=${() => this.onOpenRunFromOverview(run.id)}>查看</button>
              </div>
            `)}
      </div>
    `;
  }

  private getProjectAgentTeamRows(): { rows: ProjectAgentTeamRow[]; hasLiveRun: boolean } {
    const workflowSteps = this.workflowConfig?.resolved.steps ?? [];
    const projectRun = this.getProjectRunDetailForPipeline();
    const runStepStatus = new Map<string, string>();
    if (projectRun) {
      for (const step of projectRun.steps) {
        runStepStatus.set(step.step_key, step.status);
      }
    }

    const grouped = new Map<string, {
      agentId: string;
      stepKeys: string[];
      templates: Set<string>;
      retryBudgetMax: number;
      runningCount: number;
      failedCount: number;
    }>();

    for (const step of workflowSteps) {
      const bucket = grouped.get(step.agentId) ?? {
        agentId: step.agentId,
        stepKeys: [],
        templates: new Set<string>(),
        retryBudgetMax: 0,
        runningCount: 0,
        failedCount: 0,
      };
      bucket.stepKeys.push(step.key);
      bucket.templates.add(step.templateKey);
      bucket.retryBudgetMax = Math.max(bucket.retryBudgetMax, Number(step.maxRetries ?? 0));
      const status = String(runStepStatus.get(step.key) ?? "").toLowerCase();
      if (status === "running") bucket.runningCount += 1;
      if (status === "failed" || status === "error") bucket.failedCount += 1;
      grouped.set(step.agentId, bucket);
    }

    const rows: ProjectAgentTeamRow[] = Array.from(grouped.values())
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map((team) => {
        const state: ProjectAgentTeamRow["state"] = !projectRun
          ? "waiting"
          : team.failedCount > 0
            ? "failed"
            : team.runningCount > 0
              ? "running"
              : "waiting";
        const stateText = !projectRun
          ? "空闲（未选择运行）"
          : team.failedCount > 0
            ? "失败"
            : team.runningCount > 0
              ? "运行中"
              : "空闲";
        return {
          agentId: team.agentId,
          stepKeys: team.stepKeys,
          templates: Array.from(team.templates),
          retryBudgetMax: team.retryBudgetMax,
          runningCount: team.runningCount,
          failedCount: team.failedCount,
          state,
          stateText,
        };
      });
    return { rows, hasLiveRun: Boolean(projectRun) };
  }

  private toAgentTeam3DNodes(rows: ProjectAgentTeamRow[]): AgentTeam3DNode[] {
    return rows.map((row) => ({
      agentId: row.agentId,
      state: row.state,
      stateText: row.stateText,
      ownsSteps: row.stepKeys.length,
      runningCount: row.runningCount,
      failedCount: row.failedCount,
    }));
  }

  private async onOpenAgentTeam3D(): Promise<void> {
    if (!this.agentTeam3DReady) {
      await import("./components/agent-team-3d");
      this.agentTeam3DReady = true;
    }
    this.showAgentTeam3DModal = true;
  }

  private onCloseAgentTeam3D(): void {
    this.showAgentTeam3DModal = false;
  }

  private renderProjectAgentTeam() {
    const { rows, hasLiveRun } = this.getProjectAgentTeamRows();
    return html`
      <div class="panel-header">
        <span>Agent Team（项目编组）</span>
        <div class="panel-header-actions">
          <span class="tag">${rows.length}</span>
          <button type="button" @click=${this.onOpenAgentTeam3D} ?disabled=${rows.length === 0}>3D 视图（实验）</button>
        </div>
      </div>
      <div class="hint">定义来源：workflow.yaml。每张卡表示一个 Agent 在项目流水线中的职责分工（不是单次 Run 实例）。</div>
      <div class="hint">实验入口：点击右侧「3D 视图（实验）」可查看角色化三维编组场景。</div>
      <div class="team-grid">
        ${rows.length === 0
          ? html`<div class="hint">当前 workflow 未配置步骤，暂无 Agent Team 编组。</div>`
          : rows.map((team) => {
              return html`
                <div class="agent-card ${team.runningCount > 0 ? "running" : ""}">
                  <div class="title">${team.agentId}</div>
                  <div class="mono">owns_steps=${team.stepKeys.length} (${team.stepKeys.join(", ")})</div>
                  <div class="mono">templates=${team.templates.join(", ") || "-"}</div>
                  <div class="mono">retry_budget_max=${team.retryBudgetMax}</div>
                  <div class="mono">run_live=running:${team.runningCount} failed:${team.failedCount} 状态=${team.stateText}</div>
                  <status-dot status=${team.state}></status-dot>
                </div>
              `;
            })}
      </div>
      ${hasLiveRun
        ? null
        : html`<div class="hint">当前未绑定运行实例，状态展示偏静态（更像团队编制视图）。</div>`}
    `;
  }

  private switchPage(page: "project_overview" | "project_issues" | "project_runs" | "project_workflow" | "project_scheduler" | "system"): void {
    this.currentPage = page;
    if (page !== "system" && !this.selectedProjectId && this.projects.length > 0) {
      this.onSelectProject(this.projects[0].id);
    }
  }

  private getSelectedProject(): Project | null {
    if (!this.selectedProjectId) return null;
    return this.projects.find((project) => project.id === this.selectedProjectId) ?? null;
  }

  private renderSidebar() {
    const page = this.currentPage;
    const selectedProject = this.getSelectedProject();
    return html`
      <aside class="sidebar">
        <div class="panel-header">
          <span>项目菜单</span>
          <span class="tag project-switch-tag">
            <select
              aria-label="切换项目"
              .value=${selectedProject?.id ?? ""}
              ?disabled=${this.projects.length === 0}
              @change=${this.onProjectMenuChange}
            >
              ${this.projects.length === 0
                ? html`<option value="">暂无项目</option>`
                : this.projects.map(
                    (project) => html`
                      <option value=${project.id}>
                        ${project.name}
                      </option>
                    `
                  )}
            </select>
          </span>
        </div>
        <div class="panel-body">
          ${selectedProject
            ? html`
                <div class="row">
                  <div class="title">${selectedProject.name}</div>
                  <div class="mono">${selectedProject.id}</div>
                  <div class="mono">type=${this.getProductTypeLabel(selectedProject.product_type)} · status=${selectedProject.status}</div>
                </div>
                <div class="menu-group">
                  <div class="menu-title">工作台</div>
                  <button class="menu-btn ${page === "project_overview" ? "active" : ""}" type="button" @click=${() => this.switchPage("project_overview")}>项目概览</button>
                  <button class="menu-btn ${page === "project_issues" ? "active" : ""}" type="button" @click=${() => this.switchPage("project_issues")}>需求管理</button>
                  <button class="menu-btn ${page === "project_runs" ? "active" : ""}" type="button" @click=${() => this.switchPage("project_runs")}>运行实况</button>
                  <button class="menu-btn ${page === "project_workflow" ? "active" : ""}" type="button" @click=${() => this.switchPage("project_workflow")}>工作流编排</button>
                  <button class="menu-btn ${page === "project_scheduler" ? "active" : ""}" type="button" @click=${() => this.switchPage("project_scheduler")}>调度策略</button>
                </div>
              `
            : html`
                <div class="hint">请先在项目菜单下拉中选择项目，或点击右上「新建项目」。</div>
              `}
        </div>
      </aside>
    `;
  }

  private renderOverviewPage() {
    const selectedProject = this.getSelectedProject();
    if (!selectedProject) {
      return html`
        <div class="panel">
          <div class="panel-header"><span>项目概览</span></div>
          <div class="panel-body">
            <div class="hint">请先在项目菜单下拉选择项目，或点击右上「新建项目」。</div>
          </div>
        </div>
      `;
    }
    const showLoading = this.projectDataLoading && this.issues.length === 0 && this.runs.length === 0;
    const projectRuns = this.runs.filter((run) => run.project_id === selectedProject.id);
    const runningCount = projectRuns.filter((run) => run.status === "running").length;
    const failedCount = projectRuns.filter((run) => run.status === "failed").length;
    const completedCount = projectRuns.filter((run) => run.status === "completed").length;
    const metrics = this.projectMetrics && this.projectMetrics.project_id === selectedProject.id
      ? this.projectMetrics
      : null;
    const boundRepo = String(selectedProject.github_repo ?? "").trim();
    const metricsRepo = String(metrics?.github_repo ?? "").trim();
    const effectiveRepo = boundRepo || metricsRepo;
    const localIssueAll = this.issues.length;
    const localIssueClosed = this.issues.filter((item) => String(item.status ?? "").toLowerCase() === "closed").length;
    const localIssueOpen = Math.max(0, localIssueAll - localIssueClosed);
    const issueCounts = {
      all: metrics?.issue_count_all ?? localIssueAll,
      open: metrics?.issue_count_open ?? localIssueOpen,
      closed: metrics?.issue_count_closed ?? localIssueClosed,
    };
    const prCounts = {
      all: metrics?.pr_count_all ?? 0,
      open: metrics?.pr_count_open ?? 0,
      closed: metrics?.pr_count_closed ?? 0,
    };
    const selectedIssueCount = issueCounts[this.issuePrView];
    const selectedPrCount = prCounts[this.issuePrView];
    const codeLines = metrics?.code_lines ?? 0;
    const codeFiles = metrics?.code_files ?? 0;
    const docWords = metrics?.doc_words ?? 0;
    const docFiles = metrics?.doc_files ?? 0;
    const docsDocWords = metrics?.docs_doc_words ?? 0;
    const docsDocFiles = metrics?.docs_doc_files ?? 0;
    const codeLanguages = Array.isArray(metrics?.code_languages) ? metrics.code_languages : [];
    const tokenTotal = metrics?.token_total ?? projectRuns.reduce((sum, run) => sum + Number(run.total_tokens ?? 0), 0);
    const tokenInputTotal = metrics?.token_input_total ?? 0;
    const tokenCachedTotal = metrics?.token_cached_input_total ?? 0;
    const tokenOutputTotal = metrics?.token_output_total ?? 0;
    const tokenCacheHitRate = metrics?.token_cache_hit_rate ?? 0;
    const runTotal = metrics?.run_count ?? projectRuns.length;
    const runRunning = metrics?.run_running_count ?? runningCount;
    const runCompleted = metrics?.run_completed_count ?? completedCount;
    const runFailed = metrics?.run_failed_count ?? failedCount;
    const gateSeed = {
      passed: 0,
      failed: 0,
      running: 0,
      pending: 0,
      not_configured: 0,
      skipped: 0,
    };
    const ciGateCounts = projectRuns.reduce((acc, run) => {
      const status = this.getRunQualityGates(run).ci.status;
      if (status in acc) {
        acc[status as keyof typeof gateSeed] += 1;
      } else {
        acc.pending += 1;
      }
      return acc;
    }, { ...gateSeed });
    const platformGateCounts = projectRuns.reduce((acc, run) => {
      const status = this.getRunQualityGates(run).platform.status;
      if (status in acc) {
        acc[status as keyof typeof gateSeed] += 1;
      } else {
        acc.pending += 1;
      }
      return acc;
    }, { ...gateSeed });
    const ciGateConfigured = Math.max(0, runTotal - ciGateCounts.not_configured);
    const ciGatePassRate = ciGateConfigured > 0 ? (ciGateCounts.passed / ciGateConfigured) * 100 : 0;
    const ciGateFailurePressure = ciGateConfigured > 0 ? (ciGateCounts.failed / ciGateConfigured) * 100 : 0;
    const platformGateConfigured = Math.max(0, runTotal - platformGateCounts.not_configured);
    const platformGatePassRate = platformGateConfigured > 0 ? (platformGateCounts.passed / platformGateConfigured) * 100 : 0;
    const platformGateFailurePressure = platformGateConfigured > 0 ? (platformGateCounts.failed / platformGateConfigured) * 100 : 0;
    const runSuccessRate = runTotal > 0 ? (runCompleted / runTotal) * 100 : 0;
    const runFailurePressure = runTotal > 0 ? (runFailed / runTotal) * 100 : 0;
    const runQueuePressure = runTotal > 0 ? (runRunning / runTotal) * 100 : 0;
    const issueOpenPressure = issueCounts.all > 0 ? (issueCounts.open / issueCounts.all) * 100 : 0;
    const prOpenPressure = prCounts.all > 0 ? (prCounts.open / prCounts.all) * 100 : 0;
    const elapsedSecFallback = (() => {
      const startedAt = Date.parse(String(selectedProject.created_at ?? ""));
      if (!Number.isFinite(startedAt)) return 0;
      return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    })();
    const elapsedSec = metrics?.elapsed_sec ?? elapsedSecFallback;
    const trend = metrics?.code_trend_7d ?? null;
    const trendRows = Array.isArray(trend?.days) ? trend.days : [];
    const trendMaxAbs = Math.max(
      1,
      ...trendRows.map((row) => Math.max(
        Math.abs(Number(row.net_lines ?? 0)),
        Number(row.added_lines ?? 0),
        Number(row.deleted_lines ?? 0),
      )),
    );
    const topLanguages = codeLanguages.slice(0, 5);
    const extraLanguages = codeLanguages.slice(5);
    const extraLines = extraLanguages.reduce((sum, item) => sum + Number(item.lines ?? 0), 0);
    const extraFiles = extraLanguages.reduce((sum, item) => sum + Number(item.files ?? 0), 0);
    const languageTotal = Math.max(1, codeLines);
    const problemStatement = String(selectedProject.problem_statement ?? "").trim();
    const problemPreview = problemStatement
      ? (problemStatement.length > 84 ? `${problemStatement.slice(0, 84)}…` : problemStatement)
      : "未填写问题定义";
    const repoUrl = this.resolveGitHubRepoUrl(effectiveRepo);
    const viewOptions: Array<{ id: "all" | "open" | "closed"; label: string }> = [
      { id: "all", label: "全部" },
      { id: "open", label: "打开" },
      { id: "closed", label: "关闭" },
    ];

    return html`
      <div class="panel">
        <div class="panel-header">
          <span>项目概览</span>
          <span class="tag">${selectedProject.name}</span>
        </div>
        <div class="panel-body page-loading-shell">
          <div class=${`page-loading-content ${showLoading ? "dim" : "ready"}`}>
            <details class="row overview-project-card">
            <summary>
              <div class="overview-project-summary-head">
                <div class="title">${selectedProject.name}</div>
                <div class="overview-project-summary-actions">
                  ${repoUrl
                    ? html`
                        <a
                          class="github-link"
                          href=${repoUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="在 GitHub 打开仓库"
                          @click=${(ev: Event) => { ev.stopPropagation(); }}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M8 0C3.58 0 0 3.58 0 8a8.013 8.013 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.54 7.54 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path>
                          </svg>
                          GitHub
                        </a>
                      `
                    : null}
                  <span class="overview-project-toggle">
                    <span class="when-closed">点击展开</span>
                    <span class="when-open">点击收起</span>
                    <span class="overview-project-chevron" aria-hidden="true">▾</span>
                  </span>
                </div>
              </div>
              <div class="mono">type=${this.getProductTypeLabel(selectedProject.product_type)} · status=${selectedProject.status} · repo=${effectiveRepo || "-"}</div>
              <div class="mono">要解决的问题：${problemPreview}</div>
            </summary>
            <div class="overview-project-card-body">
              <div class="mono">project_root=${selectedProject.root_path}</div>
              <div class="mono">created=${selectedProject.created_at} · updated=${selectedProject.updated_at}</div>
              ${problemStatement
                ? html`<div class="mono">${problemStatement}</div>`
                : html`<div class="hint">暂未填写问题定义，可在项目配置中补充。</div>`}
              ${metrics
                ? html`<div class="mono">metrics@${metrics.loc_scanned_at} (${metrics.loc_source}) · github@${metrics.github_fetched_at}</div>`
                : null}
              </div>
            </details>
            <div class="overview-grid">
              <div class="metric metric-block">
              <div class="metric-block-header">
                <span class="metric-block-title">GitHub 工作项</span>
                <div class="segmented">
                  ${viewOptions.map((item) => html`
                    <button
                      type="button"
                      class=${this.issuePrView === item.id ? "active" : ""}
                      @click=${() => { this.issuePrView = item.id; }}
                    >
                      ${item.label}
                    </button>
                  `)}
                </div>
              </div>
              <div class="metric-kv">
                <span class="label">Issue</span>
                <span class="value">${this.formatNumber(selectedIssueCount)}</span>
              </div>
              <div class="metric-kv">
                <span class="label">PR</span>
                <span class="value">${this.formatNumber(selectedPrCount)}</span>
              </div>
              ${this.renderPressureBar(
                "Issue 待处理压力（open/all）",
                issueOpenPressure,
                `all=${issueCounts.all} · open=${issueCounts.open} · closed=${issueCounts.closed}`
              )}
              ${this.renderPressureBar(
                "PR 待处理压力（open/all）",
                prOpenPressure,
                `all=${prCounts.all} · open=${prCounts.open} · closed=${prCounts.closed}`
              )}
              <span class="mono">${effectiveRepo ? `repo=${effectiveRepo}` : "repo=未绑定"} · source=${metrics?.github_source ?? "none"}</span>
              </div>

              <div class="metric metric-block">
              <span class="metric-block-title">上下文资产</span>
              <div class="metric-kv">
                <span class="label">代码行数</span>
                <span class="value">${this.formatNumber(codeLines)} LOC</span>
              </div>
              <div class="metric-kv">
                <span class="label">代码文件</span>
                <span class="value">${this.formatNumber(codeFiles)}</span>
              </div>
              <div class="metric-kv">
                <span class="label">文档字数（docs/）</span>
                <span class="value">${this.formatNumber(docsDocWords)}</span>
              </div>
              <div class="metric-kv">
                <span class="label">文档字数（仓库）</span>
                <span class="value">${this.formatNumber(docWords)}</span>
              </div>
              <span class="mono">docs_files=${this.formatNumber(docsDocFiles)} · repo_doc_files=${this.formatNumber(docFiles)}</span>
              <div class="metric-kv">
                <span class="label">Token 消耗总量</span>
                <span class="value">${this.formatNumber(tokenTotal)}</span>
              </div>
              <div class="metric-kv">
                <span class="label">Token 输入</span>
                <span class="value">${this.formatNumber(tokenInputTotal)}</span>
              </div>
              <div class="metric-kv">
                <span class="label">Token 输出</span>
                <span class="value">${this.formatNumber(tokenOutputTotal)}</span>
              </div>
              <div class="metric-kv">
                <span class="label">缓存命中</span>
                <span class="value">${this.formatPercent(tokenCacheHitRate)} · ${this.formatNumber(tokenCachedTotal)}</span>
              </div>
              <span class="label">代码语言分布</span>
              <div class="lang-list">
                ${topLanguages.length === 0
                  ? html`<div class="hint">暂无代码语言分布（可能尚未扫描到代码文件）。</div>`
                  : topLanguages.map((item) => {
                      const ratio = this.clampPercent((Number(item.lines ?? 0) / languageTotal) * 100);
                      return html`
                        <div class="lang-row">
                          <span>${item.language}</span>
                          <div class="lang-track">
                            <div class="lang-fill" style=${`--lang-value:${ratio}%;`}></div>
                          </div>
                          <span class="mono">${this.formatNumber(item.lines)}L/${this.formatNumber(item.files)}F</span>
                        </div>
                      `;
                    })}
                ${extraLanguages.length > 0
                  ? html`
                      <div class="lang-row">
                        <span>Other</span>
                        <div class="lang-track">
                          <div class="lang-fill" style=${`--lang-value:${this.clampPercent((extraLines / languageTotal) * 100)}%;`}></div>
                        </div>
                        <span class="mono">${this.formatNumber(extraLines)}L/${this.formatNumber(extraFiles)}F</span>
                      </div>
                    `
                  : null}
              </div>
              </div>

              <div class="metric metric-block">
              <span class="metric-block-title">运行与节奏</span>
              <div class="metric-kv">
                <span class="label">Runs</span>
                <span class="value">${this.formatNumber(runTotal)}</span>
              </div>
              <div class="metric-kv">
                <span class="label">已运行</span>
                <span class="value">${this.formatUptime(elapsedSec)}</span>
              </div>
              <div class="mono">
                running=${runRunning} · completed=${runCompleted} · failed=${runFailed}
              </div>
              <div class="mono">
                run_success_rate=${this.formatPercent(runSuccessRate)} · queue_pressure=${this.formatPercent(runQueuePressure)}
              </div>
              <div class="mono">
                ci_pass=${ciGateConfigured > 0 ? `${ciGateCounts.passed}/${ciGateConfigured}` : "n/a"}
                · platform_pass=${platformGateConfigured > 0 ? `${platformGateCounts.passed}/${platformGateConfigured}` : "n/a"}
                · type=${this.getProductTypeLabel(selectedProject.product_type)}
              </div>
              <div class="row">
                <div class="title">7 日代码趋势</div>
                ${trend && trend.available
                  ? html`
                      <div class="trend-summary">
                        <span class="trend-summary-item">commits=${this.formatCompactTrendNumber(Number(trend.commit_count ?? 0))}</span>
                        <span class="trend-summary-item">+${this.formatCompactTrendNumber(Number(trend.added_lines ?? 0))}</span>
                        <span class="trend-summary-item">-${this.formatCompactTrendNumber(Number(trend.deleted_lines ?? 0))}</span>
                        <span class="trend-summary-item">net=${this.formatCompactTrendNumber(Number(trend.net_lines ?? 0), { signed: true })}</span>
                      </div>
                      <div class="trend-strip">
                        ${trendRows.map((row) => {
                          const net = Number(row.net_lines ?? 0);
                          const height = Math.max(8, Math.round((Math.abs(net) / trendMaxAbs) * 100));
                          return html`
                            <div class="trend-chip ${net >= 0 ? "up" : "down"}">
                              <div class="trend-date">${String(row.date ?? "").slice(5)}</div>
                              <div class="trend-bar">
                                <span style=${`--trend-size:${height}%;`}></span>
                              </div>
                              <div class="trend-net-value">${this.formatCompactTrendNumber(net, { signed: true })}</div>
                            </div>
                          `;
                        })}
                      </div>
                      <div class="mono">source=${trend.source}</div>
                    `
                  : html`
                      <div class="hint">7 日趋势暂无可用数据。${trend?.warning ? `原因：${trend.warning}` : ""}</div>
                    `}
              </div>
              </div>
            </div>
            ${metrics?.github_warning
              ? html`<div class="hint">GitHub 指标告警：${metrics.github_warning}</div>`
              : null}
            ${this.projectMetricsLoading
              ? html`<div class="hint">概览指标计算中，先展示基础数据…</div>`
              : null}
            ${this.renderProjectAgentTeam()}
            ${this.renderProjectRunningPipelines()}
            <div class="hint">建议从「需求管理」创建 GitHub Issue，再到「运行实况」启动并追踪 Run。</div>
          </div>
          ${this.renderProjectLoadingOverlay(
            showLoading,
            `正在切换到「${selectedProject.name}」，加载概览数据中…`,
            "overview",
          )}
        </div>
      </div>
    `;
  }

  private renderProjectIssuesPage() {
    if (!this.selectedProjectId) {
      return html`
        <div class="panel">
          <div class="panel-header"><span>需求管理</span></div>
          <div class="panel-body">
            <div class="hint">请先选择项目。</div>
          </div>
        </div>
      `;
    }
    const showLoading = this.projectDataLoading && this.issues.length === 0;
    const issueGroups = this.buildIssueStatusGroups(this.issues);
    return html`
      <div class="panel">
        <div class="panel-header">
          <span>需求管理</span>
          <span class="tag">${this.issues.length} issues</span>
        </div>
        <div class="panel-body page-loading-shell">
          <div class=${`page-loading-content ${showLoading ? "dim" : "ready"}`}>
            <form @submit=${this.onCreateIssue}>
              <label>
                GitHub Issue 标题
                <input name="title" placeholder="新增 OAuth 登录流程" required />
              </label>
              <label>
                GitHub Issue 描述
                <textarea name="description" placeholder="结构化需求：背景、目标、验收标准、风险"></textarea>
              </label>
              <button class="primary" type="submit">创建 GitHub Issue</button>
            </form>
            <div class="panel-header"><span>GitHub Issue 列表</span></div>
            <div class="events">
              ${this.issues.length === 0
                ? html`<div class="hint">当前项目还没有 GitHub Issue。</div>`
                : html`
                    <div class="run-group-list">
                      ${issueGroups.map((group) => html`
                        <details class="run-group" ?open=${group.openByDefault}>
                          <summary>
                            <span>${group.title}</span>
                            <span class="tag">${group.rows.length}</span>
                          </summary>
                          <div class="run-group-body">
                            <div class="events">
                              ${group.rows.map((issue) => this.renderIssueCard(issue))}
                            </div>
                          </div>
                        </details>
                      `)}
                    </div>
                  `}
            </div>
          </div>
          ${this.renderProjectLoadingOverlay(
            showLoading,
            "正在加载该项目的 GitHub Issue 列表…",
            "issues",
          )}
        </div>
      </div>
    `;
  }

  private normalizeIssueStatusKey(status: string): "open" | "in_progress" | "blocked" | "closed" | "other" {
    const key = String(status ?? "").trim().toLowerCase();
    if (!key || key === "open" || key === "todo" || key === "new") return "open";
    if (["in_progress", "in-progress", "progress", "doing", "running", "active", "queued", "pending"].includes(key)) return "in_progress";
    if (["blocked", "on_hold", "on-hold", "hold", "failed", "error"].includes(key)) return "blocked";
    if (["closed", "done", "resolved", "completed", "merged"].includes(key)) return "closed";
    return "other";
  }

  private resolveIssueDisplayStatus(issue: Issue): string {
    const workflowStatus = String(issue.workflow_status ?? "").trim();
    if (workflowStatus) return workflowStatus;
    const rawState = String(issue.status ?? "").trim().toLowerCase();
    if (rawState === "closed") return "closed";
    const labels = Array.isArray(issue.labels)
      ? issue.labels.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
      : [];
    const hasLabel = (candidates: string[]) => candidates.some((item) => labels.includes(String(item).toLowerCase()));
    if (hasLabel(["forgeops:failed", "status:failed", "status:blocked", "blocked", "on-hold", "on_hold"])) {
      return "blocked";
    }
    if (hasLabel(["forgeops:running", "forgeops:queued", "status:running", "status:in-progress", "status:in_progress", "in-progress", "in_progress"])) {
      return "in_progress";
    }
    if (hasLabel(["forgeops:ready", "status:open", "open", "todo", "backlog"])) {
      return "open";
    }
    return String(issue.status ?? "").trim() || "open";
  }

  private getIssueStatusLabel(status: string): string {
    const raw = String(status ?? "").trim();
    const key = this.normalizeIssueStatusKey(raw);
    if (key === "open") return "OPEN";
    if (key === "in_progress") return "IN PROGRESS";
    if (key === "blocked") return "BLOCKED";
    if (key === "closed") return "CLOSED";
    return raw ? raw.toUpperCase() : "OTHER";
  }

  private getIssueStatusChipClass(status: string): string {
    const key = this.normalizeIssueStatusKey(status);
    if (key === "in_progress") return "in-progress";
    return key;
  }

  private buildIssueStatusGroups(issues: Issue[]): Array<{
    id: "open" | "in_progress" | "blocked" | "closed" | "other";
    title: string;
    rows: Issue[];
    openByDefault: boolean;
  }> {
    const buckets: Record<"open" | "in_progress" | "blocked" | "closed" | "other", Issue[]> = {
      open: [],
      in_progress: [],
      blocked: [],
      closed: [],
      other: [],
    };
    for (const issue of issues) {
      buckets[this.normalizeIssueStatusKey(this.resolveIssueDisplayStatus(issue))].push(issue);
    }
    const sortByUpdatedAt = (left: Issue, right: Issue) => {
      const leftTs = Date.parse(String(left.updated_at ?? ""));
      const rightTs = Date.parse(String(right.updated_at ?? ""));
      if (!Number.isFinite(leftTs) && !Number.isFinite(rightTs)) return 0;
      if (!Number.isFinite(leftTs)) return 1;
      if (!Number.isFinite(rightTs)) return -1;
      return rightTs - leftTs;
    };
    const groups = [
      { id: "open" as const, title: "Open（待处理）", rows: buckets.open },
      { id: "in_progress" as const, title: "In Progress（进行中）", rows: buckets.in_progress },
      { id: "blocked" as const, title: "Blocked（阻塞）", rows: buckets.blocked },
      { id: "closed" as const, title: "Closed（已关闭）", rows: buckets.closed },
      { id: "other" as const, title: "Other（其他）", rows: buckets.other },
    ];
    return groups
      .filter((group) => group.rows.length > 0)
      .map((group) => ({
        ...group,
        rows: group.rows.slice().sort(sortByUpdatedAt),
        openByDefault: group.id !== "closed",
      }));
  }

  private renderIssueCard(issue: Issue) {
    const runSummary = this.getIssueRunSummary(issue.id);
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    const displayStatus = this.resolveIssueDisplayStatus(issue);
    return html`
      <div class="row">
        <div class="issue-card-head">
          <div class="title">${issue.title}</div>
          <div class="issue-chip-row">
            <span class=${`issue-status-chip ${this.getIssueStatusChipClass(displayStatus)}`}>
              ${this.getIssueStatusLabel(displayStatus)}
            </span>
            ${runSummary.target
              ? html`
                  <button
                    type="button"
                    class="issue-run-chip"
                    @click=${() => this.onOpenRunFromIssue(issue.id)}
                  >
                    ${runSummary.running > 0 ? `查看运行中 Run (${runSummary.running})` : "查看最近 Run"}
                  </button>
                `
              : null}
          </div>
        </div>
        <div class="mono">#${issue.id}</div>
        <div class="mono">status=${displayStatus} · github_state=${issue.status} · updated=${issue.updated_at}</div>
        ${runSummary.total > 0
          ? html`<div class="mono">runs=${runSummary.total} · running=${runSummary.running} · target=${runSummary.target?.id ?? "-"}</div>`
          : null}
        ${labels.length > 0
          ? html`
              <div class="issue-chip-row">
                ${labels.map((label) => html`<span class="issue-label-chip">${label}</span>`)}
              </div>
            `
          : null}
        ${issue.github_url
          ? html`<div class="mono"><a href=${issue.github_url} target="_blank" rel="noreferrer">open in GitHub</a></div>`
          : null}
        ${issue.description ? html`<div class="mono">${issue.description}</div>` : null}
      </div>
    `;
  }

  private getFilteredRunEvents(detail: RunDetail): RunDetail["events"] {
    const key = this.pipelineSelectedStepKey.trim();
    if (!key) return detail.events;
    const stepIds = new Set(
      detail.steps
        .filter((step) => step.step_key === key)
        .map((step) => step.id)
    );
    if (stepIds.size === 0) return [];
    return detail.events.filter((event) => {
      if (!event.step_id) return false;
      return stepIds.has(event.step_id);
    });
  }

  private buildGraphLevels(nodes: Array<{ id: string; dependsOnIds: string[] }>): Map<string, number> {
    const levelMap = new Map<string, number>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const unresolved = new Set(nodes.map((node) => node.id));

    let guard = 0;
    while (unresolved.size > 0 && guard < 3000) {
      guard += 1;
      let progressed = false;
      for (const node of nodes) {
        if (!unresolved.has(node.id)) continue;
        const deps = node.dependsOnIds.filter((dep) => byId.has(dep));
        const ready = deps.every((dep) => levelMap.has(dep));
        if (!ready) continue;
        const level = deps.length === 0
          ? 0
          : Math.max(...deps.map((dep) => levelMap.get(dep) ?? 0)) + 1;
        levelMap.set(node.id, level);
        unresolved.delete(node.id);
        progressed = true;
      }
      if (!progressed) {
        for (const id of unresolved) levelMap.set(id, 0);
        unresolved.clear();
      }
    }

    return levelMap;
  }

  private renderRunPipelineLivePanel(detail: RunDetail, options?: { fullscreen?: boolean; showEvents?: boolean }) {
    const fullscreen = options?.fullscreen === true;
    const showEvents = options?.showEvents !== false;
    const keyToId = new Map(detail.steps.map((step) => [step.step_key, step.id]));
    const nodes = detail.steps.map((step) => {
      const deps = this.parseDepends(step.depends_on_json);
      const dependsOnIds = deps
        .map((depKey) => keyToId.get(depKey))
        .filter((item): item is string => Boolean(item));
      const tokens = Number(step.token_input ?? 0) + Number(step.token_cached_input ?? 0) + Number(step.token_output ?? 0);
      const duration = this.calcDurationMs(step.started_at ?? null, step.ended_at ?? null);
      return {
        id: step.id,
        key: step.step_key,
        agentId: step.agent_id,
        status: step.status,
        dependsOnIds,
        tokens,
        duration,
      };
    });

    if (nodes.length === 0) {
      if (fullscreen) {
        return html`<div class="hint">当前 Run 尚未生成步骤，或步骤数据仍在同步中。</div>`;
      }
      return html`
        <div class="panel-header">
          <span>流水线实况（Run DAG）</span>
          <span class="tag">0 steps</span>
        </div>
        <div class="button-row">
          <button type="button" @click=${() => this.onOpenPipelineFullscreen("run")}>全屏查看</button>
        </div>
        <div class="hint">当前 Run 尚未生成步骤，或步骤数据仍在同步中。</div>
      `;
    }

    const levels = this.buildGraphLevels(nodes);
    const maxLevel = Math.max(...nodes.map((node) => levels.get(node.id) ?? 0), 0);
    const buckets = new Map<number, typeof nodes>();
    for (let lv = 0; lv <= maxLevel; lv += 1) buckets.set(lv, []);
    for (const node of nodes) {
      const lv = levels.get(node.id) ?? 0;
      const bucket = buckets.get(lv);
      if (bucket) bucket.push(node);
    }

    const nodeW = 232;
    const nodeH = 84;
    const colGap = 56;
    const rowGap = 30;
    const padX = 24;
    const padY = 24;
    const maxRows = Math.max(...Array.from(buckets.values()).map((items) => items.length), 1);
    const svgW = padX * 2 + (maxLevel + 1) * nodeW + maxLevel * colGap;
    const svgH = padY * 2 + maxRows * nodeH + (maxRows - 1) * rowGap;

    const pos = new Map<string, { x: number; y: number }>();
    for (let lv = 0; lv <= maxLevel; lv += 1) {
      const items = buckets.get(lv) ?? [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        pos.set(item.id, {
          x: padX + lv * (nodeW + colGap),
          y: padY + i * (nodeH + rowGap),
        });
      }
    }

    const filteredEvents = this.getFilteredRunEvents(detail);
    return html`
      ${fullscreen
        ? null
        : html`
            <div class="panel-header">
              <span>流水线实况（Run DAG）</span>
              <span class="tag">${nodes.length} steps · ${this.pipelineSelectedStepKey ? `filter=${this.pipelineSelectedStepKey}` : "all"}</span>
            </div>
          `}
      ${fullscreen
        ? null
        : html`
            <div class="button-row">
              <button type="button" @click=${() => this.onOpenPipelineFullscreen("run")}>全屏查看</button>
            </div>
          `}
      ${fullscreen
        ? null
        : html`<div class="hint">诊断：run=${detail.run.id} · steps=${nodes.length} · events=${detail.events.length}</div>`}
      ${fullscreen || showEvents || !this.pipelineSelectedStepKey
        ? null
        : html`
            <div class="run-inspector-toolbar">
              <span class="mono">已按 step=${this.pipelineSelectedStepKey} 过滤，右侧事件流已联动。</span>
              <button type="button" @click=${() => { this.pipelineSelectedStepKey = ""; }}>清除 step 过滤</button>
            </div>
          `}
      <div class=${`pipeline-live-grid ${fullscreen ? "fullscreen-fill" : ""} ${showEvents ? "" : "without-events"}`}>
        <div class=${`pipeline-wrap ${fullscreen ? "fullscreen-fill" : ""}`}>
          <svg class="pipeline-svg" width=${svgW} height=${svgH} viewBox=${`0 0 ${svgW} ${svgH}`} preserveAspectRatio="xMidYMin meet">
            ${(nodes.flatMap((node) => {
              const to = pos.get(node.id);
              if (!to) return [];
              return node.dependsOnIds.map((depId) => {
                const from = pos.get(depId);
                if (!from) return null;
                const x1 = from.x + nodeW;
                const y1 = from.y + nodeH / 2;
                const x2 = to.x;
                const y2 = to.y + nodeH / 2;
                const mx = Math.round((x1 + x2) / 2);
                const path = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
                return svg`<path class="pipeline-edge" d=${path}></path>`;
              }).filter((item) => item !== null);
            }))}

            ${nodes.map((node) => {
              const p = pos.get(node.id);
              if (!p) return null;
              const selected = this.pipelineSelectedStepKey === node.key;
              return svg`
                <g
                  class="pipeline-node-hit"
                  transform=${`translate(${p.x}, ${p.y})`}
                  @click=${() => {
                    this.pipelineSelectedStepKey = selected ? "" : node.key;
                  }}
                >
                  <rect class=${`pipeline-node-box ${this.getPipelineNodeClass(node.status)} ${selected ? "pipeline-node-selected" : ""}`} width=${nodeW} height=${nodeH}></rect>
                  <text class="pipeline-node-title" x="12" y="22">${node.key}</text>
                  <text class="pipeline-node-meta" x="12" y="42">${node.agentId}</text>
                  <text class="pipeline-node-meta" x="12" y="60">status=${node.status}</text>
                  <text class="pipeline-node-meta" x="12" y="74">dur=${this.formatDuration(node.duration)} · tokens=${this.formatNumber(node.tokens)}</text>
                </g>
              `;
            })}
          </svg>
        </div>

        ${showEvents
          ? html`
              <div class="pipeline-events">
                <div class="pipeline-events-header">
                  <div class="panel-header">
                    <span>事件流</span>
                    <span class="tag">${filteredEvents.length}</span>
                  </div>
                  ${this.pipelineSelectedStepKey
                    ? html`
                        <div class="button-row">
                          <button type="button" @click=${() => { this.pipelineSelectedStepKey = ""; }}>清除 step 过滤</button>
                        </div>
                      `
                    : null}
                </div>
                <div class="pipeline-events-list">
                  ${filteredEvents.length === 0
                    ? html`<div class="hint">当前过滤条件下暂无事件。</div>`
                    : filteredEvents.slice(-80).map((event) => html`
                        <div class="row">
                          <div class="title">${event.event_type}</div>
                          <div class="mono">${event.ts}</div>
                          <pre class="mono">${JSON.stringify(event.payload, null, 2)}</pre>
                        </div>
                      `)}
                </div>
              </div>
            `
          : null}
      </div>
      ${fullscreen
        ? null
        : showEvents
          ? html`<div class="hint">点击节点可过滤右侧事件流，便于定位单个 step 的执行链路。</div>`
          : html`<div class="hint">点击节点后，右侧「事件流」Tab 会自动按该 step 过滤。</div>`}
    `;
  }

  private getProjectRunDetailForPipeline(): RunDetail | null {
    if (!this.runDetail || !this.selectedProjectId) return null;
    if (this.runDetail.run.project_id !== this.selectedProjectId) return null;
    return this.runDetail;
  }

  private buildStepStatusMap(detail: RunDetail | null): Map<string, string> {
    const out = new Map<string, string>();
    if (!detail) return out;
    for (const step of detail.steps) {
      out.set(step.step_key, step.status);
    }
    return out;
  }

  private buildWorkflowLevels(steps: WorkflowResolvedStep[]): Map<string, number> {
    const levelMap = new Map<string, number>();
    const byKey = new Map(steps.map((step) => [step.key, step]));
    const unresolved = new Set(steps.map((step) => step.key));

    let guard = 0;
    while (unresolved.size > 0 && guard < 2000) {
      guard += 1;
      let progressed = false;
      for (const step of steps) {
        if (!unresolved.has(step.key)) continue;
        const deps = step.dependsOn.filter((dep) => byKey.has(dep));
        const allReady = deps.every((dep) => levelMap.has(dep));
        if (!allReady) continue;
        const level = deps.length === 0
          ? 0
          : Math.max(...deps.map((dep) => levelMap.get(dep) ?? 0)) + 1;
        levelMap.set(step.key, level);
        unresolved.delete(step.key);
        progressed = true;
      }
      if (!progressed) {
        for (const key of unresolved) {
          levelMap.set(key, 0);
        }
        unresolved.clear();
      }
    }

    return levelMap;
  }

  private getPipelineNodeClass(status: string): string {
    const key = String(status || "").toLowerCase();
    if (key === "running") return "pipeline-node-running";
    if (key === "done" || key === "completed") return "pipeline-node-done";
    if (key === "failed" || key === "error") return "pipeline-node-failed";
    if (key === "pending" || key === "waiting" || key === "retry") return "pipeline-node-pending";
    return "pipeline-node-default";
  }

  private renderPipelineLivePanel(options?: { fullscreen?: boolean; fillHeight?: boolean }) {
    const fullscreen = options?.fullscreen === true;
    const fillHeight = options?.fillHeight === true;
    const panelClass = `pipeline-live-panel ${fillHeight ? "fill-height" : ""}`;
    if (!this.workflowConfig) {
      if (fullscreen) {
        return html`<div class="hint">当前项目未加载 workflow（诊断：workflowConfig=null）。</div>`;
      }
      return html`
        <section class=${panelClass}>
          <div class="panel-header">
            <span>流水线实况（DAG）</span>
            <span class="tag">0 steps</span>
          </div>
          <div class="hint">当前项目未加载 workflow（诊断：workflowConfig=null）。</div>
        </section>
      `;
    }
    const steps = this.workflowConfig.resolved.steps;
    if (steps.length === 0) {
      if (fullscreen) {
        return html`<div class="hint">workflow 无步骤定义（诊断：steps=0）。</div>`;
      }
      return html`
        <section class=${panelClass}>
          <div class="panel-header">
            <span>流水线实况（DAG）</span>
            <span class="tag">0 steps</span>
          </div>
          <div class="hint">workflow 无步骤定义（诊断：steps=0）。</div>
        </section>
      `;
    }

    const runDetail = this.getProjectRunDetailForPipeline();
    const statusMap = this.buildStepStatusMap(runDetail);
    const levels = this.buildWorkflowLevels(steps);
    const maxLevel = Math.max(...steps.map((step) => levels.get(step.key) ?? 0), 0);

    const levelBuckets = new Map<number, WorkflowResolvedStep[]>();
    for (let lv = 0; lv <= maxLevel; lv += 1) {
      levelBuckets.set(lv, []);
    }
    for (const step of steps) {
      const lv = levels.get(step.key) ?? 0;
      const bucket = levelBuckets.get(lv);
      if (bucket) bucket.push(step);
    }

    const nodeW = 210;
    const nodeH = 76;
    const colGap = 60;
    const rowGap = 34;
    const padX = 28;
    const padY = 28;
    const maxRows = Math.max(...Array.from(levelBuckets.values()).map((items) => items.length), 1);
    const svgW = padX * 2 + (maxLevel + 1) * nodeW + maxLevel * colGap;
    const svgH = padY * 2 + maxRows * nodeH + (maxRows - 1) * rowGap;

    const position = new Map<string, { x: number; y: number }>();
    for (let lv = 0; lv <= maxLevel; lv += 1) {
      const list = levelBuckets.get(lv) ?? [];
      for (let i = 0; i < list.length; i += 1) {
        const step = list[i];
        const x = padX + lv * (nodeW + colGap);
        const y = padY + i * (nodeH + rowGap);
        position.set(step.key, { x, y });
      }
    }

    const graphPanel = html`
      <div class="pipeline-wrap-shell ${fullscreen ? "fullscreen-fill" : "has-corner-action"}">
        ${fullscreen
          ? null
          : html`
              <button
                class="pipeline-corner-action"
                type="button"
                @click=${() => this.onOpenPipelineFullscreen("project")}
                aria-label="全屏查看流水线"
                title="全屏查看"
              >
                <span class="pipeline-corner-icon" aria-hidden="true"></span>
              </button>
            `}
        <div class="pipeline-wrap ${fullscreen ? "fullscreen-fill" : ""}">
          <svg class="pipeline-svg" width=${svgW} height=${svgH} viewBox=${`0 0 ${svgW} ${svgH}`} preserveAspectRatio="xMidYMin meet" role="img" aria-label="Pipeline DAG">
            ${(steps.flatMap((step) => {
              const to = position.get(step.key);
              if (!to) return [];
              return step.dependsOn
                .map((depKey) => {
                  const from = position.get(depKey);
                  if (!from) return null;
                  const x1 = from.x + nodeW;
                  const y1 = from.y + nodeH / 2;
                  const x2 = to.x;
                  const y2 = to.y + nodeH / 2;
                  const mx = Math.round((x1 + x2) / 2);
                  const path = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
                  return svg`<path class="pipeline-edge" d=${path}></path>`;
                })
                .filter((item) => item !== null);
            }))}

            ${steps.map((step) => {
              const pos = position.get(step.key);
              if (!pos) return null;
              const status = statusMap.get(step.key) ?? "waiting";
              const selected = this.pipelineSelectedStepKey === step.key;
              return svg`
                <g
                  class="pipeline-node-hit"
                  transform=${`translate(${pos.x}, ${pos.y})`}
                  @click=${() => {
                    this.pipelineSelectedStepKey = selected ? "" : step.key;
                      if (runDetail) {
                        this.currentPage = "project_runs";
                      }
                    }}
                >
                  <rect class=${`pipeline-node-box ${this.getPipelineNodeClass(status)} ${selected ? "pipeline-node-selected" : ""}`} width=${nodeW} height=${nodeH}></rect>
                  <text class="pipeline-node-title" x="12" y="22">${step.key}</text>
                  <text class="pipeline-node-meta" x="12" y="42">${step.agentId}</text>
                  <text class="pipeline-node-meta" x="12" y="60">status=${status}</text>
                </g>
              `;
            })}
          </svg>
        </div>
      </div>
    `;

    if (fullscreen) {
      return html`<div class="pipeline-fullscreen-stage">${graphPanel}</div>`;
    }

    return html`
      <section class=${panelClass}>
        <div class="panel-header">
          <span>流水线实况（DAG）</span>
          <span class="tag">${steps.length} steps${runDetail ? ` · run=${runDetail.run.id}` : ""}</span>
        </div>
        <div class="hint">诊断：project=${this.selectedProjectId || "-"} · workflowLoaded=yes · steps=${steps.length} · runOverlay=${runDetail ? "yes" : "no"}</div>
        ${graphPanel}
        ${runDetail
          ? html`<div class="hint">已叠加当前选中项目 run 的 step 状态。点击节点可跳转到「运行」页并过滤该 step 的事件流。</div>`
          : html`<div class="hint">当前展示 workflow 拓扑。选中该项目的 run 后会叠加实况状态。</div>`}
      </section>
    `;
  }

  private renderProjectsPage() {
    return html`
      <div class="panel">
        <div class="panel-header">
          <span>项目工作台</span>
          ${this.selectedProjectId ? html`<span class="tag">${this.selectedProjectId}</span>` : null}
        </div>
        <div class="panel-body">
          ${!this.selectedProjectId
            ? html`<div class="hint">请先在项目菜单下拉选择项目，或点击右上「新建项目」。</div>`
            : html`
                <div class="grid-2">
                  <form @submit=${this.onCreateIssue}>
                    <label>
                      GitHub Issue 标题
                      <input name="title" placeholder="新增 OAuth 登录流程" required />
                    </label>
                    <label>
                      GitHub Issue 描述
                      <textarea name="description" placeholder="结构化需求：背景、目标、验收标准、风险"></textarea>
                    </label>
                    <button type="submit">创建 GitHub Issue</button>
                    <div class="hint">当前项目 GitHub Issue 数: ${this.issues.length}</div>
                  </form>

                  ${this.renderRunLaunchCard({ showResume: false })}
                </div>

                ${this.schedulerConfig
                  ? html`
                      <form @submit=${this.onSaveScheduler}>
                        <div class="panel-header"><span>项目调度配置（Cron）</span></div>
                        <div class="grid-2">
                          <label>
                            调度总开关
                            <select name="enabled">
                              <option value="true" ?selected=${this.schedulerConfig.enabled}>启用</option>
                              <option value="false" ?selected=${!this.schedulerConfig.enabled}>停用</option>
                            </select>
                          </label>
                          <label>
                            时区
                            <input
                              name="timezone"
                              .value=${this.schedulerConfig.timezone}
                              placeholder="Asia/Shanghai"
                              list="scheduler-timezone-options-overview"
                            />
                            ${this.renderSchedulerTimezoneDatalist("scheduler-timezone-options-overview")}
                            <div class="hint">可选：Asia/Shanghai（推荐）/ UTC / Asia/Tokyo / America/Los_Angeles 等，也兼容填写 UTC+8。</div>
                          </label>
                        </div>
                        <div class="grid-2">
                          <label>
                            Cleanup 开关
                            <select name="cleanupEnabled">
                              <option value="true" ?selected=${this.schedulerConfig.cleanup.enabled}>启用</option>
                              <option value="false" ?selected=${!this.schedulerConfig.cleanup.enabled}>停用</option>
                            </select>
                          </label>
                          <label>
                            Cleanup 模式
                            <select name="cleanupMode">
                              <option value="deep" ?selected=${this.schedulerConfig.cleanup.mode === "deep"}>deep（单节点深度清理）</option>
                              <option value="lite" ?selected=${this.schedulerConfig.cleanup.mode === "lite"}>lite（完整流水线）</option>
                            </select>
                          </label>
                        </div>
                        <div class="grid-2">
                          <label>
                            空闲时执行
                            <select name="onlyWhenIdle">
                              <option value="true" ?selected=${this.schedulerConfig.cleanup.onlyWhenIdle}>是</option>
                              <option value="false" ?selected=${!this.schedulerConfig.cleanup.onlyWhenIdle}>否</option>
                            </select>
                          </label>
                          <div class="hint">
                            标准流水线的 cleanup 步骤固定为 lite；定时 cleanup 可切换为 deep（单节点专用）。
                          </div>
                        </div>
                        <div class="grid-2">
                          <label>
                            Cron
                            <input name="cron" .value=${this.schedulerConfig.cleanup.cron} />
                          </label>
                          <label>
                            任务文案
                            <input name="task" .value=${this.schedulerConfig.cleanup.task} />
                          </label>
                        </div>
                        <div class="panel-header"><span>Issue Auto-Run（Cron）</span></div>
                        <div class="grid-2">
                          <label>
                            Auto-Run 开关
                            <select name="issueAutoRunEnabled">
                              <option value="true" ?selected=${this.schedulerConfig.issueAutoRun.enabled}>启用</option>
                              <option value="false" ?selected=${!this.schedulerConfig.issueAutoRun.enabled}>停用</option>
                            </select>
                          </label>
                          <label>
                            标签过滤
                            <input
                              name="issueAutoRunLabel"
                              .value=${this.schedulerConfig.issueAutoRun.label}
                              placeholder="forgeops:ready 或 *"
                            />
                            <div class="hint">填写 * 表示处理全部 open issue。</div>
                          </label>
                        </div>
                        <div class="grid-2">
                          <label>
                            Auto-Run Cron
                            <input name="issueAutoRunCron" .value=${this.schedulerConfig.issueAutoRun.cron} />
                          </label>
                          <label>
                            单次最多创建 Run
                            <input
                              name="issueAutoRunMaxRunsPerTick"
                              type="number"
                              min="1"
                              step="1"
                              .value=${String(this.schedulerConfig.issueAutoRun.maxRunsPerTick)}
                            />
                          </label>
                        </div>
                        <div class="grid-2">
                          <label>
                            Auto-Run 仅空闲执行
                            <select name="issueAutoRunOnlyWhenIdle">
                              <option value="true" ?selected=${this.schedulerConfig.issueAutoRun.onlyWhenIdle}>是</option>
                              <option value="false" ?selected=${!this.schedulerConfig.issueAutoRun.onlyWhenIdle}>否</option>
                            </select>
                          </label>
                        </div>
                        <div class="button-row">
                          <button type="submit">保存调度配置</button>
                        </div>
                      </form>
                    `
                  : html`<div class="hint">当前项目未加载调度配置。</div>`}
                ${this.renderSchedulerRuntimeJobs()}

                ${this.workflowConfig
                  ? html`
                      <form @submit=${this.onSaveWorkflow}>
                        <div class="panel-header">
                          <span>工作流配置（workflow.yaml）</span>
                          <span class="tag">${this.workflowConfig.resolved.steps.length} steps</span>
                        </div>
                        <label>
                          YAML 内容
                          <textarea
                            name="workflowYaml"
                            .value=${this.workflowYamlDraft}
                            @input=${(ev: InputEvent) => {
                              const target = ev.currentTarget as HTMLTextAreaElement;
                              this.workflowYamlDraft = target.value;
                            }}
                            style="min-height: 180px;"
                          ></textarea>
                        </label>
                        <div class="hint">
                          解析结果: ${this.workflowConfig.resolved.id} / ${this.workflowConfig.resolved.name}
                          · ${this.workflowConfig.resolved.steps.map((step) => step.key).join(" -> ")}
                        </div>
                        <div class="hint">
                          ${this.workflowConfig.resolved.steps.map((step) => {
                            const autoFix = step.reviewAutoFixPolicy;
                            const autoFixText = autoFix
                              ? ` · auto-fix=${autoFix.enabled ? "on" : "off"} turns=${autoFix.maxTurns} budget=${autoFix.maxFiles}F/${autoFix.maxLines}L`
                              : "";
                            return html`<div class="mono">- ${step.key} (agent=${step.agentId}, retries=${step.maxRetries}${autoFixText})</div>`;
                          })}
                        </div>
                        <div class="button-row">
                          <button type="submit">保存工作流</button>
                          <button type="button" @click=${this.onResetWorkflow}>恢复默认</button>
                        </div>
                      </form>
                    `
                  : html`<div class="hint">当前项目未加载工作流配置。</div>`}

                ${this.renderPipelineLivePanel()}
                ${this.renderProjectRunningPipelines()}
                ${this.renderProjectAgentTeam()}
              `}
        </div>
      </div>
    `;
  }

  private renderRunInspectorPanel(detail: RunDetail) {
    const filteredEvents = this.getFilteredRunEvents(detail);
    const visibleEvents = filteredEvents.slice(-180);
    const artifacts = detail.artifacts ?? [];
    const eventsTabActive = this.runInsightTab === "events";

    return html`
      <section class="subpanel run-inspector">
        <div class="panel-header">
          <span>${eventsTabActive ? "事件流" : "产物"}</span>
          <span class="tag">${eventsTabActive ? filteredEvents.length : artifacts.length}</span>
        </div>
        <div class="run-inspector-tabs">
          <button
            type="button"
            class=${eventsTabActive ? "active" : ""}
            @click=${() => { this.runInsightTab = "events"; }}
          >
            事件流
          </button>
          <button
            type="button"
            class=${!eventsTabActive ? "active" : ""}
            @click=${() => { this.runInsightTab = "artifacts"; }}
          >
            产物
          </button>
          ${this.pipelineSelectedStepKey ? html`<span class="tag">filter=${this.pipelineSelectedStepKey}</span>` : null}
        </div>
        <div class="run-inspector-window">
          ${eventsTabActive
            ? html`
                <div class="run-inspector-toolbar">
                  <span class="mono">
                    ${this.pipelineSelectedStepKey
                      ? `按 step=${this.pipelineSelectedStepKey} 过滤，显示最近 ${visibleEvents.length} 条`
                      : "显示当前 Run 全量事件（最近 180 条）"}
                  </span>
                  ${this.pipelineSelectedStepKey
                    ? html`<button type="button" @click=${() => { this.pipelineSelectedStepKey = ""; }}>清除 step 过滤</button>`
                    : null}
                </div>
                <div class="events">
                  ${visibleEvents.length === 0
                    ? html`<div class="hint">当前过滤条件下暂无事件。</div>`
                    : visibleEvents.map((event) => html`
                        <div class="row">
                          <div class="title">${event.event_type}</div>
                          <div class="mono">${event.ts}</div>
                          <pre class="mono">${JSON.stringify(event.payload, null, 2)}</pre>
                        </div>
                      `)}
                </div>
              `
            : html`
                <div class="mono">artifact_count=${artifacts.length}</div>
                <div class="artifacts">
                  ${artifacts.length === 0
                    ? html`<div class="hint">当前 Run 暂无产物。</div>`
                    : artifacts.map((artifact) => html`
                        <div class="row">
                          <div class="title">${artifact.kind} · ${artifact.title}</div>
                          <div class="mono">${artifact.created_at}</div>
                          <pre class="mono">${artifact.content}</pre>
                        </div>
                      `)}
                </div>
              `}
        </div>
      </section>
    `;
  }

  private renderRunsPage() {
    if (!this.selectedProjectId) {
      return html`
        <div class="panel">
          <div class="panel-header"><span>运行实况</span></div>
          <div class="panel-body">
            <div class="hint">请先选择项目。</div>
          </div>
        </div>
      `;
    }
    const showLoading = this.projectDataLoading && this.runs.length === 0 && !this.runDetail;
    return html`
      <div class="page-loading-shell">
        <div class=${`details run-details-layout page-loading-content ${showLoading ? "dim" : "ready"}`}>
          <section class="subpanel">
          <div class="panel-header">
            <span>运行记录</span>
            <div class="panel-header-actions">
              <span class="tag">${this.runs.length}</span>
              <button
                type="button"
                @click=${() => { this.runLaunchPanelOpen = !this.runLaunchPanelOpen; }}
              >
                ${this.runLaunchPanelOpen ? "收起启动面板" : "启动 Run"}
              </button>
            </div>
          </div>
          <div class="panel-body">
            ${this.runLaunchPanelOpen
              ? this.renderRunLaunchCard({ showResume: true })
              : html`<div class="hint">启动面板已收起，可通过右上「启动 Run」入口随时展开。</div>`}
            ${this.renderRunGroups()}

            ${this.runDetail
              ? html`
                  <div class="row">
                    <div class="title">Run 概览</div>
                    <div class="run-gates">
                      <span class="run-gate-item">
                        <span class="label">CI Gate</span>
                        <status-dot status=${this.gateStatusToDot(this.getRunQualityGates(this.runDetail.run).ci.status)}></status-dot>
                      </span>
                      <span class="run-gate-item">
                        <span class="label">Platform Gate</span>
                        <status-dot status=${this.gateStatusToDot(this.getRunQualityGates(this.runDetail.run).platform.status)}></status-dot>
                      </span>
                      <span class="run-gate-item">
                        <span class="label">Overall</span>
                        <status-dot status=${this.gateStatusToDot(this.getRunQualityGates(this.runDetail.run).overall)}></status-dot>
                      </span>
                    </div>
                    <div class="mono">run=${this.runDetail.run.id} status=${this.runDetail.run.status} running_step=${this.runDetail.run.running_step ?? "-"}</div>
                    <div class="mono">branch=${this.runDetail.run.worktree_branch ?? "-"}</div>
                    <div class="mono">base=${this.runDetail.run.base_ref ?? "-"}</div>
                    <div class="mono">${this.runDetail.run.worktree_path ?? "-"}</div>
                  </div>
                  ${this.renderRunPipelineLivePanel(this.runDetail, { showEvents: false })}
                  ${this.renderRuntimeObservability()}
                `
              : html`<div class="hint">请选择一个 Run 查看详情。</div>`}
          </div>
          </section>

          ${this.runDetail
            ? this.renderRunInspectorPanel(this.runDetail)
            : html`
                <section class="subpanel run-inspector">
                  <div class="panel-header">
                    <span>运行细节</span>
                    <span class="tag">-</span>
                  </div>
                  <div class="run-inspector-window">
                    <div class="hint">请选择一个 Run 查看事件流和产物。</div>
                  </div>
                </section>
              `}
        </div>
        ${this.renderProjectLoadingOverlay(
          showLoading,
          "正在加载该项目的 Run 与会话数据…",
          "runs",
        )}
      </div>
    `;
  }

  private renderProjectWorkflowPage() {
    if (!this.selectedProjectId) {
      return html`
        <div class="panel">
          <div class="panel-header"><span>工作流编排</span></div>
          <div class="panel-body">
            <div class="hint">请先选择项目。</div>
          </div>
        </div>
      `;
    }
    const showLoading = this.projectDataLoading && !this.workflowConfig;
    return html`
      <div class="panel workflow-panel">
        <div class="panel-header">
          <span>工作流编排</span>
          <span class="tag">${this.workflowConfig?.resolved.steps.length ?? 0} steps</span>
        </div>
        <div class="panel-body workflow-panel-body page-loading-shell">
          <div class=${`page-loading-content ${showLoading ? "dim" : "ready"}`}>
            ${this.workflowConfig
              ? html`
                  <form @submit=${this.onSaveWorkflow}>
                    <label>
                      workflow.yaml
                      <textarea
                        name="workflowYaml"
                        .value=${this.workflowYamlDraft}
                        @input=${(ev: InputEvent) => {
                          const target = ev.currentTarget as HTMLTextAreaElement;
                          this.workflowYamlDraft = target.value;
                        }}
                        style="min-height: 220px;"
                      ></textarea>
                    </label>
                    <div class="hint">
                      解析结果: ${this.workflowConfig.resolved.id} / ${this.workflowConfig.resolved.name}
                      · ${this.workflowConfig.resolved.steps.map((step) => step.key).join(" -> ")}
                    </div>
                    <div class="button-row">
                      <button type="submit">保存工作流</button>
                      <button type="button" @click=${this.onResetWorkflow}>恢复默认</button>
                    </div>
                  </form>
                `
              : html`<div class="hint">当前项目未加载工作流配置。</div>`}
            ${this.renderPipelineLivePanel({
              fillHeight: Boolean(this.workflowConfig?.resolved.steps.length),
            })}
          </div>
          ${this.renderProjectLoadingOverlay(
            showLoading,
            "正在加载 workflow 配置与 DAG…",
            "workflow",
          )}
        </div>
      </div>
    `;
  }

  private getSelectedProjectSchedulerJobs(
    filter: "all" | "cleanup" | "issueAutoRun" | "skillPromotion" | "globalSkillPromotion" = "all"
  ) {
    const projectId = String(this.selectedProjectId ?? "").trim();
    if (!projectId) return [];
    const allJobs = Array.isArray(this.engine?.scheduler?.jobs) ? this.engine.scheduler.jobs : [];
    const jobs = allJobs
      .filter((job) => String(job.projectId ?? "").trim() === projectId)
      .filter((job) => filter === "all" || String(job.kind ?? "") === filter);
    const kindOrder = (kind: string): number => {
      if (kind === "cleanup") return 0;
      if (kind === "issueAutoRun") return 1;
      if (kind === "skillPromotion") return 2;
      if (kind === "globalSkillPromotion") return 3;
      return 9;
    };
    return [...jobs].sort((left, right) => {
      const rankGap = kindOrder(String(left.kind ?? "")) - kindOrder(String(right.kind ?? ""));
      if (rankGap !== 0) return rankGap;
      return String(left.cron ?? "").localeCompare(String(right.cron ?? ""));
    });
  }

  private renderSchedulerRuntimeJobs() {
    const allJobs = this.getSelectedProjectSchedulerJobs("all");
    const jobs = this.getSelectedProjectSchedulerJobs(this.schedulerJobFilter);
    return html`
      <div class="panel-header">
        <span>运行态 Job 列表</span>
        <div class="scheduler-job-header-actions">
          <label class="scheduler-job-filter">
            <span>filter</span>
            <select
              .value=${this.schedulerJobFilter}
              @change=${(ev: Event) => {
                const next = String((ev.currentTarget as HTMLSelectElement).value ?? "");
                this.schedulerJobFilter = (
                  next === "cleanup"
                  || next === "issueAutoRun"
                  || next === "skillPromotion"
                  || next === "globalSkillPromotion"
                ) ? next : "all";
              }}
            >
              <option value="all">all</option>
              <option value="cleanup">cleanup</option>
              <option value="issueAutoRun">issueAutoRun</option>
              <option value="skillPromotion">skillPromotion</option>
              <option value="globalSkillPromotion">globalSkillPromotion</option>
            </select>
          </label>
          <span class="tag">${jobs.length}/${allJobs.length}</span>
        </div>
      </div>
      <div class="events">
        ${jobs.length === 0
          ? html`<div class="hint">当前项目暂无已接管的 Cron job（保存配置后会自动同步）。</div>`
          : jobs.map((job) => {
              const kind = String(job.kind ?? "");
              const isCleanup = kind === "cleanup";
              const isIssueAutoRun = kind === "issueAutoRun";
              const isSkillPromotion = kind === "skillPromotion";
              const isGlobalSkillPromotion = kind === "globalSkillPromotion";
              const cleanupModeRaw = String(job.cleanupMode ?? "").trim().toLowerCase();
              const cleanupMode = cleanupModeRaw === "lite" ? "lite" : "deep";
              const kindLabel = isCleanup
                ? "Cleanup"
                : (isIssueAutoRun
                  ? "Issue Auto-Run"
                  : (isSkillPromotion
                    ? "Skill Promotion"
                    : (isGlobalSkillPromotion ? "Global Skill Promotion" : kind || "Unknown")));
              const syncedAt = String(job.syncedAt ?? "").trim() || "-";
              return html`
                <div class="row">
                  <div class="process-title-row">
                    <div class="title">${kindLabel}</div>
                    <div class="scheduler-job-tags">
                      <span class="tag">kind=${kind || "-"}</span>
                      ${isCleanup
                        ? html`<span class=${`tag scheduler-mode-tag mode-${cleanupMode}`}>mode=${cleanupMode}</span>`
                        : (isIssueAutoRun
                          ? html`<span class="tag">label=${job.label || "-"}</span>`
                          : html`<span class="tag">minScore=${job.minScore ?? "-"}</span>`)}
                    </div>
                  </div>
                  <div class="mono">cron=${job.cron} · timezone=${job.timezone}</div>
                  <div class="mono">onlyWhenIdle=${job.onlyWhenIdle ? "true" : "false"} · syncedAt=${syncedAt}</div>
                  ${isCleanup
                    ? html`<div class="mono">task=${job.task || "-"}</div>`
                    : (isIssueAutoRun
                      ? html`<div class="mono">maxRunsPerTick=${job.maxRunsPerTick ?? 0}</div>`
                      : html`
                          <div class="mono">
                            maxPromotionsPerTick=${job.maxPromotionsPerTick ?? 0}
                            · minOccurrences=${job.minCandidateOccurrences ?? 0}
                            · lookbackDays=${job.lookbackDays ?? 0}
                            ${isGlobalSkillPromotion ? `· requireProjectSkill=${job.requireProjectSkill ? "true" : "false"}` : ""}
                          </div>
                        `)}
                </div>
              `;
            })}
      </div>
    `;
  }

  private renderSchedulerTimezoneDatalist(listId: string) {
    const options = [
      "Asia/Shanghai",
      "UTC",
      "Asia/Singapore",
      "Asia/Tokyo",
      "America/Los_Angeles",
      "America/New_York",
      "Europe/London",
    ];
    return html`
      <datalist id=${listId}>
        ${options.map((item) => html`<option value=${item}></option>`)}
      </datalist>
    `;
  }

  private normalizeSchedulerTimezone(value: unknown): string {
    const text = String(value ?? "").trim();
    return text || DEFAULT_SCHEDULER_TIMEZONE;
  }

  private renderProjectSchedulerPage() {
    if (!this.selectedProjectId) {
      return html`
        <div class="panel">
          <div class="panel-header"><span>调度策略</span></div>
          <div class="panel-body">
            <div class="hint">请先选择项目。</div>
          </div>
        </div>
      `;
    }
    const showLoading = this.projectDataLoading && !this.schedulerConfig;
    const cleanupRuntimeJob = this.getSelectedProjectSchedulerJobs("cleanup")[0] ?? null;
    const issueRuntimeJob = this.getSelectedProjectSchedulerJobs("issueAutoRun")[0] ?? null;
    const skillPromotionRuntimeJob = this.getSelectedProjectSchedulerJobs("skillPromotion")[0] ?? null;
    const globalSkillPromotionRuntimeJob = this.getSelectedProjectSchedulerJobs("globalSkillPromotion")[0] ?? null;
    const skillPromotionConfig = this.schedulerConfig?.skillPromotion ?? {
      enabled: true,
      cron: "15 */6 * * *",
      onlyWhenIdle: true,
      maxPromotionsPerTick: 1,
      minCandidateOccurrences: 2,
      lookbackDays: 14,
      minScore: 0.6,
      draft: true,
      roles: [] as string[],
    };
    const globalSkillPromotionConfig = this.schedulerConfig?.globalSkillPromotion ?? {
      enabled: true,
      cron: "45 */12 * * *",
      onlyWhenIdle: true,
      maxPromotionsPerTick: 1,
      minCandidateOccurrences: 3,
      lookbackDays: 30,
      minScore: 0.75,
      requireProjectSkill: true,
      draft: true,
    };
    const cleanupRuntimeMode = (() => {
      const raw = String(cleanupRuntimeJob?.cleanupMode ?? this.schedulerConfig?.cleanup.mode ?? "deep")
        .trim()
        .toLowerCase();
      return raw === "lite" ? "lite" : "deep";
    })();

    return html`
      <div class="panel">
        <div class="panel-header"><span>调度策略（Cron）</span></div>
        <div class="panel-body page-loading-shell">
          <div class=${`page-loading-content ${showLoading ? "dim" : "ready"}`}>
            ${this.schedulerConfig
              ? html`
                <form class="row" @submit=${this.onSaveSchedulerBase}>
                  <div class="process-title-row">
                    <div class="title">全局调度配置</div>
                    <div class="scheduler-job-tags">
                      <span class="tag">scope=project</span>
                      <span class="tag">${this.schedulerConfig.enabled ? "enabled" : "disabled"}</span>
                      <span class="tag">managed=${this.engine?.scheduler?.managedProjects ?? 0}</span>
                    </div>
                  </div>
                  <div class="grid-2">
                    <label>
                      调度总开关
                      <select name="enabled">
                        <option value="true" ?selected=${this.schedulerConfig.enabled}>启用</option>
                        <option value="false" ?selected=${!this.schedulerConfig.enabled}>停用</option>
                      </select>
                    </label>
                    <label>
                      时区
                      <input
                        name="timezone"
                        .value=${this.schedulerConfig.timezone}
                        placeholder="Asia/Shanghai"
                        list="scheduler-timezone-options-main"
                      />
                      ${this.renderSchedulerTimezoneDatalist("scheduler-timezone-options-main")}
                      <div class="hint">可选：Asia/Shanghai（推荐）/ UTC / Asia/Tokyo / America/Los_Angeles 等，也兼容填写 UTC+8。</div>
                    </label>
                  </div>
                  <div class="button-row">
                    <button type="submit">保存全局配置</button>
                  </div>
                </form>

                <form class="row" @submit=${this.onSaveSchedulerCleanupCard}>
                  <div class="process-title-row">
                    <div class="title">Cleanup Job</div>
                    <div class="scheduler-job-tags">
                      <span class="tag">kind=cleanup</span>
                      <span class=${`tag scheduler-mode-tag mode-${cleanupRuntimeMode}`}>mode=${cleanupRuntimeMode}</span>
                      <span class="tag">${cleanupRuntimeJob ? "attached" : "not-attached"}</span>
                    </div>
                  </div>
                  <div class="mono">
                    ${cleanupRuntimeJob
                      ? `运行态：cron=${cleanupRuntimeJob.cron} · timezone=${cleanupRuntimeJob.timezone} · syncedAt=${cleanupRuntimeJob.syncedAt}`
                      : "运行态：当前未接管该 job（可能停用或等待 scheduler 下次同步）"}
                  </div>
                  <div class="grid-2">
                    <label>
                      Cleanup 开关
                      <select name="cleanupEnabled">
                        <option value="true" ?selected=${this.schedulerConfig.cleanup.enabled}>启用</option>
                        <option value="false" ?selected=${!this.schedulerConfig.cleanup.enabled}>停用</option>
                      </select>
                    </label>
                    <label>
                      Cleanup 模式
                      <select name="cleanupMode">
                        <option value="deep" ?selected=${this.schedulerConfig.cleanup.mode === "deep"}>deep（单节点深度清理）</option>
                        <option value="lite" ?selected=${this.schedulerConfig.cleanup.mode === "lite"}>lite（完整流水线）</option>
                      </select>
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>
                      空闲时执行
                      <select name="cleanupOnlyWhenIdle">
                        <option value="true" ?selected=${this.schedulerConfig.cleanup.onlyWhenIdle}>是</option>
                        <option value="false" ?selected=${!this.schedulerConfig.cleanup.onlyWhenIdle}>否</option>
                      </select>
                    </label>
                    <div class="hint">
                      标准流水线的 cleanup 步骤固定为 lite；定时 cleanup 可切换为 deep（单节点专用）。
                    </div>
                  </div>
                  <div class="grid-2">
                    <label>
                      Cron
                      <input name="cleanupCron" .value=${this.schedulerConfig.cleanup.cron} />
                    </label>
                    <label>
                      任务文案
                      <input name="cleanupTask" .value=${this.schedulerConfig.cleanup.task} />
                    </label>
                  </div>
                  <div class="button-row">
                    <button type="submit">保存 Cleanup Job</button>
                  </div>
                </form>

                <form class="row" @submit=${this.onSaveSchedulerIssueCard}>
                  <div class="process-title-row">
                    <div class="title">Issue Auto-Run Job</div>
                    <div class="scheduler-job-tags">
                      <span class="tag">kind=issueAutoRun</span>
                      <span class="tag">label=${this.schedulerConfig.issueAutoRun.label || "-"}</span>
                      <span class="tag">${issueRuntimeJob ? "attached" : "not-attached"}</span>
                    </div>
                  </div>
                  <div class="mono">
                    ${issueRuntimeJob
                      ? `运行态：cron=${issueRuntimeJob.cron} · timezone=${issueRuntimeJob.timezone} · syncedAt=${issueRuntimeJob.syncedAt}`
                      : "运行态：当前未接管该 job（可能停用或等待 scheduler 下次同步）"}
                  </div>
                  <div class="grid-2">
                    <label>
                      Auto-Run 开关
                      <select name="issueEnabled">
                        <option value="true" ?selected=${this.schedulerConfig.issueAutoRun.enabled}>启用</option>
                        <option value="false" ?selected=${!this.schedulerConfig.issueAutoRun.enabled}>停用</option>
                      </select>
                    </label>
                    <label>
                      标签过滤
                      <input
                        name="issueLabel"
                        .value=${this.schedulerConfig.issueAutoRun.label}
                        placeholder="forgeops:ready 或 *"
                      />
                      <div class="hint">填写 * 表示处理全部 open issue。</div>
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>
                      Auto-Run Cron
                      <input name="issueCron" .value=${this.schedulerConfig.issueAutoRun.cron} />
                    </label>
                    <label>
                      单次最多创建 Run
                      <input
                        name="issueMaxRunsPerTick"
                        type="number"
                        min="1"
                        step="1"
                        .value=${String(this.schedulerConfig.issueAutoRun.maxRunsPerTick)}
                      />
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>
                      Auto-Run 仅空闲执行
                      <select name="issueOnlyWhenIdle">
                        <option value="true" ?selected=${this.schedulerConfig.issueAutoRun.onlyWhenIdle}>是</option>
                        <option value="false" ?selected=${!this.schedulerConfig.issueAutoRun.onlyWhenIdle}>否</option>
                      </select>
                    </label>
                  </div>
                  <div class="button-row">
                    <button type="submit">保存 Issue Auto-Run Job</button>
                  </div>
                </form>

                <form class="row" @submit=${this.onSaveSchedulerSkillPromotionCard}>
                  <div class="process-title-row">
                    <div class="title">Skill Promotion Job</div>
                    <div class="scheduler-job-tags">
                      <span class="tag">kind=skillPromotion</span>
                      <span class="tag">minScore=${skillPromotionConfig.minScore}</span>
                      <span class="tag">${skillPromotionRuntimeJob ? "attached" : "not-attached"}</span>
                    </div>
                  </div>
                  <div class="mono">
                    ${skillPromotionRuntimeJob
                      ? `运行态：cron=${skillPromotionRuntimeJob.cron} · timezone=${skillPromotionRuntimeJob.timezone} · syncedAt=${skillPromotionRuntimeJob.syncedAt}`
                      : "运行态：当前未接管该 job（可能停用或等待 scheduler 下次同步）"}
                  </div>
                  <div class="grid-2">
                    <label>
                      自动晋升开关
                      <select name="skillEnabled">
                        <option value="true" ?selected=${skillPromotionConfig.enabled}>启用</option>
                        <option value="false" ?selected=${!skillPromotionConfig.enabled}>停用</option>
                      </select>
                    </label>
                    <label>
                      Draft PR
                      <select name="skillDraft">
                        <option value="true" ?selected=${skillPromotionConfig.draft}>是</option>
                        <option value="false" ?selected=${!skillPromotionConfig.draft}>否</option>
                      </select>
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>
                      Cron
                      <input name="skillCron" .value=${skillPromotionConfig.cron} />
                    </label>
                    <label>
                      仅空闲执行
                      <select name="skillOnlyWhenIdle">
                        <option value="true" ?selected=${skillPromotionConfig.onlyWhenIdle}>是</option>
                        <option value="false" ?selected=${!skillPromotionConfig.onlyWhenIdle}>否</option>
                      </select>
                    </label>
                  </div>
                  <div class="grid-3">
                    <label>
                      maxPromotionsPerTick
                      <input
                        name="skillMaxPromotionsPerTick"
                        type="number"
                        min="1"
                        step="1"
                        .value=${String(skillPromotionConfig.maxPromotionsPerTick)}
                      />
                    </label>
                    <label>
                      minCandidateOccurrences
                      <input
                        name="skillMinOccurrences"
                        type="number"
                        min="1"
                        step="1"
                        .value=${String(skillPromotionConfig.minCandidateOccurrences)}
                      />
                    </label>
                    <label>
                      lookbackDays
                      <input
                        name="skillLookbackDays"
                        type="number"
                        min="1"
                        step="1"
                        .value=${String(skillPromotionConfig.lookbackDays)}
                      />
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>
                      minScore（0-1）
                      <input
                        name="skillMinScore"
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        .value=${String(skillPromotionConfig.minScore)}
                      />
                    </label>
                    <label>
                      自动挂载角色（逗号分隔，可空）
                      <input
                        name="skillRoles"
                        .value=${Array.isArray(skillPromotionConfig.roles) ? skillPromotionConfig.roles.join(",") : ""}
                        placeholder="developer,tester"
                      />
                    </label>
                  </div>
                  <div class="button-row">
                    <button type="submit">保存 Skill Promotion Job</button>
                  </div>
                </form>

                <form class="row" @submit=${this.onSaveSchedulerGlobalSkillPromotionCard}>
                  <div class="process-title-row">
                    <div class="title">Global Skill Promotion Job</div>
                    <div class="scheduler-job-tags">
                      <span class="tag">kind=globalSkillPromotion</span>
                      <span class="tag">minScore=${globalSkillPromotionConfig.minScore}</span>
                      <span class="tag">${globalSkillPromotionRuntimeJob ? "attached" : "not-attached"}</span>
                    </div>
                  </div>
                  <div class="mono">
                    ${globalSkillPromotionRuntimeJob
                      ? `运行态：cron=${globalSkillPromotionRuntimeJob.cron} · timezone=${globalSkillPromotionRuntimeJob.timezone} · syncedAt=${globalSkillPromotionRuntimeJob.syncedAt}`
                      : "运行态：当前未接管该 job（可能停用或等待 scheduler 下次同步）"}
                  </div>
                  <div class="grid-2">
                    <label>
                      自动晋升开关
                      <select name="globalSkillEnabled">
                        <option value="true" ?selected=${globalSkillPromotionConfig.enabled}>启用</option>
                        <option value="false" ?selected=${!globalSkillPromotionConfig.enabled}>停用</option>
                      </select>
                    </label>
                    <label>
                      Draft PR
                      <select name="globalSkillDraft">
                        <option value="true" ?selected=${globalSkillPromotionConfig.draft}>是</option>
                        <option value="false" ?selected=${!globalSkillPromotionConfig.draft}>否</option>
                      </select>
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>
                      Cron
                      <input name="globalSkillCron" .value=${globalSkillPromotionConfig.cron} />
                    </label>
                    <label>
                      仅空闲执行
                      <select name="globalSkillOnlyWhenIdle">
                        <option value="true" ?selected=${globalSkillPromotionConfig.onlyWhenIdle}>是</option>
                        <option value="false" ?selected=${!globalSkillPromotionConfig.onlyWhenIdle}>否</option>
                      </select>
                    </label>
                  </div>
                  <div class="grid-3">
                    <label>
                      maxPromotionsPerTick
                      <input
                        name="globalSkillMaxPromotionsPerTick"
                        type="number"
                        min="1"
                        step="1"
                        .value=${String(globalSkillPromotionConfig.maxPromotionsPerTick)}
                      />
                    </label>
                    <label>
                      minCandidateOccurrences
                      <input
                        name="globalSkillMinOccurrences"
                        type="number"
                        min="1"
                        step="1"
                        .value=${String(globalSkillPromotionConfig.minCandidateOccurrences)}
                      />
                    </label>
                    <label>
                      lookbackDays
                      <input
                        name="globalSkillLookbackDays"
                        type="number"
                        min="1"
                        step="1"
                        .value=${String(globalSkillPromotionConfig.lookbackDays)}
                      />
                    </label>
                  </div>
                  <div class="grid-2">
                    <label>
                      minScore（0-1）
                      <input
                        name="globalSkillMinScore"
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        .value=${String(globalSkillPromotionConfig.minScore)}
                      />
                    </label>
                    <label>
                      需项目技能已存在
                      <select name="globalSkillRequireProjectSkill">
                        <option value="true" ?selected=${globalSkillPromotionConfig.requireProjectSkill}>是</option>
                        <option value="false" ?selected=${!globalSkillPromotionConfig.requireProjectSkill}>否</option>
                      </select>
                    </label>
                  </div>
                  <div class="button-row">
                    <button type="submit">保存 Global Skill Promotion Job</button>
                  </div>
                </form>
              `
              : html`<div class="hint">当前项目未加载调度配置。</div>`}
          </div>
          ${this.renderProjectLoadingOverlay(
            showLoading,
            "正在加载该项目的调度配置…",
            "scheduler",
          )}
        </div>
      </div>
    `;
  }

  private renderGlobalTokenUsageModal() {
    if (!this.showGlobalTokenUsageModal) return null;
    return html`
      <div class="modal-backdrop" @click=${this.onCloseGlobalTokenUsageModal}>
        <div class="modal token-usage-modal" @click=${(ev: Event) => ev.stopPropagation()}>
          <div class="modal-header">
            <span>全局 Token 消耗</span>
            <button type="button" @click=${this.onCloseGlobalTokenUsageModal}>关闭</button>
          </div>
          <div class="modal-body-scroll">
            ${this.renderGlobalTokenUsageCard()}
          </div>
        </div>
      </div>
    `;
  }

  private renderPipelineFullscreenModal() {
    if (!this.pipelineFullscreenSource) return null;
    const runTitle = this.runDetail
      ? `Run 流水线实况（DAG） · ${this.runDetail.steps.length} steps · ${this.pipelineSelectedStepKey ? `filter=${this.pipelineSelectedStepKey}` : "all"}`
      : "Run 流水线实况（DAG）";
    const content = this.pipelineFullscreenSource === "run"
      ? (this.runDetail
        ? this.renderRunPipelineLivePanel(this.runDetail, { fullscreen: true })
        : html`<div class="hint">当前没有可展示的 Run 数据。请先在「运行实况」页选择一个 Run。</div>`)
      : this.renderPipelineLivePanel({ fullscreen: true });
    return html`
      <div class="modal-backdrop" @click=${this.onClosePipelineFullscreen}>
        <div class="modal pipeline-fullscreen-modal" @click=${(ev: Event) => ev.stopPropagation()}>
          <div class="modal-header">
            <span>${this.pipelineFullscreenSource === "run" ? runTitle : "项目工作流拓扑（DAG）"}</span>
            <button type="button" @click=${this.onClosePipelineFullscreen}>关闭</button>
          </div>
          <div class="modal-body-scroll pipeline-fullscreen-body">
            ${content}
          </div>
        </div>
      </div>
    `;
  }

  private renderAgentTeam3DModal() {
    if (!this.showAgentTeam3DModal) return null;
    const { rows } = this.getProjectAgentTeamRows();
    const nodes = this.toAgentTeam3DNodes(rows);
    return html`
      <div class="modal-backdrop" @click=${this.onCloseAgentTeam3D}>
        <div class="modal agent-team-3d-modal" @click=${(ev: Event) => ev.stopPropagation()}>
          <div class="modal-header">
            <span>Agent Team 3D（实验）</span>
            <button type="button" @click=${this.onCloseAgentTeam3D}>关闭</button>
          </div>
          <div class="modal-body-scroll agent-team-3d-body">
            ${!this.agentTeam3DReady
              ? html`<div class="hint">正在加载 3D 实验模块...</div>`
              : nodes.length === 0
              ? html`<div class="hint">暂无可展示的 Agent Team 数据，请先配置 workflow 步骤。</div>`
              : html`<agent-team-3d .nodes=${nodes}></agent-team-3d>`}
          </div>
        </div>
      </div>
    `;
  }

  private renderCreateProjectModal() {
    if (!this.showCreateProjectModal) return null;
    const progressGroups = this.buildCreateProjectProgressGroups(this.createProjectProgress);
    const completion = this.summarizeCreateProjectGroupCompletion(this.createProjectProgress);
    const latestProgress = this.createProjectProgress.length > 0
      ? this.createProjectProgress[this.createProjectProgress.length - 1]
      : null;
    const latestGroup = latestProgress
      ? this.formatCreateProjectStageGroup(this.resolveCreateProjectStageGroup(latestProgress.stage))
      : "-";

    return html`
      <div class="modal-backdrop" @click=${this.onCloseCreateProjectModal}>
        <div class="modal" @click=${(ev: Event) => ev.stopPropagation()}>
          <div class="modal-header">
            <span>新建项目</span>
            <button type="button" @click=${this.onCloseCreateProjectModal} ?disabled=${this.createProjectInFlight}>关闭</button>
          </div>
          <div class="panel-body">
            <form @submit=${this.onCreateProject}>
              <div class="grid-2">
                <label>
                  项目名称
                  <input name="name" placeholder="my-product" required />
                </label>
                <label>
                  产品类型
                  <select name="productType">
                    <option value="web">WEB应用</option>
                    <option value="miniapp">微信小程序</option>
                    <option value="ios">IOS APP</option>
                    <option value="microservice">微服务后端</option>
                    <option value="android">Android APP</option>
                    <option value="serverless">Serverless 后端</option>
                    <option value="other">其他类型</option>
                  </select>
                </label>
              </div>
              <label>
                项目根路径
                <input
                  name="rootPath"
                  placeholder="/abs/path/to/project"
                  .value=${this.createProjectRootPath}
                  @input=${(ev: InputEvent) => {
                    const target = ev.currentTarget as HTMLInputElement;
                    this.createProjectRootPath = target.value;
                  }}
                  required
                />
                <div class="button-row">
                  <button type="button" @click=${this.onPickProjectRootPath} ?disabled=${this.createProjectInFlight}>
                    选择目录（从 ~/ 开始）
                  </button>
                </div>
                <div class="hint">推荐点击按钮选择目录；若系统不支持原生目录选择器，可继续手动填写绝对路径。</div>
              </label>
              <label>
                问题定义
                <textarea name="problemStatement" placeholder="要解决什么问题、给谁使用、核心价值是什么？"></textarea>
              </label>
              <div class="hint">技术栈、CI、目录策略由 Architect Agent 在项目内规划并落地。</div>
              <div class="row">
                <div class="title">创建阶段进度流</div>
                <div class="create-progress-summary">
                  <div class="create-progress-group-title">
                    <span>当前分组：${latestGroup}</span>
                    <span class="tag">events=${this.createProjectProgress.length}</span>
                  </div>
                  <div class="create-progress-meter-meta">
                    <span>阶段完成：${completion.completed}/${completion.total}</span>
                    <span>${completion.percent}%</span>
                  </div>
                  <div
                    class="create-progress-meter"
                    role="progressbar"
                    aria-label="创建阶段完成度"
                    aria-valuemin="0"
                    aria-valuemax=${completion.total}
                    aria-valuenow=${completion.completed}
                  >
                    <span style=${`width:${completion.percent}%;`}></span>
                  </div>
                  <div class="mono">当前阶段：${latestProgress ? this.formatCreateProjectStage(latestProgress.stage) : "-"}</div>
                </div>
                <div class="events create-progress-events">
                  ${this.createProjectProgress.length === 0
                    ? html`<div class="hint">${this.createProjectInFlight ? "正在等待服务端阶段事件..." : "提交后将显示 preflight / scaffold / git 实时进度。创建成功后会保留本次进度，关闭弹窗后清空。"}</div>`
                    : progressGroups.map((group) => html`
                        <div class="row">
                          <div class="create-progress-group-title">
                            <span class="title">${group.label}</span>
                            <span class="tag">${group.rows.length}</span>
                          </div>
                          <div class="events">
                            ${group.rows.map((item) => html`
                                <div class="row">
                                  <div class="title">${this.formatCreateProjectStage(item.stage)}</div>
                                  <div class="mono">stage=${item.stage || "-"}</div>
                                  <div class="mono">${item.detail || "-"}</div>
                                  <div class="mono">${item.at}</div>
                                  <status-dot status=${this.createProjectStatusDot(item.status)}></status-dot>
                                </div>
                              `)}
                          </div>
                        </div>
                      `)}
                </div>
              </div>
              <div class="button-row">
                <button class="primary" type="submit" ?disabled=${this.createProjectInFlight}>
                  ${this.createProjectInFlight ? "创建中..." : "创建项目"}
                </button>
                <button type="button" @click=${this.onCloseCreateProjectModal} ?disabled=${this.createProjectInFlight}>取消</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    this.style.setProperty("--sidebar-width", `${this.sidebarWidth}px`);
    const page = this.currentPage;
    const automationReady = Boolean(this.systemConfig?.runtime?.ready)
      && Boolean(this.systemConfig?.git?.configured)
      && Boolean(this.systemConfig?.github?.validated);

    return html`
      <div class="shell">
        ${this.renderSidebar()}
        <div class="splitter" @pointerdown=${this.onSplitterPointerDown}></div>

        <main class="main">
          <header class="topbar">
            <div class="topbar-center">
              <div class="brand">
                <span class="brand-mark"></span>
                <div class="brand-text">
                  <span class="brand-title">ForgeOps 控制台</span>
                  <span class="brand-sub">Runtime-neutral pipeline orchestration</span>
                </div>
              </div>
            </div>

            <div class="topbar-right">
              <button
                class="top-action-btn"
                type="button"
                @click=${this.onOpenGlobalTokenUsageModal}
                title="查看全局 Token 消耗趋势"
              >
                全局 Token
              </button>
              <div class="pill status">
                <status-dot status=${automationReady ? "done" : "failed"}></status-dot>
                <span>自动化: <strong>${automationReady ? "就绪" : "阻塞"}</strong></span>
              </div>
              <div class="pill status">
                <status-dot status=${this.engine?.running ? "running" : "failed"}></status-dot>
                <span>引擎: <strong>${this.engine?.running ? "运行中" : "已停止"}</strong></span>
              </div>
              <button
                class="top-action-btn primary icon-only"
                type="button"
                @click=${this.onOpenCreateProjectModal}
                aria-label="新建项目"
                title="新建项目"
              >
                <span class="action-icon action-icon-plus" aria-hidden="true"></span>
              </button>
              <button
                class="top-action-btn icon-only"
                type="button"
                @click=${() => this.switchPage("system")}
                aria-label="系统配置"
                title="系统配置"
              >
                <span class="action-icon action-icon-system" aria-hidden="true"></span>
              </button>
            </div>
          </header>

          <section class="workspace">
            ${page === "project_overview" ? this.renderOverviewPage() : null}
            ${page === "project_issues" ? this.renderProjectIssuesPage() : null}
            ${page === "project_runs" ? this.renderRunsPage() : null}
            ${page === "project_workflow" ? this.renderProjectWorkflowPage() : null}
            ${page === "project_scheduler" ? this.renderProjectSchedulerPage() : null}
            ${page === "system" ? html`<div class="panel">${this.renderSystemConfigPanel()}</div>` : null}
          </section>
        </main>
        ${this.renderMessageToast()}
        ${this.renderGlobalTokenUsageModal()}
        ${this.renderAgentTeam3DModal()}
        ${this.renderCreateProjectModal()}
        ${this.renderPipelineFullscreenModal()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "forgeops-app": ForgeOpsApp;
  }
}
