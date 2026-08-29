import { EventEmitter } from "node:events";
import { constants, watch } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  archiveThreadInCodex,
  discoverBundledCodexCli,
  isCodexThreadDeepLinkId,
  openThreadInCodex,
  openWorkspaceInCodex,
} from "./codex-app.js";
import {
  acquireWorkspaceLock,
  canonicalDirectory,
  canonicalGitRoot,
  manuallyTransitionTask,
  parseTaskLogContent,
  readConfig,
  readTask,
} from "./workspace.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";
import { taskGitHubProjection } from "./dashboard/github-links.js";
import { CODEX_CHAT_ARCHIVE_ENABLED } from "./dashboard/state.js";
import { createUsageTracker } from "./usage-tracker.js";
import {
  DASHBOARD_CONTROL_CHALLENGE_PATH,
  DASHBOARD_CONTROL_SHUTDOWN_PATH,
  dashboardControlProof,
  validDashboardControlNonce,
  validDashboardControlSecret,
  verifyDashboardControlProof,
} from "./dashboard-ownership.js";

const TASKS_FILE_NAME = "tasks.jsonl";
const STATIC_ROOT = fileURLToPath(new URL("./dashboard/", import.meta.url));
const ASSET_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TASKS = 2_000;
const DEFAULT_MAX_EVENT_CLIENTS = 16;
const MAX_MANUAL_TRANSITION_BODY_BYTES = 4 * 1024;
export const DASHBOARD_HEALTH_PATH = "/api/health";
export const DASHBOARD_HEALTH_MAX_BYTES = 8 * 1024;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

const STATIC_FILES = new Map([
  ["/", [path.join(STATIC_ROOT, "index.html"), "text/html; charset=utf-8"]],
  ["/actions.js", [path.join(STATIC_ROOT, "actions.js"), "text/javascript; charset=utf-8"]],
  ["/app.js", [path.join(STATIC_ROOT, "app.js"), "text/javascript; charset=utf-8"]],
  ["/github-links.js", [path.join(STATIC_ROOT, "github-links.js"), "text/javascript; charset=utf-8"]],
  ["/time.js", [path.join(STATIC_ROOT, "time.js"), "text/javascript; charset=utf-8"]],
  ["/state.js", [path.join(STATIC_ROOT, "state.js"), "text/javascript; charset=utf-8"]],
  ["/styles.css", [path.join(STATIC_ROOT, "styles.css"), "text/css; charset=utf-8"]],
  ["/assets/taskchef-dark.svg", [path.join(ASSET_ROOT, "taskchef-dark.svg"), "image/svg+xml"]],
  ["/assets/taskchef.svg", [path.join(ASSET_ROOT, "taskchef.svg"), "image/svg+xml"]],
  ["/assets/codex-app-dark.png", [path.join(ASSET_ROOT, "codex-app-dark.png"), "image/png"]],
  ["/assets/codex-app-light.png", [path.join(ASSET_ROOT, "codex-app-light.png"), "image/png"]],
]);

export function dashboardAuthority(host, port) {
  const address = host === "::1" ? "[::1]" : host;
  return port === 80 ? address : `${address}:${port}`;
}

function meaningfulUpdateTime(task, observedUpdateTimes) {
  return Math.max(
    Date.parse(task.updatedAt ?? task.createdAt),
    observedUpdateTimes.get(task.id) ?? Number.NEGATIVE_INFINITY,
  );
}

export function sortTasksByMeaningfulUpdate(tasks, observedUpdateTimes = new Map()) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) =>
      meaningfulUpdateTime(right.task, observedUpdateTimes)
      - meaningfulUpdateTime(left.task, observedUpdateTimes)
      || left.index - right.index)
    .map(({ task }) => task);
}

function taskFingerprint(tasks) {
  return JSON.stringify(tasks);
}

async function fileFingerprint(filePath) {
  const details = await stat(filePath);
  return statFingerprint(details);
}

function statFingerprint(details) {
  return `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}`;
}

export async function readBoundedTaskLog(filePath, maximumBytes, { afterOpen = null } = {}) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("task log is not a regular file");
    if (afterOpen) await afterOpen();
    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maximumBytes) {
      throw new Error(`task log exceeds the dashboard limit of ${maximumBytes} bytes`);
    }
    const after = await handle.stat();
    if (statFingerprint(before) !== statFingerprint(after)) {
      throw new Error("task log changed while the dashboard was reading it");
    }
    return {
      content: Buffer.concat(chunks, total).toString("utf8"),
      fingerprint: statFingerprint(after),
    };
  } finally {
    await handle.close();
  }
}

function boundedText(value, maximum, name) {
  if (value !== null && value !== undefined && String(value).length > maximum) {
    throw new Error(`${name} exceeds the dashboard display limit`);
  }
}

function assertDashboardTaskBounds(tasks, maximumTasks) {
  if (tasks.length > maximumTasks) {
    throw new Error(`task log exceeds the dashboard limit of ${maximumTasks} tasks`);
  }
  for (const [index, task] of tasks.entries()) {
    const name = `task ${index + 1}`;
    boundedText(task.id, 512, `${name} ID`);
    boundedText(task.title, 1_000, `${name} title`);
    boundedText(task.instruction, 250_000, `${name} instruction`);
    boundedText(task.summary, 2_000, `${name} summary`);
    boundedText(task.threadId, 512, `${name} thread ID`);
    boundedText(task.turnRef, 512, `${name} turn ref`);
    boundedText(task.turnId, 512, `${name} turn ID`);
    boundedText(task.lastResult?.summary, 2_000, `${name} last result summary`);
    boundedText(task.lastResult?.turnRef, 512, `${name} last result turn ref`);
    boundedText(task.lastResult?.turnId, 512, `${name} last result turn ID`);
    boundedText(task.latestTurn?.requestSummary, 1_000, `${name} latest request summary`);
    boundedText(task.latestTurn?.turnRef, 512, `${name} latest turn ref`);
    boundedText(task.latestTurn?.turnId, 512, `${name} latest turn ID`);
    const turns = task.turns ?? [];
    if (turns.length > 10_000) {
      throw new Error(`${name} has too many turns for the dashboard`);
    }
    for (const [turnIndex, turn] of turns.entries()) {
      boundedText(turn.requestSummary, 1_000, `${name} turn ${turnIndex + 1} request summary`);
      boundedText(turn.turnRef, 512, `${name} turn ${turnIndex + 1} turn ref`);
      boundedText(turn.turnId, 512, `${name} turn ${turnIndex + 1} turn ID`);
      boundedText(turn.result?.summary, 2_000, `${name} turn ${turnIndex + 1} result summary`);
      boundedText(
        turn.provenance?.actionId,
        512,
        `${name} turn ${turnIndex + 1} manual action ID`,
      );
    }
    const results = task.results ?? [];
    if (results.length > 10_000) {
      throw new Error(`${name} has too many results for the dashboard`);
    }
    for (const [resultIndex, result] of results.entries()) {
      boundedText(result.summary, 2_000, `${name} result ${resultIndex + 1} summary`);
      boundedText(result.turnRef, 512, `${name} result ${resultIndex + 1} turn ref`);
      boundedText(result.turnId, 512, `${name} result ${resultIndex + 1} turn ID`);
      boundedText(
        result.provenance?.actionId,
        512,
        `${name} result ${resultIndex + 1} manual action ID`,
      );
    }
    boundedText(task.project.name, 1_000, `${name} project name`);
    boundedText(task.project.path, 8_192, `${name} project path`);
    boundedText(task.project.description, 4_000, `${name} project description`);
    if (task.project.githubRepos.length > 100) {
      throw new Error(`${name} has too many GitHub repositories for the dashboard`);
    }
    for (const repository of task.project.githubRepos) {
      boundedText(repository, 2_048, `${name} GitHub repository`);
    }
  }
}

function taskListProjection(task) {
  const { turns: _turns, results: _results, ...projection } = {
    ...task,
    ...taskGitHubProjection(task),
  };
  return projection;
}

function taskDetailProjection(task) {
  return { ...task, ...taskGitHubProjection(task) };
}

export class DashboardMonitor extends EventEmitter {
  constructor(workspace, {
    debounceMs = 75,
    fingerprint = fileFingerprint,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxTasks = DEFAULT_MAX_TASKS,
    readSnapshot = null,
    pollIntervalMs = 5_000,
    watchDirectory = watch,
    watchReconnectMs = 1_000,
  } = {}) {
    super();
    this.workspace = workspace;
    this.debounceMs = debounceMs;
    this.pollIntervalMs = pollIntervalMs;
    this.watchDirectory = watchDirectory;
    this.watchReconnectMs = watchReconnectMs;
    this.fingerprint = fingerprint;
    this.maxFileBytes = maxFileBytes;
    this.maxTasks = maxTasks;
    this.readSnapshot = readSnapshot ?? (async () => {
      const snapshot = await readBoundedTaskLog(this.tasksFile, this.maxFileBytes);
      return {
        fingerprint: snapshot.fingerprint,
        tasks: await parseTaskLogContent(this.workspace, snapshot.content),
      };
    });
    this.tasks = [];
    this.revision = 0;
    this.started = false;
    this.currentFingerprint = null;
    this.currentTaskFingerprint = null;
    this.unhealthy = false;
    this.observedUpdateTimes = new Map();
    this.refreshPromise = null;
    this.refreshQueued = false;
    this.watcher = null;
    this.debounceTimer = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      revision: this.revision,
      generatedAt: new Date().toISOString(),
      healthy: !this.unhealthy,
      tasks: this.tasks.map((task) => ({
        ...taskListProjection(task),
        meaningfulUpdatedAt: new Date(
          meaningfulUpdateTime(task, this.observedUpdateTimes),
        ).toISOString(),
      })),
    };
  }

  async start() {
    if (this.started) return this.snapshot();
    this.workspace = await realpath(path.resolve(this.workspace));
    this.tasksFile = path.join(this.workspace, TASKS_FILE_NAME);
    await this.refresh({ force: true });
    if (this.revision === 0) throw new Error("dashboard could not read a valid task log");
    this.started = true;
    this.startWatcher();
    this.pollTimer = setInterval(() => this.refresh(), this.pollIntervalMs);
    this.pollTimer.unref?.();
    return this.snapshot();
  }

  startWatcher() {
    if (!this.started || this.watcher) return;
    try {
      this.watcher = this.watchDirectory(this.workspace, { persistent: false }, (_event, fileName) => {
        if (fileName !== null && String(fileName) !== TASKS_FILE_NAME) return;
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.refresh({ force: true }), this.debounceMs);
        this.debounceTimer.unref?.();
      });
      this.watcher.on("error", (error) => {
        this.emit("watcherError", error);
        this.watcher?.close();
        this.watcher = null;
        this.scheduleWatcherReconnect();
      });
    } catch (error) {
      this.emit("watcherError", error);
      this.scheduleWatcherReconnect();
    }
  }

  scheduleWatcherReconnect() {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startWatcher();
      this.refresh({ force: true });
    }, this.watchReconnectMs);
    this.reconnectTimer.unref?.();
  }

  async refresh({ force = false } = {}) {
    if (this.refreshPromise) {
      this.refreshQueued ||= force;
      return this.refreshPromise;
    }
    this.refreshPromise = this.refreshOnce({ force }).finally(async () => {
      this.refreshPromise = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        await this.refresh({ force: true });
      }
    });
    return this.refreshPromise;
  }

  async refreshOnce({ force }) {
    try {
      const observed = await this.fingerprint(this.tasksFile);
      if (!force && observed === this.currentFingerprint) return false;
      const snapshot = await this.readSnapshot();
      assertDashboardTaskBounds(snapshot.tasks, this.maxTasks);
      const after = await this.fingerprint(this.tasksFile);
      if (snapshot.fingerprint !== after) {
        this.refreshQueued = true;
        return false;
      }
      const previous = new Map(this.tasks.map((task) => [task.id, task]));
      const currentIds = new Set(snapshot.tasks.map((task) => task.id));
      for (const taskId of this.observedUpdateTimes.keys()) {
        if (!currentIds.has(taskId)) this.observedUpdateTimes.delete(taskId);
      }
      const observedAt = Date.now();
      for (const task of snapshot.tasks) {
        const former = previous.get(task.id);
        if (former && JSON.stringify(former) !== JSON.stringify(task)) {
          this.observedUpdateTimes.set(task.id, observedAt);
        }
      }
      const tasks = sortTasksByMeaningfulUpdate(snapshot.tasks, this.observedUpdateTimes);
      const nextTaskFingerprint = taskFingerprint(tasks);
      this.currentFingerprint = after;
      if (nextTaskFingerprint === this.currentTaskFingerprint) {
        if (this.unhealthy) {
          this.unhealthy = false;
          this.emit("snapshot", this.snapshot());
        }
        return false;
      }
      this.tasks = tasks;
      this.currentTaskFingerprint = nextTaskFingerprint;
      this.revision += 1;
      this.unhealthy = false;
      this.emit("snapshot", this.snapshot());
      return true;
    } catch (error) {
      if (!this.unhealthy) this.emit("monitorError", error);
      this.unhealthy = true;
      return false;
    }
  }

  close() {
    this.started = false;
    this.watcher?.close();
    clearTimeout(this.debounceTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pollTimer);
    this.watcher = null;
  }
}

function securityHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(value)}\n`);
}

async function readBoundedJsonBody(request, maximumBytes = MAX_MANUAL_TRANSITION_BODY_BYTES) {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error("Request content type must be application/json.");
    error.code = "unsupported_media_type";
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) {
      const error = new Error("Request body is too large.");
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.code = "malformed_json";
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("Request body must be a JSON object.");
    error.code = "invalid_request";
    throw error;
  }
  return value;
}

function manualTransitionInput(body) {
  const fields = new Set(["schemaVersion", "actionId", "expected", "targetStatus"]);
  const unexpected = Object.keys(body).find((key) => !fields.has(key));
  const missing = [...fields].find((key) => !(key in body));
  if (unexpected || missing || body.schemaVersion !== 1) {
    const error = new Error("Manual transition request has an invalid shape.");
    error.code = "invalid_request";
    throw error;
  }
  const { schemaVersion: _schemaVersion, ...input } = body;
  return input;
}

function manualTransitionErrorResponse(error) {
  const definitions = new Map([
    ["malformed_json", [400, "Request body must be valid JSON."]],
    ["invalid_request", [400, "Manual transition request is invalid."]],
    ["task_not_found", [404, "Task not found."]],
    ["stale_task", [409, "This task changed. Review its current state and try again."]],
    ["invalid_transition", [409, "This task can no longer be changed manually."]],
    ["idempotency_conflict", [409, "This manual action ID was already used."]],
    ["body_too_large", [413, "Request body is too large."]],
    ["unsupported_media_type", [415, "Request content type must be application/json."]],
    ["ELOCKED", [503, "TaskChef is busy updating the workspace. Try again."]],
  ]);
  const definition = definitions.get(error?.code);
  const [status, message] = definition ?? [500, "Dashboard request failed."];
  return {
    status,
    body: {
      code: error?.code === "ELOCKED"
        ? "workspace_busy"
        : (definition ? error.code : "dashboard_error"),
      message,
      ...(error?.task ? { task: taskDetailProjection(error.task) } : {}),
    },
  };
}

function ssePayload(event, value) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

export function writeSseEvent(response, event, value) {
  return response.write(ssePayload(event, value));
}

export function createSseClient(response, {
  drainTimeoutMs = 5_000,
  onClose = () => {},
} = {}) {
  let blocked = false;
  let closed = false;
  let drainTimer = null;
  let queuedPayload = null;
  const drained = () => {
    blocked = false;
    clearTimeout(drainTimer);
    drainTimer = null;
    const payload = queuedPayload;
    queuedPayload = null;
    if (payload !== null) client.write(payload);
  };
  const client = {
    get blocked() { return blocked; },
    write(payload) {
      if (closed) return false;
      if (blocked) {
        queuedPayload = payload;
        return false;
      }
      const accepted = response.write(payload);
      if (!accepted) {
        blocked = true;
        response.once("drain", drained);
        drainTimer = setTimeout(() => client.close(), drainTimeoutMs);
        drainTimer.unref?.();
      }
      return accepted;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(drainTimer);
      queuedPayload = null;
      response.off("drain", drained);
      response.destroy();
      onClose();
    },
  };
  return client;
}

function publicMonitorError() {
  return {
    message: "The task log is temporarily unavailable. Showing the last valid snapshot.",
  };
}

export async function createDashboardServer({
  archiveEnabled = CODEX_CHAT_ARCHIVE_ENABLED,
  archiveThread = archiveThreadInCodex,
  discoverArchiveCli = discoverBundledCodexCli,
  workspace,
  host = "127.0.0.1",
  maxEventClients = DEFAULT_MAX_EVENT_CLIENTS,
  port = 3210,
  monitorOptions = {},
  openProject = null,
  openThread = null,
  launcher = "standalone",
  taskchefVersion = TASKCHEF_VERSION,
  serverVersion = DASHBOARD_SERVER_VERSION,
  usageTracker = null,
  control = null,
} = {}) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("dashboard host must be a loopback address");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("dashboard port must be an integer from 0 to 65535");
  }
  if (!Number.isInteger(maxEventClients) || maxEventClients < 0) {
    throw new Error("dashboard event-client limit must be a non-negative integer");
  }
  if (!new Set(["mcp", "standalone"]).has(launcher)) {
    throw new Error("dashboard launcher must be mcp or standalone");
  }
  if (control !== null && (launcher !== "mcp"
      || !validDashboardControlSecret(control?.secret)
      || typeof control?.onShutdown !== "function")) {
    throw new Error("dashboard control requires a valid MCP ownership controller");
  }
  const monitor = new DashboardMonitor(workspace, monitorOptions);
  await monitor.start();
  const taskUsageTracker = usageTracker ?? createUsageTracker({ workspace: monitor.workspace });
  const identity = Object.freeze({
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion,
    serverVersion,
    workspace: monitor.workspace,
    launcher,
  });
  if (Buffer.byteLength(`${JSON.stringify(identity)}\n`) > DASHBOARD_HEALTH_MAX_BYTES) {
    monitor.close();
    throw new Error("dashboard identity exceeds the health response limit");
  }
  const clients = new Set();
  const archiveRequests = new Set();
  const controlNonces = new Set();
  let allowedAuthority;
  let allowedOrigin;

  const broadcast = (event, value) => {
    const payload = ssePayload(event, value);
    for (const client of clients) client.write(payload);
  };
  const snapshotListener = (snapshot) => broadcast("snapshot", snapshot);
  const errorListener = () => broadcast("dashboard-error", publicMonitorError());
  monitor.on("snapshot", snapshotListener);
  monitor.on("monitorError", errorListener);

  const handleRequest = async (request, response) => {
    const method = request.method ?? "GET";
    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      sendJson(response, 400, { message: "Malformed request target." });
      return;
    }
    if (request.headers.host !== allowedAuthority) {
      sendJson(response, 421, { message: "Misdirected request." });
      return;
    }
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      response.writeHead(405, { Allow: "GET, HEAD, POST" });
      response.end();
      return;
    }

    if (url.pathname === DASHBOARD_HEALTH_PATH && (method === "GET" || method === "HEAD")) {
      if (method === "HEAD") {
        response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
        response.end();
      } else {
        sendJson(response, 200, identity);
      }
      return;
    }

    if (url.pathname === DASHBOARD_CONTROL_CHALLENGE_PATH && method === "GET") {
      const nonce = url.searchParams.get("nonce");
      if (!control || !validDashboardControlNonce(nonce)) {
        sendJson(response, control ? 400 : 404, { message: "Not found." });
        return;
      }
      sendJson(response, 200, {
        schemaVersion: 1,
        nonce,
        proof: dashboardControlProof(control.secret, "challenge", nonce),
      });
      return;
    }

    if (url.pathname === DASHBOARD_CONTROL_SHUTDOWN_PATH && method === "POST") {
      if (!control) {
        sendJson(response, 404, { message: "Not found." });
        return;
      }
      const body = await readBoundedJsonBody(request);
      const nonce = body?.nonce;
      if (!verifyDashboardControlProof(control.secret, "shutdown", nonce, body?.proof)) {
        sendJson(response, 403, { message: "Dashboard control authentication failed." });
        return;
      }
      if (controlNonces.has(nonce)) {
        sendJson(response, 409, { message: "Dashboard control credential was already used." });
        return;
      }
      controlNonces.add(nonce);
      sendJson(response, 202, { schemaVersion: 1, accepted: true });
      setImmediate(() => { void control.onShutdown().catch(() => {}); });
      return;
    }

    if (url.pathname === "/api/snapshot" && (method === "GET" || method === "HEAD")) {
      if (method === "HEAD") {
        response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
        response.end();
      } else {
        sendJson(response, 200, monitor.snapshot());
      }
      return;
    }

    if (url.pathname === "/api/events" && method === "GET") {
      if (clients.size >= maxEventClients) {
        sendJson(response, 503, { message: "Dashboard event-stream limit reached." });
        return;
      }
      response.writeHead(200, {
        ...securityHeaders("text/event-stream; charset=utf-8"),
        Connection: "keep-alive",
      });
      let client;
      client = createSseClient(response, {
        onClose: () => {
          clearInterval(client.heartbeat);
          clients.delete(client);
        },
      });
      clients.add(client);
      client.write(`retry: 2000\n\n${ssePayload("snapshot", monitor.snapshot())}`);
      client.heartbeat = setInterval(() => {
        if (!client.blocked) client.write(": heartbeat\n\n");
      }, 15_000);
      const { heartbeat } = client;
      heartbeat.unref?.();
      request.on("close", () => client.close());
      response.on("error", () => client.close());
      return;
    }

    const detailMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9._-]+)$/);
    if (detailMatch && (method === "GET" || method === "HEAD")) {
      const task = monitor.tasks.find((candidate) => candidate.id === detailMatch[1]);
      if (!task) {
        sendJson(response, 404, { message: "Task not found." });
        return;
      }
      if (method === "HEAD") {
        response.writeHead(200, securityHeaders("application/json; charset=utf-8"));
        response.end();
      } else {
        const usage = await taskUsageTracker.get(task).catch(() => ({
          status: "unavailable",
          reason: "Task usage is temporarily unavailable.",
          task: null,
          turns: {},
        }));
        sendJson(response, 200, {
          schemaVersion: 1,
          task: { ...taskDetailProjection(task), usage },
        });
      }
      return;
    }

    const transitionMatch = url.pathname.match(
      /^\/api\/tasks\/([a-zA-Z0-9._-]+)\/manual-transition$/,
    );
    if (transitionMatch && method === "POST") {
      if (request.headers.origin !== allowedOrigin) {
        sendJson(response, 403, {
          code: "invalid_origin",
          message: "Dashboard origin validation failed.",
        });
        return;
      }
      try {
        const body = await readBoundedJsonBody(request);
        const result = await manuallyTransitionTask(
          monitor.workspace,
          transitionMatch[1],
          manualTransitionInput(body),
        );
        await monitor.refresh({ force: true }).catch(() => {});
        sendJson(response, 200, {
          schemaVersion: 1,
          task: taskDetailProjection(result.task),
          idempotent: result.idempotent,
        });
      } catch (error) {
        const failure = manualTransitionErrorResponse(error);
        sendJson(response, failure.status, failure.body);
      }
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9._-]+)\/open-codex$/);
    if (taskMatch && method === "POST") {
      if (request.headers.origin !== allowedOrigin) {
        sendJson(response, 403, { message: "Dashboard origin validation failed." });
        return;
      }
      const task = monitor.tasks.find((candidate) => candidate.id === taskMatch[1]);
      if (!task) {
        sendJson(response, 404, { message: "Task not found." });
        return;
      }
      try {
        if (isCodexThreadDeepLinkId(task.threadId)) {
          if (openThread) await openThread(task.threadId);
          else await openThreadInCodex(task.threadId);
          sendJson(response, 202, {});
          return;
        }
        const trustedProject = (await readConfig(monitor.workspace, { checkPaths: false })).projects
          .find((project) => project.path === task.project.path);
        if (!trustedProject) {
          sendJson(response, 409, {
            message: "This historical task no longer matches a configured project.",
          });
          return;
        }
        const canonicalProjectPath = trustedProject.isGitRepository
          ? await canonicalGitRoot(trustedProject.path)
          : await canonicalDirectory(trustedProject.path);
        if (canonicalProjectPath !== trustedProject.path) {
          sendJson(response, 409, {
            message: "This configured project has moved. Repair the TaskChef project first.",
          });
          return;
        }
        if (openProject) await openProject(canonicalProjectPath);
        else await openWorkspaceInCodex(canonicalProjectPath);
        sendJson(response, 202, {
          message: task.threadId
            ? "Opened the project in Codex; this thread ID cannot use direct navigation."
            : "Opened the project in Codex; this task does not yet have a thread ID.",
        });
      } catch {
        sendJson(response, 503, {
          message: "Codex could not be opened. Open the project and select the recorded thread instead.",
        });
      }
      return;
    }

    const archiveMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9._-]+)\/archive-codex$/);
    if (archiveMatch && method === "POST") {
      if (!archiveEnabled) {
        sendJson(response, 404, { message: "Chat archiving is not available." });
        return;
      }
      if (request.headers.origin !== allowedOrigin) {
        sendJson(response, 403, { message: "Dashboard origin validation failed." });
        return;
      }
      const taskId = archiveMatch[1];
      const visibleTask = monitor.tasks.find((candidate) => candidate.id === taskId);
      if (!visibleTask) {
        sendJson(response, 404, { message: "Task not found." });
        return;
      }
      if (!isCodexThreadDeepLinkId(visibleTask.threadId)) {
        sendJson(response, 409, { message: "This task does not have an archivable Codex chat." });
        return;
      }
      if (visibleTask.status === "working") {
        sendJson(response, 409, { message: "Working tasks cannot be archived from the dashboard." });
        return;
      }
      if (archiveRequests.has(taskId)) {
        sendJson(response, 409, { message: "This Codex chat is already being archived." });
        return;
      }
      archiveRequests.add(taskId);
      let releaseWorkspaceLock = null;
      try {
        const cli = await discoverArchiveCli();
        releaseWorkspaceLock = await acquireWorkspaceLock(monitor.workspace);
        let task;
        try {
          task = await readTask(monitor.workspace, taskId);
        } catch (error) {
          if (/^task not found:/.test(error?.message ?? "")) {
            sendJson(response, 404, { message: "Task not found." });
            return;
          }
          throw error;
        }
        if (!isCodexThreadDeepLinkId(task.threadId)) {
          sendJson(response, 409, { message: "This task does not have an archivable Codex chat." });
          return;
        }
        if (task.status === "working") {
          sendJson(response, 409, { message: "Working tasks cannot be archived from the dashboard." });
          return;
        }
        await archiveThread(task.threadId, { cli, timeoutMs: 4_000 });
        sendJson(response, 200, {
          message: "Archived the Codex chat. TaskChef history remains available.",
          status: "archived",
        });
      } catch (error) {
        if (error?.killed || error?.code === "ETIMEDOUT") {
          sendJson(response, 504, { message: "Codex chat archiving timed out. Try again." });
        } else if (/requires the Codex CLI bundled/i.test(error?.message ?? "")) {
          sendJson(response, 503, {
            message: "Chat archiving requires the Codex CLI bundled with the ChatGPT or Codex desktop app.",
          });
        } else {
          sendJson(response, 409, {
            message: "Codex could not archive this chat. It may be active, already archived, or stored on another host or profile.",
          });
        }
      } finally {
        await releaseWorkspaceLock?.();
        archiveRequests.delete(taskId);
      }
      return;
    }

    if (method === "POST") {
      sendJson(response, 404, { message: "Not found." });
      return;
    }

    const staticFile = STATIC_FILES.get(url.pathname);
    if (!staticFile) {
      sendJson(response, 404, { message: "Not found." });
      return;
    }
    const [filePath, contentType] = staticFile;
    const body = await readFile(filePath);
    response.writeHead(200, securityHeaders(contentType));
    response.end(method === "HEAD" ? undefined : body);
  };

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { message: "Dashboard request failed." });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  }).catch((error) => {
    monitor.close();
    throw error;
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  allowedAuthority = dashboardAuthority(host, boundPort);
  allowedOrigin = `http://${allowedAuthority}`;
  return {
    host,
    port: boundPort,
    origin: allowedOrigin,
    url: `${allowedOrigin}/`,
    identity,
    monitor,
    get eventClientCount() { return clients.size; },
    async close() {
      monitor.off("snapshot", snapshotListener);
      monitor.off("monitorError", errorListener);
      monitor.close();
      for (const client of clients) client.close();
      const closed = new Promise((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}
