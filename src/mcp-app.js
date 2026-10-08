import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CodexSessionScanner } from "./codex-session-scanner.js";
import { isCodexThreadDeepLinkId, openThreadInCodex } from "./codex-app.js";

export const TASKCHEF_APP_URI = "ui://taskchef/task-board/v3";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const htmlPath = fileURLToPath(new URL("./mcp-app/dist/index.html", import.meta.url));
const taskIdSchema = z.string().uuid();

export function registerTaskChefApp(server, {
  createScanner = () => new CodexSessionScanner(),
  openThread = openThreadInCodex,
} = {}) {
  const scanner = createScanner();
  const originalClose = server.close.bind(server);
  server.close = async () => { scanner.close(); await originalClose(); };
  const appOnly = { ui: { resourceUri: TASKCHEF_APP_URI, visibility: ["app"] } };
  server.registerResource("TaskChef Next task board", TASKCHEF_APP_URI, {
    description: "TaskChef Next read-only Codex session board", mimeType: RESOURCE_MIME_TYPE,
  }, async () => ({ contents: [{ uri: TASKCHEF_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(htmlPath, "utf8") }] }));
  server.registerTool("open_taskchef_board", {
    title: "TaskChef Next", description: "Show read-only local Codex session activity in the sidebar.", inputSchema: {},
    _meta: { ui: { resourceUri: TASKCHEF_APP_URI }, "openai/ui": { entrypoints: [{ type: "global" }] } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const snapshot = await scanner.refresh();
    if (!snapshot.healthy) return { structuredContent: { taskCount: 0, error: snapshot.scan.error }, content: [{ type: "text", text: `TaskChef Next: ${snapshot.scan.error}` }] };
    return { structuredContent: { taskCount: snapshot.tasks.length }, content: [{ type: "text", text: `TaskChef Next: ${snapshot.tasks.length} indexed chats. Visibility settings control which chats appear.` }] };
  });
  server.registerTool("taskchef_app_snapshot", {
    title: "Refresh TaskChef Next", description: "Read local Codex session metadata.",
    inputSchema: { revision: z.number().int().nonnegative().optional(), force: z.boolean().optional() }, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ revision, force }) => {
    const snapshot = await scanner.refresh({ force });
    if (!force && revision !== undefined && revision === snapshot.revision && snapshot.healthy !== false) {
      return { structuredContent: { unchanged: true, revision: snapshot.revision, scan: snapshot.scan }, content: [] };
    }
    return { structuredContent: { snapshot }, content: [] };
  });
  server.registerTool("taskchef_app_task", {
    title: "Read Codex chat metadata", description: "Read one local chat's metadata without returning transcript text.",
    inputSchema: { taskId: taskIdSchema }, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ taskId }) => {
    const snapshot = await scanner.refresh();
    if (!snapshot.healthy) throw new Error(snapshot.scan.error);
    const task = await scanner.taskDetail(taskId);
    if (!task) throw new Error("Task not found.");
    return { structuredContent: { task }, content: [] };
  });
  server.registerTool("taskchef_app_set_done", {
    title: "Mark chat Done in TaskChef Next", description: "Save or remove a local Done mark. Codex databases are never modified.",
    inputSchema: { taskId: taskIdSchema, expectedTurnId: z.string().min(1), done: z.boolean() }, _meta: appOnly,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ taskId, expectedTurnId, done }) => {
    const task = await scanner.setDone(taskId, expectedTurnId, done);
    return { structuredContent: { task }, content: [] };
  });
  server.registerTool("taskchef_app_open_chat", {
    title: "Open Codex chat", description: "Open the selected Codex chat.",
    inputSchema: { taskId: taskIdSchema }, _meta: appOnly,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ taskId }) => {
    const snapshot = await scanner.refresh();
    if (!snapshot.healthy) throw new Error(snapshot.scan.error);
    const task = scanner.task(taskId);
    if (!task) throw new Error("Task not found.");
    if (!isCodexThreadDeepLinkId(task.threadId)) throw new Error("This chat cannot be opened directly.");
    await openThread(task.threadId);
    return { structuredContent: { message: "Opened chat in Codex." }, content: [] };
  });
}
