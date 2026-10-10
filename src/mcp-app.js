import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { acquireWorkspaceLock } from "./workspace.js";
import { writeDurableAtomic } from "./state-store.js";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { NextGitHub } from "./next-github.js";
import { NextNotifications } from "./next-notifications.js";
import { CodexSessionScanner } from "./codex-session-scanner.js";
import { isCodexThreadDeepLinkId, openThreadInCodex, openPluginSettingsInCodex } from "./codex-app.js";

export const TASKCHEF_GITHUB_URI = "ui://taskchef/github-settings/v1";
export const TASKCHEF_APP_URI = "ui://taskchef/task-board/v3";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const htmlPath = fileURLToPath(new URL("./mcp-app/dist/index.html", import.meta.url));
const taskIdSchema = z.string().uuid();

const DEFAULT_GITHUB_CLIENT_ID = "Iv23likjK80RCtqZFGg8";
const visibilityFields = { showExec: z.boolean(), showCli: z.boolean(), showArchived: z.boolean() };
const settingsSchema = z.strictObject({ ...visibilityFields, showCalendarDates: z.boolean() });
const storedSettingsSchema = settingsSchema.extend({ githubClientId: z.string().trim().max(80).regex(/^(?:Iv(?:1\.[A-Za-z0-9]+|[A-Za-z0-9]{10,}))?$/) });
const settingsDefaults = { showExec: false, showCli: false, showArchived: false, showCalendarDates: false, githubClientId: DEFAULT_GITHUB_CLIENT_ID };
const settingsProperties = {
  showExec: { type: "boolean", title: "Show exec sessions", description: "Include standalone codex exec runs. Subagents stay hidden." },
  showCli: { type: "boolean", title: "Show CLI sessions", description: "Include chats started from the Codex CLI." },
  showCalendarDates: { type: "boolean", title: "Show calendar dates", description: "Show calendar dates and local times instead of relative ages." },
  showArchived: { type: "boolean", title: "Show archived chats", description: "Show archived chats in their own column and list filter." },
};
function publicSettings(values) {
  return Object.fromEntries(Object.keys(settingsProperties).map(key => [key, values[key]]));
}

export async function pluginSettingsUrl({ pluginRoot = fileURLToPath(new URL("../", import.meta.url)), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex") } = {}) {
  // Codex plugin detail links take the catalog file, not the marketplace root.
  const plugin = basename(dirname(pluginRoot));
  const marketplace = basename(dirname(dirname(pluginRoot)));
  try {
    const config = parseToml(await readFile(join(codexHome, "config.toml"), "utf8"));
    const source = config.marketplaces?.[marketplace]?.source;
    if (typeof source === "string" && isAbsolute(source)) {
      const marketplacePath = join(source, ".agents", "plugins", "marketplace.json");
      const catalog = JSON.parse(await readFile(marketplacePath, "utf8"));
      if (catalog.name !== marketplace || !catalog.plugins?.some((entry) => entry.name === plugin)) return null;
      return `codex://plugins/${encodeURIComponent(plugin)}?${new URLSearchParams({ marketplacePath })}`;
    }
  } catch { /* Report unresolved settings navigation when the user requests it. */ }
  return null;
}

export function registerTaskChefApp(server, {
  createScanner = () => new CodexSessionScanner(),
  openThread = openThreadInCodex,
  getSettingsUrl = pluginSettingsUrl,
  openSettings = openPluginSettingsInCodex,
  settingsPath = join(homedir(), ".agents", "taskchef-next", "settings.json"),
  notificationsPath = join(dirname(settingsPath), "notifications.json"),
  createGitHub = (options) => new NextGitHub(options),
} = {}) {
  const scanner = createScanner();
  const notificationStore = new NextNotifications(notificationsPath);
  const github = createGitHub({ stateDir: dirname(settingsPath) });
  let boardRevision = 0;
  let boardSignature;
  let githubAuth;
  async function boardSnapshot(settings, force = false, scope = { date: "all", taskIds: [] }) {
    const result = await github.enrich(await scanner.refresh({ force }), settings, { force, scope });
    githubAuth = result.auth;
    const signature = JSON.stringify([result.snapshot.revision, result.snapshot.tasks.map((task) => [task.id, task.status, task.pullRequests])]);
    if (signature !== boardSignature) { boardRevision += 1; boardSignature = signature; }
    return { ...result.snapshot, revision: boardRevision };
  }
  async function decoratedTask(task, force = false, includeHistory = false) {
    if (!task) return task;
    const { snapshot } = await github.enrich({ healthy: true, tasks: [task] }, await readSettings(), { force });
    const result = snapshot.tasks[0];
    if (!includeHistory || !task.detailPullRequests?.length) return result;
    // History is display-only. Never classify the chat using older PRs.
    const historyTask = { ...task, pullRequests: task.detailPullRequests };
    const history = await github.enrich({ healthy: true, tasks: [historyTask] }, await readSettings(), { force, detail: true });
    return { ...result, detailPullRequests: history.snapshot.tasks[0].pullRequests };
  }
  async function readSettings() {
    try {
      const values = storedSettingsSchema.parse({ ...settingsDefaults, ...JSON.parse(await readFile(settingsPath, "utf8")) });
      return { ...values, githubClientId: values.githubClientId || DEFAULT_GITHUB_CLIENT_ID };
    }
    catch (error) {
      if (error.code === "ENOENT") return { ...settingsDefaults };
      throw new Error("TaskChef cannot read settings.json. Repair the file and refresh.");
    }
  }
  server.server.registerCapabilities({ experimental: { "openai/settings": {
    readTool: "taskchef_settings_read", updateTool: "taskchef_settings_update",
  } } });
  server.registerTool("taskchef_settings_read", {
    title: "Read TaskChef settings", inputSchema: {},
    outputSchema: { schema: z.record(z.string(), z.unknown()), values: settingsSchema, layout: z.array(z.record(z.string(), z.unknown())) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const values = await readSettings();
    let connected = false;
    try { connected = (await github.auth(values.githubClientId, "status")).connected; } catch { /* Keep connection errors in the GitHub dialog. */ }
    return { content: [], structuredContent: {
      schema: { type: "object", properties: settingsProperties }, values: publicSettings(values),
      layout: [{ kind: "group", title: "Chat visibility", items: Object.keys(visibilityFields).map(property => ({ kind: "property", property })) }, { kind: "group", title: "Card display", items: [{ kind: "property", property: "showCalendarDates" }] }, { kind: "group", title: "GitHub", items: [{ kind: "tool", tool: "taskchef_github_settings", title: connected ? "Manage GitHub" : "Connect GitHub", description: "Sign in, manage repository access, or disconnect this computer." }] }],
    } };
  });
  server.registerTool("taskchef_settings_update", {
    title: "Update TaskChef settings",
    inputSchema: { set: settingsSchema.partial().refine((values) => Object.keys(values).length > 0, "Set at least one setting.") },
    outputSchema: { values: settingsSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ set }) => {
    await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
    const release = await acquireWorkspaceLock(dirname(settingsPath));
    try {
      const values = { ...await readSettings(), ...set };
      await writeDurableAtomic(settingsPath, JSON.stringify(values));
      return { content: [], structuredContent: { values: publicSettings(values) } };
    } finally { await release(); }
  });
  const originalClose = server.close.bind(server);
  server.close = async () => { scanner.close(); await originalClose(); };
  const appOnly = { ui: { resourceUri: TASKCHEF_APP_URI, visibility: ["app"] } };
  server.registerResource("TaskChef task board", TASKCHEF_APP_URI, {
    description: "TaskChef read-only Codex session board", mimeType: RESOURCE_MIME_TYPE,
    _meta: { ui: { csp: { resourceDomains: ["https:"] } } },
  }, async () => ({ contents: [{ uri: TASKCHEF_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(htmlPath, "utf8"), _meta: { ui: { csp: { resourceDomains: ["https:"] } } } }] }));
  server.registerResource("TaskChef GitHub settings", TASKCHEF_GITHUB_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
    uri: TASKCHEF_GITHUB_URI, mimeType: RESOURCE_MIME_TYPE,
    text: (await readFile(htmlPath, "utf8")).replace('<div id="root"', '<div data-taskchef-page="github" id="root"'),
  }] }));
  server.registerTool("taskchef_github_settings", {
    title: "Connect GitHub", inputSchema: {},
    _meta: { ui: { resourceUri: TASKCHEF_GITHUB_URI } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({ structuredContent: { github: await github.auth((await readSettings()).githubClientId, "status") }, content: [] }));
  server.registerTool("open_taskchef_board", {
    title: "TaskChef", description: "Show read-only local Codex session activity in the sidebar.", inputSchema: {},
    _meta: { ui: { resourceUri: TASKCHEF_APP_URI }, "openai/ui": { entrypoints: [{ type: "global" }] } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const snapshot = await scanner.refresh();
    if (!snapshot.healthy) return { structuredContent: { taskCount: 0, error: snapshot.scan.error }, content: [{ type: "text", text: `TaskChef: ${snapshot.scan.error}` }] };
    return { structuredContent: { taskCount: snapshot.tasks.length }, content: [{ type: "text", text: `TaskChef: ${snapshot.tasks.length} indexed chats. Visibility settings control which chats appear.` }] };
  });
  server.registerTool("taskchef_app_snapshot", {
    title: "Refresh TaskChef", description: "Read local Codex session metadata.",
    inputSchema: { revision: z.number().int().nonnegative().optional(), force: z.boolean().optional(), project: z.string().max(1000).optional(), date: z.enum(["24h", "7d", "all"]).optional(), visibleTaskIds: z.array(taskIdSchema).max(500).optional() }, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ revision, force, project, date, visibleTaskIds }) => {
    const settings = await readSettings();
    const settingsUrl = await getSettingsUrl();
    const { snapshot, notifications } = await notificationStore.reconcile(() => boardSnapshot(settings, force, { project, date: date ?? "all", taskIds: visibleTaskIds ?? [] }), settings);
    if (!force && revision !== undefined && revision === snapshot.revision && snapshot.healthy !== false) {
      return { structuredContent: { unchanged: true, revision: snapshot.revision, scan: snapshot.scan, settings: publicSettings(settings), settingsUrl, notifications, github: githubAuth }, content: [] };
    }
    return { structuredContent: { snapshot, settings: publicSettings(settings), settingsUrl, notifications, github: githubAuth }, content: [] };
  });
  server.registerTool("taskchef_app_task", {
    title: "Read Codex chat metadata", description: "Read one local chat's metadata without returning transcript text.",
    inputSchema: { taskId: taskIdSchema, refreshGithub: z.boolean().optional() }, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ taskId, refreshGithub }) => {
    const snapshot = await scanner.refresh();
    if (!snapshot.healthy) throw new Error(snapshot.scan.error);
    const task = await decoratedTask(await scanner.taskDetail(taskId), refreshGithub === true, true);
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
  server.registerTool("taskchef_app_set_scheduled", {
    title: "Return chat to Scheduled", description: "Acknowledge the latest human turn and return an active scheduled chat to its queue.",
    inputSchema: { taskId: taskIdSchema, expectedTurnId: z.string().min(1) }, _meta: appOnly,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ taskId, expectedTurnId }) => ({ structuredContent: { task: await decoratedTask(await scanner.setScheduled(taskId, expectedTurnId)) }, content: [] }));
  server.registerTool("taskchef_app_set_done", {
    title: "Mark chat Done in TaskChef", description: "Save or remove a local Done mark. Codex databases are never modified.",
    inputSchema: { taskId: taskIdSchema, expectedTurnId: z.string().min(1), done: z.boolean() }, _meta: appOnly,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ taskId, expectedTurnId, done }) => {
    let mergedPrUrls = [];
    if (done) {
      const snapshot = await scanner.refresh({ force: true });
      if (!snapshot.healthy) throw new Error(snapshot.scan.error);
      const current = await decoratedTask(scanner.task(taskId));
      if (!current || current.turnId !== expectedTurnId) throw new Error("Chat changed. Refresh and try again.");
      mergedPrUrls = (current.pullRequests ?? []).filter(pr => pr.state === "merged").map(pr => pr.url);
    }
    const task = await decoratedTask(await scanner.setDone(taskId, expectedTurnId, done, mergedPrUrls));
    return { structuredContent: { task, notifications: done ? await notificationStore.confirmation(task) : undefined }, content: [] };
  });
  for (const [name, resourceUri] of [["taskchef_app_github", TASKCHEF_APP_URI], ["taskchef_github_settings_auth", TASKCHEF_GITHUB_URI]]) server.registerTool(name, {
    title: "Connect GitHub for PR status", description: "Start device sign-in, check approval, or remove local credentials. Tokens stay in the system credential store.",
    inputSchema: { action: z.enum(["status", "start", "poll", "disconnect"]) }, _meta: { ui: { resourceUri, visibility: ["app"] } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ action }) => ({ structuredContent: { github: await github.auth((await readSettings()).githubClientId, action) }, content: [] }));
  server.registerTool("taskchef_app_notifications", {
    title: "Update TaskChef notifications",
    inputSchema: { action: z.enum(["read", "read_all", "clear", "error"]), id: z.string().optional(), taskId: taskIdSchema.optional(), operation: z.enum(["open", "done", "move", "copy", "settings"]).optional(), error: z.string().max(1000).optional() },
    _meta: appOnly, annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ action, id, taskId, operation, error }) => {
    if (action === "read" && !id) throw new Error("Notification ID required.");
    if (action === "error" && (!operation || !error)) throw new Error("Operation and error required.");
    const task = taskId ? scanner.task(taskId) : null;
    const notifications = await notificationStore.action({ action, id, task, operation, error });
    return { structuredContent: { notifications }, content: [] };
  });
  for (const [name, resourceUri] of [["taskchef_app_open_settings", TASKCHEF_APP_URI], ["taskchef_github_settings_open_plugin", TASKCHEF_GITHUB_URI]]) server.registerTool(name, {
    title: "Open TaskChef settings", description: "Open this installed plugin's native settings page in Codex.",
    inputSchema: {}, _meta: { ui: { resourceUri, visibility: ["app"] } },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async () => {
    await openSettings(await getSettingsUrl());
    return { structuredContent: { message: "Requested plugin settings in Codex." }, content: [] };
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
