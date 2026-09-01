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
}

export interface ManualTransitionResponse {
  ok: boolean;
  code?: string;
  message?: string;
  task?: Task | null;
}
