import {
  clearNotifications,
  dismissNotification,
  findCurrentTask,
  KNOWN_TASK_STATUSES,
  nextDateFilterRefreshDelay,
  notificationDismissLabel,
  notificationOpenLabel,
  notificationTitle,
  reconcileNotifications,
  taskStatusLabel,
  taskWithinDateFilter,
} from "./state.js";
import { openTaskFromControl } from "./actions.js";
import { formatRelativeTime, RelativeTimeController, parsedTimestamp } from "./time.js";

const state = {
  tasks: [],
  signatures: new Map(),
  notifications: [],
  seenNotificationIds: new Set(),
  initialized: false,
  selectedTask: null,
};
let dateRefreshTimer = null;
let detailRequestGeneration = 0;
const relativeTimes = new RelativeTimeController();

const elements = {
  clearNotifications: document.querySelector("#clear-notifications"),
  closeDialog: document.querySelector("#close-dialog"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  copyThreadId: document.querySelector("#copy-thread-id"),
  dashboardMessage: document.querySelector("#dashboard-message"),
  dashboardMessageText: document.querySelector("#dashboard-message-text"),
  dateFilter: document.querySelector("#date-filter"),
  dialog: document.querySelector("#task-dialog"),
  dialogInstruction: document.querySelector("#dialog-instruction"),
  dialogMetadata: document.querySelector("#dialog-metadata"),
  dialogProject: document.querySelector("#dialog-project"),
  dialogResults: document.querySelector("#dialog-results"),
  dialogTitle: document.querySelector("#dialog-title"),
  dismissDashboardMessage: document.querySelector("#dismiss-dashboard-message"),
  emptyState: document.querySelector("#empty-state"),
  notifications: document.querySelector("#notifications"),
  notificationAnnouncer: document.querySelector("#notification-announcer"),
  openProject: document.querySelector("#open-codex"),
  projectFilter: document.querySelector("#project-filter"),
  statusFilter: document.querySelector("#status-filter"),
  taskCount: document.querySelector("#task-count"),
  taskchefVersion: document.querySelector("#taskchef-version"),
  taskList: document.querySelector("#task-list"),
  toastList: document.querySelector("#toast-list"),
};
let notificationDescriptionSerial = 0;

function timestampControl(value, { accessibleName, key, prefix = "" }) {
  if (!parsedTimestamp(value)) {
    const missing = document.createElement("span");
    missing.className = "timestamp-missing";
    missing.textContent = `${prefix}—`;
    return missing;
  }
  const control = document.createElement("button");
  control.type = "button";
  control.className = "timestamp-toggle";
  const time = document.createElement("time");
  control.append(time);
  relativeTimes.register(key, value, ({ exact, iso, label }) => {
    time.dateTime = iso;
    time.textContent = `${prefix}${label}`;
    const action = exact ? "Show relative time" : "Show exact date and time";
    control.title = action;
    control.setAttribute("aria-label", `${accessibleName}: ${label}. ${action}.`);
  }, { isActive: () => control.isConnected });
  control.addEventListener("click", () => relativeTimes.toggle(key));
  return control;
}

function codexIcon() {
  const picture = document.createElement("picture");
  picture.className = "codex-icon";
  picture.setAttribute("aria-hidden", "true");
  const dark = document.createElement("source");
  dark.srcset = "/assets/codex-app-dark.png";
  dark.media = "(prefers-color-scheme: dark)";
  const image = document.createElement("img");
  image.src = "/assets/codex-app-light.png";
  image.alt = "";
  image.width = 18;
  image.height = 18;
  picture.append(dark, image);
  return picture;
}

function configureOpenTaskControl(control, ariaLabel) {
  control.classList.add("task-action");
  control.setAttribute("aria-label", ariaLabel);
  const label = document.createElement("span");
  label.textContent = "Open task";
  control.replaceChildren(codexIcon(), label);
}

function setConnection(connected) {
  elements.connectionDot.classList.toggle("connected", connected);
  elements.connectionLabel.textContent = connected ? "Live" : "Reconnecting…";
}

async function loadDashboardVersion() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return;
    const identity = await response.json();
    if (typeof identity.taskchefVersion !== "string" || !identity.taskchefVersion) return;
    elements.taskchefVersion.textContent = `v${identity.taskchefVersion}`;
    elements.taskchefVersion.setAttribute(
      "aria-label",
      `TaskChef version ${identity.taskchefVersion}`,
    );
  } catch {
    // The live connection state already communicates dashboard availability.
  }
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
  const toast = document.createElement("div");
  toast.className = `toast${task ? "" : " toast-missing"}`;
  const text = document.createElement("button");
  text.type = "button";
  text.className = "toast-content";
  text.setAttribute("aria-label", notificationOpenLabel(notification, Boolean(task)));
  const describedBy = [];
  const title = document.createElement("strong");
  title.textContent = notificationTitle(notification);
  const description = document.createElement("span");
  description.textContent = notification.title;
  text.append(title, description);
  if (notification.summary) {
    const summary = document.createElement("span");
    summary.className = "toast-summary preserve-lines";
    summary.id = `notification-description-${notificationDescriptionSerial += 1}`;
    summary.textContent = notification.summary;
    text.append(summary);
    describedBy.push(summary.id);
  }
  const metadata = document.createElement("span");
  metadata.className = "toast-metadata";
  metadata.id = `notification-description-${notificationDescriptionSerial += 1}`;
  const timestamp = document.createElement("time");
  timestamp.dateTime = notification.timestamp ?? "";
  timestamp.textContent = formatRelativeTime(notification.timestamp);
  metadata.append(timestamp);
  if (!task) metadata.append(" · Task no longer available");
  text.append(metadata);
  describedBy.push(metadata.id);
  text.setAttribute("aria-describedby", describedBy.join(" "));
  text.addEventListener("click", () => {
    const current = findCurrentTask(state.tasks, notification.taskId);
    if (current) openDialog(current);
    else showMessage("This task is no longer present in the current snapshot.");
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "icon-button";
  dismiss.setAttribute("aria-label", notificationDismissLabel(notification));
  dismiss.setAttribute("aria-describedby", describedBy.join(" "));
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    state.notifications = dismissNotification(state.notifications, notification.id);
    renderNotifications();
  });
  toast.append(text, dismiss);
  return toast;
}

function notificationAnnouncement(notification) {
  return [
    notificationTitle(notification),
    notification.title,
    notification.summary,
    notification.turnId ? `Turn ${notification.turnId}` : null,
    formatRelativeTime(notification.timestamp),
  ].filter(Boolean).join(". ");
}

function renderNotifications(additions = []) {
  elements.toastList.replaceChildren(
    ...state.notifications.map(notificationToast),
  );
  elements.notifications.hidden = state.notifications.length === 0;
  if (additions.length > 0) {
    elements.notificationAnnouncer.textContent = additions
      .map(notificationAnnouncement)
      .join(". ");
  }
}

function detailRow(term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value ?? "—";
  return [dt, dd];
}

function resultHistory(taskId, results) {
  if (results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "result-history-empty";
    empty.textContent = "No semantic result has been reported yet.";
    return [empty];
  }
  return [...results].reverse().map((result, index) => {
    const item = document.createElement("article");
    item.className = `result-history-item${index === 0 ? " result-history-latest" : ""}`;
    const header = document.createElement("div");
    header.className = "result-history-header";
    const status = document.createElement("span");
    status.className = `status status-${result.status}`;
    status.textContent = result.status.replaceAll("_", " ");
    const resultKey = result.turnId ?? `${result.status}:${index}`;
    const timestamp = timestampControl(result.updatedAt, {
      accessibleName: `Result updated time for ${result.status.replaceAll("_", " ")}`,
      key: `detail:${taskId}:result:${resultKey}`,
    });
    header.append(status, timestamp);
    const summary = document.createElement("p");
    summary.className = "preserve-lines";
    summary.textContent = result.summary;
    const turn = document.createElement("p");
    turn.className = "result-history-turn";
    turn.textContent = result.turnId ? `Turn ${result.turnId}` : "No turn ID (creation failure)";
    item.append(header, summary, turn);
    return item;
  });
}

function renderDialog(task) {
  const preservedResults = state.selectedTask?.id === task.id
    ? state.selectedTask.results
    : null;
  const detailedTask = {
    ...task,
    results: task.results ?? preservedResults ?? [],
  };
  state.selectedTask = detailedTask;
  elements.dialogProject.textContent = task.project.name;
  elements.dialogTitle.textContent = task.title;
  elements.dialogResults.replaceChildren(...resultHistory(task.id, detailedTask.results));
  elements.dialogInstruction.textContent = task.instruction;
  elements.copyThreadId.disabled = !task.threadId;
  elements.dialogMetadata.replaceChildren(
    ...detailRow("Current status", taskStatusLabel(task)),
    ...detailRow("Current turn ID", task.turnId),
    ...detailRow("Last result status", task.lastResult?.status?.replaceAll("_", " ")),
    ...detailRow("Last result turn ID", task.lastResult?.turnId),
    ...detailRow("Last result updated", timestampControl(task.lastResult?.updatedAt, {
      accessibleName: `Last result updated time for ${task.title}`,
      key: `detail:${task.id}:last-result-updated`,
    })),
    ...detailRow("Task ID", task.id),
    ...detailRow("Thread ID", task.threadId),
    ...detailRow("Project path", task.project.path),
    ...detailRow("Created", timestampControl(task.createdAt, {
      accessibleName: `Created time for ${task.title}`,
      key: `detail:${task.id}:created`,
    })),
    ...detailRow("Updated", timestampControl(
      task.meaningfulUpdatedAt ?? task.updatedAt ?? task.createdAt,
      {
        accessibleName: `Updated time for ${task.title}`,
        key: `detail:${task.id}:updated`,
      },
    )),
    ...detailRow("Updated by", task.updatedBy),
  );
  configureOpenTaskControl(elements.openProject, `Open ${task.title} in Codex`);
}

async function openDialog(task) {
  const requestGeneration = ++detailRequestGeneration;
  renderDialog(task);
  if (!elements.dialog.open) elements.dialog.showModal();
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`);
    if (!response.ok) throw new Error("Task details are unavailable.");
    const detail = await response.json();
    if (
      requestGeneration === detailRequestGeneration
      && state.selectedTask?.id === task.id
      && elements.dialog.open
    ) {
      renderDialog(detail.task);
    }
  } catch {
    if (state.selectedTask?.id === task.id) {
      showMessage("Task result history is temporarily unavailable.");
    }
  }
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
  badge.textContent = taskStatusLabel(task);
  heading.append(title, badge);
  const project = document.createElement("p");
  project.className = "task-project";
  project.textContent = task.project.name;
  const summary = document.createElement("p");
  summary.className = "task-summary";
  summary.textContent = task.lastResult?.summary ?? "No semantic result reported yet.";
  const time = timestampControl(
    task.meaningfulUpdatedAt ?? task.updatedAt ?? task.createdAt,
    {
      accessibleName: `Updated time for ${task.title}`,
      key: `list:${task.id}:updated`,
      prefix: "Updated ",
    },
  );
  const footer = document.createElement("div");
  footer.className = "task-footer";
  const openTask = document.createElement("button");
  openTask.type = "button";
  openTask.className = "secondary-button task-open";
  configureOpenTaskControl(openTask, `Open ${task.title} in Codex`);
  openTask.addEventListener("click", (event) => openTaskFromControl(event, task.id, {
    showMessage,
  }));
  footer.append(time, openTask);
  article.append(heading, project, summary, footer);
  return article;
}

function render() {
  const project = elements.projectFilter.value;
  const status = elements.statusFilter.value;
  const date = elements.dateFilter.value;
  const visible = state.tasks.filter((task) =>
    (!project || task.project.name === project)
    && (!status || taskStatusLabel(task) === status)
    && taskWithinDateFilter(task, date));
  elements.taskList.replaceChildren(...visible.map(taskCard));
  elements.emptyState.hidden = visible.length > 0;
  elements.taskCount.textContent = `${visible.length} of ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;
  clearTimeout(dateRefreshTimer);
  const refreshDelay = nextDateFilterRefreshDelay(visible, date);
  dateRefreshTimer = refreshDelay === null ? null : setTimeout(render, refreshDelay);
}

function applySnapshot(snapshot) {
  const reconciled = reconcileNotifications({
    initialized: state.initialized,
    notifications: state.notifications,
    seenIds: state.seenNotificationIds,
    signatures: state.signatures,
  }, snapshot.tasks);
  state.tasks = snapshot.tasks;
  state.signatures = reconciled.signatures;
  state.notifications = reconciled.notifications;
  state.seenNotificationIds = reconciled.seenIds;
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
    [...new Set([...KNOWN_TASK_STATUSES, ...state.tasks.map(taskStatusLabel)])],
    "All statuses",
  );
  if (state.selectedTask) {
    const updated = state.tasks.find((task) => task.id === state.selectedTask.id);
    if (updated && elements.dialog.open) openDialog(updated);
  }
  renderNotifications(reconciled.additions);
  render();
}

function showMessage(message) {
  elements.dashboardMessageText.textContent = message;
  elements.dashboardMessage.hidden = false;
}

void loadDashboardVersion();

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
elements.dateFilter.addEventListener("change", render);
elements.dismissDashboardMessage.addEventListener("click", () => {
  elements.dashboardMessage.hidden = true;
});
elements.clearNotifications.addEventListener("click", () => {
  state.notifications = clearNotifications();
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
elements.openProject.addEventListener("click", async (event) => {
  if (!state.selectedTask) return;
  await openTaskFromControl(event, state.selectedTask.id, { showMessage });
});
