export const MAX_NOTIFICATIONS = 50;
const INTERRUPTED_TURN_SUMMARY = "Turn interrupted before a terminal report.";
export const KNOWN_TASK_STATUSES = [
  "working",
  "needs input",
  "completed",
  "failed",
  "unresolved",
];

const NOTIFICATION_TITLES = new Map([
  ["created", "Task created"],
  ["task_started", "Task started"],
  ["follow_up_started", "Follow-up started"],
  ["completed", "Task completed"],
  ["needs_input", "Task needs input"],
  ["failed", "Task failed"],
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

export function latestTurnPresentation(task) {
  const turn = task.latestTurn ?? null;
  const result = turn?.result ?? null;
  const requestSummary = turn?.requestSummary
    ?? (turn ? "Request not recorded by this TaskChef version." : task.title);
  return {
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
  };
}

export function mergeProjectedTurns(task, preservedTurns = []) {
  if (Array.isArray(task.turns)) return task.turns;
  if (!task.latestTurn) return preservedTurns;
  const turns = [...preservedTurns];
  const lastIndex = turns.length - 1;
  if (lastIndex >= 0 && turns[lastIndex].turnId === task.latestTurn.turnId) {
    turns[lastIndex] = task.latestTurn;
  } else {
    if (
      task.schemaVersion === 8
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
  return JSON.stringify([task.id, task.turnId ?? null, task.status ?? "unresolved"]);
}

export function findCurrentTask(tasks, taskId) {
  return tasks.find((task) => task.id === taskId) ?? null;
}

function lifecycleEvent(task) {
  if (task.status === "working") {
    return task.lastResult ? "follow_up_started" : "task_started";
  }
  return task.status ?? "unresolved";
}

function notificationIdentity(task, event) {
  if (event === "created") {
    return JSON.stringify([task.id, null, event, task.createdAt ?? null]);
  }
  return JSON.stringify([task.id, task.turnId ?? null, event]);
}

function eventTimestamp(task, event) {
  if (event === "created") return task.createdAt ?? task.updatedAt ?? null;
  if (
    task.lastResult?.status === task.status
    && task.lastResult?.turnId === task.turnId
  ) {
    return task.lastResult.updatedAt;
  }
  return task.updatedAt ?? task.createdAt ?? null;
}

function eventSummary(task, event) {
  if (!["completed", "needs_input", "failed"].includes(event)) return null;
  if (
    task.lastResult?.status === task.status
    && task.lastResult?.turnId === task.turnId
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
    turnId: created ? null : task.turnId ?? null,
    timestamp: eventTimestamp(task, event),
    summary: eventSummary(task, event),
  });
}

function resultNotificationSnapshot(task) {
  const result = task.lastResult;
  if (!result) return null;
  return Object.freeze({
    id: notificationIdentity({ ...task, turnId: result.turnId }, result.status),
    taskId: task.id,
    title: task.title,
    status: result.status,
    event: result.status,
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
      if (task.turnId || task.status !== "working" || resultNotification) {
        candidates.push(notificationSnapshot(task));
        if (resultNotification) candidates.push(resultNotification);
      }
      candidates.push(notificationSnapshot(task, "created"));
    } else if (signatures.get(task.id) !== nextSignatures.get(task.id)) {
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
