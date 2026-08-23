export const MAX_NOTIFICATIONS = 50;
export const KNOWN_TASK_STATUSES = [
  "working",
  "needs input",
  "completed",
  "failed",
  "unresolved",
];

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

export function notificationTitle(task, kind) {
  return kind === "new" ? "New task" : `Task ${taskStatusLabel(task)}`;
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
  return JSON.stringify([
    task.threadId,
    task.status,
    task.summary,
    task.turnId,
    task.updatedAt,
    task.updatedBy,
  ]);
}

export function findCurrentTask(tasks, taskId) {
  return tasks.find((task) => task.id === taskId) ?? null;
}

export function reconcileNotifications(
  { initialized, notifications, signatures },
  tasks,
  revision,
) {
  const nextSignatures = new Map(tasks.map((task) => [task.id, taskSignature(task)]));
  if (!initialized) return { notifications, signatures: nextSignatures };
  const additions = [];
  for (const task of tasks) {
    let kind = null;
    if (!signatures.has(task.id)) kind = "new";
    else if (signatures.get(task.id) !== nextSignatures.get(task.id)) kind = "changed";
    if (kind) additions.push({
      id: `${revision}:${task.id}`,
      kind,
      taskId: task.id,
    });
  }
  return {
    notifications: [...additions, ...notifications].slice(0, MAX_NOTIFICATIONS),
    signatures: nextSignatures,
  };
}
