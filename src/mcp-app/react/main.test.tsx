import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { useState } from "react";
import type { Task } from "../../dashboard/react/types";

const server = vi.hoisted(() => ({ call: vi.fn(), displayMode: "unknown", hostContextChanged: undefined as undefined | ((context: { displayMode: string }) => void), teardown: undefined as undefined | (() => object) }));
vi.mock("@mantine/core", async () => {
  const React = await import("react");
  const wrap = (tag: string) => ({ children, component, ...props }: Record<string, unknown>) => React.createElement(component as string || tag, { "aria-label": props["aria-label"], role: props.role, id: props.id }, children as React.ReactNode);
  return {
    ActionIcon: ({ children, onClick, ...props }: Record<string, unknown>) => React.createElement("button", { "aria-label": props["aria-label"], onClick }, children as React.ReactNode),
    Alert: wrap("div"), Box: wrap("div"), Button: wrap("button"), Group: wrap("div"),
    MantineProvider: ({ children }: { children: React.ReactNode }) => children,
    Paper: wrap("div"), Stack: wrap("div"), Text: wrap("p"), Title: wrap("h2"),
    SegmentedControl: ({ data, onChange, value, ...props }: { data: Array<{ label: string; value: string }>; onChange: (value: string) => void; value: string; "aria-label": string }) => React.createElement("div", { role: "radiogroup", "aria-label": props["aria-label"] }, data.map((item) => React.createElement("button", { key: item.value, role: "radio", "aria-checked": item.value === value, onClick: () => onChange(item.value) }, item.label))),
    Select: ({ data, onChange, value, ...props }: { data: Array<{ label: string; value: string }>; onChange: (value: string) => void; value: string; "aria-label": string }) => React.createElement("select", { "aria-label": props["aria-label"], value, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value) }, data.map((item) => React.createElement("option", { key: item.value, value: item.value }, item.label))),
  };
});
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    connect() { return Promise.resolve(); }
    getHostContext() { return { displayMode: server.displayMode }; }
    callServerTool(input: { name: string; arguments: Record<string, unknown> }) { return server.call(input); }
    set onhostcontextchanged(handler: (context: { displayMode: string }) => void) { server.hostContextChanged = handler; }
    set onteardown(handler: () => object) { server.teardown = handler; }
  },
}));
vi.mock("../../dashboard/react/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenCodex, onOpenDetail }: { task: Task; onOpenCodex: (task: Task) => void; onOpenDetail: (task: Task) => void }) => <article><button onClick={() => onOpenDetail(task)}>{task.title}</button><button onClick={() => onOpenCodex(task)}>Open chat for {task.title}</button></article>,
}));
vi.mock("../../dashboard/react/components/TaskBoard", () => ({
  TaskBoard: ({ tasks, onOpenDetail }: { tasks: Task[]; onOpenDetail: (task: Task) => void }) => <section aria-label="Task board">{tasks.map((task) => <button key={task.id} onClick={() => onOpenDetail(task)}>{task.title}</button>)}</section>,
}));
vi.mock("../../dashboard/react/components/TaskDetail", () => ({
  TaskDetail: ({ task, opened, onClose, onTransition }: {
    task: Task | null; opened: boolean; onClose: () => void;
    onTransition: (status: "completed" | "failed", actionId: string) => Promise<unknown>;
  }) => {
    const [confirm, setConfirm] = useState(false);
    return opened && task ? <section aria-label="Task detail"><h2>{task.title}</h2><p>{task.status}</p><button onClick={onClose}>Close</button><button onClick={() => setConfirm(true)}>Mark completed</button>{confirm && <button onClick={() => { void onTransition("completed", crypto.randomUUID()); setConfirm(false); }}>Confirm</button>}</section> : null;
  },
}));

import { TaskChefApp } from "./main";

const task = (id: string, status: Task["status"] = "working", updatedAt = "2026-10-01T00:00:00Z", project = "Example"): Task => ({
  id, title: `Task ${id}`, instruction: "Do the work", status, updatedAt, createdAt: updatedAt,
  project: { name: project, path: `/${project}`, githubRepos: [] }, summary: "Initial summary",
  threadId: null, turnRef: null, turnId: null, lastResult: null, latestTurn: null,
});

let tasks: Task[];
let details: Map<string, Task>;
let transition: () => Promise<unknown>;
let detailFailure: string | null;
beforeEach(() => {
  server.displayMode = "unknown";
  server.hostContextChanged = undefined;
  server.teardown = undefined;
  window.localStorage.clear();
  tasks = [task("one")];
  details = new Map(tasks.map((item) => [item.id, item]));
  transition = async () => ({ structuredContent: { task: task("one", "completed") } });
  detailFailure = null;
  server.call.mockImplementation(({ name, arguments: args }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: { tasks, healthy: true } } });
    if (name === "taskchef_app_task" && detailFailure) return Promise.resolve({ isError: true, content: [{ type: "text", text: detailFailure }] });
    if (name === "taskchef_app_task") return Promise.resolve({ structuredContent: { task: details.get(args.taskId as string) } });
    if (name === "taskchef_app_transition") return transition();
    if (name === "taskchef_app_open_chat") return Promise.resolve({ isError: true, content: [{ type: "text", text: "Codex could not be opened." }] });
    throw new Error(`Unexpected tool: ${name}`);
  });
});
afterEach(() => { cleanup(); server.call.mockReset(); vi.restoreAllMocks(); });
function mount() { render(<TaskChefApp />); }

test("lifecycle events log readable single strings without suppressing repeats", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { unmount } = render(<TaskChefApp />);
  const details = JSON.stringify({ visibility: document.visibilityState, displayMode: "unknown" });
  expect(warn).toHaveBeenCalledWith(`[TaskChef] TaskChef Next lifecycle: mounted ${details}`);
  warn.mockClear();
  fireEvent(document, new Event("visibilitychange"));
  expect(warn).toHaveBeenCalledWith(`[TaskChef] TaskChef Next lifecycle: visibilitychange ${details}`);
  fireEvent(window, new Event("pagehide"));
  fireEvent(window, new Event("pagehide"));
  expect(warn.mock.calls.filter(([message]) => message === `[TaskChef] TaskChef Next lifecycle: pagehide ${details}`)).toHaveLength(2);
  act(() => server.hostContextChanged?.({ displayMode: "fullscreen" }));
  expect(warn).toHaveBeenCalledWith(`[TaskChef] TaskChef Next lifecycle: host context changed ${JSON.stringify({ visibility: document.visibilityState, displayMode: "fullscreen" })}`);
  act(() => server.teardown?.());
  expect(warn).toHaveBeenCalledWith(`[TaskChef] TaskChef Next lifecycle: host teardown ${details}`);
  unmount();
  expect(warn).toHaveBeenCalledWith(`[TaskChef] TaskChef Next lifecycle: unmounted ${details}`);
  expect(warn.mock.calls.every((call) => call.length === 1 && typeof call[0] === "string" && !call[0].includes("[object Object]"))).toBe(true);
  warn.mockClear();
  fireEvent(window, new Event("pagehide"));
  expect(warn).not.toHaveBeenCalled();
});

test("switches list and board and filters by project, date, and status with contextual counts", async () => {
  tasks = [task("one", "working", new Date().toISOString(), "Alpha"), task("two", "completed", "2026-01-01T00:00:00Z", "Alpha"), task("three", "failed", new Date().toISOString(), "Beta")];
  details = new Map(tasks.map((item) => [item.id, item]));
  mount();
  expect(await screen.findByRole("button", { name: "Task one" })).toBeVisible();
  expect(screen.getByText("Tasks: 3 of 3")).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "/Alpha" } });
  expect(screen.getByText("Tasks: 2 of 3")).toBeVisible();
  expect(screen.getByRole("radio", { name: "All 2" })).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Updated" }), { target: { value: "24h" } });
  expect(screen.getByText("Tasks: 1 of 3")).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Updated" }), { target: { value: "all" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("radio", { name: /Failed/ }));
  expect(screen.getByText("Tasks: 1 of 3")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task one" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(within(screen.getByRole("region", { name: "Task board" })).getAllByRole("button")).toHaveLength(3);
  expect(screen.queryByRole("radiogroup", { name: "Status" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.getByRole("button", { name: "Task three" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task two" })).not.toBeInTheDocument();
});

test("offers an Unresolved filter with a contextual count", async () => {
  tasks = [task("one", null, new Date().toISOString(), "Alpha"), task("two", null, new Date().toISOString(), "Beta")];
  mount();
  expect(await screen.findByRole("radio", { name: "Unresolved 2" })).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "/Alpha" } });
  fireEvent.click(screen.getByRole("radio", { name: "Unresolved 1" }));
  expect(screen.getByRole("button", { name: "Task one" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task two" })).not.toBeInTheDocument();
});

test("filters projects with the same name by directory", async () => {
  const first = task("one", null, new Date().toISOString(), "project");
  const second = task("two", null, new Date().toISOString(), "project");
  first.project.path = "/work/first/project";
  second.project.path = "/work/second/project";
  tasks = [first, second];
  mount();
  expect(await screen.findByRole("button", { name: "Task one" })).toBeVisible();
  const picker = screen.getByRole("combobox", { name: "Project" });
  expect(within(picker).getByRole("option", { name: "project (/work/first/project)" })).toBeVisible();
  expect(within(picker).getByRole("option", { name: "project (/work/second/project)" })).toBeVisible();
  fireEvent.change(picker, { target: { value: "/work/second/project" } });
  expect(screen.queryByRole("button", { name: "Task one" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Task two" })).toBeVisible();
  expect(screen.getByRole("radio", { name: "All 1" })).toBeVisible();
});

test("refresh updates detail and removes a disappeared selection", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
  await screen.findByRole("region", { name: "Task detail" });
  details.set("one", task("one", "needs_input", "2026-10-02T00:00:00Z"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("needs_input"));
  tasks = [];
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument());
});

test("refresh sends the last revision and keeps selection detail current on unchanged snapshots", async () => {
  let revision = 1;
  server.call.mockImplementation(({ name, arguments: args }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: args.revision === revision
      ? { unchanged: true, revision }
      : { snapshot: { tasks, healthy: true, revision } } });
    if (name === "taskchef_app_task") return Promise.resolve({ structuredContent: { task: details.get(args.taskId as string) } });
    throw new Error(`Unexpected tool: ${name}`);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
  details.set("one", task("one", "needs_input"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("needs_input"));
  expect(server.call).toHaveBeenCalledWith({ name: "taskchef_app_snapshot", arguments: { revision: 1, force: true } });
  tasks = [task("two")];
  revision = 2;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Task two" })).toBeVisible();
});

test("an older selection detail cannot replace a newer refresh detail", async () => {
  let releaseFirst!: (value: unknown) => void;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let detailCalls = 0;
  server.call.mockImplementation(({ name }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: { tasks, healthy: true } } });
    if (name === "taskchef_app_task") return ++detailCalls === 1
      ? first
      : Promise.resolve({ structuredContent: { task: task("one", "needs_input") } });
    throw new Error(`Unexpected tool: ${name}`);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
  await waitFor(() => expect(detailCalls).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("needs_input"));
  await act(async () => { releaseFirst({ structuredContent: { task: task("one", "working") } }); await first; });
  expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("needs_input");
});

test("shows a card Open chat failure without opening detail", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open chat for Task one" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Codex could not be opened.");
  expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument();
});

test("an older selection response cannot replace the current task", async () => {
  tasks = [task("one"), task("two")];
  let release!: (value: unknown) => void;
  const first = new Promise((resolve) => { release = resolve; });
  server.call.mockImplementation(({ name, arguments: args }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: { tasks, healthy: true } } });
    if (name === "taskchef_app_task") return args.taskId === "one" ? first : Promise.resolve({ structuredContent: { task: task("two") } });
    throw new Error(`Unexpected tool: ${name}`);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
  fireEvent.click(screen.getByRole("button", { name: "Task two" }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("Task two"));
  release({ structuredContent: { task: task("one") } });
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("Task two"));
});

test("shows database source and five second coverage without a reparse claim", async () => {
  server.call.mockImplementation(({ name }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: {
      tasks: [], healthy: true, revision: 1,
      scan: { source: "database", mode: "database", checkedAt: "2026-10-05T00:00:00Z", intervalSeconds: 5,
        indexedFiles: 8620, visibleFiles: 300, unreadFiles: 8320, errors: 0 },
    } } });
    throw new Error(`Unexpected tool: ${name}`);
  });
  mount();
  expect(await screen.findByText(/300 shown of 8620 top-level chats/)).toBeVisible();
  expect(screen.getByText(/Read-only database/)).toBeVisible();
  expect(screen.getByText(/checks every 5s when document is visible/)).toBeVisible();
  expect(screen.getByText(/title \(may contain user text\)/)).toBeVisible();
  expect(screen.queryByText(/Full reparse/)).not.toBeInTheDocument();
});

test("shows an initial inventory failure without undefined scan counts", async () => {
  server.call.mockImplementation(({ name }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: {
      tasks: [], healthy: false, revision: 0,
      scan: { mode: "error", checkedAt: "2026-10-05T00:00:00Z", error: "EACCES" },
    } } });
    throw new Error(`Unexpected tool: ${name}`);
  });
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("cannot read the Codex databases");
  expect(screen.getByText(/Read-only database · error/)).toBeVisible();
  expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  expect(screen.queryByText(/shown of/)).not.toBeInTheDocument();
});

test("inline mode shows a compact recent-chat view", async () => {
  server.displayMode = "inline";
  tasks = [task("one"), task("two"), task("three"), task("four")];
  mount();
  expect(await screen.findByText("4 recent top-level chats")).toBeVisible();
  expect(screen.getByRole("button", { name: "Task one" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task four" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Task board" })).not.toBeInTheDocument();
  expect(screen.getByText("View: inline · document: visible")).toBeVisible();
});

test("inline mode loads once and begins polling when expanded", async () => {
  server.displayMode = "inline";
  const setInterval = vi.spyOn(window, "setInterval");
  const clearInterval = vi.spyOn(window, "clearInterval");
  const snapshotCalls = () => server.call.mock.calls.filter(([input]) => input.name === "taskchef_app_snapshot").length;
  mount();
  expect(await screen.findByText("1 recent top-level chats")).toBeVisible();
  expect(snapshotCalls()).toBe(1);
  expect(setInterval.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(snapshotCalls()).toBe(2));
  server.displayMode = "fullscreen";
  act(() => server.hostContextChanged?.({ displayMode: "fullscreen" }));
  await waitFor(() => expect(snapshotCalls()).toBe(3));
  const pollIndex = setInterval.mock.calls.findIndex(([, delay]) => delay === 5000);
  expect(pollIndex).toBeGreaterThanOrEqual(0);
  await act(async () => { (setInterval.mock.calls[pollIndex][0] as () => void)(); });
  expect(snapshotCalls()).toBe(4);
  server.displayMode = "inline";
  act(() => server.hostContextChanged?.({ displayMode: "inline" }));
  expect(clearInterval).toHaveBeenCalledWith(setInterval.mock.results[pollIndex].value);
});

test("shows the Node requirement when the scanner rejects its runtime", async () => {
  server.call.mockResolvedValue({ structuredContent: { snapshot: {
    tasks: [], healthy: false, revision: 0,
    scan: { mode: "error", checkedAt: "2026-10-05T00:00:00Z", error: "TaskChef Next requires Node.js 22.18.0 or later for read-only SQLite (current: 22.17.9)." },
  } } });
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("TaskChef Next requires Node.js 22.18.0 or later");
});

test("a database failure after a healthy snapshot removes stale tasks", async () => {
  mount();
  expect(await screen.findByRole("button", { name: "Task one" })).toBeVisible();
  server.call.mockImplementation(({ name }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: {
      tasks: [], healthy: false, revision: 2,
      scan: { source: "database", mode: "error", checkedAt: new Date().toISOString() },
    } } });
    throw new Error(`Unexpected tool: ${name}`);
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cannot read the Codex databases");
  expect(screen.queryByRole("button", { name: "Task one" })).not.toBeInTheDocument();
});
