import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  prepareDispatch,
  linkTask,
  recordTask,
  reportTaskState,
  reportTaskResult,
  dashboardAutostartEnabled,
  readConfig,
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
  projectCount: z.number(),
  projects: z.array(projectSchema),
});

const dashboardSchema = z.object({
  action: z.enum(["started", "reused"]),
  launcher: z.literal("session"),
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
    return `TaskChef dashboard autostart skipped: verified older TaskChef ${error.staleTaskchefVersion} listener could not complete authenticated handoff; it was left untouched.`;
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
  dashboardManager = createDashboardManager({ workspace }),
  readConfiguration = readConfig,
  logDashboardDiagnostic,
  usageTracker = createUsageTracker({ workspace }),
} = {}) {
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
        "Best-effort ensure the canonical TaskChef dashboard is available on 127.0.0.1:3210. Starts or reuses the authenticated TaskChef dashboard for this Codex session and canonical workspace; verified older TaskChef session listeners are handed off to the installed version, while standalone and unknown listeners are never terminated or replaced.",
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
        "Report this self-linked executor turn's lifecycle state. Use one stable turnRef for working and its terminal report; pass the native Codex turn ID as both turnRef and turnId when available, otherwise pass a client-generated UUID turnRef and null turnId. Preserve known repository context and delivered links. Exact retries are idempotent; stale or mismatched turnRefs are rejected.",
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
        "Deprecated compatibility alias for semantic results. New executors must use report_state working at turn start and report_state again with needs_input, completed, or failed before ending. This alias preserves legacy callers by implicitly starting the supplied newer turn before storing its result.",
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
