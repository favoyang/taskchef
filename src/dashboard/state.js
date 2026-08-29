export const MAX_NOTIFICATIONS = 50;
const INTERRUPTED_TURN_SUMMARY = "Turn interrupted before a terminal report.";
export const KNOWN_TASK_STATUSES = [
  "working",
  "needs input",
  "completed",
  "failed",
];
export const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "working", label: "Working" },
  { value: "needs input", label: "Needs input" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];
const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Disabled because the bundled `codex archive` command can reject valid idle
// desktop-app threads while Codex's native archive operation succeeds. Keep
// the implementation behind this gate until Codex exposes a reliable,
// supported app-callable archive interface or guarantees CLI compatibility.
export const CODEX_CHAT_ARCHIVE_ENABLED = false;

const NOTIFICATION_TITLES = new Map([
  ["created", "Task created"],
  ["task_started", "Task started"],
  ["follow_up_started", "Follow-up started"],
  ["completed", "Task completed"],
  ["needs_input", "Task needs input"],
  ["failed", "Task failed"],
  ["manual_completed", "Task manually completed"],
  ["manual_failed", "Task manually failed"],
  ["archive_succeeded", "Chat archived"],
  ["archive_failed", "Chat archive failed"],
  ["unresolved", "Task updated"],
]);

const DATE_WINDOWS_MS = new Map([
  ["24h", 24 * 60 * 60 * 1_000],
  ["7d", 7 * 24 * 60 * 60 * 1_000],
  ["all", null],
]);

function taskMeaningfulTime(task) {
  return Date.parse(task.meaningfulUpdatedAt ?? task.updatedAt ?? task.createdAt);
}

export function taskStatusLabel(task) {
  return task.status === null ? "unresolved" : task.status.replaceAll("_", " ");
}

export function isArchiveTaskEligible(task) {
  return task.status !== "working"
    && typeof task.threadId === "string"
    && CODEX_THREAD_ID_PATTERN.test(task.threadId);
}

export function canArchiveTask(task) {
  return CODEX_CHAT_ARCHIVE_ENABLED && isArchiveTaskEligible(task);
}

export function canManuallyTransitionTask(task, targetStatus = null) {
  const targets = task.status === "completed"
    ? ["failed"]
    : task.status === "failed"
      ? ["completed"]
      : ["working", "needs_input"].includes(task.status)
        ? ["completed", "failed"]
        : [];
  return targetStatus === null ? targets.length > 0 : targets.includes(targetStatus);
}

export function manualTransitionExpectedState(task) {
  return {
    status: task.status,
    turnRef: task.turnRef,
    threadId: task.threadId,
    updatedAt: task.updatedAt,
  };
}

export function taskMatchesManualTransitionExpected(task, expected) {
  return Boolean(expected)
    && task.status === expected.status
    && task.turnRef === expected.turnRef
    && task.threadId === expected.threadId
    && task.updatedAt === expected.updatedAt;
}

export function reconcileManualTransition(transition, task) {
  if (!transition || transition.taskId !== task.id) return null;
  if (transition.stage === "pending") return transition;
  if (taskMatchesManualTransitionExpected(task, transition.expected)) return transition;
  return {
    taskId: task.id,
    stage: "choose",
    expected: manualTransitionExpectedState(task),
  };
}

export function reconcileManualTransitionResponse({
  requestTask,
  expected,
  responseTask,
  selectedTask,
}) {
  const current = selectedTask?.id === requestTask.id ? selectedTask : requestTask;
  return taskMatchesManualTransitionExpected(current, expected)
    ? (responseTask ?? current)
    : current;
}

export function latestTurnPresentation(task) {
  const turn = task.latestTurn ?? null;
  const result = turn?.result ?? null;
  const requestSummary = turn?.requestSummary
    ?? (turn ? "Request not recorded by this TaskChef version." : task.title);
  return {
    turnRef: turn?.turnRef ?? turn?.turnId ?? task.turnRef ?? task.turnId ?? null,
    turnId: turn?.turnId ?? task.turnId ?? null,
    startedAt: turn?.startedAt ?? task.updatedAt ?? task.createdAt ?? null,
    requestSummary,
    resultStatus: result?.status ?? (task.status === "working" ? "working" : task.status),
    resultSummary: result?.summary
      ?? (task.status === "working"
        ? "In progress"
        : task.lastResult?.summary ?? task.summary ?? "No result reported."),
    resultUpdatedAt: result?.updatedAt ?? null,
  };
}

export function turnPresentation(turn) {
  const result = turn.result ?? null;
  return {
    status: result?.status ?? "working",
    summary: result?.summary ?? "In progress",
    updatedAt: result?.updatedAt ?? turn.startedAt,
    ...(turn.provenance?.kind === "dashboard_manual"
      ? { sourceLabel: "Manual dashboard change" }
      : {}),
  };
}

export function mergeProjectedTurns(task, preservedTurns = []) {
  if (Array.isArray(task.turns)) return task.turns;
  if (!task.latestTurn) return preservedTurns;
  const turns = [...preservedTurns];
  const lastIndex = turns.length - 1;
  const latestIdentity = task.latestTurn.turnRef ?? task.latestTurn.turnId;
  const preservedIdentity = lastIndex >= 0
    ? (turns[lastIndex].turnRef ?? turns[lastIndex].turnId)
    : null;
  const migratedFallbackIdentity = lastIndex >= 0
    && preservedIdentity === null
    && latestIdentity !== null
    && turns[lastIndex].turnId == null
    && task.latestTurn.turnId == null
    && JSON.stringify({ ...turns[lastIndex], turnRef: null })
      === JSON.stringify({ ...task.latestTurn, turnRef: null });
  if (
    lastIndex >= 0
    && (preservedIdentity === latestIdentity || migratedFallbackIdentity)
  ) {
    turns[lastIndex] = task.latestTurn;
  } else {
    if (
      task.schemaVersion >= 8
      && lastIndex >= 0
      && turns[lastIndex].result === null
    ) {
      turns[lastIndex] = {
        ...turns[lastIndex],
        result: {
          status: "interrupted",
          summary: INTERRUPTED_TURN_SUMMARY,
          updatedAt: task.latestTurn.startedAt,
        },
      };
    }
    turns.push(task.latestTurn);
  }
  return turns;
}

export function notificationTitle(notification) {
  return NOTIFICATION_TITLES.get(notification.event) ?? "Task updated";
}

export function taskWithinDateFilter(task, filter, now = Date.now()) {
  const windowMs = DATE_WINDOWS_MS.get(filter);
  if (windowMs === null) return true;
  if (windowMs === undefined) return false;
  const meaningfulTime = taskMeaningfulTime(task);
  return Number.isFinite(meaningfulTime) && meaningfulTime >= now - windowMs;
}

export function filterTasks(
  tasks,
  { project = "", status = "", date = "all", now = Date.now() } = {},
) {
  return tasks.filter((task) =>
    (!project || task.project.name === project)
    && (!status || taskStatusLabel(task) === status)
    && taskWithinDateFilter(task, date, now));
}

export function statusFilterCounts(
  tasks,
  { project = "", date = "all", now = Date.now() } = {},
) {
  const contextualTasks = filterTasks(tasks, { project, date, now });
  return Object.fromEntries(STATUS_FILTERS.map(({ value }) => [
    value,
    value
      ? contextualTasks.filter((task) => taskStatusLabel(task) === value).length
      : contextualTasks.length,
  ]));
}

export function statusFilterText(value, count) {
  const option = STATUS_FILTERS.find((filter) => filter.value === value);
  if (!option) return "";
  return count > 0 ? `${option.label} (${count})` : option.label;
}

export function nextDateFilterRefreshDelay(tasks, filter, now = Date.now()) {
  const windowMs = DATE_WINDOWS_MS.get(filter);
  if (windowMs === null || windowMs === undefined) return null;
  const nextCutoff = tasks
    .map((task) => taskMeaningfulTime(task) + windowMs - now)
    .filter((delay) => Number.isFinite(delay) && delay >= 0)
    .reduce((minimum, delay) => Math.min(minimum, delay), Number.POSITIVE_INFINITY);
  return Number.isFinite(nextCutoff) ? nextCutoff + 1 : null;
}

export function taskSignature(task) {
  return JSON.stringify([
    task.id,
    task.turnRef ?? task.turnId ?? null,
    task.turnId ?? null,
    task.status ?? "unresolved",
  ]);
}

function signaturesDifferOnlyByMigratedFallback(previous, next) {
  try {
    const before = JSON.parse(previous);
    const after = JSON.parse(next);
    return Array.isArray(before)
      && Array.isArray(after)
      && before.length === after.length
      && before[1] === null
      && after[1] !== null
      && before[2] === null
      && after[2] === null
      && before[3] !== "working"
      && before.every((value, index) => index === 1 || value === after[index]);
  } catch {
    return false;
  }
}

export function findCurrentTask(tasks, taskId) {
  return tasks.find((task) => task.id === taskId) ?? null;
}

function lifecycleEvent(task) {
  if (task.status === "working") {
    return task.lastResult ? "follow_up_started" : "task_started";
  }
  if (task.latestTurn?.provenance?.kind === "dashboard_manual") {
    return `manual_${task.status}`;
  }
  return task.status ?? "unresolved";
}

function notificationIdentity(task, event) {
  if (event === "created") {
    return JSON.stringify([task.id, null, event, task.createdAt ?? null]);
  }
  return JSON.stringify([task.id, task.turnRef ?? task.turnId ?? null, event]);
}

function eventTimestamp(task, event) {
  if (event === "created") return task.createdAt ?? task.updatedAt ?? null;
  if (
    task.lastResult?.status === task.status
    && (task.lastResult?.turnRef ?? task.lastResult?.turnId)
      === (task.turnRef ?? task.turnId)
  ) {
    return task.lastResult.updatedAt;
  }
  return task.updatedAt ?? task.createdAt ?? null;
}

function eventSummary(task, event) {
  if (!["completed", "needs_input", "failed", "manual_completed", "manual_failed"].includes(event)) {
    return null;
  }
  if (
    task.lastResult?.status === task.status
    && (task.lastResult?.turnRef ?? task.lastResult?.turnId)
      === (task.turnRef ?? task.turnId)
  ) {
    return task.lastResult.summary;
  }
  return task.summary ?? null;
}

export function notificationSnapshot(task, event = lifecycleEvent(task)) {
  const created = event === "created";
  return Object.freeze({
    id: notificationIdentity(task, event),
    taskId: task.id,
    title: task.title,
    status: created ? "working" : task.status,
    event,
    turnRef: created ? null : task.turnRef ?? task.turnId ?? null,
    turnId: created ? null : task.turnId ?? null,
    timestamp: eventTimestamp(task, event),
    summary: eventSummary(task, event),
  });
}

function resultNotificationSnapshot(task) {
  const result = task.lastResult;
  if (!result) return null;
  const event = result.provenance?.kind === "dashboard_manual"
    ? `manual_${result.status}`
    : result.status;
  return Object.freeze({
    id: notificationIdentity({
      ...task,
      turnRef: result.turnRef ?? result.turnId,
      turnId: result.turnId,
    }, event),
    taskId: task.id,
    title: task.title,
    status: result.status,
    event,
    turnRef: result.turnRef ?? result.turnId ?? null,
    turnId: result.turnId ?? null,
    timestamp: result.updatedAt,
    summary: result.summary,
  });
}

export function notificationOpenLabel(notification, available) {
  const action = available ? "Open current task details" : "Show task availability";
  return `${action} for ${notification.title}: ${notificationTitle(notification)}`;
}

export function notificationDismissLabel(notification) {
  return `Dismiss ${notificationTitle(notification)} notification for ${notification.title}`;
}

export function dismissNotification(notifications, notificationId) {
  return notifications.filter(({ id }) => id !== notificationId);
}

export function clearNotifications() {
  return [];
}

export function reconcileNotifications(
  { initialized, notifications, seenIds = new Set(), signatures },
  tasks,
) {
  const nextSignatures = new Map(signatures);
  for (const task of tasks) nextSignatures.set(task.id, taskSignature(task));
  const nextSeenIds = new Set(seenIds);
  if (!initialized) {
    for (const task of tasks) {
      nextSeenIds.add(notificationSnapshot(task, "created").id);
      const resultNotification = resultNotificationSnapshot(task);
      if (resultNotification) nextSeenIds.add(resultNotification.id);
      nextSeenIds.add(notificationSnapshot(task).id);
    }
    return {
      additions: [],
      notifications,
      seenIds: nextSeenIds,
      signatures: nextSignatures,
    };
  }
  const additions = [];
  for (const task of tasks) {
    const candidates = [];
    if (!signatures.has(task.id)) {
      const resultNotification = resultNotificationSnapshot(task);
      if (task.turnRef || task.turnId || task.status !== "working" || resultNotification) {
        candidates.push(notificationSnapshot(task));
        if (resultNotification) candidates.push(resultNotification);
      }
      candidates.push(notificationSnapshot(task, "created"));
    } else if (
      signatures.get(task.id) !== nextSignatures.get(task.id)
      && !signaturesDifferOnlyByMigratedFallback(
        signatures.get(task.id),
        nextSignatures.get(task.id),
      )
    ) {
      candidates.push(notificationSnapshot(task));
      const resultNotification = resultNotificationSnapshot(task);
      if (resultNotification) candidates.push(resultNotification);
    }
    for (const notification of candidates) {
      if (!nextSeenIds.has(notification.id)) additions.push(notification);
      nextSeenIds.add(notification.id);
    }
    const resultNotification = resultNotificationSnapshot(task);
    if (resultNotification) nextSeenIds.add(resultNotification.id);
    nextSeenIds.add(notificationSnapshot(task).id);
  }
  return {
    additions,
    notifications: [...additions, ...notifications].slice(0, MAX_NOTIFICATIONS),
    seenIds: nextSeenIds,
    signatures: nextSignatures,
  };
}
