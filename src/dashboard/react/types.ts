export type TaskStatus = "working" | "needs_input" | "completed" | "failed" | null;

export interface Project {
  name: string;
  path: string;
  description?: string;
  githubRepos: string[];
}

export interface TaskResult {
  status: "needs_input" | "completed" | "failed" | "interrupted";
  summary: string;
  updatedAt: string;
  turnRef?: string | null;
  turnId?: string | null;
  provenance?: { kind: string } | null;
}

export interface TaskTurn {
  requestSummary: string | null;
  result: TaskResult | null;
  startedAt: string;
  turnRef: string | null;
  turnId: string | null;
  provenance?: { kind: string } | null;
  intent?: "investigate" | "plan_and_implement" | "implement" | "continue_plan" | null;
  acceptedScope?: string | null;
  planRef?: PlanReference | null;
  phases?: TaskPhase[];
}

export interface PlanReference {
  repository: string;
  path: string;
  revision: string;
  contentHash: string;
}

export interface ExecutionResolution {
  requestedModel: string | null;
  requestedEffort: string | null;
  source: string | null;
  status: "configured" | "missing";
  resolvedAt: string;
  model: string | null;
  effort: string | null;
  effectiveModel: string | null;
  effectiveEffort: string | null;
}

export interface TaskPhase {
  phaseId: string;
  kind: "plan" | "implement" | "review" | "verify" | "deliver";
  attempt: number;
  role: "orchestrator" | "planner" | "implementer" | "reviewer";
  resolution: ExecutionResolution;
  agentHandle: string | null;
  threadBinding: { threadId: string; provenance: "native" | "child_asserted" } | null;
  writer: boolean;
  writerGeneration: number | null;
  state: "reserved" | "running" | "awaiting_input" | "completed" | "failed" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  result: { summary: string; artifacts: string[] } | null;
  reviewPassId: string | null;
}

export interface GitHubLink {
  label: string;
  url: string;
  type?: "issue" | "pull" | "generic";
  owner?: string;
  repository?: string;
  number?: string;
}

export interface UsageNumbers {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
  estimatedCostUsd?: number | null;
  sampledAt?: string | null;
  sourceUpdatedAt?: string | null;
  models?: Record<string, unknown>;
}

export interface UsageProjection {
  generationTurnRef?: string | null;
  status: "available" | "calculating" | "pending" | "unavailable";
  task?: UsageNumbers | null;
  turns?: Record<string, Partial<UsageNumbers> & {
    status?: "available" | "calculating" | "pending" | "unavailable";
    reason?: string;
  }>;
  reason?: string;
  message?: string;
  updatedAt?: string | null;
  coverage?: {
    status: "partial";
    scope: "parent_only";
    includedMembers: number;
    missingMembers: number;
    reason: string;
  };
}

export interface ReportedWorkSummary {
  terminalTurns: number;
  validTurns: number;
  totalMilliseconds: number | null;
}

export interface Task {
  schemaVersion?: number;
  id: string;
  title: string;
  instruction: string;
  project: Project;
  createdAt: string;
  updatedAt: string;
  meaningfulUpdatedAt?: string;
  updatedBy?: string;
  status: TaskStatus;
  summary: string | null;
  threadId: string | null;
  turnRef: string | null;
  turnId: string | null;
  lastResult: TaskResult | null;
  latestTurn: TaskTurn | null;
  turns?: TaskTurn[];
  results?: TaskResult[];
  reportedWork?: ReportedWorkSummary;
  usage?: UsageProjection | null;
  relatedGitHubLinks?: GitHubLink[];
  relatedGitHubLinksTruncated?: boolean;
  relatedGitHubRepository?: string | null;
  executionMode?: "legacy" | "orchestrated";
  executionRevision?: number;
  parentResolution?: ExecutionResolution | null;
}

export interface NotificationSnapshot {
  id: string;
  taskId: string;
  title: string;
  status: TaskStatus;
  event: string;
  turnRef: string | null;
  turnId: string | null;
  timestamp: string | null;
  summary: string | null;
}

export interface DashboardSnapshot {
  healthy?: boolean;
  tasks: Task[];
  projectIndex?: {
    status: "available" | "unavailable";
    projectCount: number | null;
    missingProjects: Array<{
      path: string;
      snapshotNames: string[];
      taskCount: number;
    }>;
    truncated?: boolean;
  };
}

export interface ManualTransitionResponse {
  ok: boolean;
  code?: string;
  message?: string;
  task?: Task | null;
}
