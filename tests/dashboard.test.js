import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DashboardMonitor,
  addProject,
  createDashboardManager,
  createDashboardServer,
  dashboardAuthority,
  initializeWorkspace,
  linkTask,
  recordTask,
  reportTaskResult,
  reportTaskState,
  sortTasksByMeaningfulUpdate,
  readDashboardIdentity,
} from "../index.js";
import {
  createSseClient,
  readBoundedTaskLog,
  writeSseEvent,
} from "../src/dashboard.js";
import {
  clearNotifications,
  dismissNotification,
  KNOWN_TASK_STATUSES,
  MAX_NOTIFICATIONS,
  findCurrentTask,
  nextDateFilterRefreshDelay,
  notificationDismissLabel,
  notificationOpenLabel,
  notificationSnapshot,
  notificationTitle,
  reconcileNotifications,
  taskWithinDateFilter,
} from "../src/dashboard/state.js";
import { openTaskFromControl } from "../src/dashboard/actions.js";
import {
  RELATIVE_DATE_LIMIT_DAYS,
  RELATIVE_TIME_REFRESH_MS,
  RelativeTimeController,
  formatExactTime,
  formatRelativeTime,
  timestampPresentation,
} from "../src/dashboard/time.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_THREAD_ID = "019ffb69-57a6-7801-8b7a-8ff4c32a398c";
const FIRST_TURN_ID = "01a03275-d530-7043-ab4a-513a1ad6ae1e";
const SECOND_TURN_ID = "01a03275-d531-7043-ab4a-513a1ad6ae1e";

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

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
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

test("dashboard manager starts once and repeated and concurrent ensures reuse it", async () => {
  const { workspace } = await fixture();
  const port = await unusedPort();
  const manager = createDashboardManager({ workspace, port });
  try {
    const concurrent = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);
    assert.deepEqual(concurrent.map((result) => result.action), ["started", "reused", "reused"]);
    assert.equal(concurrent[0].url, `http://127.0.0.1:${port}/`);
    assert.equal(concurrent[0].workspace, await realpath(workspace));
    assert.equal((await manager.ensure()).action, "reused");
  } finally {
    await manager.close();
  }
});

test("dashboard health exposes bounded service identity independently of task snapshots", async () => {
  const { workspace } = await fixture();
  const server = await createDashboardServer({ workspace, port: 0 });
  try {
    const identity = await readDashboardIdentity({ host: server.host, port: server.port });
    assert.deepEqual(identity, server.identity);
    assert.deepEqual(Object.keys(identity).sort(), [
      "schemaVersion", "serverVersion", "service", "taskchefVersion", "workspace",
    ]);
    assert.equal(identity.workspace, await realpath(workspace));
    assert.equal((await fetch(`${server.origin}/api/health`)).headers.get("cache-control"), "no-store");

    await writeFile(path.join(workspace, "tasks.jsonl"), "not-json\n");
    await server.monitor.refresh({ force: true });
    assert.equal((await fetch(`${server.origin}/api/snapshot`).then((r) => r.json())).healthy, false);
    assert.deepEqual(await readDashboardIdentity({ host: server.host, port: server.port }), identity);
  } finally {
    await server.close();
  }
});

test("dashboard manager reuses only the same canonical workspace and exact version", async () => {
  const { workspace } = await fixture();
  const port = await unusedPort();
  const server = await createDashboardServer({ workspace, port });
  const manager = createDashboardManager({ workspace: path.join(workspace, "."), port });
  try {
    const result = await manager.ensure();
    assert.equal(result.action, "reused");
    assert.equal(manager.owned, false);

    const staleManager = createDashboardManager({
      workspace,
      port,
      taskchefVersion: "0.0.0-stale",
    });
    await assert.rejects(
      staleManager.ensure(),
      /unknown, stale, or different-workspace service[\s\S]+will not terminate it/,
    );
    await staleManager.close();
  } finally {
    await manager.close();
    await server.close();
  }
});

test("dashboard manager leaves unknown port occupants running", async () => {
  const { workspace } = await fixture();
  const listener = http.createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("unknown");
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : null;
  const manager = createDashboardManager({ workspace, port });
  try {
    await assert.rejects(
      manager.ensure(),
      /port conflict[\s\S]+HTTP 404[\s\S]+will not terminate it/,
    );
    assert.equal(listener.listening, true);
  } finally {
    await manager.close();
    listener.closeAllConnections?.();
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("dashboard manager rejects invalid initial logs without retaining a listener", async () => {
  const { workspace } = await fixture();
  const port = await unusedPort();
  await writeFile(path.join(workspace, "tasks.jsonl"), "not-json\n");
  const manager = createDashboardManager({ workspace, port });
  await assert.rejects(manager.ensure(), /dashboard could not read a valid task log/);
  assert.equal(manager.owned, false);
  await manager.close();
  await assert.rejects(readDashboardIdentity({ port }), /ECONNREFUSED/);
});

test("closing a dashboard manager releases only its in-process listener", async () => {
  const { workspace } = await fixture();
  const port = await unusedPort();
  const manager = createDashboardManager({ workspace, port });
  await manager.ensure();
  assert.equal((await readDashboardIdentity({ port })).workspace, await realpath(workspace));
  await manager.close();
  await assert.rejects(
    readDashboardIdentity({ port }),
    (error) => error.code === "ECONNREFUSED" || error.code === "ECONNRESET",
  );
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

test("relative task times use deterministic readable thresholds", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const ago = (milliseconds) => new Date(now - milliseconds).toISOString();
  assert.equal(formatRelativeTime(ago(59_999), { now }), "just now");
  assert.equal(formatRelativeTime(ago(60_000), { now }), "1 minute ago");
  assert.equal(formatRelativeTime(ago(2 * 60_000), { now }), "2 minutes ago");
  assert.equal(formatRelativeTime(ago(60 * 60_000), { now }), "1 hour ago");
  assert.equal(formatRelativeTime(ago(2 * 60 * 60_000 + 17 * 60_000), { now }),
    "2 hours 17 minutes ago");
  assert.equal(formatRelativeTime(ago(7 * 60 * 60_000 + 17 * 60_000), { now }),
    "7 hours ago");
  assert.equal(formatRelativeTime(ago(24 * 60 * 60_000), { now }), "1 day ago");
  assert.equal(formatRelativeTime(ago(12 * 24 * 60 * 60_000), { now }), "12 days ago");
  assert.equal(RELATIVE_DATE_LIMIT_DAYS, 30);
  assert.equal(formatRelativeTime(ago(30 * 24 * 60 * 60_000), {
    now,
    locale: "en-US",
    timeZone: "UTC",
  }), "Jul 26, 2026");
});

test("task time formatting is locale aware and handles future, missing, and invalid values", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-08-25T12:04:01.000Z", { now }), "in 5 minutes");
  assert.equal(formatRelativeTime("2026-08-25T12:00:30.000Z", { now }), "just now");
  assert.equal(formatRelativeTime(null, { now }), "—");
  assert.equal(formatRelativeTime("not-a-date", { now }), "—");
  assert.equal(formatExactTime("2026-08-25T12:34:00.000Z", {
    locale: "en-GB",
    timeZone: "UTC",
  }), "25 Aug 2026, 12:34");
  assert.deepEqual(timestampPresentation("invalid", { now }), {
    valid: false,
    label: "—",
    iso: null,
  });
});

test("one relative-time timer refreshes controls and preserves independent toggles across rerenders", () => {
  let now = Date.parse("2026-08-25T12:00:30.000Z");
  let scheduled = null;
  let intervalCount = 0;
  const controller = new RelativeTimeController({
    now: () => now,
    setIntervalFn(callback, delay) {
      intervalCount += 1;
      assert.equal(delay, RELATIVE_TIME_REFRESH_MS);
      scheduled = callback;
      return 7;
    },
  });
  const firstLabels = [];
  const secondLabels = [];
  let firstActive = true;
  controller.register("task:first", "2026-08-25T12:00:00.000Z",
    (value) => firstLabels.push(value), { isActive: () => firstActive });
  controller.register("task:second", "2026-08-25T11:00:30.000Z",
    (value) => secondLabels.push(value));
  assert.equal(intervalCount, 1, "all timestamp controls share one timer");
  assert.equal(firstLabels.at(-1).label, "just now");
  assert.equal(secondLabels.at(-1).label, "1 hour ago");

  now += 60_000;
  scheduled();
  assert.equal(firstLabels.at(-1).label, "1 minute ago");
  controller.toggle("task:first");
  assert.equal(firstLabels.at(-1).exact, true);
  assert.equal(secondLabels.at(-1).exact, false, "each control toggles independently");

  firstActive = false;
  const rerendered = [];
  controller.register("task:first", "2026-08-25T12:00:00.000Z",
    (value) => rerendered.push(value));
  assert.equal(rerendered.at(-1).exact, true, "exact mode survives snapshot rerendering");
  controller.toggle("task:first");
  assert.equal(rerendered.at(-1).exact, false);
  controller.refresh();
  assert.equal(controller.entries.size, 2, "disconnected controls are pruned");
  controller.stop();
});

test("relative-time controller default scheduler remains callable through the controller", () => {
  const controller = new RelativeTimeController({ refreshEveryMs: 60_000 });
  controller.register("default-scheduler", "2026-08-25T12:00:00.000Z", () => {});
  assert.notEqual(controller.timer, null);
  controller.stop();
});

test("dashboard exposes stable task status filters", () => {
  assert.deepEqual(KNOWN_TASK_STATUSES, [
    "working", "needs input", "completed", "failed", "unresolved",
  ]);
});

test("dashboard task controls isolate clicks and keep successful direct opens silent", async () => {
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
      return { json: async () => ({}) };
    },
    showMessage: (message) => messages.push(message),
  });
  assert.equal(stopped, true);
  assert.deepEqual(requests, [{
    url: `/api/tasks/${FIRST_ID}/open-codex`,
    options: { method: "POST" },
    disabledDuringRequest: true,
  }]);
  assert.deepEqual(messages, []);
  assert.equal(control.disabled, false);
});

test("dashboard task controls preserve open fallback and failure messages", async () => {
  const messages = [];
  const control = { disabled: false };
  const responses = [
    "Opened the project in Codex; this task does not yet have a thread ID.",
    "Codex could not be opened. Open the project and select the recorded thread instead.",
  ];
  for (const message of responses) {
    await openTaskFromControl({
      currentTarget: control,
      stopPropagation: () => {},
    }, FIRST_ID, {
      fetchAction: async () => ({ json: async () => ({ message }) }),
      showMessage: (value) => messages.push(value),
    });
  }
  assert.deepEqual(messages, responses);
});

test("dashboard notification labels describe immutable lifecycle events", () => {
  assert.equal(notificationTitle({ event: "created" }), "Task created");
  assert.equal(notificationTitle({ event: "task_started" }), "Task started");
  assert.equal(notificationTitle({ event: "follow_up_started" }), "Follow-up started");
  assert.equal(notificationTitle({ event: "completed" }), "Task completed");
  assert.equal(notificationTitle({ event: "needs_input" }), "Task needs input");
  assert.equal(notificationTitle({ event: "failed" }), "Task failed");
  const mutableTask = {
    id: FIRST_ID,
    title: "Captured title",
    status: "completed",
    summary: "Captured summary.",
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    lastResult: {
      status: "completed",
      summary: "Captured summary.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:00:00.000Z",
    },
  };
  const captured = notificationSnapshot(mutableTask);
  mutableTask.title = "Later title";
  mutableTask.status = "working";
  mutableTask.summary = null;
  assert.equal(captured.title, "Captured title");
  assert.equal(captured.status, "completed");
  assert.equal(captured.summary, "Captured summary.");
});

test("notification snapshots stay immutable across the MarketLake follow-up sequence", () => {
  const baseTask = {
    id: FIRST_ID,
    title: "Continue MarketLake V1",
    threadId: FIRST_THREAD_ID,
    status: "working",
    summary: null,
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    updatedBy: "mcp",
    lastResult: null,
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [baseTask]);
  const sequence = [
    {
      status: "needs_input",
      summary: "Choose the MarketLake import source.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:01:00.000Z",
      lastResult: {
        status: "needs_input",
        summary: "Choose the MarketLake import source.",
        turnId: FIRST_TURN_ID,
        updatedAt: "2026-08-20T10:01:00.000Z",
      },
    },
    {
      status: "working",
      summary: null,
      turnId: SECOND_TURN_ID,
      updatedAt: "2026-08-20T10:02:00.000Z",
      lastResult: {
        status: "needs_input",
        summary: "Choose the MarketLake import source.",
        turnId: FIRST_TURN_ID,
        updatedAt: "2026-08-20T10:01:00.000Z",
      },
    },
    {
      status: "needs_input",
      summary: "Confirm the revised retention window.",
      turnId: SECOND_TURN_ID,
      updatedAt: "2026-08-20T10:03:00.000Z",
      lastResult: {
        status: "needs_input",
        summary: "Confirm the revised retention window.",
        turnId: SECOND_TURN_ID,
        updatedAt: "2026-08-20T10:03:00.000Z",
      },
    },
    {
      status: "working",
      summary: null,
      turnId: "01a03275-d532-7043-ab4a-513a1ad6ae1e",
      updatedAt: "2026-08-20T10:04:00.000Z",
      lastResult: {
        status: "needs_input",
        summary: "Confirm the revised retention window.",
        turnId: SECOND_TURN_ID,
        updatedAt: "2026-08-20T10:03:00.000Z",
      },
    },
  ];
  for (const update of sequence) {
    const task = { ...baseTask, ...update };
    notificationState = reconcileNotifications({
      initialized: true,
      ...notificationState,
    }, [task]);
  }
  assert.deepEqual(notificationState.notifications.map((notification) => ({
    event: notification.event,
    turnId: notification.turnId,
    summary: notification.summary,
    timestamp: notification.timestamp,
  })), [
    {
      event: "follow_up_started",
      turnId: "01a03275-d532-7043-ab4a-513a1ad6ae1e",
      summary: null,
      timestamp: "2026-08-20T10:04:00.000Z",
    },
    {
      event: "needs_input",
      turnId: SECOND_TURN_ID,
      summary: "Confirm the revised retention window.",
      timestamp: "2026-08-20T10:03:00.000Z",
    },
    {
      event: "follow_up_started",
      turnId: SECOND_TURN_ID,
      summary: null,
      timestamp: "2026-08-20T10:02:00.000Z",
    },
    {
      event: "needs_input",
      turnId: FIRST_TURN_ID,
      summary: "Choose the MarketLake import source.",
      timestamp: "2026-08-20T10:01:00.000Z",
    },
  ]);
  assert.equal(notificationState.notifications.at(-1).title, "Continue MarketLake V1");
});

test("notification reconciliation ignores replay and non-semantic rewrites", () => {
  const task = {
    id: FIRST_ID,
    title: "Stable title",
    status: "working",
    summary: null,
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    updatedBy: "mcp",
    lastResult: null,
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [task]);
  for (const replay of [
    task,
    { ...task, title: "Renamed without a lifecycle event" },
    { ...task, updatedAt: "2026-08-20T10:00:01.000Z", updatedBy: "dispatcher" },
    {
      ...task,
      lastResult: {
        status: "needs_input",
        summary: "Normalized previous result.",
        turnId: "01a03275-d529-7043-ab4a-513a1ad6ae1e",
        updatedAt: "2026-08-20T09:59:30.000Z",
      },
    },
  ]) {
    notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [replay]);
  }
  assert.deepEqual(notificationState.notifications, []);
});

test("new task snapshots use a stable creation fallback and survive missing tasks", () => {
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, []);
  const task = {
    id: FIRST_ID,
    title: "New recorded task",
    status: "working",
    summary: null,
    turnId: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    lastResult: null,
  };
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [task]);
  const [created] = notificationState.notifications;
  assert.equal(created.id, JSON.stringify([
    FIRST_ID,
    null,
    "created",
    "2026-08-20T10:00:00.000Z",
  ]));
  assert.equal(created.turnId, null);
  assert.equal(created.title, "New recorded task");
  assert.equal(findCurrentTask([], created.taskId), null);
  assert.equal(notificationOpenLabel(created, true), "Open current task details for New recorded task: Task created");
  assert.equal(notificationOpenLabel(created, false), "Show task availability for New recorded task: Task created");
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, []);
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [task]);
  assert.equal(notificationState.notifications.length, 1, "reappearing task must not replay creation");
});

test("newly observed terminal tasks retain creation and terminal events", () => {
  const task = {
    id: FIRST_ID,
    title: "Completed before observation",
    status: "completed",
    summary: "Completed quickly.",
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:01:00.000Z",
    lastResult: {
      status: "completed",
      summary: "Completed quickly.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:01:00.000Z",
    },
  };
  const notificationState = reconcileNotifications({
    initialized: true,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [task]);
  assert.deepEqual(notificationState.notifications.map(({ event, turnId }) => ({ event, turnId })), [
    { event: "completed", turnId: FIRST_TURN_ID },
    { event: "created", turnId: null },
  ]);
});

test("initial progressed tasks establish a quiet baseline without later replay", () => {
  const task = {
    id: FIRST_ID,
    title: "Completed before page load",
    status: "completed",
    summary: "Existing result.",
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:01:00.000Z",
    lastResult: {
      status: "completed",
      summary: "Existing result.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:01:00.000Z",
    },
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [task]);
  assert.deepEqual(notificationState.notifications, []);
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [task]);
  assert.deepEqual(notificationState.notifications, [], "baseline replay must remain quiet");
});

test("newly observed follow-up tasks retain result, working, and creation events", () => {
  const task = {
    id: FIRST_ID,
    title: "Follow-up before observation",
    status: "working",
    summary: null,
    turnId: SECOND_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:02:00.000Z",
    lastResult: {
      status: "needs_input",
      summary: "Choose the MarketLake import source.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:01:00.000Z",
    },
  };
  const notificationState = reconcileNotifications({
    initialized: true,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [task]);
  assert.deepEqual(notificationState.notifications.map(({ event, turnId }) => ({ event, turnId })), [
    { event: "follow_up_started", turnId: SECOND_TURN_ID },
    { event: "needs_input", turnId: FIRST_TURN_ID },
    { event: "created", turnId: null },
  ]);
});

test("null and literal no-turn turn identities never collide", () => {
  const unlinked = {
    id: FIRST_ID,
    title: "Opaque turn identity",
    status: "working",
    summary: null,
    turnId: null,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    lastResult: null,
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [unlinked]);
  const opaqueTurn = {
    ...unlinked,
    turnId: "no-turn",
    updatedAt: "2026-08-20T10:01:00.000Z",
  };
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [opaqueTurn]);
  assert.deepEqual(notificationState.notifications.map(({ event, turnId }) => ({ event, turnId })), [
    { event: "task_started", turnId: "no-turn" },
  ]);
});

test("coalesced snapshots recover the latest result before the newer working turn", () => {
  const initial = {
    id: FIRST_ID,
    title: "Continue MarketLake V1",
    status: "working",
    summary: null,
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    lastResult: null,
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [initial]);
  const coalesced = {
    ...initial,
    turnId: SECOND_TURN_ID,
    updatedAt: "2026-08-20T10:02:00.000Z",
    lastResult: {
      status: "needs_input",
      summary: "Choose the MarketLake import source.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:01:00.000Z",
    },
  };
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [coalesced]);
  assert.deepEqual(notificationState.notifications.map(({ event, turnId }) => ({ event, turnId })), [
    { event: "follow_up_started", turnId: SECOND_TURN_ID },
    { event: "needs_input", turnId: FIRST_TURN_ID },
  ]);
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [coalesced]);
  assert.equal(notificationState.notifications.length, 2, "replayed coalesced snapshot must deduplicate");
  assert.deepEqual(notificationState.additions, [], "replay must not trigger an announcement");
});

test("task reappearance retains its tombstone and emits progressed lifecycle events", () => {
  const initial = {
    id: FIRST_ID,
    title: "Continue MarketLake V1",
    status: "working",
    summary: null,
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    lastResult: null,
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [initial]);
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, []);
  const progressed = {
    ...initial,
    turnId: SECOND_TURN_ID,
    updatedAt: "2026-08-20T10:02:00.000Z",
    lastResult: {
      status: "needs_input",
      summary: "Choose the MarketLake import source.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:01:00.000Z",
    },
  };
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [progressed]);
  assert.deepEqual(notificationState.notifications.map(({ event }) => event), [
    "follow_up_started",
    "needs_input",
  ]);
  assert.equal(notificationState.notifications.some(({ event }) => event === "created"), false);
});

test("notification state stays bounded and dismiss and clear do not reset deduplication", () => {
  const baseTask = {
    id: FIRST_ID,
    title: "Bounded notifications",
    status: "working",
    summary: null,
    turnId: "turn-0",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    lastResult: null,
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [baseTask]);
  for (let index = 1; index <= MAX_NOTIFICATIONS + 12; index += 1) {
    const task = {
      ...baseTask,
      status: "completed",
      summary: `Result ${index}`,
      turnId: `turn-${index}`,
      updatedAt: new Date(Date.parse(baseTask.updatedAt) + index * 1_000).toISOString(),
      lastResult: {
        status: "completed",
        summary: `Result ${index}`,
        turnId: `turn-${index}`,
        updatedAt: new Date(Date.parse(baseTask.updatedAt) + index * 1_000).toISOString(),
      },
    };
    notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [task]);
  }
  assert.equal(notificationState.notifications.length, MAX_NOTIFICATIONS);
  const newest = notificationState.notifications[0];
  assert.equal(notificationDismissLabel(newest), "Dismiss Task completed notification for Bounded notifications");
  notificationState.notifications = dismissNotification(notificationState.notifications, newest.id);
  assert.equal(notificationState.notifications.length, MAX_NOTIFICATIONS - 1);
  notificationState.notifications = clearNotifications();
  assert.deepEqual(notificationState.notifications, []);
  const replay = {
    ...baseTask,
    status: "completed",
    summary: `Result ${MAX_NOTIFICATIONS + 12}`,
    turnId: `turn-${MAX_NOTIFICATIONS + 12}`,
    updatedAt: newest.timestamp,
    lastResult: {
      status: "completed",
      summary: `Result ${MAX_NOTIFICATIONS + 12}`,
      turnId: `turn-${MAX_NOTIFICATIONS + 12}`,
      updatedAt: newest.timestamp,
    },
  };
  notificationState = reconcileNotifications({ initialized: true, ...notificationState }, [replay]);
  assert.deepEqual(notificationState.notifications, []);
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

test("executor self-linking advances meaningful ordering", async () => {
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

  const resolved = await linkTask(workspace, FIRST_ID, FIRST_THREAD_ID, {
    now: "2026-08-23T10:00:00.000Z",
  });
  assert.equal(resolved.updatedAt, "2026-08-23T10:00:00.000Z");
  assert.equal(resolved.updatedBy, "mcp");
  await waitFor(() => monitor.snapshot().tasks[0].id === FIRST_ID);
  monitor.close();
});

test("dashboard snapshot separates a working turn from its preserved semantic result", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "Lifecycle task", null),
    instruction: `<!-- taskchef_id=${FIRST_ID} -->\n\nTrack lifecycle state.`,
  });
  await linkTask(workspace, FIRST_ID, FIRST_THREAD_ID);
  await reportTaskState(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "working",
  });
  await reportTaskState(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "needs_input",
    summary: "Choose a region.",
  });
  await reportTaskState(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: SECOND_TURN_ID,
    status: "working",
  });

  const monitor = new DashboardMonitor(workspace, { pollIntervalMs: 60_000 });
  await monitor.start();
  const [task] = monitor.snapshot().tasks;
  assert.equal(task.status, "working");
  assert.equal(task.turnId, SECOND_TURN_ID);
  assert.equal(task.lastResult.status, "needs_input");
  assert.equal(task.lastResult.turnId, FIRST_TURN_ID);
  assert.equal(task.lastResult.summary, "Choose a region.");
  assert.equal("results" in task, false, "snapshot/SSE list projection must omit full history");
  assert.equal(monitor.tasks[0].results.length, 1, "monitor retains bounded detail history");
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
  await reportTaskResult(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "completed",
    summary: "Dashboard fixture completed.",
  });
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

    for (const assetName of ["taskchef.svg", "taskchef-dark.svg", "codex.svg"]) {
      const assetResponse = await fetch(`${server.origin}/assets/${assetName}`);
      assert.equal(assetResponse.status, 200);
      assert.equal(assetResponse.headers.get("content-type"), "image/svg+xml");
      assert.equal(
        await assetResponse.text(),
        await readFile(path.resolve("assets", assetName), "utf8"),
      );
    }
    const timeModule = await fetch(`${server.origin}/time.js`);
    assert.equal(timeModule.status, 200);
    assert.match(timeModule.headers.get("content-type"), /text\/javascript/);
    assert.match(await timeModule.text(), /class RelativeTimeController/);

    const snapshotResponse = await fetch(`${server.origin}/api/snapshot`);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.tasks[0].title, "<img src=x onerror=alert(1)>");
    assert.equal(snapshot.tasks[0].id, FIRST_ID);
    assert.equal("results" in snapshot.tasks[0], false);
    const detailResponse = await fetch(`${server.origin}/api/tasks/${FIRST_ID}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.task.results.length, 1);
    assert.equal(detail.task.results[0].summary, "Dashboard fixture completed.");
    assert.deepEqual(detail.task.lastResult, detail.task.results[0]);

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
    assert.deepEqual(await accepted.json(), {});
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
    forged.threadId = "opaque-thread";
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
  const timeScript = await readFile(path.resolve("src/dashboard/time.js"), "utf8");
  const styles = await readFile(path.resolve("src/dashboard/styles.css"), "utf8");
  const codexIcon = await readFile(path.resolve("assets/codex.svg"), "utf8");
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="notification-announcer"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(html, /id="toast-list"[^>]+aria-live/);
  assert.match(html, /id="clear-notifications"/);
  assert.match(html, /id="date-filter"/);
  assert.match(html, /id="dashboard-message-text" role="status" aria-live="polite"/);
  assert.match(html, /id="dismiss-dashboard-message"[^>]+type="button"[^>]+aria-label="Dismiss dashboard message"/);
  assert.match(html, /<title>TaskChef Dashboard<\/title>/);
  assert.match(html, /<h1>TaskChef Dashboard<\/h1>/);
  assert.match(html, /<source srcset="\/assets\/taskchef-dark\.svg" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /<img src="\/assets\/taskchef\.svg" alt="" width="48" height="48">/);
  assert.match(html, /<picture class="dashboard-icon" aria-hidden="true">/);
  assert.match(html, /<h3>Result history<\/h3>/);
  assert.match(html, /id="dialog-results"/);
  assert.match(html, /id="open-codex"[^>]+aria-label="Open this task in Codex"/);
  assert.match(html, /class="codex-icon" aria-hidden="true"/);
  assert.match(html, /<span>Open task<\/span>/);
  assert.doesNotMatch(html, />Open task in Codex</);
  assert.doesNotMatch(html, />Task dashboard</);
  assert.match(script, /textContent = task\.instruction/);
  assert.match(script, /\[\.\.\.results\]\.reverse\(\)/);
  assert.match(script, /result-history-latest/);
  assert.match(script, /fetch\(`\/api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}`\)/);
  assert.match(script, /requestGeneration === detailRequestGeneration/);
  assert.match(script, /task\.results \?\? preservedResults \?\? \[\]/);
  assert.match(script, /openTask\.type = "button"/);
  assert.match(script, /configureOpenTaskControl\(openTask, `Open \$\{task\.title\} in Codex`\)/);
  assert.match(script, /configureOpenTaskControl\(elements\.openProject, `Open \$\{task\.title\} in Codex`\)/);
  assert.match(script, /icon\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(script, /openTaskFromControl\(event, task\.id/);
  assert.match(script, /relativeTimes\.register\(/);
  assert.match(script, /relativeTimes\.toggle\(key\)/);
  assert.match(script, /time\.dateTime = iso/);
  assert.match(script, /control\.setAttribute\("aria-label"/);
  assert.match(script, /control\.title = action/);
  assert.match(script, /elements\.dashboardMessageText\.textContent = message/);
  assert.match(script, /elements\.dismissDashboardMessage\.addEventListener\("click", \(\) => \{/);
  assert.match(script, /elements\.dashboardMessage\.hidden = true/);
  assert.match(script, /notificationOpenLabel\(notification, Boolean\(task\)\)/);
  assert.match(script, /notificationDismissLabel\(notification\)/);
  assert.match(script, /text\.setAttribute\("aria-describedby", describedBy\.join\(" "\)\)/);
  assert.match(script, /dismiss\.setAttribute\("aria-describedby", describedBy\.join\(" "\)\)/);
  assert.match(script, /if \(additions\.length > 0\) \{\s+elements\.notificationAnnouncer\.textContent/);
  assert.match(script, /renderNotifications\(reconciled\.additions\)/);
  assert.match(script, /Task no longer available/);
  assert.match(script, /timestamp\.dateTime = notification\.timestamp/);
  assert.match(actionScript, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(script, /\bstatusLabel\(/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(stateScript, /MAX_NOTIFICATIONS = 50/);
  assert.match(timeScript, /RELATIVE_TIME_REFRESH_MS = 30_000/);
  assert.match(styles, /mask: url\("\/assets\/codex\.svg"\)/);
  assert.match(styles, /\.task-open \{ align-self: flex-start; \}/);
  assert.match(styles, /\.dialog-actions \{ align-items: center; flex-flow: row wrap; \}/);
  assert.match(codexIcon, /viewBox="0 0 16 16"/);
});
