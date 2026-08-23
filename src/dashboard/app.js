import {
  findCurrentTask,
  reconcileNotifications,
} from "./state.js";

const state = {
  tasks: [],
  signatures: new Map(),
  notifications: [],
  initialized: false,
  selectedTask: null,
};

const elements = {
  clearNotifications: document.querySelector("#clear-notifications"),
  closeDialog: document.querySelector("#close-dialog"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  copyThreadId: document.querySelector("#copy-thread-id"),
  dashboardMessage: document.querySelector("#dashboard-message"),
  dialog: document.querySelector("#task-dialog"),
  dialogInstruction: document.querySelector("#dialog-instruction"),
  dialogMetadata: document.querySelector("#dialog-metadata"),
  dialogProject: document.querySelector("#dialog-project"),
  dialogSummary: document.querySelector("#dialog-summary"),
  dialogTitle: document.querySelector("#dialog-title"),
  emptyState: document.querySelector("#empty-state"),
  notifications: document.querySelector("#notifications"),
  openProject: document.querySelector("#open-project"),
  projectFilter: document.querySelector("#project-filter"),
  statusFilter: document.querySelector("#status-filter"),
  taskCount: document.querySelector("#task-count"),
  taskList: document.querySelector("#task-list"),
  toastList: document.querySelector("#toast-list"),
};

function statusLabel(task) {
  return task.status === null ? "unresolved" : task.status.replaceAll("_", " ");
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function setConnection(connected) {
  elements.connectionDot.classList.toggle("connected", connected);
  elements.connectionLabel.textContent = connected ? "Live" : "Reconnecting…";
}

function replaceOptions(select, values, allLabel) {
  const selected = select.value;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = allLabel;
  select.append(all);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  if (values.includes(selected)) select.value = selected;
}

function notificationToast(notification) {
  const task = findCurrentTask(state.tasks, notification.taskId);
  if (!task) return null;
  const toast = document.createElement("div");
  toast.className = "toast";
  const text = document.createElement("button");
  text.type = "button";
  text.className = "toast-content";
  const title = document.createElement("strong");
  title.textContent = notification.kind === "new" ? "New task" : "Task updated";
  const description = document.createElement("span");
  description.textContent = `${task.title} · ${statusLabel(task)}`;
  text.append(title, description);
  text.addEventListener("click", () => {
    const current = findCurrentTask(state.tasks, notification.taskId);
    if (current) openDialog(current);
    else showMessage("This task is no longer present in the current snapshot.");
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "icon-button";
  dismiss.setAttribute("aria-label", `Dismiss notification for ${task.title}`);
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    state.notifications = state.notifications.filter(({ id }) => id !== notification.id);
    renderNotifications();
  });
  toast.append(text, dismiss);
  return toast;
}

function renderNotifications() {
  elements.toastList.replaceChildren(
    ...state.notifications.map(notificationToast).filter(Boolean),
  );
  elements.notifications.hidden = state.notifications.length === 0;
}

function detailRow(term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value ?? "—";
  return [dt, dd];
}

function openDialog(task) {
  state.selectedTask = task;
  elements.dialogProject.textContent = task.project.name;
  elements.dialogTitle.textContent = task.title;
  elements.dialogSummary.textContent = task.summary ?? "No semantic result has been reported yet.";
  elements.dialogInstruction.textContent = task.instruction;
  elements.copyThreadId.disabled = !task.threadId;
  elements.dialogMetadata.replaceChildren(
    ...detailRow("Status", statusLabel(task)),
    ...detailRow("Task ID", task.id),
    ...detailRow("Thread ID", task.threadId),
    ...detailRow("Turn ID", task.turnId),
    ...detailRow("Project path", task.project.path),
    ...detailRow("Created", formatTime(task.createdAt)),
    ...detailRow("Updated", formatTime(task.updatedAt ?? task.createdAt)),
    ...detailRow("Updated by", task.updatedBy),
  );
  if (!elements.dialog.open) elements.dialog.showModal();
}

function taskCard(task) {
  const article = document.createElement("article");
  article.className = "task-card";
  const heading = document.createElement("div");
  heading.className = "task-heading";
  const title = document.createElement("button");
  title.type = "button";
  title.className = "task-title";
  title.textContent = task.title;
  title.addEventListener("click", () => openDialog(task));
  const badge = document.createElement("span");
  badge.className = `status status-${task.status ?? "unresolved"}`;
  badge.textContent = statusLabel(task);
  heading.append(title, badge);
  const project = document.createElement("p");
  project.className = "task-project";
  project.textContent = task.project.name;
  const summary = document.createElement("p");
  summary.className = "task-summary";
  summary.textContent = task.summary ?? "No semantic result reported yet.";
  const time = document.createElement("time");
  time.dateTime = task.updatedAt ?? task.createdAt;
  time.textContent = `Updated ${formatTime(task.updatedAt ?? task.createdAt)}`;
  article.append(heading, project, summary, time);
  return article;
}

function render() {
  const project = elements.projectFilter.value;
  const status = elements.statusFilter.value;
  const visible = state.tasks.filter((task) =>
    (!project || task.project.name === project)
    && (!status || statusLabel(task) === status));
  elements.taskList.replaceChildren(...visible.map(taskCard));
  elements.emptyState.hidden = visible.length > 0;
  elements.taskCount.textContent = `${visible.length} of ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;
}

function applySnapshot(snapshot) {
  const reconciled = reconcileNotifications({
    initialized: state.initialized,
    notifications: state.notifications,
    signatures: state.signatures,
  }, snapshot.tasks, snapshot.revision);
  state.tasks = snapshot.tasks;
  state.signatures = reconciled.signatures;
  state.notifications = reconciled.notifications;
  state.initialized = true;
  if (snapshot.healthy === false) {
    showMessage("The task log is temporarily unavailable. Showing the last valid snapshot.");
  } else {
    elements.dashboardMessage.hidden = true;
  }
  replaceOptions(
    elements.projectFilter,
    [...new Set(state.tasks.map((task) => task.project.name))].sort(),
    "All projects",
  );
  replaceOptions(
    elements.statusFilter,
    [...new Set(state.tasks.map(statusLabel))].sort(),
    "All statuses",
  );
  if (state.selectedTask) {
    const updated = state.tasks.find((task) => task.id === state.selectedTask.id);
    if (updated && elements.dialog.open) openDialog(updated);
  }
  renderNotifications();
  render();
}

function showMessage(message) {
  elements.dashboardMessage.textContent = message;
  elements.dashboardMessage.hidden = false;
}

const events = new EventSource("/api/events");
events.addEventListener("open", () => setConnection(true));
events.addEventListener("error", () => setConnection(false));
events.addEventListener("snapshot", (event) => {
  setConnection(true);
  applySnapshot(JSON.parse(event.data));
});
events.addEventListener("dashboard-error", (event) => {
  showMessage(JSON.parse(event.data).message);
});

elements.projectFilter.addEventListener("change", render);
elements.statusFilter.addEventListener("change", render);
elements.clearNotifications.addEventListener("click", () => {
  state.notifications = [];
  renderNotifications();
});
elements.closeDialog.addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});
elements.copyThreadId.addEventListener("click", async () => {
  if (!state.selectedTask?.threadId) return;
  try {
    await navigator.clipboard.writeText(state.selectedTask.threadId);
    elements.copyThreadId.textContent = "Copied";
    setTimeout(() => { elements.copyThreadId.textContent = "Copy thread ID"; }, 1_500);
  } catch {
    showMessage("Clipboard access is unavailable. Copy the thread ID from the metadata below.");
  }
});
elements.openProject.addEventListener("click", async () => {
  if (!state.selectedTask) return;
  elements.openProject.disabled = true;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(state.selectedTask.id)}/open-project`, {
      method: "POST",
    });
    const result = await response.json();
    showMessage(result.message);
  } finally {
    elements.openProject.disabled = false;
  }
});
