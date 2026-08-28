export async function openTaskFromControl(event, taskId, {
  fetchAction = globalThis.fetch,
  showMessage,
} = {}) {
  event.stopPropagation();
  const control = event.currentTarget;
  control.disabled = true;
  try {
    const response = await fetchAction(`/api/tasks/${encodeURIComponent(taskId)}/open-codex`, {
      method: "POST",
    });
    const result = await response.json();
    if (result.message) showMessage(result.message);
  } finally {
    control.disabled = false;
  }
}

export async function archiveTaskFromControl(event, task, {
  confirmAction = globalThis.confirm,
  fetchAction = globalThis.fetch,
  onArchived = () => {},
  showMessage,
} = {}) {
  event.stopPropagation();
  const accepted = confirmAction(
    `Archive “${task.title}” in Codex?\n\n`
    + "The chat will leave active Codex lists, and spawned descendant chats may also be archived. "
    + "TaskChef history will remain available.",
  );
  if (!accepted) return false;
  const control = event.currentTarget;
  let archived = false;
  control.disabled = true;
  try {
    const response = await fetchAction(
      `/api/tasks/${encodeURIComponent(task.id)}/archive-codex`,
      { method: "POST" },
    );
    const result = await response.json();
    if (!response.ok) {
      showMessage(result.message ?? "Codex could not archive this chat.");
      return false;
    }
    onArchived(task.threadId);
    archived = true;
    showMessage(result.message ?? "Archived the Codex chat. TaskChef history remains available.");
    return true;
  } catch {
    showMessage("Codex chat archiving is temporarily unavailable. Try again.");
    return false;
  } finally {
    if (!archived) control.disabled = false;
  }
}

export async function manuallyTransitionTaskFromControl(event, task, targetStatus, actionId, {
  clearTimer = globalThis.clearTimeout,
  fetchAction = globalThis.fetch,
  setTimer = globalThis.setTimeout,
  timeoutMs = 10_000,
} = {}) {
  event?.stopPropagation?.();
  const controller = new AbortController();
  const timeout = setTimer(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchAction(
      `/api/tasks/${encodeURIComponent(task.id)}/manual-transition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          actionId,
          expected: {
            status: task.status,
            turnRef: task.turnRef,
            threadId: task.threadId,
            updatedAt: task.updatedAt,
          },
          targetStatus,
        }),
          signal: controller.signal,
        },
    );
    const result = await response.json();
    return response.ok
      ? { ok: true, ...result }
      : {
        ok: false,
        code: result.code ?? "dashboard_error",
        message: result.message ?? "Task state could not be changed.",
        task: result.task ?? null,
      };
  } catch {
    return {
      ok: false,
      code: controller.signal.aborted ? "request_timeout" : "network_error",
      message: controller.signal.aborted
        ? "Task state change timed out. Try again."
        : "Task state changes are temporarily unavailable. Try again.",
      task: null,
    };
  } finally {
    clearTimer(timeout);
  }
}

export function handleManualTransitionEscape(event, {
  active,
  pending,
  cancel,
}) {
  if (event.key !== "Escape" || !active) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!pending) cancel();
  return true;
}

export function focusManualTransitionStatus(panel) {
  const status = panel.querySelector('[data-manual-focus="pending"]');
  status?.focus();
  return status !== null;
}

export function restoreTaskActionMenuFocus(panel, activeElement, fallback) {
  if (!activeElement || !panel.contains(activeElement)) return null;
  if (!activeElement.hidden && !activeElement.disabled) return activeElement;
  const copyTaskId = panel.querySelector('[data-manual-focus="copy"]');
  const destination = copyTaskId && !copyTaskId.hidden && !copyTaskId.disabled
    ? copyTaskId
    : fallback;
  destination?.focus();
  return destination ?? null;
}
