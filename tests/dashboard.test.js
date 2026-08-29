import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  filterTasks,
  KNOWN_TASK_STATUSES,
  latestTurnPresentation,
  manualTransitionExpectedState,
  mergeProjectedTurns,
  MAX_NOTIFICATIONS,
  findCurrentTask,
  nextDateFilterRefreshDelay,
  notificationDismissLabel,
  notificationOpenLabel,
  notificationSnapshot,
  notificationTitle,
  reconcileNotifications,
  reconcileManualTransition,
  reconcileManualTransitionResponse,
  STATUS_FILTERS,
  statusFilterCounts,
  statusFilterText,
  taskWithinDateFilter,
  turnPresentation,
  canArchiveTask,
  canManuallyTransitionTask,
  CODEX_CHAT_ARCHIVE_ENABLED,
  isArchiveTaskEligible,
} from "../src/dashboard/state.js";
import {
  archiveTaskFromControl,
  focusManualTransitionStatus,
  handleManualTransitionEscape,
  manuallyTransitionTaskFromControl,
  openTaskFromControl,
  restoreTaskActionMenuFocus,
} from "../src/dashboard/actions.js";
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
    assert.deepEqual(concurrent.map((result) => result.launcher), ["mcp", "mcp", "mcp"]);
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
      "launcher", "schemaVersion", "serverVersion", "service", "taskchefVersion", "workspace",
    ]);
    assert.equal(identity.launcher, "standalone");
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
  const server = await createDashboardServer({ workspace, port, launcher: "mcp" });
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
      /unknown, stale, different-workspace, or differently launched service[\s\S]+will not terminate it/,
    );
    await staleManager.close();
  } finally {
    await manager.close();
    await server.close();
  }
});

test("dashboard manager refuses a standalone dashboard even when workspace and version match", async () => {
  const { workspace } = await fixture();
  const port = await unusedPort();
  const server = await createDashboardServer({ workspace, port });
  const manager = createDashboardManager({ workspace, port });
  try {
    await assert.rejects(
      manager.ensure(),
      /unknown, stale, different-workspace, or differently launched service[\s\S]+will not terminate it/,
    );
    assert.equal(manager.owned, false);
    assert.equal(server.identity.launcher, "standalone");
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
    "working", "needs input", "completed", "failed",
  ]);
  assert.deepEqual(STATUS_FILTERS, [
    { value: "", label: "All" },
    { value: "working", label: "Working" },
    { value: "needs input", label: "Needs input" },
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
  ]);
});

test("dashboard status counts are contextual to project and date before status selection", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const task = (id, project, status, hoursAgo) => ({
    id,
    project: { name: project },
    status,
    createdAt: new Date(now - hoursAgo * 60 * 60 * 1_000).toISOString(),
  });
  const tasks = [
    task("a", "alpha", "working", 1),
    task("b", "alpha", "needs_input", 2),
    task("c", "alpha", "completed", 48),
    task("d", "beta", "failed", 1),
  ];

  assert.deepEqual(statusFilterCounts(tasks, { project: "alpha", date: "24h", now }), {
    "": 2,
    working: 1,
    "needs input": 1,
    completed: 0,
    failed: 0,
  });
  assert.deepEqual(
    filterTasks(tasks, { project: "alpha", date: "24h", status: "needs input", now })
      .map(({ id }) => id),
    ["b"],
  );
});

test("dashboard status labels retain zero-count options without empty parentheses", () => {
  assert.equal(statusFilterText("", 45), "All (45)");
  assert.equal(statusFilterText("working", 1), "Working (1)");
  assert.equal(statusFilterText("needs input", 0), "Needs input");
  assert.equal(statusFilterText("completed", 0), "Completed");
  assert.equal(statusFilterText("unknown", 3), "");
});

test("latest turn presentation keeps each request paired with its own result", () => {
  const working = {
    title: "Timeline task",
    status: "working",
    turnId: SECOND_TURN_ID,
    latestTurn: {
      turnId: SECOND_TURN_ID,
      requestSummary: "Apply the selected region.",
      startedAt: "2026-08-20T10:02:00.000Z",
      result: null,
    },
    lastResult: {
      status: "needs_input",
      summary: "Choose a region.",
      turnId: FIRST_TURN_ID,
      updatedAt: "2026-08-20T10:01:00.000Z",
    },
  };
  assert.deepEqual(latestTurnPresentation(working), {
    turnRef: SECOND_TURN_ID,
    turnId: SECOND_TURN_ID,
    startedAt: "2026-08-20T10:02:00.000Z",
    requestSummary: "Apply the selected region.",
    resultStatus: "working",
    resultSummary: "In progress",
    resultUpdatedAt: null,
  });
  const completed = {
    ...working,
    status: "completed",
    latestTurn: {
      ...working.latestTurn,
      result: {
        status: "completed",
        summary: "Applied the selected region.",
        updatedAt: "2026-08-20T10:03:00.000Z",
      },
    },
  };
  assert.equal(latestTurnPresentation(completed).resultSummary, "Applied the selected region.");
});

test("dashboard projections show the recovered request in progress and the interrupted history honestly", () => {
  const interrupted = {
    turnId: FIRST_TURN_ID,
    requestSummary: "Run the original deployment.",
    startedAt: "2026-08-20T10:00:00.000Z",
    result: {
      status: "interrupted",
      summary: "Turn interrupted before a terminal report.",
      updatedAt: "2026-08-20T10:02:00.000Z",
    },
  };
  assert.deepEqual(turnPresentation(interrupted), {
    status: "interrupted",
    summary: "Turn interrupted before a terminal report.",
    updatedAt: "2026-08-20T10:02:00.000Z",
  });
  assert.deepEqual(latestTurnPresentation({
    title: "Recovered deployment",
    status: "working",
    turnId: SECOND_TURN_ID,
    latestTurn: {
      turnId: SECOND_TURN_ID,
      requestSummary: "Resume after restart.",
      startedAt: "2026-08-20T10:02:00.000Z",
      result: null,
    },
    lastResult: null,
  }), {
    turnRef: SECOND_TURN_ID,
    turnId: SECOND_TURN_ID,
    startedAt: "2026-08-20T10:02:00.000Z",
    requestSummary: "Resume after restart.",
    resultStatus: "working",
    resultSummary: "In progress",
    resultUpdatedAt: null,
  });
});

test("projected working turns update an open dialog before detail refresh", () => {
  const first = {
    turnId: FIRST_TURN_ID,
    requestSummary: "Choose a region.",
    startedAt: "2026-08-20T10:00:00.000Z",
    result: {
      status: "needs_input",
      summary: "Region required.",
      updatedAt: "2026-08-20T10:01:00.000Z",
    },
  };
  const followUp = {
    turnId: SECOND_TURN_ID,
    requestSummary: "Use Singapore.",
    startedAt: "2026-08-20T10:02:00.000Z",
    result: null,
  };
  assert.deepEqual(mergeProjectedTurns({ latestTurn: followUp }, [first]), [first, followUp]);
  const completed = {
    ...followUp,
    result: {
      status: "completed",
      summary: "Used Singapore.",
      updatedAt: "2026-08-20T10:03:00.000Z",
    },
  };
  assert.deepEqual(mergeProjectedTurns({ latestTurn: completed }, [first, followUp]), [
    first,
    completed,
  ]);
});

test("a compact recovery snapshot immediately interrupts the preserved unfinished predecessor", () => {
  const predecessor = {
    turnId: FIRST_TURN_ID,
    requestSummary: "Deploy before the app restart.",
    startedAt: "2026-08-20T10:00:00.000Z",
    result: null,
  };
  const recovery = {
    turnId: SECOND_TURN_ID,
    requestSummary: "Resume after restart.",
    startedAt: "2026-08-20T10:02:00.000Z",
    result: null,
  };
  assert.deepEqual(mergeProjectedTurns({
    schemaVersion: 8,
    status: "working",
    latestTurn: recovery,
  }, [predecessor]), [
    {
      ...predecessor,
      result: {
        status: "interrupted",
        summary: "Turn interrupted before a terminal report.",
        updatedAt: recovery.startedAt,
      },
    },
    recovery,
  ]);
});

test("a compact migrated fallback result replaces its legacy null-ref turn", () => {
  const legacy = {
    turnRef: null,
    turnId: null,
    requestSummary: null,
    startedAt: "2026-08-20T10:00:00.000Z",
    result: {
      status: "failed",
      summary: "Executor creation failed.",
      updatedAt: "2026-08-20T10:00:00.000Z",
    },
  };
  const migrated = {
    ...legacy,
    turnRef: "33333333-3333-4333-8333-333333333333",
  };
  assert.deepEqual(mergeProjectedTurns({
    schemaVersion: 9,
    status: "failed",
    latestTurn: migrated,
  }, [legacy]), [migrated]);
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

test("dashboard hides archive while preserving dormant eligibility rules", () => {
  assert.equal(CODEX_CHAT_ARCHIVE_ENABLED, false);
  for (const status of ["needs_input", "completed", "failed"]) {
    const task = { status, threadId: FIRST_THREAD_ID };
    assert.equal(isArchiveTaskEligible(task), true);
    assert.equal(canArchiveTask(task), false);
  }
  assert.equal(isArchiveTaskEligible({ status: "working", threadId: FIRST_THREAD_ID }), false);
  assert.equal(isArchiveTaskEligible({ status: "failed", threadId: "opaque-thread" }), false);
  assert.equal(isArchiveTaskEligible({
    status: "failed",
    threadId: "11111111-1111-4111-8111-111111111111",
  }), false);
  assert.equal(isArchiveTaskEligible({ status: "failed", threadId: null }), false);
});

test("manual transition eligibility is limited to working and needs-input tasks", () => {
  assert.equal(canManuallyTransitionTask({ status: "working" }), true);
  assert.equal(canManuallyTransitionTask({ status: "needs_input" }), true);
  assert.equal(canManuallyTransitionTask({ status: "completed" }), false);
  assert.equal(canManuallyTransitionTask({ status: "failed" }), false);
});

test("task action menu refreshes stale choices but preserves an in-flight request", () => {
  const task = {
    id: FIRST_ID,
    status: "needs_input",
    turnRef: FIRST_TURN_ID,
    threadId: FIRST_THREAD_ID,
    updatedAt: "2026-08-28T12:00:00.000Z",
  };
  const expected = manualTransitionExpectedState(task);
  const choice = { taskId: FIRST_ID, stage: "choose", expected };
  const pending = { taskId: FIRST_ID, stage: "pending", expected };
  assert.equal(reconcileManualTransition(choice, task), choice);
  assert.deepEqual(reconcileManualTransition(choice, { ...task, status: "completed" }), {
    taskId: FIRST_ID,
    stage: "choose",
    expected: { ...expected, status: "completed" },
  });
  assert.equal(reconcileManualTransition(pending, { ...task, status: "failed" }), pending);
  const advanced = {
    ...task,
    status: "working",
    turnRef: SECOND_TURN_ID,
    updatedAt: "2026-08-28T12:01:00.000Z",
  };
  assert.deepEqual(reconcileManualTransition(choice, advanced), {
    taskId: FIRST_ID,
    stage: "choose",
    expected: manualTransitionExpectedState(advanced),
  });
  assert.equal(reconcileManualTransition(choice, { ...task, id: SECOND_ID }), null);
});

test("manual transition responses never replace a task advanced by SSE", () => {
  const requestTask = {
    id: FIRST_ID,
    status: "needs_input",
    turnRef: FIRST_TURN_ID,
    threadId: FIRST_THREAD_ID,
    updatedAt: "2026-08-28T12:00:00.000Z",
  };
  const expected = manualTransitionExpectedState(requestTask);
  const responseTask = {
    ...requestTask,
    status: "completed",
    turnRef: SECOND_TURN_ID,
    updatedAt: "2026-08-28T12:01:00.000Z",
  };
  assert.equal(reconcileManualTransitionResponse({
    requestTask,
    expected,
    responseTask,
    selectedTask: requestTask,
  }), responseTask);

  const sseTask = {
    ...requestTask,
    status: "working",
    turnRef: "01a03275-d532-7043-ab4a-513a1ad6ae1e",
    updatedAt: "2026-08-28T12:02:00.000Z",
  };
  assert.equal(reconcileManualTransitionResponse({
    requestTask,
    expected,
    responseTask,
    selectedTask: sseTask,
  }), sseTask);
  assert.equal(reconcileManualTransitionResponse({
    requestTask,
    expected,
    responseTask: null,
    selectedTask: sseTask,
  }), sseTask);
});

test("manual transition control sends one versioned optimistic request and preserves failures", async () => {
  const task = {
    id: FIRST_ID,
    status: "needs_input",
    turnRef: FIRST_TURN_ID,
    threadId: FIRST_THREAD_ID,
    updatedAt: "2026-08-28T12:00:00.000Z",
  };
  const requests = [];
  const success = await manuallyTransitionTaskFromControl(
    { stopPropagation: () => {} },
    task,
    "completed",
    FIRST_ID,
    {
      fetchAction: async (url, options) => {
        requests.push({ url, options });
        return {
          ok: true,
          json: async () => ({ schemaVersion: 1, task: { ...task, status: "completed" } }),
        };
      },
    },
  );
  assert.equal(success.ok, true);
  assert.equal(requests[0].url, `/api/tasks/${FIRST_ID}/manual-transition`);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    schemaVersion: 1,
    actionId: FIRST_ID,
    expected: {
      status: "needs_input",
      turnRef: FIRST_TURN_ID,
      threadId: FIRST_THREAD_ID,
      updatedAt: task.updatedAt,
    },
    targetStatus: "completed",
  });

  const failure = await manuallyTransitionTaskFromControl(
    { stopPropagation: () => {} },
    task,
    "failed",
    FIRST_ID,
    {
      fetchAction: async () => ({
        ok: false,
        json: async () => ({
          code: "stale_task",
          message: "This task changed.",
          task: { ...task, updatedAt: "2026-08-28T12:01:00.000Z" },
        }),
      }),
    },
  );
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "stale_task");
  assert.equal(failure.task.updatedAt, "2026-08-28T12:01:00.000Z");

  const timeout = await manuallyTransitionTaskFromControl(
    { stopPropagation: () => {} },
    task,
    "failed",
    FIRST_ID,
    {
      clearTimer: () => {},
      fetchAction: async (_url, { signal }) => {
        assert.equal(signal.aborted, true);
        throw new Error("aborted");
      },
      setTimer: (callback) => { callback(); return 1; },
    },
  );
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, "request_timeout");
  assert.equal(timeout.message, "Task state change timed out. Try again.");
});

test("manual transition keyboard helpers close the menu and focus pending status", () => {
  const calls = [];
  const event = {
    key: "Escape",
    preventDefault: () => calls.push("prevented"),
    stopPropagation: () => calls.push("stopped"),
  };
  assert.equal(handleManualTransitionEscape(event, {
    active: true,
    pending: false,
    cancel: () => calls.push("cancelled"),
  }), true);
  assert.deepEqual(calls, ["prevented", "stopped", "cancelled"]);

  calls.length = 0;
  assert.equal(handleManualTransitionEscape(event, {
    active: true,
    pending: true,
    cancel: () => calls.push("cancelled"),
  }), true);
  assert.deepEqual(calls, ["prevented", "stopped"]);
  assert.equal(handleManualTransitionEscape({ key: "Enter" }, {
    active: true,
    pending: false,
    cancel: () => calls.push("cancelled"),
  }), false);

  const focused = [];
  for (const node of ["initial-status", "replacement-status"]) {
    assert.equal(focusManualTransitionStatus({
      querySelector: (selector) => {
        assert.equal(selector, '[data-manual-focus="pending"]');
        return { focus: () => focused.push(node) };
      },
    }), true);
  }
  assert.deepEqual(focused, ["initial-status", "replacement-status"]);
  assert.equal(focusManualTransitionStatus({ querySelector: () => null }), false);

  const hiddenFailed = { hidden: true, disabled: false };
  const copyTaskId = { hidden: false, disabled: false, focus: () => focused.push("copy") };
  const panel = {
    contains: (element) => element === hiddenFailed,
    querySelector: (selector) => {
      assert.equal(selector, '[data-manual-focus="copy"]');
      return copyTaskId;
    },
  };
  assert.equal(restoreTaskActionMenuFocus(panel, hiddenFailed, null), copyTaskId);

  const disabledCopy = { hidden: false, disabled: true };
  const fallback = { focus: () => focused.push("more") };
  assert.equal(restoreTaskActionMenuFocus({
    contains: () => true,
    querySelector: () => disabledCopy,
  }, { hidden: true, disabled: false }, fallback), fallback);
  assert.deepEqual(focused, ["initial-status", "replacement-status", "copy", "more"]);
});

test("dashboard archive control confirms consequences and reports success", async () => {
  const requests = [];
  const confirmations = [];
  const archived = [];
  const messages = [];
  const control = { disabled: false };
  const task = { id: FIRST_ID, threadId: FIRST_THREAD_ID, title: "Close stalled work" };
  const result = await archiveTaskFromControl({
    currentTarget: control,
    stopPropagation: () => {},
  }, task, {
    confirmAction: (message) => { confirmations.push(message); return true; },
    fetchAction: async (url, options) => {
      requests.push({ url, options, disabledDuringRequest: control.disabled });
      return {
        ok: true,
        json: async () => ({
          message: "Archived the Codex chat. TaskChef history remains available.",
          status: "archived",
        }),
      };
    },
    onArchived: (threadId) => archived.push(threadId),
    showMessage: (message) => messages.push(message),
  });
  assert.equal(result, true);
  assert.match(confirmations[0], /spawned descendant chats may also be archived/);
  assert.match(confirmations[0], /TaskChef history will remain available/);
  assert.deepEqual(requests, [{
    url: `/api/tasks/${FIRST_ID}/archive-codex`,
    options: { method: "POST" },
    disabledDuringRequest: true,
  }]);
  assert.deepEqual(archived, [FIRST_THREAD_ID]);
  assert.deepEqual(messages, ["Archived the Codex chat. TaskChef history remains available."]);
  assert.equal(control.disabled, true);
});

test("dashboard archive control leaves a declined or failed action unchanged", async () => {
  const messages = [];
  const task = { id: FIRST_ID, threadId: FIRST_THREAD_ID, title: "Keep this chat" };
  let fetched = false;
  assert.equal(await archiveTaskFromControl({
    currentTarget: { disabled: false },
    stopPropagation: () => {},
  }, task, {
    confirmAction: () => false,
    fetchAction: async () => { fetched = true; },
    showMessage: (message) => messages.push(message),
  }), false);
  assert.equal(fetched, false);

  assert.equal(await archiveTaskFromControl({
    currentTarget: { disabled: false },
    stopPropagation: () => {},
  }, task, {
    confirmAction: () => true,
    fetchAction: async () => ({
      ok: false,
      json: async () => ({ message: "Working tasks cannot be archived from the dashboard." }),
    }),
    showMessage: (message) => messages.push(message),
  }), false);
  assert.deepEqual(messages, ["Working tasks cannot be archived from the dashboard."]);
});

test("dashboard notification labels describe immutable lifecycle events", () => {
  assert.equal(notificationTitle({ event: "created" }), "Task created");
  assert.equal(notificationTitle({ event: "task_started" }), "Task started");
  assert.equal(notificationTitle({ event: "follow_up_started" }), "Follow-up started");
  assert.equal(notificationTitle({ event: "completed" }), "Task completed");
  assert.equal(notificationTitle({ event: "needs_input" }), "Task needs input");
  assert.equal(notificationTitle({ event: "failed" }), "Task failed");
  assert.equal(notificationTitle({ event: "manual_completed" }), "Task manually completed");
  assert.equal(notificationTitle({ event: "manual_failed" }), "Task manually failed");
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

test("turnRef migration does not replay an unchanged fallback failure notification", () => {
  const legacyFailure = {
    id: FIRST_ID,
    title: "Historical creation failure",
    status: "failed",
    summary: "Executor creation failed.",
    turnRef: null,
    turnId: null,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    latestTurn: {
      turnRef: null,
      turnId: null,
      requestSummary: null,
      startedAt: "2026-08-20T10:00:00.000Z",
      result: {
        status: "failed",
        summary: "Executor creation failed.",
        updatedAt: "2026-08-20T10:00:00.000Z",
      },
    },
    lastResult: {
      status: "failed",
      summary: "Executor creation failed.",
      turnRef: null,
      turnId: null,
      updatedAt: "2026-08-20T10:00:00.000Z",
    },
  };
  const baseline = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [legacyFailure]);
  const migratedRef = "33333333-3333-4333-8333-333333333333";
  const migrated = {
    ...legacyFailure,
    turnRef: migratedRef,
    latestTurn: { ...legacyFailure.latestTurn, turnRef: migratedRef },
    lastResult: { ...legacyFailure.lastResult, turnRef: migratedRef },
  };
  const reconciled = reconcileNotifications({ initialized: true, ...baseline }, [migrated]);
  assert.deepEqual(reconciled.additions, []);
  assert.deepEqual(reconciled.notifications, []);
});

test("a first fallback working turn still emits its task-started notification", () => {
  const linkPending = {
    id: FIRST_ID,
    title: "Fallback start",
    status: "working",
    summary: null,
    turnRef: null,
    turnId: null,
    createdAt: "2026-08-20T09:59:00.000Z",
    updatedAt: "2026-08-20T09:59:00.000Z",
    latestTurn: null,
    lastResult: null,
  };
  const baseline = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [linkPending]);
  const fallbackRef = "33333333-3333-4333-8333-333333333333";
  const started = {
    ...linkPending,
    turnRef: fallbackRef,
    updatedAt: "2026-08-20T10:00:00.000Z",
    latestTurn: {
      turnRef: fallbackRef,
      turnId: null,
      requestSummary: "Begin without native metadata.",
      startedAt: "2026-08-20T10:00:00.000Z",
      result: null,
    },
  };
  const reconciled = reconcileNotifications({ initialized: true, ...baseline }, [started]);
  assert.equal(reconciled.additions.length, 1);
  assert.equal(reconciled.additions[0].event, "task_started");
  assert.equal(reconciled.additions[0].turnRef, fallbackRef);
  assert.equal(reconciled.additions[0].turnId, null);
});

test("starting interrupted-turn recovery emits no misleading failed-result notification", () => {
  const previousSemanticResult = {
    status: "failed",
    summary: "A much earlier turn failed.",
    turnId: "01a03275-d529-7043-ab4a-513a1ad6ae1e",
    updatedAt: "2026-08-20T09:58:00.000Z",
  };
  const interruptedWorking = {
    id: FIRST_ID,
    title: "Recover deployment",
    status: "working",
    summary: null,
    turnId: FIRST_TURN_ID,
    createdAt: "2026-08-20T09:55:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    lastResult: previousSemanticResult,
  };
  let notificationState = reconcileNotifications({
    initialized: false,
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  }, [interruptedWorking]);
  const recoveredWorking = {
    ...interruptedWorking,
    turnId: SECOND_TURN_ID,
    updatedAt: "2026-08-20T10:02:00.000Z",
    latestTurn: {
      turnId: SECOND_TURN_ID,
      requestSummary: "Resume after restart.",
      startedAt: "2026-08-20T10:02:00.000Z",
      result: null,
    },
  };
  notificationState = reconcileNotifications({
    initialized: true,
    ...notificationState,
  }, [recoveredWorking]);
  assert.deepEqual(notificationState.additions.map(({ event, turnId }) => ({ event, turnId })), [
    { event: "follow_up_started", turnId: SECOND_TURN_ID },
  ]);
  assert.equal(notificationState.additions.some(({ event }) => event === "failed"), false);
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
    requestSummary: "Choose a deployment region.",
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
    requestSummary: "Apply the selected region.",
  });

  const monitor = new DashboardMonitor(workspace, { pollIntervalMs: 60_000 });
  await monitor.start();
  const [task] = monitor.snapshot().tasks;
  assert.equal(task.status, "working");
  assert.equal(task.turnId, SECOND_TURN_ID);
  assert.equal(task.lastResult.status, "needs_input");
  assert.equal(task.lastResult.turnId, FIRST_TURN_ID);
  assert.equal(task.lastResult.summary, "Choose a region.");
  assert.equal(task.latestTurn.requestSummary, "Apply the selected region.");
  assert.equal(task.latestTurn.result, null);
  assert.equal("turns" in task, false, "snapshot/SSE list projection must omit full timeline");
  assert.equal("results" in task, false, "snapshot/SSE list projection must omit full history");
  assert.equal(monitor.tasks[0].turns.length, 2, "monitor retains bounded detail timeline");
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
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "<img src=x onerror=alert(1)>", FIRST_THREAD_ID),
    instruction: "Address favoyang/taskchef#123 safely.",
  });
  await reportTaskResult(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "completed",
    summary: "Dashboard fixture completed for https://github.com/favoyang/taskchef/issues/123.",
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

    for (const assetName of ["taskchef.svg", "taskchef-dark.svg"]) {
      const assetResponse = await fetch(`${server.origin}/assets/${assetName}`);
      assert.equal(assetResponse.status, 200);
      assert.equal(assetResponse.headers.get("content-type"), "image/svg+xml");
      assert.equal(
        await assetResponse.text(),
        await readFile(path.resolve("assets", assetName), "utf8"),
      );
    }
    for (const assetName of ["codex-app-dark.png", "codex-app-light.png"]) {
      const assetResponse = await fetch(`${server.origin}/assets/${assetName}`);
      assert.equal(assetResponse.status, 200);
      assert.equal(assetResponse.headers.get("content-type"), "image/png");
      assert.deepEqual(
        Buffer.from(await assetResponse.arrayBuffer()),
        await readFile(path.resolve("assets", assetName)),
      );
    }
    const timeModule = await fetch(`${server.origin}/time.js`);
    assert.equal(timeModule.status, 200);
    assert.match(timeModule.headers.get("content-type"), /text\/javascript/);
    assert.match(await timeModule.text(), /class RelativeTimeController/);
    const githubLinksModule = await fetch(`${server.origin}/github-links.js`);
    assert.equal(githubLinksModule.status, 200);
    assert.match(githubLinksModule.headers.get("content-type"), /text\/javascript/);
    assert.match(await githubLinksModule.text(), /taskGitHubProjection/);

    const snapshotResponse = await fetch(`${server.origin}/api/snapshot`);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.tasks[0].title, "<img src=x onerror=alert(1)>");
    assert.equal(snapshot.tasks[0].id, FIRST_ID);
    assert.equal("turns" in snapshot.tasks[0], false);
    assert.equal("results" in snapshot.tasks[0], false);
    assert.equal(
      snapshot.tasks[0].latestTurn.result.summary,
      "Dashboard fixture completed for https://github.com/favoyang/taskchef/issues/123.",
    );
    assert.deepEqual(snapshot.tasks[0].relatedGitHubLinks, [{
      label: "favoyang/taskchef#123",
      number: "123",
      owner: "favoyang",
      repository: "taskchef",
      type: "generic",
      url: "https://github.com/favoyang/taskchef/issues/123",
    }]);
    assert.equal(snapshot.tasks[0].relatedGitHubRepository, "favoyang/taskchef");
    const detailResponse = await fetch(`${server.origin}/api/tasks/${FIRST_ID}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.task.turns.length, 1);
    assert.equal(detail.task.turns[0].requestSummary, null);
    assert.equal(
      detail.task.turns[0].result.summary,
      "Dashboard fixture completed for https://github.com/favoyang/taskchef/issues/123.",
    );
    assert.equal(detail.task.results.length, 1);
    assert.equal(
      detail.task.results[0].summary,
      "Dashboard fixture completed for https://github.com/favoyang/taskchef/issues/123.",
    );
    assert.deepEqual(detail.task.relatedGitHubLinks, snapshot.tasks[0].relatedGitHubLinks);
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

test("dashboard archive endpoint is unavailable by default without invoking the CLI", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "Dormant archive task", null),
    instruction: `<!-- taskchef_id=${FIRST_ID} -->\n\nDo not invoke archived code.`,
  });
  await linkTask(workspace, FIRST_ID, FIRST_THREAD_ID);
  await reportTaskResult(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "completed",
    summary: "Ready to remain visible.",
  });
  let discoveryCount = 0;
  let archiveCount = 0;
  const server = await createDashboardServer({
    workspace,
    port: 0,
    monitorOptions: { pollIntervalMs: 60_000 },
    discoverArchiveCli: async () => {
      discoveryCount += 1;
      return { path: "/mock/Codex.app/Contents/Resources/codex", source: "desktop-bundle" };
    },
    archiveThread: async () => { archiveCount += 1; },
  });
  server.monitor.watcher?.close();
  server.monitor.watcher = null;
  try {
    const response = await fetch(`${server.origin}/api/tasks/${FIRST_ID}/archive-codex`, {
      method: "POST",
      headers: { Origin: server.origin },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { message: "Chat archiving is not available." });
    assert.equal(discoveryCount, 0);
    assert.equal(archiveCount, 0);
  } finally {
    await server.close();
  }
});

test("dashboard Open task uses the Codex thread ID rather than the TaskChef task ID", async () => {
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
    assert.notEqual(openedThread, FIRST_ID);
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

test("dashboard manual transition route validates origin, stale state, and durable retries", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "Administrative outcome", null),
    instruction: `<!-- taskchef_id=${FIRST_ID} -->\n\nWait for a dashboard outcome.`,
  }, { now: "2026-08-28T12:00:00.000Z" });
  await linkTask(workspace, FIRST_ID, FIRST_THREAD_ID, {
    now: "2026-08-28T12:01:00.000Z",
  });
  await reportTaskState(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "working",
    requestSummary: "Wait for an administrative decision.",
  }, { now: "2026-08-28T12:02:00.000Z" });
  const needsInput = await reportTaskState(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "needs_input",
    summary: "An administrator must settle this task.",
  }, { now: "2026-08-28T12:03:00.000Z" });
  const server = await createDashboardServer({
    workspace,
    port: 0,
    monitorOptions: { pollIntervalMs: 60_000 },
  });
  const body = {
    schemaVersion: 1,
    actionId: FIRST_ID,
    expected: {
      status: needsInput.status,
      turnRef: needsInput.turnRef,
      threadId: needsInput.threadId,
      updatedAt: needsInput.updatedAt,
    },
    targetStatus: "completed",
  };
  const transition = (value = body, origin = server.origin) => fetch(
    `${server.origin}/api/tasks/${FIRST_ID}/manual-transition`,
    {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    },
  );
  try {
    assert.equal((await transition(body, "http://example.invalid")).status, 403);
    assert.equal((await fetch(
      `${server.origin}/api/tasks/${FIRST_ID}/manual-transition`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    )).status, 403);
    assert.equal((await fetch(
      `${server.origin}/api/tasks/${FIRST_ID}/manual-transition`,
      { method: "POST", headers: { Origin: server.origin }, body: "{}" },
    )).status, 415);
    const malformed = await fetch(
      `${server.origin}/api/tasks/${FIRST_ID}/manual-transition`,
      {
        method: "POST",
        headers: { Origin: server.origin, "Content-Type": "application/json" },
        body: "{",
      },
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "malformed_json");
    assert.equal((await transition({ ...body, unexpected: true })).status, 400);
    const oversized = await fetch(
      `${server.origin}/api/tasks/${FIRST_ID}/manual-transition`,
      {
        method: "POST",
        headers: { Origin: server.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(4097) }),
      },
    );
    assert.equal(oversized.status, 413);
    const stale = await transition({
      ...body,
      actionId: SECOND_ID,
      expected: { ...body.expected, updatedAt: "2026-08-28T12:02:00.000Z" },
    });
    assert.equal(stale.status, 409);
    const staleResult = await stale.json();
    assert.equal(staleResult.code, "stale_task");
    assert.equal(staleResult.task.status, "needs_input");

    const completed = await transition();
    assert.equal(completed.status, 200);
    const completedResult = await completed.json();
    assert.equal(completedResult.idempotent, false);
    assert.equal(completedResult.task.status, "completed");
    assert.equal(completedResult.task.updatedBy, "dashboard");
    assert.equal(completedResult.task.latestTurn.provenance.actionId, FIRST_ID);

    const retry = await transition();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).idempotent, true);
    const rejected = await transition({
      ...body,
      actionId: SECOND_ID,
      expected: {
        status: "completed",
        turnRef: completedResult.task.turnRef,
        threadId: completedResult.task.threadId,
        updatedAt: completedResult.task.updatedAt,
      },
      targetStatus: "failed",
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "invalid_transition");
  } finally {
    await server.close();
  }
});

test("dashboard archive action accepts every non-working state and rejects working tasks", async () => {
  const { workspace, project } = await fixture();
  await recordTask(workspace, {
    ...input(project, FIRST_ID, "Archivable task", null),
    instruction: `<!-- taskchef_id=${FIRST_ID} -->\n\nTest dashboard archiving.`,
  });
  await linkTask(workspace, FIRST_ID, FIRST_THREAD_ID);
  await reportTaskResult(workspace, {
    taskId: FIRST_ID,
    threadId: FIRST_THREAD_ID,
    turnId: FIRST_TURN_ID,
    status: "completed",
    summary: "Initial work completed.",
  });
  const archived = [];
  let releaseArchive = null;
  let blockArchive = false;
  const server = await createDashboardServer({
    archiveEnabled: true,
    workspace,
    port: 0,
    monitorOptions: { pollIntervalMs: 60_000 },
    discoverArchiveCli: async () => ({ path: "/mock/Codex.app/Contents/Resources/codex", source: "desktop-bundle" }),
    archiveThread: async (threadId) => {
      archived.push(threadId);
      if (blockArchive) await new Promise((resolve) => { releaseArchive = resolve; });
    },
  });
  server.monitor.watcher?.close();
  server.monitor.watcher = null;
  const archive = () => fetch(`${server.origin}/api/tasks/${FIRST_ID}/archive-codex`, {
    method: "POST",
    headers: { Origin: server.origin },
  });
  try {
    const forgedOrigin = await fetch(
      `${server.origin}/api/tasks/${FIRST_ID}/archive-codex`,
      { method: "POST", headers: { Origin: "http://example.invalid" } },
    );
    assert.equal(forgedOrigin.status, 403);
    assert.deepEqual(archived, []);

    const completed = await archive();
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).status, "archived");

    await reportTaskState(workspace, {
      taskId: FIRST_ID,
      threadId: FIRST_THREAD_ID,
      turnId: SECOND_TURN_ID,
      status: "working",
      requestSummary: "Continue after completion.",
    });
    const working = await archive();
    assert.equal(working.status, 409);
    assert.match((await working.json()).message, /Working tasks cannot be archived/);

    await reportTaskState(workspace, {
      taskId: FIRST_ID,
      threadId: FIRST_THREAD_ID,
      turnId: SECOND_TURN_ID,
      status: "needs_input",
      summary: "Choose whether to continue.",
    });
    assert.equal((await archive()).status, 200);

    const thirdTurnId = "01a03275-d532-7043-ab4a-513a1ad6ae1e";
    await reportTaskState(workspace, {
      taskId: FIRST_ID,
      threadId: FIRST_THREAD_ID,
      turnId: thirdTurnId,
      status: "working",
      requestSummary: "Try one final time.",
    });
    await reportTaskState(workspace, {
      taskId: FIRST_ID,
      threadId: FIRST_THREAD_ID,
      turnId: thirdTurnId,
      status: "failed",
      summary: "The final attempt failed.",
    });
    assert.equal((await archive()).status, 200);
    assert.deepEqual(archived, [FIRST_THREAD_ID, FIRST_THREAD_ID, FIRST_THREAD_ID]);

    blockArchive = true;
    const first = archive();
    await waitFor(() => releaseArchive !== null);
    let transitionSettled = false;
    const concurrentTransition = reportTaskState(workspace, {
      taskId: FIRST_ID,
      threadId: FIRST_THREAD_ID,
      turnId: "01a03275-d533-7043-ab4a-513a1ad6ae1e",
      status: "working",
      requestSummary: "Start only after archival finishes.",
    }).finally(() => { transitionSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transitionSettled, false);
    const duplicate = await archive();
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).message, /already being archived/);
    releaseArchive();
    assert.equal((await first).status, 200);
    await concurrentTransition;
  } finally {
    releaseArchive?.();
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
  assert.match(html, /aria-live="polite"/);
  assert.match(script, /const USAGE_POLL_INTERVAL_MS = 1_500;/);
  assert.match(script, /const MAX_USAGE_POLL_ATTEMPTS = 40;/);
  assert.match(script, /attempt < MAX_USAGE_POLL_ATTEMPTS/);
  assert.match(html, /id="notification-announcer"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(html, /id="toast-list"[^>]+aria-live/);
  assert.match(html, /id="clear-notifications"/);
  assert.match(html, /id="more-task-actions"[^>]+aria-label="More task actions"[^>]+aria-expanded="false"/);
  assert.match(
    html,
    /id="more-task-actions"[\s\S]*?id="manual-transition-panel"[\s\S]*?id="copy-task-id"[\s\S]*?id="mark-task-completed"[\s\S]*?id="mark-task-failed"[\s\S]*?id="archive-codex"/,
  );
  assert.match(styles, /--control-height: 38px;/);
  assert.match(styles, /\.primary-button, \.secondary-button, \.danger-button \{[^}]+min-height: var\(--control-height\)/);
  assert.match(styles, /\.primary-button\.task-action, \.secondary-button\.task-action \{[^}]+min-height: var\(--control-height\)[^}]+font-size: var\(--control-font-size\)/);
  assert.match(html, /<div class="dialog-actions" role="group" aria-label="Task actions">/);
  assert.match(styles, /\.manual-transition-panel, \.manual-transition-controls \{ display: contents; \}/);
  assert.match(styles, /\.manual-transition-controls > button\[hidden\] \{ display: none; \}/);
  assert.match(html, /id="date-filter"/);
  const toolbarMarkup = html.match(/<section class="toolbar"[\s\S]*?<\/section>/)?.[0];
  assert.ok(toolbarMarkup);
  assert.match(
    toolbarMarkup,
    /<div class="toolbar-primary">[\s\S]*?id="project-filter"[\s\S]*?id="date-filter"[\s\S]*?<\/div>\s*<fieldset class="status-filter-fieldset">/,
  );
  assert.match(html, /<fieldset class="status-filter-fieldset">/);
  assert.match(html, /<legend>Status<\/legend>/);
  const statusFilterMarkup = html.match(/<div id="status-filter"[\s\S]*?<\/div>/)?.[0];
  assert.ok(statusFilterMarkup);
  assert.deepEqual(
    [...statusFilterMarkup.matchAll(/<input type="radio" name="status-filter" value="([^"]*)"( checked)?>/g)]
      .map((match) => ({ value: match[1], checked: Boolean(match[2]) })),
    [
      { value: "", checked: true },
      { value: "working", checked: false },
      { value: "needs input", checked: false },
      { value: "completed", checked: false },
      { value: "failed", checked: false },
    ],
  );
  assert.match(statusFilterMarkup, /data-status-label="needs input">Needs input<\/span>/);
  assert.doesNotMatch(statusFilterMarkup, /<select/);
  assert.match(html, /id="dashboard-message-text" role="status" aria-live="polite"/);
  assert.match(html, /id="dismiss-dashboard-message"[^>]+type="button"[^>]+aria-label="Dismiss dashboard message"/);
  assert.match(html, /<title>TaskChef Dashboard<\/title>/);
  assert.match(html, /<h1>TaskChef Dashboard<\/h1>/);
  assert.match(html, /id="taskchef-version" class="dashboard-version"/);
  assert.match(html, /<source srcset="\/assets\/taskchef-dark\.svg" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /<img src="\/assets\/taskchef\.svg" alt="" width="48" height="48">/);
  assert.match(html, /<picture class="dashboard-icon" aria-hidden="true">/);
  assert.match(html, /<h3>Activity timeline<\/h3>/);
  assert.match(html, /id="dialog-results"/);
  assert.match(html, /id="open-codex"[^>]+aria-label="Open this task in Codex"/);
  assert.match(html, /id="copy-task-id"[^>]+aria-label="Copy Task ID"[^>]*>Copy Task ID<\/button>/);
  assert.match(html, /id="mark-task-completed"[^>]*>Mark completed<\/button>/);
  assert.match(html, /id="mark-task-failed"[^>]*>Mark failed<\/button>/);
  assert.doesNotMatch(html, /copy-thread-id|Copy thread ID/);
  assert.match(html, /class="codex-icon" aria-hidden="true"/);
  assert.match(html, /<span>Open task<\/span>/);
  assert.doesNotMatch(html, />Open task in Codex</);
  assert.doesNotMatch(html, />Task dashboard</);
  assert.match(script, /textContent = task\.instruction/);
  assert.match(script, /\[\.\.\.task\.turns\]\.reverse\(\)/);
  assert.match(script, /result-history-latest/);
  assert.match(script, /fetch\(`\/api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}`\)/);
  assert.match(script, /requestGeneration === detailRequestGeneration/);
  assert.match(script, /task\.results \?\? preservedResults \?\? \[\]/);
  assert.match(script, /latestTurnPresentation\(task\)/);
  assert.match(script, /mergeProjectedTurns\(task, state\.selectedTask\?\.turns \?\? \[\]\)/);
  assert.match(script, /openTask\.type = "button"/);
  assert.match(script, /configureOpenTaskControl\(openTask, `Open \$\{task\.title\} in Codex`\)/);
  assert.match(script, /configureOpenTaskControl\(elements\.openProject, `Open \$\{task\.title\} in Codex`\)/);
  assert.match(script, /picture\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(script, /openTaskFromControl\(event, task\.id/);
  assert.match(script, /relativeTimes\.register\(/);
  assert.match(script, /relativeTimes\.toggle\(key\)/);
  assert.match(script, /time\.dateTime = iso/);
  assert.match(script, /control\.setAttribute\("aria-label"/);
  assert.match(script, /control\.title = action/);
  assert.match(script, /elements\.dashboardMessageText\.textContent = message/);
  assert.match(script, /querySelector\("input:checked"\)\?\.value \?\? ""/);
  assert.match(script, /elements\.statusFilter\.addEventListener\("keydown", selectStatusFromKeyboard\)/);
  assert.match(script, /const contextualTasks = filterTasks\(state\.tasks, \{ project, date, now \}\)/);
  assert.match(script, /statusFilterCounts\(state\.tasks, \{ project, date, now \}\)/);
  assert.match(script, /statusFilterText\(value, counts\[value\]\)/);
  assert.match(script, /fetch\("\/api\/health"\)/);
  assert.match(script, /elements\.taskchefVersion\.textContent = `v\$\{identity\.taskchefVersion\}`/);
  assert.match(script, /`TaskChef version \$\{identity\.taskchefVersion\}`/);
  assert.match(script, /elements\.dismissDashboardMessage\.addEventListener\("click", \(\) => \{/);
  assert.match(script, /elements\.dashboardMessage\.hidden = true/);
  assert.match(script, /notificationOpenLabel\(notification, Boolean\(task\)\)/);
  assert.match(script, /submitManualTransition\("completed", event\)/);
  assert.match(script, /submitManualTransition\("failed", event\)/);
  assert.match(actionScript, /event\.key !== "Escape"/);
  assert.match(script, /dialog\.addEventListener\("cancel"/);
  assert.match(script, /aria-busy/);
  assert.match(script, /Saving task state…/);
  assert.match(html, /id="manual-transition-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(script, /\b(?:alert|confirm)\s*\(/);
  assert.match(actionScript, /manual-transition/);
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
  assert.match(styles, /\.task-open \{ align-self: flex-start; \}/);
  assert.match(styles, /\.task-list \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(styles, /\.task-title, \.task-summary \{ overflow-wrap: anywhere; \}/);
  assert.match(styles, /\.github-link \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.github-links \{[^}]*display: grid;/);
  assert.match(styles, /\.github-links-group \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.dialog-actions \{ align-items: center; flex-flow: row wrap; \}/);
  assert.match(styles, /\.toolbar \{[^}]*display: grid;/);
  assert.match(styles, /\.toolbar-primary \{[^}]*grid-template-columns: repeat\(2, minmax\(180px, 240px\)\);/);
  assert.match(styles, /\.status-filter-fieldset \{[^}]*width: 100%;/);
  assert.match(styles, /\.status-filter-options \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.status-filter-option:has\(input:checked\) span \{/);
  assert.match(styles, /\.status-filter-option:has\(input:focus-visible\) span \{/);
  assert.match(styles, /h1 \{[^}]*font-size: clamp\(1\.9rem, 4\.5vw, 3\.1rem\);/);
  assert.match(styles, /\.task-card \{[^}]*padding: 16px 18px;/);
  assert.match(styles, /\.task-summary \{[^}]*font-size: 0\.9rem;[^}]*line-height: 1\.45;/);
  assert.match(styles, /\.status-filter-option span \{[^}]*min-height: 34px;[^}]*padding: 5px 10px;/);
  assert.match(styles, /\.primary-button\.task-action, \.secondary-button\.task-action \{[^}]*min-height: var\(--control-height\);/);
  assert.match(styles, /@media \(max-width: 650px\)[\s\S]*\.toolbar \.status-filter-option \{ width: auto; \}/);
  assert.match(styles, /@media \(max-width: 650px\) \{\s*:root \{ --control-height: 40px; \}/);
  assert.doesNotMatch(styles, /\.manual-transition-controls > button \{ min-height: 40px; \}/);
  assert.match(styles, /@media \(max-width: 650px\)[\s\S]*\.status-filter-option span \{ min-height: 38px; \}/);
  assert.match(styles, /@media \(max-width: 650px\)[\s\S]*\.task-title, \.timestamp-toggle \{[^}]*min-height: 36px;/);
  assert.match(styles, /@media \(max-width: 650px\)[\s\S]*\.github-links \{ max-width: 100%; \}/);
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*\.toolbar-primary \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\)[\s\S]*\.status-filter-option:has\(input:checked\) span \{ color: var\(--background\); \}/);
});

test("Open task controls use the shared authoritative Codex app assets", async () => {
  const html = await readFile(path.resolve("src/dashboard/index.html"), "utf8");
  const script = await readFile(path.resolve("src/dashboard/app.js"), "utf8");
  const styles = await readFile(path.resolve("src/dashboard/styles.css"), "utf8");
  const source = `${html}\n${script}\n${styles}`;
  const expectedAssets = new Map([
    ["codex-app-dark.png", "69fb4384e161be8a20dcb94a9ac34aea4fbfaeb67514110a71e7b0732eccb0fc"],
    ["codex-app-light.png", "de7d43f3386105ab20952958c2c25beb0d903e2aeb6e1aef57c49a648c0d1c07"],
  ]);

  for (const [assetName, expectedDigest] of expectedAssets) {
    const asset = await readFile(path.resolve("assets", assetName));
    assert.equal(asset.readUInt32BE(16), 1024);
    assert.equal(asset.readUInt32BE(20), 1024);
    assert.equal(createHash("sha256").update(asset).digest("hex"), expectedDigest);
  }

  const sharedIcon = script.match(/function codexIcon\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  assert.ok(sharedIcon);
  assert.match(sharedIcon, /dark\.srcset = "\/assets\/codex-app-dark\.png"/);
  assert.match(sharedIcon, /image\.src = "\/assets\/codex-app-light\.png"/);
  assert.match(sharedIcon, /picture\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(sharedIcon, /image\.alt = ""/);
  assert.match(script, /configureOpenTaskControl\(openTask,/);
  assert.match(script, /configureOpenTaskControl\(elements\.openProject,/);

  const detailControl = html.match(/<button id="open-codex"[\s\S]*?<\/button>/)?.[0];
  assert.ok(detailControl);
  assert.match(detailControl, /<source srcset="\/assets\/codex-app-dark\.png"/);
  assert.match(detailControl, /<img src="\/assets\/codex-app-light\.png" alt="" width="18" height="18">/);
  assert.match(detailControl, /<picture class="codex-icon" aria-hidden="true">/);
  assert.match(styles, /\.codex-icon \{[^}]*width: 18px; height: 18px;/);
  assert.match(styles, /\.codex-icon img \{[^}]*object-fit: contain;/);

  await assert.rejects(readFile(path.resolve("assets/codex.svg")), { code: "ENOENT" });
  assert.doesNotMatch(source, /codex\.svg|mask:\s*url\(|background:\s*currentColor/);
});
