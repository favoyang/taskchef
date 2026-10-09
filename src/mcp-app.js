import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { acquireWorkspaceLock } from "./workspace.js";
import { writeDurableAtomic } from "./state-store.js";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { NextNotifications } from "./next-notifications.js";
import { CodexSessionScanner } from "./codex-session-scanner.js";
import { isCodexThreadDeepLinkId, openThreadInCodex } from "./codex-app.js";

export const TASKCHEF_APP_URI = "ui://taskchef/task-board/v3";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const htmlPath = fileURLToPath(new URL("./mcp-app/dist/index.html", import.meta.url));
const taskIdSchema = z.string().uuid();

const settingsFields = { showExec: z.boolean(), showCli: z.boolean(), showArchived: z.boolean() };
const settingsSchema = z.strictObject(settingsFields);
const settingsDefaults = { showExec: false, showCli: false, showArchived: false };
const settingsProperties = {
  showExec: { type: "boolean", title: "Show exec sessions", description: "Include standalone codex exec runs. Subagents stay hidden." },
  showCli: { type: "boolean", title: "Show CLI sessions", description: "Include chats started from the Codex CLI." },
  showArchived: { type: "boolean", title: "Show archived chats", description: "Show archived chats in their own column and list filter." },
};

export async function pluginSettingsUrl({ pluginRoot = fileURLToPath(new URL("../", import.meta.url)), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex") } = {}) {
  // Local plugin detail links need the marketplace root, not the installed cache.
  const plugin = basename(dirname(pluginRoot));
  const marketplace = basename(dirname(dirname(pluginRoot)));
  try {
    const config = parseToml(await readFile(join(codexHome, "config.toml"), "utf8"));
    const source = config.marketplaces?.[marketplace]?.source;
    if (typeof source === "string" && isAbsolute(source)) {
      return `codex://plugins/${encodeURIComponent(plugin)}?${new URLSearchParams({ marketplacePath: source })}`;
    }
  } catch { /* The plugin browser remains available if the local source cannot be resolved. */ }
  return "codex://plugins";
}

export function registerTaskChefApp(server, {
  createScanner = () => new CodexSessionScanner(),
  openThread = openThreadInCodex,
  getSettingsUrl = pluginSettingsUrl,
  settingsPath = join(homedir(), ".agents", "taskchef-next", "settings.json"),
  notificationsPath = join(dirname(settingsPath), "notifications.json"),
} = {}) {
  const scanner = createScanner();
  const notificationStore = new NextNotifications(notificationsPath);
  async function readSettings() {
    try { return settingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8"))); }
    catch (error) {
      if (error.code === "ENOENT") return { ...settingsDefaults };
      throw new Error("TaskChef Next cannot read settings.json. Repair the file and refresh.");
    }
  }
  server.server.registerCapabilities({ experimental: { "openai/settings": {
    readTool: "taskchef_settings_read", updateTool: "taskchef_settings_update",
  } } });
  server.registerTool("taskchef_settings_read", {
    title: "Read TaskChef Next settings", inputSchema: {},
    outputSchema: { schema: z.record(z.string(), z.unknown()), values: settingsSchema, layout: z.array(z.record(z.string(), z.unknown())) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({ content: [], structuredContent: {
    schema: { type: "object", properties: settingsProperties }, values: await readSettings(),
    layout: [{ kind: "group", title: "Chat visibility", items: Object.keys(settingsFields).map((property) => ({ kind: "property", property })) }],
  } }));
  server.registerTool("taskchef_settings_update", {
    title: "Update TaskChef Next settings",
    inputSchema: { set: settingsSchema.partial().refine((values) => Object.keys(values).length > 0, "Set at least one setting.") },
    outputSchema: { values: settingsSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ set }) => {
    await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
    const release = await acquireWorkspaceLock(dirname(settingsPath));
    try {
      const values = { ...await readSettings(), ...set };
      await writeDurableAtomic(settingsPath, JSON.stringify(values));
      return { content: [], structuredContent: { values } };
    } finally { await release(); }
  });
  const originalClose = server.close.bind(server);
  server.close = async () => { scanner.close(); await originalClose(); };
  const appOnly = { ui: { resourceUri: TASKCHEF_APP_URI, visibility: ["app"] } };
  server.registerResource("TaskChef Next task board", TASKCHEF_APP_URI, {
    description: "TaskChef Next read-only Codex session board", mimeType: RESOURCE_MIME_TYPE,
    _meta: { ui: { csp: { resourceDomains: ["https:"] } } },
  }, async () => ({ contents: [{ uri: TASKCHEF_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(htmlPath, "utf8"), _meta: { ui: { csp: { resourceDomains: ["https:"] } } } }] }));
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
    const settings = await readSettings();
    const settingsUrl = await getSettingsUrl();
    const { snapshot, notifications } = await notificationStore.reconcile(() => scanner.refresh({ force }), settings);
    if (!force && revision !== undefined && revision === snapshot.revision && snapshot.healthy !== false) {
      return { structuredContent: { unchanged: true, revision: snapshot.revision, scan: snapshot.scan, settings, settingsUrl, notifications }, content: [] };
    }
    return { structuredContent: { snapshot, settings, settingsUrl, notifications }, content: [] };
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
  server.registerTool("taskchef_app_image", {
    title: "Read reply cover image", description: "Read the local raster image referenced by the latest reply, up to 4 MiB.",
    inputSchema: { taskId: taskIdSchema, expectedTurnId: z.string().min(1), expectedUrl: z.string().min(1) }, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ taskId, expectedTurnId, expectedUrl }) => ({
    structuredContent: { dataUrl: await scanner.taskImage(taskId, expectedTurnId, expectedUrl) }, content: [],
  }));
  server.registerTool("taskchef_app_set_done", {
    title: "Mark chat Done in TaskChef Next", description: "Save or remove a local Done mark. Codex databases are never modified.",
    inputSchema: { taskId: taskIdSchema, expectedTurnId: z.string().min(1), done: z.boolean() }, _meta: appOnly,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ taskId, expectedTurnId, done }) => {
    const task = await scanner.setDone(taskId, expectedTurnId, done);
    return { structuredContent: { task, notifications: done ? await notificationStore.confirmation(task) : undefined }, content: [] };
  });
  server.registerTool("taskchef_app_notifications", {
    title: "Update TaskChef Next notifications",
    inputSchema: { action: z.enum(["read", "read_all", "clear", "error"]), id: z.string().optional(), taskId: taskIdSchema.optional(), operation: z.enum(["open", "done", "copy", "settings"]).optional(), error: z.string().max(1000).optional() },
    _meta: appOnly, annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ action, id, taskId, operation, error }) => {
    if (action === "read" && !id) throw new Error("Notification ID required.");
    if (action === "error" && (!operation || !error)) throw new Error("Operation and error required.");
    const task = taskId ? scanner.task(taskId) : null;
    const notifications = await notificationStore.action({ action, id, task, operation, error });
    return { structuredContent: { notifications }, content: [] };
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
