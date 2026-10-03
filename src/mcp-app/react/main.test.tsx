import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { useState } from "react";
import type { Task } from "../../dashboard/react/types";

const server = vi.hoisted(() => ({ call: vi.fn() }));
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
    callServerTool(input: { name: string; arguments: Record<string, unknown> }) { return server.call(input); }
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
afterEach(() => { cleanup(); server.call.mockReset(); });
function mount() { render(<TaskChefApp />); }

test("switches list and board and filters by project, date, and status with contextual counts", async () => {
  tasks = [task("one", "working", new Date().toISOString(), "Alpha"), task("two", "completed", "2026-01-01T00:00:00Z", "Alpha"), task("three", "failed", new Date().toISOString(), "Beta")];
  details = new Map(tasks.map((item) => [item.id, item]));
  mount();
  expect(await screen.findByRole("button", { name: "Task one" })).toBeVisible();
  expect(screen.getByText("Tasks: 3 of 3")).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "Alpha" } });
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
  expect(server.call).toHaveBeenCalledWith({ name: "taskchef_app_snapshot", arguments: { revision: 1 } });
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

test("transition conflict refreshes the current task", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Task one" }));
  await screen.findByRole("region", { name: "Task detail" });
  transition = async () => {
    details.set("one", task("one", "failed", "2026-10-02T00:00:00Z"));
    throw new Error("Task changed concurrently.");
  };
  fireEvent.click(screen.getByRole("button", { name: "Mark completed" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("failed"));
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
