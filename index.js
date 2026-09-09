export {
  buildCopilotBrief,
  addProject,
  createWorkspaceBackup,
  buildTaskSummary,
  canonicalDirectory,
  canonicalGitRoot,
  doctorWorkspace,
  dashboardAutostartEnabled,
  ensureWorkspaceInstructions,
  filterTasks,
  importProjects,
  initializeWorkspace,
  linkTask,
  listProjects,
  listWorkspaceBackups,
  pruneWorkspaceBackups,
  readProjectIndex,
  readWorkspaceMaintenance,
  manuallyTransitionTask,
  migrateTaskLog,
  prepareDispatch,
  readConfig,
  listTasks,
  readTask,
  recordTask,
  reportTaskState,
  reportTaskPhase,
  reportTaskResult,
  requireSafeId,
  removeProject,
  restoreWorkspaceBackup,
  validateConfig,
  updateProject,
  verifyWorkspaceBackup,
} from "./src/workspace.js";

export {
  configHash,
  projectDiff,
  projectSetHash,
} from "./src/config-mutations.js";

export {
  canonicalGithubRepository,
  matchProjectForGithubUrl,
  normalizeGithubRepositories,
} from "./src/github.js";

export {
  EXECUTOR_OWNERSHIP_PARAGRAPH,
  EXECUTOR_LINK_PARAGRAPH,
  EXECUTOR_RESULT_PARAGRAPH,
  EXECUTOR_WORKING_PARAGRAPH,
  EXECUTOR_SKILL_INVOCATION,
  EXECUTOR_REPORTING_AUTHORIZATION,
  createAndRecordDelegation,
  isProvisionalThreadId,
  normalizeCodexThreadId,
  normalizeDurableThreadId,
  parseTaskChefMarker,
  prepareDelegation,
  taskChefMarker,
} from "./src/delegation.js";

export {
  TASKCHEF_WORKSPACE_ENV,
  defaultWorkspacePath,
  resolveWorkspacePath,
} from "./src/workspace-path.js";

export {
  discoverCodexCli,
  isCodexThreadDeepLinkId,
  openThreadInCodex,
  openWorkspaceInCodex,
} from "./src/codex-app.js";

export {
  DASHBOARD_HEALTH_MAX_BYTES,
  DASHBOARD_HEALTH_PATH,
  DashboardMonitor,
  UsageSummaryMonitor,
  createDashboardServer,
  dashboardAuthority,
  sortTasksByMeaningfulUpdate,
  taskListUsageProjection,
} from "./src/dashboard.js";

export {
  createDashboardManager,
  readDashboardIdentity,
} from "./src/dashboard-manager.js";

export { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./src/version.js";

export { createDashboardAutostart, createTaskChefMcpServer } from "./src/mcp.js";

export {
  EXECUTION_CONTRACT_VERSION,
  EXECUTION_INTENTS,
  EXECUTION_ROLES,
  PHASE_KINDS,
  PHASE_STATES,
  activeExecutionPhase,
  applyPhaseEvent,
  assertOrchestratedCompletion,
  normalizeExecutionResolution,
  normalizePlanReference,
  resolutionSnapshotFromRole,
} from "./src/execution.js";

export { resolveExecutionRole, resolveModelRoles, updateModelRole } from "./src/model-roles.js";
