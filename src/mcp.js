import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  prepareDispatch,
  recordTask,
  resolveTask,
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
  schemaVersion: z.number(),
  id: z.string(),
  project: projectSchema,
  title: z.string(),
  instruction: z.string(),
  threadId: z.string().nullable(),
  createdAt: z.string(),
});

const preparationSchema = z.object({
  schemaVersion: z.number(),
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
  resolve = resolveTask,
} = {}) {
  const server = new McpServer(
    { name: "taskchef", version: "1.0.0" },
    {
      instructions:
        "Prepare with prepare_dispatch, create the Codex task natively, then call record_task exactly once. Use resolve_task only after one exact structured marker match.",
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
        "Atomically append one created Codex task to the canonical TaskChef history. Pass the exact marked instruction returned by preparation and never pass a provisional ID as threadId.",
      inputSchema: {
        id: z.string().min(1),
        project: z.string().min(1),
        title: z.string().min(1),
        instruction: z.string().min(1),
        threadId: z.string().min(1).nullable(),
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
        throw new Error("record_task instruction must start with its exact TaskChef marker");
      }
      const task = await record(workspace, input);
      return toolResult("task", task, `Recorded TaskChef task ${task.id}.`);
    },
  );

  server.registerTool(
    "resolve_task",
    {
      title: "Resolve TaskChef task",
      description:
        "Atomically fill one recorded TaskChef task's nullable thread ID after exactly one structured marker match. The one-way transition cannot overwrite another durable ID.",
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
      const task = await resolve(workspace, taskId, threadId);
      return toolResult("task", task, `Resolved TaskChef task ${task.id}.`);
    },
  );

  return server;
}
