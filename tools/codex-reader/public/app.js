import { formatTime } from "./time.js";

const listElement = document.querySelector("#list");
const projectElement = document.querySelector("#project");
const pinnedElement = document.querySelector("#pinned");
const scheduledElement = document.querySelector("#scheduled");
const threadElement = document.querySelector(".thread");
const threadEmptyElement = document.querySelector("#thread-empty");
const threadViewElement = document.querySelector("#thread-view");
const threadTitleElement = document.querySelector("#thread-title");
const threadFlagsElement = document.querySelector("#thread-flags");
const messagesElement = document.querySelector("#messages");

const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3l7 7-3 1-4 4-1 5-2 2-3-6-5-3 2-2 5-1 4-4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

const state = {
  chats: [],
  projects: [],
  selectedId: null,
  project: "",
  pinned: false,
  scheduled: false,
  request: 0,
};

function flagElement(kind) {
  const element = document.createElement("span");
  element.className = `flag flag-${kind}`;
  element.title = kind === "pinned" ? "Pinned" : "Scheduled";
  element.innerHTML = kind === "pinned" ? PIN_ICON : CLOCK_ICON;
  return element;
}

function flagsFor(chat) {
  const element = document.createElement("span");
  element.className = "flags";
  if (chat.pinned) element.append(flagElement("pinned"));
  if (chat.scheduled) element.append(flagElement("scheduled"));
  return element;
}

function visibleChats() {
  return state.chats
    .filter((chat) => !state.project || chat.project.id === state.project)
    .filter((chat) => !state.pinned || chat.pinned)
    .filter((chat) => !state.scheduled || chat.scheduled)
    .sort((left, right) => {
      const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return Number.isFinite(difference) && difference !== 0 ? difference : left.title.localeCompare(right.title);
    });
}

function updateSelection() {
  for (const row of listElement.querySelectorAll(".row")) {
    const selected = row.dataset.id === state.selectedId;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
  }
}

function renderThread(chat) {
  threadTitleElement.textContent = chat.title;
  threadFlagsElement.replaceChildren();
  if (chat.pinned) threadFlagsElement.append(flagElement("pinned"));
  if (chat.scheduled) threadFlagsElement.append(flagElement("scheduled"));
}

async function selectChat(id) {
  state.selectedId = id;
  updateSelection();
  const chat = state.chats.find((item) => item.id === id);
  if (!chat) return;
  renderThread(chat);
  threadEmptyElement.hidden = true;
  threadViewElement.hidden = false;
  messagesElement.replaceChildren();
  threadElement.scrollTop = 0;
  const request = ++state.request;
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Chat request failed.");
    const data = await response.json();
    if (request !== state.request || id !== state.selectedId) return;
    if (!data.messages.length) {
      const empty = document.createElement("div");
      empty.className = "message-empty";
      empty.textContent = "No messages";
      messagesElement.append(empty);
      return;
    }
    for (const message of data.messages) {
      const element = document.createElement("div");
      element.className = `message ${message.role}`;
      element.innerHTML = message.html;
      messagesElement.append(element);
    }
  } catch {
    if (request !== state.request || id !== state.selectedId) return;
    const error = document.createElement("div");
    error.className = "message-empty";
    error.textContent = "Could not load chat";
    messagesElement.replaceChildren(error);
  }
}

function renderList() {
  const visible = visibleChats();
  listElement.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = "No chats";
    listElement.append(empty);
    state.selectedId = null;
    state.request += 1;
    threadViewElement.hidden = true;
    threadEmptyElement.hidden = false;
    return;
  }

  if (!state.selectedId || !visible.some((chat) => chat.id === state.selectedId)) {
    const first = visible[0].id;
    state.selectedId = first;
    for (const chat of visible) listElement.append(renderRow(chat));
    updateSelection();
    void selectChat(first);
    return;
  }

  for (const chat of visible) listElement.append(renderRow(chat));
  updateSelection();
}

function renderRow(chat) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "row";
  row.dataset.id = chat.id;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(chat.id === state.selectedId));
  row.title = chat.title;

  const project = document.createElement("span");
  project.className = "project";
  project.textContent = chat.project.name;

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = chat.title;

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime(chat.updatedAt);

  row.append(flagsFor(chat), project, title, time);
  row.addEventListener("click", () => { void selectChat(chat.id); });
  return row;
}

function renderProjects() {
  const current = state.project;
  projectElement.replaceChildren();
  projectElement.append(new Option("All projects", ""));
  for (const project of state.projects) projectElement.append(new Option(project.name, project.id));
  projectElement.value = state.projects.some((project) => project.id === current) ? current : "";
  state.project = projectElement.value;
}

function renderToggle(button, active) {
  button.setAttribute("aria-pressed", String(active));
}

async function load() {
  try {
    const response = await fetch("/api/chats");
    if (!response.ok) throw new Error("Chat list request failed.");
    const data = await response.json();
    state.chats = Array.isArray(data.chats) ? data.chats : [];
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    renderProjects();
    renderList();
  } catch {
    listElement.replaceChildren();
    const error = document.createElement("div");
    error.className = "list-empty";
    error.textContent = "Could not load chats";
    listElement.append(error);
    threadViewElement.hidden = true;
    threadEmptyElement.hidden = false;
  }
}

projectElement.addEventListener("change", () => {
  state.project = projectElement.value;
  renderList();
});

pinnedElement.addEventListener("click", () => {
  state.pinned = !state.pinned;
  renderToggle(pinnedElement, state.pinned);
  renderList();
});

scheduledElement.addEventListener("click", () => {
  state.scheduled = !state.scheduled;
  renderToggle(scheduledElement, state.scheduled);
  renderList();
});

void load();
