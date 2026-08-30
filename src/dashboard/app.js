import {
  MAX_NOTIFICATIONS,
  canArchiveTask,
  canManuallyTransitionTask,
  clearNotifications,
  dismissNotification,
  filterTasks,
  findCurrentTask,
  latestTurnPresentation,
  manualTransitionExpectedState,
  mergeProjectedTurns,
  nextDateFilterRefreshDelay,
  notificationDismissLabel,
  notificationOpenLabel,
  notificationTitle,
  reconcileNotifications,
  reconcileManualTransition,
  reconcileManualTransitionResponse,
  statusFilterCounts,
  statusFilterText,
  taskStatusLabel,
  taskMatchesManualTransitionExpected,
  turnPresentation,
} from "./state.js";
import {
  archiveTaskFromControl,
  focusManualTransitionStatus,
  handleManualTransitionEscape,
  manuallyTransitionTaskFromControl,
  openTaskFromControl,
  restoreTaskActionMenuFocus,
} from "./actions.js";
import {
  githubReferenceAccessibleLabel,
  githubReferenceDisplayLabels,
  groupRelatedGitHubLinks,
  referenceSegments,
} from "./github-links.js";
import { formatRelativeTime, RelativeTimeController, parsedTimestamp } from "./time.js";

const USAGE_POLL_INTERVAL_MS = 1_500;
const MAX_USAGE_POLL_ATTEMPTS = 40;

const state = {
  archivePendingThreadIds: new Set(),
  archivedThreadIds: new Set(),
  tasks: [],
  signatures: new Map(),
  notifications: [],
  seenNotificationIds: new Set(),
  initialized: false,
  detailNavigation: null,
  manualTransition: null,
  selectedTask: null,
};
let dateRefreshTimer = null;
let detailRequestGeneration = 0;
let copyTaskIdGeneration = 0;
let copyTaskIdTimer = null;
let archiveUpdateSerial = 0;
const relativeTimes = new RelativeTimeController();

const elements = {
  archiveTask: document.querySelector("#archive-codex"),
  clearNotifications: document.querySelector("#clear-notifications"),
  closeDialog: document.querySelector("#close-dialog"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  copyTaskId: document.querySelector("#copy-task-id"),
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
  dialogUsage: document.querySelector("#dialog-usage"),
  dismissDashboardMessage: document.querySelector("#dismiss-dashboard-message"),
  emptyState: document.querySelector("#empty-state"),
  notifications: document.querySelector("#notifications"),
  notificationHost: document.querySelector("#notification-host"),
  notificationAnnouncer: document.querySelector("#notification-announcer"),
  manualTransitionPanel: document.querySelector("#manual-transition-panel"),
  manualTransitionError: document.querySelector("#manual-transition-error"),
  manualTransitionStatus: document.querySelector("#manual-transition-status"),
  markTaskCompleted: document.querySelector("#mark-task-completed"),
  markTaskFailed: document.querySelector("#mark-task-failed"),
  moreTaskActions: document.querySelector("#more-task-actions"),
  openProject: document.querySelector("#open-codex"),
  projectFilter: document.querySelector("#project-filter"),
  statusFilter: document.querySelector("#status-filter"),
  taskCount: document.querySelector("#task-count"),
  taskchefVersion: document.querySelector("#taskchef-version"),
  taskList: document.querySelector("#task-list"),
  toastList: document.querySelector("#toast-list"),
};
let notificationDescriptionSerial = 0;

function referenceLink(link, { compact = false, displayLabel } = {}) {
  const anchor = document.createElement("a");
  anchor.className = compact ? "github-link github-link-compact" : "github-link";
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.dataset.focusKey = `link:${link.url}`;
  const label = link.label ?? link.text;
  anchor.textContent = displayLabel ?? label;
  const accessibleLabel = githubReferenceAccessibleLabel(link);
  const githubKind = link.type === "issue"
    ? ", GitHub issue"
    : link.type === "pull"
      ? ", GitHub pull request"
      : link.provider === "github" || link.owner ? " on GitHub" : "";
  anchor.setAttribute(
    "aria-label",
    `${accessibleLabel}${githubKind} (opens in a new tab)`,
  );
  anchor.addEventListener("click", (event) => event.stopPropagation());
  return anchor;
}

function appendLinkedText(container, text, task) {
  const segments = referenceSegments(text, {
    projectRepositories: task.project?.githubRepos,
    taskRepository: task.relatedGitHubRepository,
  });
  const links = segments.filter((segment) => segment.kind === "link");
  const displayLabels = githubReferenceDisplayLabels(links);
  let linkIndex = 0;
  const children = segments.map((segment) => {
    if (segment.kind === "text") return document.createTextNode(segment.text);
    if (segment.kind === "link") {
      const displayLabel = displayLabels[linkIndex];
      linkIndex += 1;
      return referenceLink(segment, { displayLabel });
    }
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
  const groups = groupRelatedGitHubLinks(task.relatedGitHubLinks);
  const links = groups.flat();
  const container = document.createElement("nav");
  container.className = `github-links${compact ? " github-links-compact" : ""}`;
  container.setAttribute("aria-label", `Related GitHub links for ${task.title}`);
  const displayLabels = githubReferenceDisplayLabels(links, { related: true });
  let linkIndex = 0;
  const children = groups.map((group) => {
    const line = document.createElement("div");
    line.className = "github-links-group";
    line.replaceChildren(...group.map((link) => {
      const anchor = referenceLink(link, {
        compact,
        displayLabel: displayLabels[linkIndex],
      });
      linkIndex += 1;
      return anchor;
    }));
    return line;
  });
  if (task.relatedGitHubLinksTruncated) {
    const more = document.createElement("span");
    more.className = "github-links-more";
    more.textContent = "+ more";
    more.title = "Additional related GitHub references are omitted from this bounded dashboard view.";
    more.setAttribute("aria-label", more.title);
    const finalGroup = children.at(-1);
    if (finalGroup) finalGroup.append(more);
    else children.push(more);
  }
  container.hidden = children.length === 0;
  container.replaceChildren(...children);
  return container;
}

function renderProject(container, task) {
  const children = [document.createTextNode(task.project.name)];
  const repository = task.relatedGitHubRepository;
  if (repository) {
    const [owner, repositoryName] = repository.split("/");
    children.push(
      document.createTextNode(" "),
      referenceLink({
        label: repository,
        owner,
        provider: "github",
        repository: repositoryName,
        type: "repository",
        url: `https://github.com/${repository}`,
      }, { displayLabel: repositoryName }),
    );
  }
  container.replaceChildren(...children);
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
  control.dataset.focusKey = `timestamp:${key}`;
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

function setCopyTaskIdLabel(label) {
  elements.copyTaskId.textContent = label;
  elements.copyTaskId.setAttribute("aria-label", label);
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
  text.addEventListener("click", async () => {
    const current = findCurrentTask(state.tasks, notification.taskId);
    state.notifications = dismissNotification(state.notifications, notification.id);
    renderNotifications();
    if (current) {
      await openDialog(current, {
        focus: true,
        highlightTurnRef: notification.turnRef ?? notification.turnId,
      });
    } else showMessage("This task is no longer present in the current snapshot.");
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
    notification.turnRef ? `Turn ref ${notification.turnRef}` : null,
    formatRelativeTime(notification.timestamp),
  ].filter(Boolean).join(". ");
}

function renderNotifications(additions = []) {
  elements.toastList.replaceChildren(
    ...state.notifications.map(notificationToast),
  );
  const notificationHost = elements.dialog.open ? elements.dialog : elements.notificationHost;
  const movingLayer = elements.notifications.parentNode !== notificationHost;
  if ((movingLayer || additions.length > 0) && state.notifications.length > 0) {
    try {
      elements.notifications.hidePopover?.();
    } catch {
      // The notification layer is not open yet.
    }
  }
  if (movingLayer) notificationHost.append(elements.notifications);
  if (state.notifications.length === 0) {
    try {
      elements.notifications.hidePopover?.();
    } catch {
      // The notification layer is already closed.
    }
    elements.notifications.hidden = true;
  } else {
    elements.notifications.hidden = false;
    try {
      elements.notifications.showPopover?.();
    } catch {
      // Re-rendering an already-open manual popover needs no further action.
    }
  }
  if (additions.length > 0) {
    elements.notificationAnnouncer.textContent = additions
      .map(notificationAnnouncement)
      .join(". ");
  }
}

export function showArchiveUpdate(task, message, { failed = false } = {}) {
  const notification = Object.freeze({
    id: `archive:${task.id}:${Date.now()}:${archiveUpdateSerial += 1}`,
    taskId: task.id,
    title: task.title,
    status: task.status,
    event: failed ? "archive_failed" : "archive_succeeded",
    turnRef: null,
    turnId: null,
    timestamp: new Date().toISOString(),
    summary: message,
  });
  state.notifications = [notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS);
  renderNotifications([notification]);
}

function detailRow(term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value ?? "—";
  return [dt, dd];
}

const tokenFormatter = new Intl.NumberFormat();

function formatEstimatedCost(value) {
  if (typeof value !== "number") return "cost unavailable";
  if (value === 0) return "estimated $0.00";
  return `estimated $${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function usageBreakdownText(usage) {
  return [
    `${tokenFormatter.format(usage.inputTokens)} input`,
    `${tokenFormatter.format(usage.cachedInputTokens)} cached input`,
    `${tokenFormatter.format(usage.outputTokens)} output`,
    `${tokenFormatter.format(usage.reasoningOutputTokens)} reasoning`,
  ].join(" · ");
}

const SHIMMER_STEP_MS = 420;
const SHIMMER_PAUSE_MS = 1_800;
const SHIMMER_PULSE_MS = 420;
const SHIMMER_ANIMATION_ID = "taskchef-text-shimmer";
const shimmerMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
const shimmerRecords = new Set();

function animateShimmerRecord(record, reducedMotion) {
  for (const animation of record.animations) animation.cancel();
  record.animations = [];
  if (reducedMotion) return;
  for (const [shimmerIndex, glyph] of record.glyphs.entries()) {
    if (typeof glyph.animate !== "function") continue;
    const pulseEnd = SHIMMER_PULSE_MS / record.cycleMs;
    const animation = glyph.animate([
      { color: "var(--muted)", textShadow: "none", offset: 0 },
      {
        color: "var(--text)",
        textShadow: "0 0 0.28em color-mix(in srgb, var(--text) 22%, transparent)",
        offset: pulseEnd / 2,
      },
      { color: "var(--muted)", textShadow: "none", offset: pulseEnd },
      { color: "var(--muted)", textShadow: "none", offset: 1 },
    ], {
      delay: shimmerIndex * SHIMMER_STEP_MS,
      duration: record.cycleMs,
      easing: "linear",
      iterations: Infinity,
    });
    animation.id = SHIMMER_ANIMATION_ID;
    record.animations.push(animation);
  }
}

shimmerMotionQuery?.addEventListener?.("change", ({ matches }) => {
  for (const record of shimmerRecords) animateShimmerRecord(record, matches);
});

export function cancelTextShimmers(root) {
  for (const record of shimmerRecords) {
    if (root !== record.element && !root?.contains?.(record.element)) continue;
    for (const animation of record.animations) animation.cancel();
    shimmerRecords.delete(record);
  }
}

export function renderTextShimmer(element, value) {
  const text = String(value ?? "");
  const characters = Array.from(text);
  const highlightedCharacters = characters.filter((character) => !/\s/u.test(character));
  const cycleMs = Math.max(
    SHIMMER_PULSE_MS + SHIMMER_PAUSE_MS,
    (highlightedCharacters.length - 1) * SHIMMER_STEP_MS
      + SHIMMER_PULSE_MS
      + SHIMMER_PAUSE_MS,
  );
  const glyphs = [];
  const nodes = characters.map((character) => {
    if (/\s/u.test(character)) return document.createTextNode(character);
    const glyph = document.createElement("span");
    glyph.className = "text-shimmer-glyph";
    glyph.textContent = character;
    glyphs.push(glyph);
    return glyph;
  });
  const accessibleText = document.createElement("span");
  accessibleText.className = "visually-hidden";
  accessibleText.textContent = text;
  const animatedText = document.createElement("span");
  animatedText.className = "text-shimmer-visual";
  animatedText.setAttribute("aria-hidden", "true");
  animatedText.append(...nodes);
  element.replaceChildren(accessibleText, animatedText);
  const record = { animations: [], cycleMs, element, glyphs };
  shimmerRecords.add(record);
  animateShimmerRecord(record, shimmerMotionQuery?.matches ?? false);
  return element;
}

export function usagePresentation(usage, { wholeTask = false } = {}) {
  const container = document.createElement("div");
  container.className = `usage-summary usage-${usage?.status ?? "unavailable"}`;
  if (usage?.status === "pending" || usage?.status === "calculating") {
    const text = document.createElement("span");
    text.className = "text-shimmer";
    renderTextShimmer(text, usage.status === "pending"
      ? "Tokens pending · available when turn finishes"
      : "Calculating token usage…");
    container.replaceChildren(text);
    return container;
  }
  if (usage?.status !== "available") {
    const headline = document.createElement("strong");
    headline.textContent = "Token usage unavailable";
    container.append(headline);
    if (usage?.reason) {
      const reason = document.createElement("span");
      reason.textContent = usage.reason;
      container.append(reason);
    }
    return container;
  }
  const headline = document.createElement("strong");
  headline.textContent = `${tokenFormatter.format(usage.totalTokens)} tokens · ${formatEstimatedCost(usage.estimatedCostUsd)}${usage.knownSoFar ? " · known so far" : ""}`;
  const breakdown = document.createElement("span");
  breakdown.textContent = usageBreakdownText(usage);
  container.append(headline, breakdown);
  const provenance = document.createElement("span");
  const version = usage.provenance?.version ? ` ${usage.provenance.version}` : "";
  const pricingMode = usage.provenance?.pricingMode
    ? ` · ${usage.provenance.pricingMode === "online"
      ? "online pricing requested"
      : "offline pricing fallback"}`
    : "";
  const freshness = usage.sourceUpdatedAt ?? usage.sampledAt;
  provenance.textContent = `Source: ccusage${version}${pricingMode}${freshness ? ` · updated ${formatRelativeTime(freshness)}` : ""}. Dollar cost is an API-equivalent estimate${wholeTask ? " for the task" : " for this turn"}.`;
  if (usage.provenance?.costCoverage === "cache_writes_unverified") {
    provenance.textContent += " ccusage may omit GPT-5.6 cache-write charges.";
  }
  container.append(provenance);
  return container;
}

function usageStillCalculating(task) {
  return task.usage?.status === "calculating"
    || (task.status !== "working" && Object.values(task.usage?.turns ?? {})
      .some((turn) => turn.status === "calculating"));
}

function turnTimeline(task, { highlightTurnRef = null } = {}) {
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
    const turnKey = turn.turnRef ?? turn.turnId ?? `no-turn:${index}`;
    item.dataset.turnRef = turnKey;
    if (highlightTurnRef !== null && turnKey === highlightTurnRef) {
      item.className += " result-history-notified";
      item.tabIndex = -1;
    }
    const timestamp = timestampControl(presentation.updatedAt, {
      accessibleName: `Turn updated time for ${turnStatus.replaceAll("_", " ")}`,
      key: `detail:${task.id}:turn:${turnKey}`,
    });
    header.append(status, timestamp);
    if (presentation.sourceLabel) {
      const source = document.createElement("span");
      source.className = "result-history-source";
      source.textContent = presentation.sourceLabel;
      header.insertBefore(source, timestamp);
    }
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
    result.className = `preserve-lines${turnStatus === "working" ? " text-shimmer" : ""}`;
    if (turnStatus === "working") renderTextShimmer(result, presentation.summary);
    else appendLinkedText(result, presentation.summary, task);
    const turnMetadata = document.createElement("p");
    turnMetadata.className = "result-history-turn";
    turnMetadata.textContent = `Turn ref ${turn.turnRef ?? "not recorded"}; Codex turn ${turn.turnId ?? "unavailable"}`;
    const recordedUsage = task.usage?.turns?.[turn.turnRef ?? turn.turnId];
    const turnUsage = turn.result === null
      ? { status: "pending" }
      : recordedUsage ?? {
        status: "unavailable",
        reason: "No reliable turn boundary is available.",
      };
    item.append(
      header,
      requestLabel,
      request,
      resultLabel,
      result,
      usagePresentation(turnUsage),
      turnMetadata,
    );
    return item;
  });
}

function descendantPath(root, descendant) {
  const path = [];
  let current = descendant;
  while (current && current !== root) {
    const parent = current.parentNode;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.children, current);
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return current === root ? path : null;
}

function descendantAtPath(root, path) {
  let current = root;
  for (const index of path ?? []) {
    current = current?.children?.[index];
    if (!current) return null;
  }
  return current;
}

function descendantWithFocusKey(root, focusKey) {
  if (!root || !focusKey) return null;
  if (root.dataset?.focusKey === focusKey) return root;
  for (const child of root.children ?? []) {
    const match = descendantWithFocusKey(child, focusKey);
    if (match) return match;
  }
  return null;
}

function manualTransitionPending() {
  return state.manualTransition?.stage === "pending";
}

function resetManualTransition({ focus = false } = {}) {
  state.manualTransition = null;
  elements.closeDialog.disabled = false;
  if (state.selectedTask) renderManualTransition(state.selectedTask);
  if (focus) elements.moreTaskActions.focus();
}

function replaceCurrentTask(task) {
  state.tasks = state.tasks.map((candidate) => candidate.id === task.id ? task : candidate);
  state.selectedTask = task;
}

function renderManualTransition(task) {
  const activeElement = document.activeElement;
  const focusWasInPanel = elements.manualTransitionPanel.contains?.(activeElement) ?? false;
  state.manualTransition = reconcileManualTransition(state.manualTransition, task);
  const pending = manualTransitionPending();
  const expanded = Boolean(state.manualTransition);
  elements.moreTaskActions.disabled = pending;
  elements.moreTaskActions.textContent = expanded ? "←" : "…";
  elements.moreTaskActions.setAttribute(
    "aria-label",
    expanded ? "Hide more task actions" : "More task actions",
  );
  elements.moreTaskActions.setAttribute("title", expanded ? "Hide more task actions" : "More task actions");
  elements.moreTaskActions.setAttribute("aria-expanded", String(expanded));
  elements.closeDialog.disabled = pending;
  elements.manualTransitionPanel.hidden = state.manualTransition === null;
  elements.manualTransitionPanel.setAttribute("aria-busy", String(pending));
  elements.copyTaskId.disabled = pending || !task.id;
  elements.markTaskCompleted.hidden = !canManuallyTransitionTask(task, "completed");
  elements.markTaskFailed.hidden = !canManuallyTransitionTask(task, "failed");
  elements.markTaskCompleted.disabled = pending;
  elements.markTaskFailed.disabled = pending;
  const archivePending = state.archivePendingThreadIds.has(task.threadId);
  const archived = state.archivedThreadIds.has(task.threadId);
  elements.archiveTask.disabled = pending || archivePending || archived;
  elements.archiveTask.textContent = archived ? "Archived" : archivePending ? "Archiving…" : "Archive chat";
  elements.archiveTask.setAttribute(
    "aria-label",
    archived
      ? `${task.title} is archived in Codex`
      : archivePending
        ? `Archiving ${task.title} in Codex`
        : `Archive ${task.title} in Codex`,
  );
  elements.manualTransitionStatus.hidden = !pending;
  elements.manualTransitionStatus.textContent = pending ? "Saving task state…" : "";
  const error = state.manualTransition?.error ?? "";
  elements.manualTransitionError.hidden = !error;
  elements.manualTransitionError.textContent = error;
  if (!state.manualTransition) {
    elements.closeDialog.disabled = false;
    if (focusWasInPanel) elements.moreTaskActions.focus();
    return;
  }
  if (pending) {
    focusManualTransitionStatus(elements.manualTransitionPanel);
  } else {
    restoreTaskActionMenuFocus(
      elements.manualTransitionPanel,
      activeElement,
      elements.moreTaskActions,
    );
  }
}

async function submitManualTransition(targetStatus, event) {
  const task = state.selectedTask;
  if (
    !task
    || !canManuallyTransitionTask(task, targetStatus)
    || manualTransitionPending()
  ) return;
  const previous = state.manualTransition;
  const actionId = previous?.targetStatus === targetStatus && previous.actionId
    ? previous.actionId
    : crypto.randomUUID();
  const attempt = {
    ...previous,
    taskId: task.id,
    stage: "pending",
    targetStatus,
    actionId,
    expected: previous?.expected ?? manualTransitionExpectedState(task),
    error: null,
  };
  state.manualTransition = attempt;
  renderManualTransition(task);
  const result = await manuallyTransitionTaskFromControl(
    event,
    { ...task, ...attempt.expected },
    targetStatus,
    attempt.actionId,
  );
  const current = reconcileManualTransitionResponse({
    requestTask: task,
    expected: attempt.expected,
    responseTask: result.task,
    selectedTask: state.selectedTask,
  });
  if (result.ok) {
    state.manualTransition = null;
    if (current === result.task) replaceCurrentTask(result.task);
    renderDialog(current);
    render();
    elements.dialogTitle.focus?.();
    return;
  }
  if (current === result.task) replaceCurrentTask(result.task);
  if (
    !canManuallyTransitionTask(current)
    || !taskMatchesManualTransitionExpected(current, attempt.expected)
  ) {
    state.manualTransition = null;
    renderDialog(current);
    render();
    showMessage("This task changed. Review its current state before trying again.");
    elements.dialogTitle.focus?.();
    return;
  }
  state.manualTransition = {
    ...attempt,
    stage: "choose",
    error: result.message,
    actionId: result.code === "stale_task" ? crypto.randomUUID() : attempt.actionId,
  };
  renderDialog(current);
  elements.manualTransitionError.focus();
}

function renderDialog(task, { highlightTurnRef = null } = {}) {
  if (state.selectedTask?.id !== task.id) {
    copyTaskIdGeneration += 1;
    clearTimeout(copyTaskIdTimer);
    copyTaskIdTimer = null;
  }
  const preservedResults = state.selectedTask?.id === task.id
    ? state.selectedTask.results
    : null;
  const preservedUsage = state.selectedTask?.id === task.id
    ? state.selectedTask.usage
    : null;
  const detailedTask = {
    ...task,
    turns: mergeProjectedTurns(task, state.selectedTask?.turns ?? []),
    results: task.results ?? preservedResults ?? [],
    usage: task.usage ?? preservedUsage ?? null,
  };
  const focusedElement = elements.dialogResults.contains?.(document.activeElement)
    ? document.activeElement
    : null;
  let focusedTurn = focusedElement;
  while (focusedTurn && focusedTurn !== elements.dialogResults && !focusedTurn.dataset?.turnRef) {
    focusedTurn = focusedTurn.parentNode;
  }
  const focusedTurnRef = focusedTurn?.dataset?.turnRef ?? null;
  const focusedDescendantKey = focusedElement?.dataset?.focusKey ?? null;
  const focusedDescendantPath = focusedTurn && focusedElement
    ? descendantPath(focusedTurn, focusedElement)
    : null;
  state.selectedTask = detailedTask;
  renderProject(elements.dialogProject, task);
  elements.dialogTitle.textContent = task.title;
  elements.dialogRelatedLinks.replaceChildren(...relatedGitHubLinks(detailedTask).children);
  elements.dialogRelatedLinks.setAttribute(
    "aria-label",
    `Related GitHub links for ${task.title}`,
  );
  elements.dialogRelatedLinks.hidden = (
    (task.relatedGitHubLinks?.length ?? 0) === 0 && !task.relatedGitHubLinksTruncated
  );
  const timeline = turnTimeline(detailedTask, { highlightTurnRef });
  cancelTextShimmers(elements.dialogResults);
  elements.dialogResults.replaceChildren(...timeline);
  const highlightedTurn = timeline.find((item) => item.dataset.turnRef === highlightTurnRef) ?? null;
  const replacedFocusedTurn = timeline.find((item) => item.dataset.turnRef === focusedTurnRef) ?? null;
  if (replacedFocusedTurn) {
    const pathMatchedElement = descendantAtPath(replacedFocusedTurn, focusedDescendantPath);
    const replacedFocusedElement = (
      pathMatchedElement?.dataset?.focusKey === focusedDescendantKey
        ? pathMatchedElement
        : null
    ) ?? descendantWithFocusKey(replacedFocusedTurn, focusedDescendantKey);
    if (replacedFocusedElement && replacedFocusedElement !== replacedFocusedTurn) {
      replacedFocusedElement.focus?.();
    } else {
      replacedFocusedTurn.tabIndex = -1;
      replacedFocusedTurn.focus?.();
    }
  }
  const currentTurnRef = task.turnRef ?? task.latestTurn?.turnRef ?? null;
  const preservedUsageIsPriorGeneration = task.usage == null
    && preservedUsage != null
    && currentTurnRef != null
    && preservedUsage.generationTurnRef !== currentTurnRef;
  const taskUsage = detailedTask.usage?.task
    && (detailedTask.usage.status === "available" || task.status === "working")
    && (!preservedUsageIsPriorGeneration || task.status === "working")
    ? {
      status: "available",
      ...detailedTask.usage.task,
      knownSoFar: task.status === "working",
    }
    : detailedTask.usage?.status === "calculating" || preservedUsageIsPriorGeneration
      ? { ...detailedTask.usage, status: task.status === "working" ? "pending" : "calculating" }
      : detailedTask.usage ?? {
        status: task.status === "working"
          ? "pending"
          : task.threadId
            ? "calculating"
            : "unavailable",
      };
  cancelTextShimmers(elements.dialogUsage);
  elements.dialogUsage.replaceChildren(usagePresentation(
    taskUsage,
    { wholeTask: true },
  ));
  elements.dialogInstruction.textContent = task.instruction;
  elements.copyTaskId.disabled = !task.id;
  setCopyTaskIdLabel("Copy Task ID");
  elements.dialogMetadata.replaceChildren(
    ...detailRow("Current status", taskStatusLabel(task)),
    ...detailRow("Current turn ref", task.turnRef),
    ...detailRow("Current Codex turn ID", task.turnId),
    ...detailRow("Last result status", task.lastResult?.status?.replaceAll("_", " ")),
    ...detailRow("Last result turn ref", task.lastResult?.turnRef),
    ...detailRow("Last result Codex turn ID", task.lastResult?.turnId),
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
  const canArchive = canArchiveTask(task);
  const archived = state.archivedThreadIds.has(task.threadId);
  const archivePending = state.archivePendingThreadIds.has(task.threadId);
  elements.archiveTask.hidden = !canArchive;
  elements.archiveTask.disabled = archived || archivePending;
  elements.archiveTask.textContent = archived ? "Archived" : archivePending ? "Archiving…" : "Archive chat";
  elements.archiveTask.setAttribute(
    "aria-label",
    archived ? `${task.title} is archived in Codex` : `Archive ${task.title} in Codex`,
  );
  renderManualTransition(detailedTask);
  return highlightedTurn;
}

async function openDialog(task, {
  focus = false,
  highlightTurnRef = null,
  preserveNavigation = false,
} = {}) {
  if (focus) {
    state.detailNavigation = {
      focusPending: true,
      highlightTurnRef,
      taskId: task.id,
    };
  } else if (!preserveNavigation) state.detailNavigation = null;
  const navigation = state.detailNavigation?.taskId === task.id
    ? state.detailNavigation
    : null;
  const activeHighlightTurnRef = navigation?.highlightTurnRef ?? highlightTurnRef;
  const requestGeneration = ++detailRequestGeneration;
  renderDialog(task, { highlightTurnRef: activeHighlightTurnRef });
  if (!elements.dialog.open) {
    elements.dialog.showModal();
    renderNotifications();
  }
  const load = async (attempt = 0) => {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`);
      if (!response.ok) throw new Error("Task details are unavailable.");
      const detail = await response.json();
      if (
        requestGeneration === detailRequestGeneration
        && state.selectedTask?.id === task.id
        && elements.dialog.open
      ) {
        const activeNavigation = state.detailNavigation?.taskId === task.id
          ? state.detailNavigation
          : null;
        const highlightedTurn = renderDialog(detail.task, {
          highlightTurnRef: activeNavigation?.highlightTurnRef ?? activeHighlightTurnRef,
        });
        if (activeNavigation?.focusPending) {
          (highlightedTurn ?? elements.dialogTitle).focus?.();
          activeNavigation.focusPending = false;
        }
        if (usageStillCalculating(detail.task) && attempt < MAX_USAGE_POLL_ATTEMPTS) {
          setTimeout(() => load(attempt + 1), USAGE_POLL_INTERVAL_MS);
        }
      }
    } catch {
      if (
        requestGeneration === detailRequestGeneration
        && state.selectedTask?.id === task.id
        && elements.dialog.open
      ) {
        showMessage("Task activity timeline is temporarily unavailable.");
        const activeNavigation = state.detailNavigation?.taskId === task.id
          ? state.detailNavigation
          : null;
        if (activeNavigation?.focusPending) {
          elements.dialogTitle.focus?.();
          activeNavigation.focusPending = false;
        }
      }
    }
  };
  await load();
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
  renderProject(project, task);
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
  result.className = `preserve-lines${latest.resultStatus === "working" ? " text-shimmer" : ""}`;
  if (latest.resultStatus === "working") renderTextShimmer(result, latest.resultSummary);
  else appendLinkedText(result, latest.resultSummary, task);
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
  const cards = visible.map(taskCard);
  cancelTextShimmers(elements.taskList);
  elements.taskList.replaceChildren(...cards);
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
    if (updated && elements.dialog.open) openDialog(updated, { preserveNavigation: true });
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
elements.closeDialog.addEventListener("click", () => {
  if (!manualTransitionPending()) elements.dialog.close();
});
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog && !manualTransitionPending()) elements.dialog.close();
});
elements.dialog.addEventListener("keydown", (event) => {
  handleManualTransitionEscape(event, {
    active: Boolean(state.manualTransition),
    pending: manualTransitionPending(),
    cancel: () => resetManualTransition({ focus: true }),
  });
});
elements.dialog.addEventListener("cancel", (event) => {
  if (!state.manualTransition) return;
  event.preventDefault();
  if (!manualTransitionPending()) resetManualTransition({ focus: true });
});
elements.dialog.addEventListener("close", () => {
  cancelTextShimmers(elements.dialogResults);
  cancelTextShimmers(elements.dialogUsage);
  if (!manualTransitionPending()) state.manualTransition = null;
  state.detailNavigation = null;
  renderNotifications();
});
elements.moreTaskActions.addEventListener("click", () => {
  const task = state.selectedTask;
  if (!task || manualTransitionPending()) return;
  if (state.manualTransition) {
    resetManualTransition({ focus: true });
    return;
  }
  state.manualTransition = {
    taskId: task.id,
    stage: "choose",
    expected: manualTransitionExpectedState(task),
  };
  renderManualTransition(task);
  elements.copyTaskId.focus();
});
elements.markTaskCompleted.addEventListener("click", (event) => {
  return submitManualTransition("completed", event);
});
elements.markTaskFailed.addEventListener("click", (event) => {
  return submitManualTransition("failed", event);
});
elements.copyTaskId.addEventListener("click", async () => {
  const taskId = state.selectedTask?.id;
  if (!taskId) return;
  const copyGeneration = ++copyTaskIdGeneration;
  clearTimeout(copyTaskIdTimer);
  copyTaskIdTimer = null;
  try {
    await navigator.clipboard.writeText(taskId);
    if (copyGeneration !== copyTaskIdGeneration || state.selectedTask?.id !== taskId) return;
    setCopyTaskIdLabel("Task ID copied");
    copyTaskIdTimer = setTimeout(() => {
      if (copyGeneration === copyTaskIdGeneration && state.selectedTask?.id === taskId) {
        setCopyTaskIdLabel("Copy Task ID");
      }
      copyTaskIdTimer = null;
    }, 1_500);
  } catch {
    if (copyGeneration === copyTaskIdGeneration && state.selectedTask?.id === taskId) {
      showMessage("Clipboard access is unavailable. Copy the Task ID from the metadata below.");
    }
  }
});
elements.openProject.addEventListener("click", async (event) => {
  if (!state.selectedTask) return;
  await openTaskFromControl(event, state.selectedTask.id, { showMessage });
});
elements.archiveTask.addEventListener("click", async (event) => {
  const task = state.selectedTask;
  if (
    !task
    || !canArchiveTask(task)
    || state.archivePendingThreadIds.has(task.threadId)
  ) return;
  state.archivePendingThreadIds.add(task.threadId);
  renderManualTransition(task);
  try {
    await archiveTaskFromControl(event, task, {
      onArchived: (threadId) => state.archivedThreadIds.add(threadId),
      showUpdate: (message, options) => showArchiveUpdate(task, message, options),
    });
  } finally {
    state.archivePendingThreadIds.delete(task.threadId);
    if (state.selectedTask?.id === task.id) renderDialog(state.selectedTask);
  }
});
