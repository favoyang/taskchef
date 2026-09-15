import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  prepareDispatch,
  linkTask,
  recordTask,
  reportTaskState,
  reportTaskResult,
  dashboardAutostartEnabled,
  includeProject,
  readConfig,
  reconcileProjects,
  updateProjectHint,
} from "./workspace.js";
import { parseTaskChefMarker } from "./delegation.js";
import { createDashboardManager } from "./dashboard-manager.js";
import { resolveWorkspacePath } from "./workspace-path.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";
import { createUsageTracker } from "./usage-tracker.js";

const projectSchema = z.object({
  name: z.string(),
  path: z.string(),
  isGitRepository: z.boolean(),
  githubRepos: z.array(z.string()),
  description: z.string().optional(),
});

const turnProvenanceSchema = z.union([
  z.object({ kind: z.enum(["legacy", "mcp"]) }),
  z.object({
    kind: z.literal("dashboard_manual"),
    actionId: z.string(),
    fromStatus: z.enum(["working", "needs_input", "completed", "failed"]),
    toStatus: z.enum(["completed", "failed"]),
    expectedTurnRef: z.string().nullable(),
    expectedThreadId: z.string().nullable(),
    expectedUpdatedAt: z.string(),
  }),
]);

const taskSchema = z.object({
  schemaVersion: z.union([
    z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9),
    z.literal(10),
  ]),
  id: z.string(),
  project: projectSchema,
  title: z.string(),
  instruction: z.string(),
  threadId: z.string().nullable(),
  createdAt: z.string(),
  status: z.enum(["working", "needs_input", "completed", "failed"]),
  summary: z.string().nullable(),
  turnRef: z.string().nullable(),
  turnId: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.enum(["dispatcher", "mcp", "dashboard"]),
  turns: z.array(z.object({
    turnRef: z.string().nullable(),
    turnId: z.string().nullable(),
    requestSummary: z.string().nullable(),
    startedAt: z.string(),
    result: z.object({
      status: z.enum(["needs_input", "completed", "failed", "interrupted"]),
      summary: z.string(),
      updatedAt: z.string(),
    }).nullable(),
    provenance: turnProvenanceSchema.nullable(),
  })),
  latestTurn: z.object({
    turnRef: z.string().nullable(),
    turnId: z.string().nullable(),
    requestSummary: z.string().nullable(),
    startedAt: z.string(),
    result: z.object({
      status: z.enum(["needs_input", "completed", "failed", "interrupted"]),
      summary: z.string(),
      updatedAt: z.string(),
    }).nullable(),
    provenance: turnProvenanceSchema.nullable(),
  }).nullable(),
  results: z.array(z.object({
    status: z.enum(["needs_input", "completed", "failed"]),
    summary: z.string(),
    turnRef: z.string().nullable(),
    turnId: z.string().nullable(),
    updatedAt: z.string(),
    provenance: turnProvenanceSchema.optional(),
  })),
  lastResult: z.object({
    status: z.enum(["needs_input", "completed", "failed"]),
    summary: z.string(),
    turnRef: z.string().nullable(),
    turnId: z.string().nullable(),
    updatedAt: z.string(),
    provenance: turnProvenanceSchema.optional(),
  }).nullable(),
});

const preparationSchema = z.object({
  schemaVersion: z.literal(1),
  workspace: z.string(),
  taskId: z.string(),
  preparedAt: z.string(),
  marker: z.string(),
  modelRoles: z.record(z.string(), z.unknown()).optional(),
  projectCount: z.number(),
  projects: z.array(projectSchema),
  routingHints: z.array(z.object({
    path: z.string(),
    aliases: z.array(z.string()),
    githubRepos: z.array(z.string()),
    responsibilities: z.array(z.string()),
  })).optional(),
});

const nativeProjectSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  projects: z.array(z.object({
    projectId: z.string().min(1),
    projectKind: z.string().min(1),
    label: z.string().min(1),
    path: z.string().nullable().optional(),
    hostId: z.string().nullable().optional(),
    hostDisplayName: z.string().nullable().optional(),
    isGitRepository: z.boolean().nullable().optional(),
  }).passthrough()),
}).passthrough();

const routingProvenanceSchema = z.object({
  kind: z.enum(["explicit_user", "verified_repository", "accepted_terminal_report"]),
  evidence: z.string().min(1).max(240),
  taskId: z.string().min(1).nullable(),
  threadId: z.string().min(1).nullable(),
  turnRef: z.string().min(1).max(256).nullable(),
  repositoryPath: z.string().min(1).nullable(),
});

const reconciliationSchema = z.object({
  schemaVersion: z.literal(1),
  changed: z.boolean(),
  projectCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  boundCount: z.number().int().nonnegative(),
  available: z.array(z.object({
    hostId: z.string(),
    projectId: z.string(),
    path: z.string(),
  })),
  diagnostics: z.array(z.object({
    projectId: z.string(),
    code: z.string(),
    message: z.string(),
  })),
});

const hintUpdateSchema = z.object({
  changed: z.boolean(),
  suppressed: z.boolean(),
  project: z.string(),
  kind: z.enum(["alias", "githubRepo", "responsibility"]),
  value: z.string(),
});

const dashboardSchema = z.object({
  action: z.enum(["started", "reused"]),
  launcher: z.enum(["session", "standalone", "mcp"]),
  url: z.string().url(),
  workspace: z.string(),
  taskchefVersion: z.string(),
  serverVersion: z.string(),
});

function toolResult(key, value, message) {
  return {
    structuredContent: { [key]: value },
    content: [{ type: "text", text: message }],
  };
}

function dashboardAutostartDiagnostic(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (typeof error?.staleTaskchefVersion === "string") {
    return `TaskChef dashboard autostart skipped: recognized older TaskChef ${error.staleTaskchefVersion} listener refused graceful shutdown; it was left running.`;
  }
  if (error?.code === "EADDRINUSE" || /port conflict|already in use/i.test(message)) {
    return "TaskChef dashboard autostart skipped: port 127.0.0.1:3210 is unavailable; the listener was left untouched.";
  }
  if (/configuration|workspace|task log/i.test(message)) {
    return "TaskChef dashboard autostart skipped: the canonical workspace is not ready.";
  }
  return "TaskChef dashboard autostart skipped: the dashboard could not be started.";
}

export function createDashboardAutostart({
  workspace,
  dashboardManager,
  readConfiguration = readConfig,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  let startPromise = null;
  return async () => {
    startPromise ??= (async () => {
      try {
        const config = await readConfiguration(workspace, { checkPaths: false });
        if (!dashboardAutostartEnabled(config)) return { action: "disabled" };
        return await dashboardManager.ensure();
      } catch (error) {
        try { log(dashboardAutostartDiagnostic(error)); } catch {}
        return { action: "failed" };
      }
    })();
    return startPromise;
  };
}

export function createTaskChefMcpServer({
  workspace = resolveWorkspacePath().workspace,
  prepare = prepareDispatch,
  record = recordTask,
  reportResult = reportTaskResult,
  reportState = reportTaskState,
  link = linkTask,
  reconcile = reconcileProjects,
  updateHint = updateProjectHint,
  include = includeProject,
  dashboardManager = createDashboardManager({ workspace }),
  readConfiguration = readConfig,
  logDashboardDiagnostic,
  usageTracker = createUsageTracker({ workspace }),
} = {}) {
  const reportingDestination = `Store lifecycle state and summaries in the configured local TaskChef dashboard log ${JSON.stringify(path.resolve(workspace, "tasks.jsonl"))}. GitHub URLs are stored as references, not published to GitHub. Also triggers local Codex usage tracking in ${JSON.stringify(path.resolve(workspace, ".taskchef-usage.json"))}. Exclude secrets. `;
  const server = new McpServer(
    { name: "taskchef", version: TASKCHEF_VERSION },
    {
      instructions:
        "Prepare with prepare_dispatch, call record_task before creating the Codex task, then create it natively and return immediately. Follow the active TaskChef skill for role-specific sequencing of the identity and state tools.",
    },
  );

  const originalClose = server.close.bind(server);
  let closePromise = null;
  let closing = false;
  server.close = async () => {
    closing = true;
    closePromise ??= (async () => {
      const results = await Promise.allSettled([
        dashboardManager.close(),
        originalClose(),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return closePromise;
  };
  server.server.onclose = () => {
    void dashboardManager.close().catch(() => {});
  };

  server.registerTool(
    "ensure_dashboard",
    {
      title: "Ensure TaskChef dashboard",
      description:
        "Best-effort ensure the canonical TaskChef dashboard is available on 127.0.0.1:3210. Starts or reuses the exact recognized TaskChef dashboard for this Codex session and canonical workspace; recognized older same-workspace listeners are gracefully restarted to the installed version, while newer and unknown listeners remain running.",
      inputSchema: {},
      outputSchema: { dashboard: dashboardSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const dashboard = await dashboardManager.ensure();
      return toolResult(
        "dashboard",
        dashboard,
        `${dashboard.action === "started" ? "Started" : "Reused"} TaskChef dashboard ${dashboard.url}`,
      );
    },
  );

  server.registerTool(
    "reconcile_projects",
    {
      title: "Reconcile TaskChef projects",
      description:
        "Atomically reconcile an agent-supplied native Codex list_projects schema-2 snapshot into the local TaskChef project index. Only eligible local projects on hostId local are considered; existing curated metadata and missing entries are preserved.",
      inputSchema: { snapshot: nativeProjectSnapshotSchema },
      outputSchema: { reconciliation: reconciliationSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ snapshot }) => {
      const result = await reconcile(workspace, snapshot);
      const reconciliation = {
        schemaVersion: 1,
        changed: result.changed,
        projectCount: result.projectCount,
        addedCount: result.added.length,
        boundCount: result.bound.length,
        available: result.available,
        diagnostics: result.diagnostics,
      };
      return toolResult(
        "reconciliation",
        reconciliation,
        `Reconciled ${reconciliation.projectCount} TaskChef project(s).`,
      );
    },
  );

  server.registerTool(
    "include_project",
    {
      title: "Include a previously excluded TaskChef project",
      description:
        "Remove an explicit reconciliation exclusion by exact local native projectId or canonical path. Reconciliation must run afterward before the project becomes a routing target again.",
      inputSchema: {
        projectId: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
      },
      outputSchema: {
        result: z.object({ changed: z.boolean(), remainingExclusionCount: z.number().int().nonnegative() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectId, path: projectPath }) => {
      if (Boolean(projectId) === Boolean(projectPath)) {
        throw new Error("include_project requires exactly one projectId or path");
      }
      const updated = await include(workspace, projectId
        ? { projectId, hostId: "local" }
        : { path: projectPath });
      const result = {
        changed: updated.changed,
        remainingExclusionCount: updated.exclusions.length,
      };
      return toolResult("result", result, result.changed
        ? "Removed the TaskChef project exclusion."
        : "No matching TaskChef project exclusion exists.");
    },
  );

  server.registerTool(
    "prepare_dispatch",
    {
      title: "Prepare TaskChef dispatch",
      description:
        "Generate the task UUID, exact correlation marker, timestamp, and configured routing targets from the canonical TaskChef workspace.",
      inputSchema: {},
      outputSchema: { preparation: preparationSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const preparation = await prepare(workspace);
      return toolResult("preparation", preparation, `Prepared TaskChef task ${preparation.taskId}.`);
    },
  );

  server.registerTool(
    "update_project_hint",
    {
      title: "Remember or forget TaskChef project routing",
      description:
        "Remember or forget one bounded routing fact for an exact configured project. Aliases and forgetting require explicit user evidence; repository ownership requires verified origin evidence; report-derived responsibilities require the accepted current terminal task/turn identity.",
      inputSchema: {
        action: z.enum(["remember", "correct", "forget"]),
        project: z.string().min(1),
        kind: z.enum(["alias", "githubRepo", "responsibility"]),
        value: z.string().min(1).max(256),
        provenance: routingProvenanceSchema,
      },
      outputSchema: { result: hintUpdateSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const updated = await updateHint(workspace, input);
      const result = {
        changed: updated.changed,
        suppressed: updated.suppressed,
        project: updated.project,
        kind: updated.kind,
        value: updated.value,
      };
      return toolResult(
        "result",
        result,
        `${result.changed ? "Updated" : "Kept"} TaskChef project routing.`,
      );
    },
  );

  server.registerTool(
    "record_task",
    {
      title: "Record TaskChef task",
      description:
        "Atomically append one prepared TaskChef task before creating its Codex executor. Pass the exact marked instruction and null threadId; only the executor may self-link it.",
      inputSchema: {
        id: z.string().min(1),
        project: z.string().min(1),
        title: z.string().min(1),
        instruction: z.string().min(1),
        threadId: z.null(),
      },
      outputSchema: { task: taskSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (parseTaskChefMarker(input.instruction) !== input.id) {
        throw new Error("record_task instruction must contain its exact TaskChef marker in an accepted scaffold");
      }
      const task = await record(workspace, input);
      return toolResult("task", task, `Recorded TaskChef task ${task.id}.`);
    },
  );

  server.registerTool(
    "link_task",
    {
      title: "Link TaskChef executor",
      description:
        "Register this executor's asserted durable Codex thread ID. The atomic one-way transition is idempotent and rejects conflicts or thread reuse.",
      inputSchema: {
        taskId: z.string().min(1),
        threadId: z.string().min(1),
      },
      outputSchema: { task: taskSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId, threadId }) => {
      const task = await link(workspace, taskId, threadId);
      return toolResult("task", task, `Linked TaskChef task ${task.id}.`);
    },
  );

  server.registerTool(
    "report_state",
    {
      title: "Report TaskChef state",
      description:
        reportingDestination + "Report this self-linked executor turn's lifecycle state. Use one stable turnRef for working and its terminal report; pass the native Codex turn ID as both turnRef and turnId when available, otherwise pass a client-generated UUID turnRef and null turnId. Preserve known repository context and delivered links. Exact retries are idempotent; stale or mismatched turnRefs are rejected.",
      inputSchema: {
        taskId: z.string().min(1),
        threadId: z.string().min(1).nullable(),
        turnRef: z.string().min(1).max(256).nullable().optional(),
        turnId: z.string().min(1).max(256).nullable(),
        status: z.enum(["working", "needs_input", "completed", "failed"]),
        summary: z.string().min(1).max(2_000).nullable().optional(),
        requestSummary: z.string().min(1).max(1_000).nullable().optional(),
      },
      outputSchema: { task: taskSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const task = await reportState(workspace, input);
      void usageTracker.observe(task).catch(() => {});
      return toolResult("task", task, `Recorded ${task.status} state for TaskChef task ${task.id}.`);
    },
  );

  server.registerTool(
    "report_result",
    {
      title: "Report TaskChef result (deprecated)",
      description:
        reportingDestination + "Deprecated compatibility alias for semantic results. New executors must use report_state working at turn start and report_state again with needs_input, completed, or failed before ending. This alias preserves legacy callers by implicitly starting the supplied newer turn before storing its result.",
      inputSchema: {
        taskId: z.string().min(1),
        threadId: z.string().min(1).nullable(),
        turnRef: z.string().min(1).max(256).nullable().optional(),
        turnId: z.string().min(1).max(256).nullable(),
        status: z.enum(["needs_input", "completed", "failed"]),
        summary: z.string().min(1).max(2_000),
      },
      outputSchema: { task: taskSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const task = await reportResult(workspace, input);
      void usageTracker.observe(task).catch(() => {});
      return toolResult("task", task, `Recorded ${task.status} result for TaskChef task ${task.id}.`);
    },
  );

  const originalConnect = server.connect.bind(server);
  const autostartDashboard = createDashboardAutostart({
    workspace,
    dashboardManager,
    readConfiguration,
    ...(logDashboardDiagnostic ? { log: logDashboardDiagnostic } : {}),
  });
  server.connect = async (...args) => {
    await autostartDashboard();
    if (closing) throw new Error("TaskChef MCP server is shutting down");
    try {
      await originalConnect(...args);
      if (closing) {
        await originalClose();
        throw new Error("TaskChef MCP server shut down during transport startup");
      }
    } catch (error) {
      await Promise.allSettled([
        Promise.resolve().then(() => dashboardManager.close()),
        Promise.resolve().then(() => originalClose()),
      ]);
      throw error;
    }
  };

  return server;
}
