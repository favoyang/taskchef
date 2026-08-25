import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  prepareDispatch,
  linkTask,
  recordTask,
  reportTaskState,
  reportTaskResult,
} from "./workspace.js";
import { parseTaskChefMarker } from "./delegation.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const projectSchema = z.object({
  name: z.string(),
  path: z.string(),
  isGitRepository: z.boolean(),
  githubRepos: z.array(z.string()),
  description: z.string().optional(),
});

const taskSchema = z.object({
  schemaVersion: z.union([z.literal(4), z.literal(5)]),
  id: z.string(),
  project: projectSchema,
  title: z.string(),
  instruction: z.string(),
  threadId: z.string().nullable(),
  createdAt: z.string(),
  status: z.enum(["working", "needs_input", "completed", "failed"]),
  summary: z.string().nullable(),
  turnId: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.enum(["dispatcher", "mcp"]),
  lastResult: z.object({
    status: z.enum(["needs_input", "completed", "failed"]),
    summary: z.string(),
    turnId: z.string().nullable(),
    updatedAt: z.string(),
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

function toolResult(key, value, message) {
  return {
    structuredContent: { [key]: value },
    content: [{ type: "text", text: message }],
  };
}

export function createTaskChefMcpServer({
  workspace = resolveWorkspacePath().workspace,
  prepare = prepareDispatch,
  record = recordTask,
  reportResult = reportTaskResult,
  reportState = reportTaskState,
  link = linkTask,
} = {}) {
  const server = new McpServer(
    { name: "taskchef", version: "1.0.0" },
    {
      instructions:
        "Prepare with prepare_dispatch, call record_task before creating the Codex task, then create it natively and return immediately. Follow the active TaskChef skill for role-specific sequencing of the identity and state tools.",
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
        "Report this self-linked executor turn's lifecycle state. Use working before substantive work in a newly linked or follow-up turn, with summary omitted or null. Before ending the same turn, report needs_input, completed, or failed with a concise semantic summary. Exact retries are idempotent; stale or mismatched turns are rejected.",
      inputSchema: {
        taskId: z.string().min(1),
        threadId: z.string().min(1).nullable(),
        turnId: z.string().min(1).max(256).nullable(),
        status: z.enum(["working", "needs_input", "completed", "failed"]),
        summary: z.string().min(1).max(2_000).nullable().optional(),
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
      return toolResult("task", task, `Recorded ${task.status} result for TaskChef task ${task.id}.`);
    },
  );

  return server;
}
