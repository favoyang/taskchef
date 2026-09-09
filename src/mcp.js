import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  prepareDispatch,
  linkTask,
  recordTask,
  reportTaskState,
  reportTaskPhase,
  reportTaskResult,
  dashboardAutostartEnabled,
  readConfig,
} from "./workspace.js";
import { resolveExecutionRole } from "./model-roles.js";
import { resolutionSnapshotFromRole } from "./execution.js";
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

const executionResolutionSchema = z.object({
  requestedModel: z.string().nullable(),
  requestedEffort: z.string().nullable(),
  source: z.string().nullable(),
  status: z.enum(["configured", "missing"]),
  resolvedAt: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  effectiveEffort: z.string().nullable(),
});

const planReferenceSchema = z.object({
  repository: z.string(),
  path: z.string(),
  revision: z.string(),
  contentHash: z.string(),
});

const phaseSchema = z.object({
  phaseId: z.string(),
  kind: z.enum(["plan", "implement", "review", "verify", "deliver"]),
  attempt: z.number().int(),
  role: z.enum(["orchestrator", "planner", "implementer", "reviewer"]),
  resolution: executionResolutionSchema,
  agentHandle: z.string().nullable(),
  threadBinding: z.object({
    threadId: z.string(),
    provenance: z.enum(["native", "child_asserted"]),
  }).nullable(),
  writer: z.boolean(),
  writerGeneration: z.number().int().nullable(),
  state: z.enum(["reserved", "running", "awaiting_input", "completed", "failed", "interrupted"]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  result: z.object({ summary: z.string(), artifacts: z.array(z.string()) }).nullable(),
  reviewPassId: z.string().nullable(),
  events: z.array(z.object({
    eventId: z.string(),
    operation: z.enum(["reserve", "start", "bind", "finish"]),
    payloadHash: z.string(),
    at: z.string(),
  })),
});

const taskSchema = z.object({
  schemaVersion: z.union([
    z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8), z.literal(9),
    z.literal(10),
    z.literal(11),
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
    intent: z.enum(["investigate", "plan_and_implement", "implement", "continue_plan"]).nullable().optional(),
    acceptedScope: z.string().nullable().optional(),
    planRef: planReferenceSchema.nullable().optional(),
    phases: z.array(phaseSchema).optional(),
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
    intent: z.enum(["investigate", "plan_and_implement", "implement", "continue_plan"]).nullable().optional(),
    acceptedScope: z.string().nullable().optional(),
    planRef: planReferenceSchema.nullable().optional(),
    phases: z.array(phaseSchema).optional(),
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
  executionMode: z.enum(["legacy", "orchestrated"]).optional(),
  executionRevision: z.number().int().optional(),
  parentResolution: executionResolutionSchema.nullable().optional(),
});

const preparationSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  workspace: z.string(),
  taskId: z.string(),
  preparedAt: z.string(),
  marker: z.string(),
  modelRoles: z.record(z.string(), z.unknown()).optional(),
  parentRole: z.record(z.string(), z.unknown()).optional(),
  parentResolution: executionResolutionSchema.nullable().optional(),
  capabilities: z.object({
    executionContractVersion: z.number().int(),
    orchestratedExecution: z.boolean(),
    phaseReporting: z.boolean(),
    descendantUsage: z.enum(["parent_only"]),
  }).optional(),
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
  reportPhase = reportTaskPhase,
  link = linkTask,
  resolveRole = resolveExecutionRole,
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
        Promise.resolve().then(() => usageTracker.close?.()),
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
        executionMode: z.enum(["legacy", "orchestrated"]).optional(),
        executionContractVersion: z.number().int().optional(),
        parentResolution: executionResolutionSchema.optional(),
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
    "resolve_execution_role",
    {
      title: "Resolve TaskChef execution role",
      description:
        "Resolve exactly one global orchestrator, planner, implementer, or reviewer model preference immediately before creating that parent or spawning that phase. Cached availability is advisory; the current native creation tool remains authoritative.",
      inputSchema: {
        role: z.enum(["orchestrator", "planner", "implementer", "reviewer"]),
        explicitModel: z.string().min(1).max(256).nullable().optional(),
        explicitEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).nullable().optional(),
        nativeAvailabilityConfirmed: z.boolean().optional(),
      },
      outputSchema: { role: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ role, explicitModel = null, explicitEffort = null, nativeAvailabilityConfirmed = false }) => {
      const resolved = await resolveRole(role, {
        explicitModel,
        explicitEffort,
        nativeAvailabilityConfirmed,
      });
      const resolution = ["configured", "missing"].includes(resolved.status)
        ? resolutionSnapshotFromRole(resolved, { requestedModel: explicitModel, requestedEffort: explicitEffort })
        : null;
      return toolResult(
        "role",
        { ...resolved, resolution },
        `Resolved TaskChef ${role} role with status ${resolved.status}.`,
      );
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
        intent: z.enum(["investigate", "plan_and_implement", "implement", "continue_plan"]).optional(),
        acceptedScope: z.string().min(1).max(2_000).optional(),
        planRef: planReferenceSchema.nullable().optional(),
        executionContractVersion: z.number().int().optional(),
        parentResolution: executionResolutionSchema.optional(),
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
    "report_phase",
    {
      title: "Report TaskChef execution phase",
      description:
        reportingDestination + "Record a parent-owned orchestrated phase event. Reserve before spawning, start with the returned opaque handle, optionally bind a durable child identity only from explicit evidence, and finish after native terminal state is established. Events use optimistic execution revisions and exact idempotency IDs; only the self-linked parent may report them.",
      inputSchema: {
        taskId: z.string().min(1),
        parentThreadId: z.string().min(1),
        turnRef: z.string().min(1).max(256),
        eventId: z.string().min(1).max(256),
        expectedRevision: z.number().int().min(0),
        operation: z.enum(["reserve", "start", "bind", "finish"]),
        phaseId: z.string().min(1).max(256),
        kind: z.enum(["plan", "implement", "review", "verify", "deliver"]).optional(),
        attempt: z.number().int().min(1).max(100).optional(),
        role: z.enum(["orchestrator", "planner", "implementer", "reviewer"]).optional(),
        resolution: executionResolutionSchema.optional(),
        writer: z.boolean().optional(),
        agentHandle: z.string().min(1).max(512).optional(),
        threadId: z.string().min(1).max(256).optional(),
        bindingProvenance: z.enum(["native", "child_asserted"]).optional(),
        state: z.enum(["awaiting_input", "completed", "failed", "interrupted"]).optional(),
        summary: z.string().min(1).max(2_000).optional(),
        artifacts: z.array(z.string().min(1).max(1_000)).max(32).optional(),
        reviewPassId: z.string().min(1).max(256).nullable().optional(),
      },
      outputSchema: {
        event: z.object({
          task: taskSchema,
          phase: phaseSchema,
          eventId: z.string(),
          executionRevision: z.number().int(),
          idempotent: z.boolean(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const event = await reportPhase(workspace, input);
      void usageTracker.observe(event.task).catch(() => {});
      return toolResult("event", event, `Recorded ${input.operation} for TaskChef phase ${input.phaseId}.`);
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
