import {
  clearNotifications,
  dismissNotification,
  filterTasks,
  findCurrentTask,
  latestTurnPresentation,
  mergeProjectedTurns,
  nextDateFilterRefreshDelay,
  notificationDismissLabel,
  notificationOpenLabel,
  notificationTitle,
  reconcileNotifications,
  statusFilterCounts,
  statusFilterText,
  taskStatusLabel,
  turnPresentation,
} from "./state.js";
import { openTaskFromControl } from "./actions.js";
import { referenceSegments } from "./github-links.js";
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
  dialogRelatedLinks: document.querySelector("#dialog-related-links"),
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

function referenceLink(link, { compact = false } = {}) {
  const anchor = document.createElement("a");
  anchor.className = compact ? "github-link github-link-compact" : "github-link";
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = link.label ?? link.text;
  const githubKind = link.type === "issue"
    ? ", GitHub issue"
    : link.type === "pull"
      ? ", GitHub pull request"
      : link.provider === "github" || link.owner ? " on GitHub" : "";
  anchor.setAttribute(
    "aria-label",
    `${link.label ?? link.text}${githubKind} (opens in a new tab)`,
  );
  anchor.addEventListener("click", (event) => event.stopPropagation());
  return anchor;
}

function appendLinkedText(container, text, task) {
  const children = referenceSegments(text, {
    projectRepositories: task.project?.githubRepos,
    taskRepository: task.relatedGitHubRepository,
  }).map((segment) => {
    if (segment.kind === "text") return document.createTextNode(segment.text);
    if (segment.kind === "link") return referenceLink(segment);
    const ambiguous = document.createElement("span");
    ambiguous.className = "github-reference-ambiguous";
    ambiguous.textContent = segment.text;
    ambiguous.tabIndex = 0;
    ambiguous.title = segment.reason;
    ambiguous.setAttribute("aria-label", segment.reason);
    return ambiguous;
  });
  container.replaceChildren(...children);
}

function relatedGitHubLinks(task, { compact = false } = {}) {
  const links = task.relatedGitHubLinks ?? [];
  const container = document.createElement("nav");
  container.className = `github-links${compact ? " github-links-compact" : ""}`;
  container.setAttribute("aria-label", `Related GitHub links for ${task.title}`);
  const children = links.map((link) => referenceLink(link, { compact }));
  if (task.relatedGitHubLinksTruncated) {
    const more = document.createElement("span");
    more.className = "github-links-more";
    more.textContent = "+ more";
    more.title = "Additional related GitHub references are omitted from this bounded dashboard view.";
    more.setAttribute("aria-label", more.title);
    children.push(more);
  }
  container.hidden = children.length === 0;
  container.replaceChildren(...children);
  return container;
}

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

function turnTimeline(task) {
  if (task.turns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "result-history-empty";
    empty.textContent = "No executor turn has been reported yet.";
    return [empty];
  }
  return [...task.turns].reverse().map((turn, index) => {
    const item = document.createElement("article");
    item.className = `result-history-item${index === 0 ? " result-history-latest" : ""}`;
    const header = document.createElement("div");
    header.className = "result-history-header";
    const status = document.createElement("span");
    const presentation = turnPresentation(turn);
    const turnStatus = presentation.status;
    status.className = `status status-${turnStatus}`;
    status.textContent = turnStatus.replaceAll("_", " ");
    const turnKey = turn.turnId ?? `no-turn:${index}`;
    const timestamp = timestampControl(presentation.updatedAt, {
      accessibleName: `Turn updated time for ${turnStatus.replaceAll("_", " ")}`,
      key: `detail:${task.id}:turn:${turnKey}`,
    });
    header.append(status, timestamp);
    const requestLabel = document.createElement("h4");
    requestLabel.textContent = "Request";
    const request = document.createElement("p");
    request.className = "preserve-lines";
    appendLinkedText(
      request,
      turn.requestSummary ?? "Request not recorded by this TaskChef version.",
      task,
    );
    const resultLabel = document.createElement("h4");
    resultLabel.textContent = "Result";
    const result = document.createElement("p");
    result.className = "preserve-lines";
    appendLinkedText(result, presentation.summary, task);
    const turnMetadata = document.createElement("p");
    turnMetadata.className = "result-history-turn";
    turnMetadata.textContent = turn.turnId
      ? `Turn ${turn.turnId}`
      : "No turn ID (creation failure)";
    item.append(header, requestLabel, request, resultLabel, result, turnMetadata);
    return item;
  });
}

function renderDialog(task) {
  const preservedResults = state.selectedTask?.id === task.id
    ? state.selectedTask.results
    : null;
  const detailedTask = {
    ...task,
    turns: mergeProjectedTurns(task, state.selectedTask?.turns ?? []),
    results: task.results ?? preservedResults ?? [],
  };
  state.selectedTask = detailedTask;
  elements.dialogProject.textContent = task.project.name;
  elements.dialogTitle.textContent = task.title;
  elements.dialogRelatedLinks.replaceChildren(...relatedGitHubLinks(detailedTask).children);
  elements.dialogRelatedLinks.setAttribute(
    "aria-label",
    `Related GitHub links for ${task.title}`,
  );
  elements.dialogRelatedLinks.hidden = (
    (task.relatedGitHubLinks?.length ?? 0) === 0 && !task.relatedGitHubLinksTruncated
  );
  elements.dialogResults.replaceChildren(...turnTimeline(detailedTask));
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
      showMessage("Task activity timeline is temporarily unavailable.");
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
  const latest = latestTurnPresentation(task);
  const requestLabel = document.createElement("strong");
  requestLabel.textContent = "Request";
  const request = document.createElement("span");
  request.className = "preserve-lines";
  appendLinkedText(request, latest.requestSummary, task);
  const resultLabel = document.createElement("strong");
  resultLabel.textContent = "Result";
  const result = document.createElement("span");
  result.className = "preserve-lines";
  appendLinkedText(result, latest.resultSummary, task);
  summary.replaceChildren(requestLabel, request, resultLabel, result);
  const relatedLinks = relatedGitHubLinks(task, { compact: true });
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
  article.append(heading, project, summary, relatedLinks, footer);
  return article;
}

function render() {
  const project = elements.projectFilter.value;
  const status = elements.statusFilter.querySelector("input:checked")?.value ?? "";
  const date = elements.dateFilter.value;
  const now = Date.now();
  const contextualTasks = filterTasks(state.tasks, { project, date, now });
  const visible = filterTasks(contextualTasks, { status, now });
  const counts = statusFilterCounts(state.tasks, { project, date, now });
  for (const label of elements.statusFilter.querySelectorAll("[data-status-label]")) {
    const value = label.dataset.statusLabel;
    label.textContent = statusFilterText(value, counts[value]);
  }
  elements.taskList.replaceChildren(...visible.map(taskCard));
  elements.emptyState.hidden = visible.length > 0;
  elements.taskCount.textContent = `${visible.length} of ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;
  clearTimeout(dateRefreshTimer);
  const refreshDelay = nextDateFilterRefreshDelay(contextualTasks, date, now);
  dateRefreshTimer = refreshDelay === null ? null : setTimeout(render, refreshDelay);
}

function selectStatusFromKeyboard(event) {
  if (event.target?.name !== "status-filter") return;
  const inputs = [...elements.statusFilter.querySelectorAll('input[name="status-filter"]')];
  const currentIndex = inputs.indexOf(event.target);
  if (currentIndex < 0) return;
  let nextIndex = currentIndex;
  if (["ArrowRight", "ArrowDown"].includes(event.key)) nextIndex = (currentIndex + 1) % inputs.length;
  else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
    nextIndex = (currentIndex - 1 + inputs.length) % inputs.length;
  } else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = inputs.length - 1;
  else if (![" ", "Enter"].includes(event.key)) return;
  event.preventDefault();
  for (const input of inputs) input.checked = false;
  inputs[nextIndex].checked = true;
  inputs[nextIndex].focus();
  render();
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
elements.statusFilter.addEventListener("keydown", selectStatusFromKeyboard);
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
