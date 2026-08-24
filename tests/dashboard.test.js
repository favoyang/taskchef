import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DashboardMonitor,
  addProject,
  createDashboardServer,
  dashboardAuthority,
  initializeWorkspace,
  recordTask,
  reportTaskResult,
  resolveTask,
  sortTasksByMeaningfulUpdate,
} from "../index.js";
import {
  createSseClient,
  readBoundedTaskLog,
  writeSseEvent,
} from "../src/dashboard.js";
import {
  KNOWN_TASK_STATUSES,
  MAX_NOTIFICATIONS,
  findCurrentTask,
  nextDateFilterRefreshDelay,
  notificationTitle,
  reconcileNotifications,
  taskWithinDateFilter,
} from "../src/dashboard/state.js";
import { openTaskFromControl } from "../src/dashboard/actions.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_THREAD_ID = "019ffb69-57a6-7801-8b7a-8ff4c32a398c";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-dashboard-"));
  const workspace = path.join(root, "dispatcher");
  const project = path.join(root, "project");
  await mkdir(project);
  await initializeWorkspace(workspace);
  await addProject(workspace, {
    name: "example-project",
    path: project,
    description: "Dashboard fixture.",
    githubRepos: [],
  });
  return { workspace, project };
}

function input(project, id, title, threadId) {
  return {
    id,
    project,
    title,
    instruction: `Complete ${title} safely.`,
    threadId,
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for dashboard update");
}

async function rawHttpRequest({ host, port, request }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("dashboard ordering uses the latest meaningful update with stable ties", () => {
  const tasks = [
    { id: "old", createdAt: "2026-08-20T10:00:00.000Z", updatedAt: null },
    { id: "new", createdAt: "2026-08-21T10:00:00.000Z", updatedAt: "2026-08-23T10:00:00.000Z" },
    { id: "tie", createdAt: "2026-08-23T10:00:00.000Z", updatedAt: null },
  ];
  assert.deepEqual(sortTasksByMeaningfulUpdate(tasks).map((task) => task.id), [
    "new", "tie", "old",
  ]);
});

test("dashboard authority omits the normalized HTTP default port", () => {
  assert.equal(dashboardAuthority("127.0.0.1", 80), "127.0.0.1");
  assert.equal(dashboardAuthority("127.0.0.1", 3210), "127.0.0.1:3210");
  assert.equal(dashboardAuthority("::1", 80), "[::1]");
});

test("dashboard date filters use each task's latest meaningful update", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const recent = {
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-24T11:00:00.000Z",
  };
  const threeDaysOld = {
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: null,
  };
  assert.equal(taskWithinDateFilter(recent, "24h", now), true);
  assert.equal(taskWithinDateFilter(threeDaysOld, "24h", now), false);
  assert.equal(taskWithinDateFilter(threeDaysOld, "7d", now), true);
  assert.equal(taskWithinDateFilter(threeDaysOld, "all", now), true);
  assert.equal(taskWithinDateFilter(recent, "unknown", now), false);
  assert.equal(nextDateFilterRefreshDelay([recent], "24h", now), 23 * 60 * 60 * 1_000 + 1);
  assert.equal(nextDateFilterRefreshDelay([threeDaysOld], "24h", now), null);
  assert.equal(nextDateFilterRefreshDelay([recent], "all", now), null);
});

test("dashboard exposes stable task status filters", () => {
  assert.deepEqual(KNOWN_TASK_STATUSES, [
    "working", "needs input", "completed", "failed", "unresolved",
  ]);
});

test("dashboard task controls isolate clicks and share the supported Codex action", async () => {
  const requests = [];
  const messages = [];
  let stopped = false;
  const control = { disabled: false };
  await openTaskFromControl({
    currentTarget: control,
    stopPropagation: () => { stopped = true; },
  }, FIRST_ID, {
    fetchAction: async (url, options) => {
      requests.push({ url, options, disabledDuringRequest: control.disabled });
      return { json: async () => ({ message: "Opened this task in Codex." }) };
    },
    showMessage: (message) => messages.push(message),
  });
  assert.equal(stopped, true);
  assert.deepEqual(requests, [{
    url: `/api/tasks/${FIRST_ID}/open-codex`,
    options: { method: "POST" },
    disabledDuringRequest: true,
  }]);
  assert.deepEqual(messages, ["Opened this task in Codex."]);
  assert.equal(control.disabled, false);
});

test("dashboard notification titles describe the task's latest state", () => {
  assert.equal(notificationTitle({ status: "completed" }, "changed"), "Task completed");
  assert.equal(notificationTitle({ status: "needs_input" }, "changed"), "Task needs input");
  assert.equal(notificationTitle({ status: null }, "changed"), "Task unresolved");
  assert.equal(notificationTitle({ status: "working" }, "new"), "New task");
});

test("notification state stays bounded and resolves older notices to current tasks", () => {
  const baseTask = {
    id: FIRST_ID,
    threadId: "thread-one",
    status: "working",
    summary: null,
    turnId: null,
    updatedAt: "2026-08-20T10:00:00.000Z",
    updatedBy: "dispatcher",
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    signatures: new Map(),
  }, [baseTask], 1);
  const snapshots = [];
  for (let revision = 2; revision <= MAX_NOTIFICATIONS + 12; revision += 1) {
    const task = {
      ...baseTask,
      status: "completed",
      summary: `Result ${revision}`,
      turnId: `turn-${revision}`,
      updatedAt: `2026-08-23T10:${String(revision).padStart(2, "0")}:00.000Z`,
      updatedBy: "mcp",
    };
    snapshots.push(task);
    notificationState = reconcileNotifications({
      initialized: true,
      ...notificationState,
    }, [task], revision);
  }
  assert.equal(notificationState.notifications.length, MAX_NOTIFICATIONS);
  const oldestRetained = notificationState.notifications.at(-1);
  const currentTask = findCurrentTask([snapshots.at(-1)], oldestRetained.taskId);
  assert.equal(currentTask.summary, `Result ${MAX_NOTIFICATIONS + 12}`);
});

test("SSE backpressure coalesces writes and disconnects clients that never drain", async () => {
  const writes = [];
  let destroyed = false;
  const response = Object.assign(new EventEmitter(), {
    write: (payload) => {
      writes.push(payload);
      return false;
    },
    destroy: () => { destroyed = true; },
  });
  assert.equal(writeSseEvent(response, "snapshot", { tasks: [] }), false);
  assert.equal(destroyed, false);
  const client = createSseClient(response, { drainTimeoutMs: 5 });
  assert.equal(client.write("first snapshot"), false);
  assert.equal(client.blocked, true);
  assert.equal(client.write("coalesced snapshot"), false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(destroyed, true);
  assert.deepEqual(writes, ["event: snapshot\ndata: {\"tasks\":[]}\n\n", "first snapshot"]);
});

test("SSE backpressure flushes only the newest queued snapshot after drain", () => {
  const writes = [];
  let accepting = false;
  const response = Object.assign(new EventEmitter(), {
    write: (payload) => {
      writes.push(payload);
      return accepting;
    },
    destroy: () => {},
  });
  const client = createSseClient(response);
  client.write("initial snapshot");
  client.write("superseded snapshot");
  client.write("latest snapshot");
  accepting = true;
  response.emit("drain");
  assert.deepEqual(writes, ["initial snapshot", "latest snapshot"]);
});

test("dashboard monitor accepts atomic task changes and retains its last valid snapshot", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, input(project, FIRST_ID, "First task", "thread-one"), {
    now: "2026-08-20T10:00:00.000Z",
  });
  const monitor = new DashboardMonitor(workspace, { pollIntervalMs: 60_000 });
  const errors = [];
  monitor.on("monitorError", (error) => errors.push(error));
  await monitor.start();
  assert.equal(monitor.snapshot().tasks[0].status, "working");

  await reportTaskResult(workspace, {
    taskId: FIRST_ID,
    threadId: "thread-one",
    turnId: "turn-one",
    status: "completed",
    summary: "The task completed.",
  }, { now: "2026-08-23T10:00:00.000Z" });
  await waitFor(() => monitor.snapshot().tasks[0].status === "completed");
  assert.equal(monitor.snapshot().tasks[0].status, "completed");

  const validSnapshot = monitor.snapshot();
  const validLog = await readFile(path.join(workspace, "tasks.jsonl"), "utf8");
  const recoveredSnapshots = [];
  monitor.on("snapshot", (snapshot) => recoveredSnapshots.push(snapshot));
  await writeFile(path.join(workspace, "tasks.jsonl"), "not-json\n");
  assert.equal(await monitor.refresh({ force: true }), false);
  assert.deepEqual(monitor.snapshot().tasks, validSnapshot.tasks);
  assert.equal(monitor.snapshot().healthy, false);
  assert.match(errors.at(-1).message, /invalid JSON/);
  await writeFile(path.join(workspace, "tasks.jsonl"), validLog);
  assert.equal(await monitor.refresh({ force: true }), false);
  assert.equal(recoveredSnapshots.length, 1);
  assert.deepEqual(recoveredSnapshots[0].tasks, validSnapshot.tasks);
  assert.equal(recoveredSnapshots[0].healthy, true);
  monitor.maxFileBytes = 1;
  assert.equal(await monitor.refresh({ force: true }), false);
  assert.match(errors.at(-1).message, /limit of 1 bytes/);
  assert.deepEqual(monitor.snapshot().tasks, validSnapshot.tasks);
  monitor.close();
});

test("dashboard monitor retries when an atomic replacement races its read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-dashboard-race-"));
  const oldTask = {
    id: FIRST_ID,
    title: "Racing task",
    instruction: "Complete the racing task.",
    summary: null,
    threadId: "thread-one",
    turnId: null,
    project: {
      name: "example-project",
      path: root,
      description: null,
      githubRepos: [],
    },
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  };
  const newTask = {
    ...oldTask,
    updatedAt: "2026-08-23T10:00:00.000Z",
  };
  const fingerprints = ["v1", "v1", "v1", "v2", "v2", "v2"];
  const snapshots = [
    { fingerprint: "v1", tasks: [oldTask] },
    { fingerprint: "v1", tasks: [oldTask] },
    { fingerprint: "v2", tasks: [newTask] },
  ];
  const monitor = new DashboardMonitor(root, {
    fingerprint: async () => fingerprints.shift(),
    pollIntervalMs: 60_000,
    readSnapshot: async () => snapshots.shift(),
  });
  await monitor.start();
  assert.equal(monitor.snapshot().tasks[0].updatedAt, oldTask.updatedAt);
  await monitor.refresh({ force: true });
  assert.equal(monitor.snapshot().tasks[0].updatedAt, newTask.updatedAt);
  assert.deepEqual(fingerprints, []);
  assert.deepEqual(snapshots, []);
  monitor.close();
});

test("watcher failures reconnect without marking a healthy snapshot stale", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, input(project, FIRST_ID, "Watched task", "thread-one"));
  const watchers = [];
  const watchDirectory = () => {
    const watcher = Object.assign(new EventEmitter(), {
      close() { this.closed = true; },
      closed: false,
    });
    watchers.push(watcher);
    return watcher;
  };
  const monitor = new DashboardMonitor(workspace, {
    pollIntervalMs: 60_000,
    watchDirectory,
    watchReconnectMs: 5,
  });
  const watcherErrors = [];
  const monitorErrors = [];
  monitor.on("watcherError", (error) => watcherErrors.push(error));
  monitor.on("monitorError", (error) => monitorErrors.push(error));
  await monitor.start();
  watchers[0].emit("error", new Error("watcher failed"));
  await waitFor(() => watchers.length === 2);
  assert.equal(watchers[0].closed, true);
  assert.equal(watcherErrors.length, 1);
  assert.equal(monitorErrors.length, 0);
  assert.equal(monitor.snapshot().healthy, true);
  assert.equal(monitor.snapshot().revision, 1);
  monitor.close();
});

test("bounded task-log reads stay on one descriptor across atomic replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-dashboard-bounded-"));
  const taskLog = path.join(root, "tasks.jsonl");
  const oversizedReplacement = path.join(root, "replacement.jsonl");
  await writeFile(taskLog, "small\n");
  await writeFile(oversizedReplacement, `${"x".repeat(64)}\n`);
  const snapshot = await readBoundedTaskLog(taskLog, 16, {
    afterOpen: () => rename(oversizedReplacement, taskLog),
  });
  assert.equal(snapshot.content, "small\n");
  await assert.rejects(readBoundedTaskLog(taskLog, 16), /limit of 16 bytes/);
});

test("manual thread resolution advances meaningful ordering", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "Older unresolved task", null),
    instruction: `<!-- taskchef_id=${FIRST_ID} -->\n\nResolve this task.`,
  }, { now: "2026-08-20T10:00:00.000Z" });
  await recordTask(workspace, input(project, SECOND_ID, "Newer task", "thread-two"), {
    now: "2026-08-21T10:00:00.000Z",
  });
  const monitor = new DashboardMonitor(workspace, { pollIntervalMs: 60_000 });
  await monitor.start();
  assert.equal(monitor.snapshot().tasks[0].id, SECOND_ID);

  const resolved = await resolveTask(workspace, FIRST_ID, "thread-one", {
    now: "2026-08-23T10:00:00.000Z",
  });
  assert.equal(resolved.updatedAt, "2026-08-23T10:00:00.000Z");
  assert.equal(resolved.updatedBy, "dispatcher");
  await waitFor(() => monitor.snapshot().tasks[0].id === FIRST_ID);
  monitor.close();
});

test("observed legacy resolution advances meaningful ordering", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "Older legacy task", null),
    instruction: `<!-- taskchef_id=${FIRST_ID} -->\n\nResolve this legacy task.`,
  }, { now: "2026-08-20T10:00:00.000Z" });
  await recordTask(workspace, input(project, SECOND_ID, "Newer task", "thread-two"), {
    now: "2026-08-21T10:00:00.000Z",
  });
  const taskLog = path.join(workspace, "tasks.jsonl");
  const records = (await readFile(taskLog, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const { githubRepos, ...legacyProject } = records[0].project;
  const {
    status,
    summary,
    turnId,
    updatedAt,
    updatedBy,
    ...legacyRecord
  } = records[0];
  records[0] = {
    ...legacyRecord,
    schemaVersion: 1,
    project: { ...legacyProject, githubRepo: githubRepos[0] ?? null },
  };
  await writeFile(taskLog, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const monitor = new DashboardMonitor(workspace, { pollIntervalMs: 60_000 });
  await monitor.start();
  assert.equal(monitor.snapshot().tasks[0].id, SECOND_ID);
  const resolutionStartedAt = Date.now();
  await resolveTask(workspace, FIRST_ID, "thread-one");
  await waitFor(() => monitor.snapshot().tasks[0].id === FIRST_ID);
  const resolvedTask = monitor.snapshot().tasks[0];
  assert.equal(resolvedTask.updatedAt, null);
  assert.ok(Date.parse(resolvedTask.meaningfulUpdatedAt) >= resolutionStartedAt);
  assert.equal(taskWithinDateFilter(resolvedTask, "24h"), true);
  monitor.close();
});

test("dashboard server serves independent clients without sessions and protects local actions", async () => {
  const { workspace, project } = await fixture();
  const staleProject = path.join(path.dirname(workspace), "stale-project");
  await mkdir(staleProject);
  await addProject(workspace, {
    name: "stale-project",
    path: staleProject,
    description: "Unrelated moved project.",
    githubRepos: [],
  });
  await recordTask(workspace, input(
    project,
    FIRST_ID,
    "<img src=x onerror=alert(1)>",
    FIRST_THREAD_ID,
  ));
  await rename(staleProject, `${staleProject}-moved`);
  let openedProject = null;
  let openedThread = null;
  const server = await createDashboardServer({
    workspace,
    maxEventClients: 1,
    port: 0,
    monitorOptions: { pollIntervalMs: 60_000 },
    openProject: async (projectPath) => { openedProject = projectPath; },
    openThread: async (threadId) => { openedThread = threadId; },
  });

  try {
    assert.equal(new URL(server.url).search, "");
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(page.headers.get("x-frame-options"), /DENY/);
    const html = await page.text();
    assert.doesNotMatch(html, /onerror=alert/);

    const snapshotResponse = await fetch(`${server.origin}/api/snapshot`);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.tasks[0].title, "<img src=x onerror=alert(1)>");
    assert.equal(snapshot.tasks[0].id, FIRST_ID);

    const rejected = await fetch(`${server.origin}/api/tasks/${FIRST_ID}/open-codex`, {
      method: "POST",
      headers: { Origin: "http://example.invalid" },
    });
    assert.equal(rejected.status, 403);
    assert.equal(openedProject, null);
    assert.equal(openedThread, null);

    const accepted = await fetch(`${server.origin}/api/tasks/${FIRST_ID}/open-codex`, {
      method: "POST",
      headers: { Origin: server.origin },
    });
    assert.equal(accepted.status, 202);
    assert.equal(openedThread, FIRST_THREAD_ID);
    assert.equal(openedProject, null);

    const eventResponse = await fetch(`${server.origin}/api/events`);
    const reader = eventResponse.body.getReader();
    const firstEvent = new TextDecoder().decode((await reader.read()).value);
    assert.match(firstEvent, /event: snapshot/);
    assert.match(firstEvent, new RegExp(FIRST_ID));
    const cappedEvent = await fetch(`${server.origin}/api/events`);
    assert.equal(cappedEvent.status, 503);
    await reader.cancel();
    await waitFor(() => server.eventClientCount === 0);

    const taskLog = path.join(workspace, "tasks.jsonl");
    const validLog = await readFile(taskLog, "utf8");
    await writeFile(taskLog, "not-json\n");
    await server.monitor.refresh({ force: true });
    const unhealthySnapshot = await fetch(`${server.origin}/api/snapshot`);
    assert.equal((await unhealthySnapshot.json()).healthy, false);
    const unhealthyEvents = await fetch(`${server.origin}/api/events`);
    const unhealthyReader = unhealthyEvents.body.getReader();
    const unhealthyEvent = new TextDecoder().decode((await unhealthyReader.read()).value);
    assert.match(unhealthyEvent, /event: snapshot/);
    assert.match(unhealthyEvent, /"healthy":false/);
    await unhealthyReader.cancel();
    await writeFile(taskLog, validLog);
    await server.monitor.refresh({ force: true });

    const forged = JSON.parse(validLog.trim());
    forged.project.path = workspace;
    forged.threadId = "legacy-thread";
    await writeFile(taskLog, `${JSON.stringify(forged)}\n`);
    await server.monitor.refresh({ force: true });
    openedProject = null;
    openedThread = null;
    const forgedAction = await fetch(`${server.origin}/api/tasks/${FIRST_ID}/open-codex`, {
      method: "POST",
      headers: { Origin: server.origin },
    });
    assert.equal(forgedAction.status, 409);
    assert.equal(openedProject, null);
    assert.equal(openedThread, null);

    const malformed = await rawHttpRequest({
      host: server.host,
      port: server.port,
      request: `GET //[ HTTP/1.1\r\nHost: ${new URL(server.origin).host}\r\nConnection: close\r\n\r\n`,
    });
    assert.match(malformed, /^HTTP\/1\.1 400 Bad Request/);
    assert.equal((await fetch(`${server.origin}/api/snapshot`)).status, 200);

    const invalidHost = await rawHttpRequest({
      host: server.host,
      port: server.port,
      request: "GET /api/snapshot HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n",
    });
    assert.match(invalidHost, /^HTTP\/1\.1 421 Misdirected Request/);
  } finally {
    await server.close();
  }
});

test("dashboard opens a valid Codex thread after its recorded project moves", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, input(project, FIRST_ID, "Historical task", FIRST_THREAD_ID));
  await rename(project, `${project}-moved`);
  let openedThread = null;
  const server = await createDashboardServer({
    workspace,
    port: 0,
    monitorOptions: { pollIntervalMs: 60_000 },
    openThread: async (threadId) => { openedThread = threadId; },
  });
  try {
    const response = await fetch(`${server.origin}/api/tasks/${FIRST_ID}/open-codex`, {
      method: "POST",
      headers: { Origin: server.origin },
    });
    assert.equal(response.status, 202);
    assert.equal(openedThread, FIRST_THREAD_ID);
  } finally {
    await server.close();
  }
});

test("dashboard open action preserves the unresolved task project fallback", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "Unresolved task", null),
    instruction: `<!-- taskchef_id=${FIRST_ID} -->\n\nComplete the unresolved task safely.`,
  });
  let openedProject = null;
  const server = await createDashboardServer({
    workspace,
    port: 0,
    monitorOptions: { pollIntervalMs: 60_000 },
    openProject: async (projectPath) => { openedProject = projectPath; },
  });
  try {
    const response = await fetch(`${server.origin}/api/tasks/${FIRST_ID}/open-codex`, {
      method: "POST",
      headers: { Origin: server.origin },
    });
    assert.equal(response.status, 202);
    assert.equal(await realpath(openedProject), await realpath(project));
    assert.equal((await response.json()).message,
      "Opened the project in Codex; this task does not yet have a thread ID.");
  } finally {
    await server.close();
  }
});

test("dashboard server rejects non-loopback binding and malformed startup logs", async () => {
  const { workspace } = await fixture();
  await assert.rejects(
    createDashboardServer({ workspace, host: "0.0.0.0", port: 0 }),
    /loopback address/,
  );
  await assert.rejects(
    createDashboardServer({ workspace, host: "localhost", port: 0 }),
    /loopback address/,
  );
  await writeFile(path.join(workspace, "tasks.jsonl"), "{}\n");
  await assert.rejects(
    createDashboardServer({ workspace, port: 0 }),
    /could not read a valid task log/,
  );
});

test("in-app and external-style clients use one dashboard concurrently without shared state", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, input(project, FIRST_ID, "Shared task", "thread-one"));
  const server = await createDashboardServer({ workspace, port: 0 });
  try {
    const [inAppPage, externalPage, inAppEvents, externalEvents] = await Promise.all([
      fetch(server.url, { headers: { "User-Agent": "Codex in-app browser" } }),
      fetch(server.url, { headers: { "User-Agent": "External browser" } }),
      fetch(`${server.origin}/api/events`, { headers: { "User-Agent": "Codex in-app browser" } }),
      fetch(`${server.origin}/api/events`, { headers: { "User-Agent": "External browser" } }),
    ]);
    assert.equal(inAppPage.status, 200);
    assert.equal(externalPage.status, 200);
    assert.equal(inAppPage.headers.get("set-cookie"), null);
    assert.equal(externalPage.headers.get("set-cookie"), null);
    for (const response of [inAppEvents, externalEvents]) {
      const reader = response.body.getReader();
      const event = new TextDecoder().decode((await reader.read()).value);
      assert.match(event, /event: snapshot/);
      assert.match(event, new RegExp(FIRST_ID));
      await reader.cancel();
    }
  } finally {
    await server.close();
  }
});

test("dashboard assets remain part of the shipped source tree", async () => {
  const html = await readFile(path.resolve("src/dashboard/index.html"), "utf8");
  const script = await readFile(path.resolve("src/dashboard/app.js"), "utf8");
  const actionScript = await readFile(path.resolve("src/dashboard/actions.js"), "utf8");
  const stateScript = await readFile(path.resolve("src/dashboard/state.js"), "utf8");
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="clear-notifications"/);
  assert.match(html, /id="date-filter"/);
  assert.match(html, /<title>TaskChef dashboard<\/title>/);
  assert.match(html, /<h1>TaskChef dashboard<\/h1>/);
  assert.doesNotMatch(html, />Task dashboard</);
  assert.match(script, /textContent = task\.instruction/);
  assert.match(script, /openTask\.type = "button"/);
  assert.match(script, /openTask\.textContent = "Open task"/);
  assert.match(script, /openTask\.setAttribute\("aria-label", `Open \$\{task\.title\} in Codex`\)/);
  assert.match(script, /openTaskFromControl\(event, task\.id/);
  assert.match(actionScript, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(script, /\bstatusLabel\(/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(stateScript, /MAX_NOTIFICATIONS = 50/);
});
