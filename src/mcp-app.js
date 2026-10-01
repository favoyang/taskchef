import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DashboardMonitor } from "./dashboard.js";
import { isCodexThreadDeepLinkId, openThreadInCodex, openWorkspaceInCodex } from "./codex-app.js";
import { canonicalDirectory, canonicalGitRoot, manuallyTransitionTask, readConfig } from "./workspace.js";

export const TASKCHEF_APP_URI = "ui://taskchef/task-board";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const htmlPath = fileURLToPath(new URL("./mcp-app/dist/index.html", import.meta.url));
const taskIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/).max(512);
const expectedSchema = z.object({
  status: z.enum(["working", "needs_input", "completed", "failed"]),
  turnRef: z.string().nullable(),
  threadId: z.string().nullable(),
  updatedAt: z.string().min(1),
}).strict();

export function registerTaskChefApp(server, {
  workspace,
  createMonitor = (root) => new DashboardMonitor(root),
  transition = manuallyTransitionTask,
  openThread = openThreadInCodex,
  openProject = openWorkspaceInCodex,
  readConfiguration = readConfig,
} = {}) {
  let monitor;
  let starting;
  async function currentMonitor() {
    if (!monitor) {
      starting ??= (async () => {
        const candidate = createMonitor(workspace);
        try {
          await candidate.start();
          monitor = candidate;
          return candidate;
        } catch (error) {
          candidate.close();
          throw error;
        }
      })().finally(() => { starting = null; });
      return starting;
    }
    await monitor.refresh();
    return monitor;
  }
  const originalClose = server.close.bind(server);
  server.close = async () => {
    monitor?.close();
    await originalClose();
  };
  const appOnly = { ui: { resourceUri: TASKCHEF_APP_URI, visibility: ["app"] } };
  server.registerResource("TaskChef task board", TASKCHEF_APP_URI, {
    description: "TaskChef sidebar task board",
    mimeType: RESOURCE_MIME_TYPE,
  }, async () => ({ contents: [{
    uri: TASKCHEF_APP_URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: await readFile(htmlPath, "utf8"),
  }] }));
  server.registerTool("open_taskchef_board", {
    title: "Open TaskChef task board",
    description: "Show the local TaskChef task board in the Codex sidebar.",
    inputSchema: {},
    _meta: { ui: { resourceUri: TASKCHEF_APP_URI }, "openai/ui": { entrypoints: [{ type: "global" }] } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const snapshot = (await currentMonitor()).snapshot();
    return { structuredContent: { taskCount: snapshot.tasks.length }, content: [{ type: "text", text: `TaskChef board: ${snapshot.tasks.length} tasks.` }] };
  });
  server.registerTool("taskchef_app_snapshot", {
    title: "Refresh TaskChef board", description: "Read the local task board.",
    inputSchema: {}, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({ structuredContent: { snapshot: (await currentMonitor()).snapshot() }, content: [] }));
  server.registerTool("taskchef_app_task", {
    title: "Read TaskChef task", description: "Read one task's details.",
    inputSchema: { taskId: taskIdSchema }, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ taskId }) => {
    const task = (await currentMonitor()).tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Task not found.");
    return { structuredContent: { task }, content: [] };
  });
  server.registerTool("taskchef_app_transition", {
    title: "Mark TaskChef task", description: "Apply a confirmed manual status transition.",
    inputSchema: {
      taskId: taskIdSchema,
      actionId: z.string().uuid(),
      expected: expectedSchema,
      targetStatus: z.enum(["completed", "failed"]),
    }, _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ taskId, actionId, expected, targetStatus }) => {
    const result = await transition(workspace, taskId, { actionId, expected, targetStatus });
    await (await currentMonitor()).refresh({ force: true });
    return { structuredContent: { task: result.task, idempotent: result.idempotent }, content: [] };
  });
  server.registerTool("taskchef_app_open_chat", {
    title: "Open TaskChef chat", description: "Open the task's Codex chat or configured project.",
    inputSchema: { taskId: taskIdSchema }, _meta: appOnly,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ taskId }) => {
    const task = (await currentMonitor()).tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Task not found.");
    if (isCodexThreadDeepLinkId(task.threadId)) {
      await openThread(task.threadId);
      return { structuredContent: { message: "Opened chat in Codex." }, content: [] };
    }
    const trusted = (await readConfiguration(workspace, { checkPaths: false })).projects
      .find((project) => project.path === task.project.path);
    if (!trusted) throw new Error("This historical task no longer matches a configured project.");
    const canonicalPath = trusted.isGitRepository
      ? await canonicalGitRoot(trusted.path) : await canonicalDirectory(trusted.path);
    if (canonicalPath !== trusted.path) throw new Error("This configured project has moved.");
    await openProject(canonicalPath);
    return { structuredContent: { message: "Opened project in Codex. Select the recorded thread there." }, content: [] };
  });
}
