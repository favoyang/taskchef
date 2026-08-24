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
    showMessage(result.message);
  } finally {
    control.disabled = false;
  }
}
