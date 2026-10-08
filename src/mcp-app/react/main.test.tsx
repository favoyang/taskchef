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
    Alert: wrap("div"), Box: wrap("div"), Button: ({ children, onClick, disabled }: {children: React.ReactNode; onClick?: () => void; disabled?: boolean}) => <button onClick={onClick} disabled={disabled}>{children}</button>, Group: wrap("div"),
    MantineProvider: ({ children }: { children: React.ReactNode }) => children,
    Paper: wrap("div"), Stack: wrap("div"), Text: wrap("p"), Title: wrap("h2"),
    SegmentedControl: ({ data, onChange, value, ...props }: { data: Array<{ label: string; value: string }>; onChange: (value: string) => void; value: string; "aria-label": string }) => React.createElement("div", { role: "radiogroup", "aria-label": props["aria-label"] }, data.map((item) => React.createElement("button", { key: item.value, role: "radio", "aria-checked": item.value === value, onClick: () => onChange(item.value) }, item.label))),
    Switch: ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (event: React.ChangeEvent<HTMLInputElement>) => void }) => <label>{label}<input type="checkbox" checked={checked} onChange={onChange} /></label>,
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
  TaskDetail: ({ task, opened, onClose, onTransition, extraActions }: {
    task: Task | null; opened: boolean; onClose: () => void; extraActions?: React.ReactNode;
    onTransition: (status: "completed" | "failed", actionId: string) => Promise<unknown>;
  }) => {
    const [confirm, setConfirm] = useState(false);
    return opened && task ? <section aria-label="Task detail"><h2>{task.title}</h2><p>{task.status}</p>{extraActions}<button onClick={onClose}>Close</button><button onClick={() => setConfirm(true)}>Mark completed</button>{confirm && <button onClick={() => { void onTransition("completed", crypto.randomUUID()); setConfirm(false); }}>Confirm</button>}</section> : null;
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
  tasks = [task("one", "working", new Date().toISOString(), "Alpha"), task("two", "completed", "2026-01-01T00:00:00Z", "Alpha"), task("three", "interrupted", new Date().toISOString(), "Beta")];
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
  fireEvent.click(screen.getByRole("radio", { name: /Interrupted/ }));
  expect(screen.getByText("Tasks: 1 of 3")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task one" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(within(screen.getByRole("region", { name: "Task board" })).getAllByRole("button")).toHaveLength(3);
  expect(screen.queryByRole("radiogroup", { name: "Status" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.getByRole("button", { name: "Task three" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task two" })).not.toBeInTheDocument();
});

test("offers an Unverified filter with a contextual count", async () => {
  tasks = [task("one", null, new Date().toISOString(), "Alpha"), task("two", null, new Date().toISOString(), "Beta")];
  mount();
  expect(await screen.findByRole("radio", { name: "Unverified 2" })).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "/Alpha" } });
  fireEvent.click(screen.getByRole("radio", { name: "Unverified 1" }));
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

test("shows a card Open chat failure without hiding cards or opening detail", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open chat for Task one" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Codex could not be opened.");
  expect(screen.getByRole("button", { name: "Task one" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open chat for Task one" })).toBeVisible();
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

test("keeps scan diagnostics out of the board", async () => {
  server.call.mockImplementation(({ name }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: {
      tasks: [], healthy: true, revision: 1,
      scan: { source: "database", mode: "database", checkedAt: "2026-10-05T00:00:00Z", intervalSeconds: 5,
        indexedFiles: 8620, visibleFiles: 300, unreadFiles: 8320, errors: 0 },
    } } });
    throw new Error(`Unexpected tool: ${name}`);
  });
  mount();
  fireEvent.click(screen.getByText("Board", { exact: true }));
  await screen.findByRole("region", { name: "Task board" });
  expect(screen.queryByText(/Read-only database/)).not.toBeInTheDocument();
  expect(screen.queryByText(/shown of.*top-level chats/)).not.toBeInTheDocument();
  expect(screen.queryByText(/checks every 5s/)).not.toBeInTheDocument();
  expect(screen.queryByText(/title \(may contain user text\)/)).not.toBeInTheDocument();
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
  expect(screen.queryByText(/Read-only database/)).not.toBeInTheDocument();
  expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  expect(screen.queryByText(/shown of/)).not.toBeInTheDocument();
});

test("inline mode shows a compact recent-chat view", async () => {
  server.displayMode = "inline";
  tasks = [task("one"), task("two"), task("three"), task("four")];
  mount();
  expect(await screen.findByText("4 eligible top-level chats")).toBeVisible();
  expect(screen.getByRole("button", { name: "Task one" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task four" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Task board" })).not.toBeInTheDocument();
  expect(screen.queryByText(/View:.*document:/)).not.toBeInTheDocument();
});

test("inline mode loads once and begins polling when expanded", async () => {
  server.displayMode = "inline";
  const setInterval = vi.spyOn(window, "setInterval");
  const clearInterval = vi.spyOn(window, "clearInterval");
  const snapshotCalls = () => server.call.mock.calls.filter(([input]) => input.name === "taskchef_app_snapshot").length;
  mount();
  expect(await screen.findByText("1 eligible top-level chats")).toBeVisible();
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


test("Done control calls the local mark tool with the displayed turn and refreshes", async () => {
  const current = { ...task("one", "needs_input"), turnId: "turn-one", observed: { archive: false, lastTurnEvent: "completed", lastTurnEventAt: null, recentFileActivity: false } };
  tasks = [current]; details = new Map([[current.id, current]]);
  server.call.mockImplementation(async ({ name, arguments: args }) => {
    if (name === "taskchef_app_set_done") {
      const next = { ...current, status: args.done ? "completed" : "needs_input", manualDone: args.done } as Task;
      tasks = [next]; details.set(current.id, next);
      return { structuredContent: { task: next } };
    }
    if (name === "taskchef_app_snapshot") return { structuredContent: { snapshot: { tasks, healthy: true } } };
    if (name === "taskchef_app_task") return { structuredContent: { task: details.get(current.id) } };
    throw new Error(name);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
  fireEvent.click(await screen.findByRole("button", { name: "Mark Done" }));
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Task detail" })).getByText("completed")).toBeVisible());
  expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Mark Done" })).not.toBeInTheDocument();
  expect(server.call).toHaveBeenCalledWith({ name: "taskchef_app_set_done", arguments: { taskId: "one", expectedTurnId: "turn-one", done: true } });

});


test("CLI and archive settings default hidden, update counts, and persist across views and reloads", async () => {
  tasks = [task("desktop", "needs_input"), {
    ...task("cli", "needs_input"), observed: { source: "cli", archive: false, lastTurnEvent: "completed", lastTurnEventAt: null, recentFileActivity: false },
  }, {
    ...task("archive", "archived"), observed: { source: "vscode", archive: true, lastTurnEvent: "completed", lastTurnEventAt: null, recentFileActivity: false },
  }, task("done", "completed")];
  details = new Map(tasks.map((item) => [item.id, item]));
  const first = render(<TaskChefApp />);
  expect(await screen.findByText("Tasks: 2 of 2")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task cli" })).not.toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: /Archived/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("checkbox", { name: "Show CLI sessions" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Show archived chats" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Show CLI sessions" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Show archived chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
  expect(screen.getByText("Tasks: 4 of 4")).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: "Archived 1" }));
  expect(screen.getByRole("button", { name: "Task archive" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task done" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(within(screen.getByRole("region", { name: "Task board" })).getAllByRole("button")).toHaveLength(4);
  first.unmount();
  mount();
  expect(await screen.findByRole("button", { name: "Task cli" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Task archive" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("checkbox", { name: "Show CLI sessions" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Show CLI sessions" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Show archived chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
  expect(screen.queryByRole("button", { name: "Task cli" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Task archive" })).not.toBeInTheDocument();
});

test("a selected CLI chat closes when its source becomes hidden during refresh", async () => {
  window.localStorage.setItem("taskchef.next.show-cli", "true");
  const cli = { ...task("cli"), observed: { source: "cli", archive: false, lastTurnEvent: "inProgress", lastTurnEventAt: null, recentFileActivity: false } };
  tasks = [cli]; details = new Map([[cli.id, cli]]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Task cli" }));
  expect(await screen.findByRole("region", { name: "Task detail" })).toBeVisible();
  // Another visible client, or updated metadata, can make this chat archived.
  const archived = { ...cli, status: "archived" as const, observed: { ...cli.observed, archive: true } };
  tasks = [archived]; details.set(cli.id, archived);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Task cli" })).not.toBeInTheDocument();
});

test("inline mode follows the CLI and archive visibility settings", async () => {
  server.displayMode = "inline";
  tasks = [task("desktop"), { ...task("cli"), observed: { source: "cli", archive: false, lastTurnEvent: "completed", lastTurnEventAt: null, recentFileActivity: false } }, { ...task("archive", "archived"), observed: { archive: true, lastTurnEvent: "completed", lastTurnEventAt: null, recentFileActivity: false } }];
  mount();
  expect(await screen.findByText("1 eligible top-level chats")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Task cli" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Task archive" })).not.toBeInTheDocument();
});
