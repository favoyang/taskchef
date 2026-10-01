import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { Task } from "../../dashboard/react/types";

const server = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    connect() { return Promise.resolve(); }
    callServerTool(input: { name: string; arguments: Record<string, unknown> }) { return server.call(input); }
  },
}));

import { TaskChefApp } from "./main";

const task = (id: string, status: Task["status"] = "working", updatedAt = "2026-01-01T00:00:00Z"): Task => ({
  id, title: `Task ${id}`, instruction: "Do the work", status, updatedAt, createdAt: updatedAt,
  project: { name: "Example", path: "/example", githubRepos: [] }, summary: "Initial summary",
  threadId: null, turnRef: null, turnId: null, lastResult: null, latestTurn: null,
});

let tasks: Task[];
let details: Map<string, Task>;
let transition: () => Promise<unknown>;
let detailFailure: string | null;
beforeEach(() => {
  tasks = [task("one")];
  details = new Map(tasks.map((item) => [item.id, item]));
  transition = async () => ({ structuredContent: { task: task("one", "completed") } });
  detailFailure = null;
  server.call.mockImplementation(({ name, arguments: args }) => {
    if (name === "taskchef_app_snapshot") return Promise.resolve({ structuredContent: { snapshot: { tasks, healthy: true } } });
    if (name === "taskchef_app_task" && detailFailure) return Promise.resolve({ isError: true, content: [{ type: "text", text: detailFailure }] });
    if (name === "taskchef_app_task") return Promise.resolve({ structuredContent: { task: details.get(args.taskId as string) } });
    if (name === "taskchef_app_transition") return transition();
    throw new Error(`Unexpected tool: ${name}`);
  });
});
afterEach(() => { cleanup(); server.call.mockReset(); });

function mount() { render(<MantineProvider forceColorScheme="dark"><TaskChefApp /></MantineProvider>); }

test("shows tasks with unresolved status on the board", async () => {
  tasks = [task("unresolved", null)];
  details = new Map(tasks.map((item) => [item.id, item]));
  mount();
  const lane = await screen.findByRole("heading", { name: "Unresolved" });
  expect(within(lane.closest("section")!).getByRole("button", { name: /Task unresolved/ })).toBeVisible();
});

test("refresh updates selected detail and closes confirmation when its expected state changes", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Task one/ }));
  await screen.findByRole("region", { name: "Task detail" });
  fireEvent.click(screen.getByRole("button", { name: "Mark completed" }));
  expect(screen.getByText("Mark task completed?")).toBeVisible();
  details.set("one", { ...task("one", "needs_input", "2026-01-02T00:00:00Z"), summary: "Updated summary" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("needs input"));
  expect(screen.queryByText("Mark task completed?")).not.toBeInTheDocument();
});

test("refresh returns to the board and clears confirmation when the selected task is removed", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Task one/ }));
  await screen.findByRole("region", { name: "Task detail" });
  fireEvent.click(screen.getByRole("button", { name: "Mark completed" }));
  tasks = [];
  detailFailure = "Task not found.";
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument());
  expect(screen.queryByText("Mark task completed?")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Working" })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("refresh returns to the board if the task disappears after the snapshot", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Task one/ }));
  await screen.findByRole("region", { name: "Task detail" });
  detailFailure = "Task not found.";
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("refresh keeps selected detail and reports unrelated task fetch errors", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Task one/ }));
  await screen.findByRole("region", { name: "Task detail" });
  detailFailure = "Task log unavailable.";
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Task log unavailable."));
  expect(screen.getByRole("region", { name: "Task detail" })).toBeVisible();
});

test("transition conflict refreshes selected detail before offering another action", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Task one/ }));
  await screen.findByRole("region", { name: "Task detail" });
  fireEvent.click(screen.getByRole("button", { name: "Mark completed" }));
  transition = async () => {
    details.set("one", task("one", "failed", "2026-01-02T00:00:00Z"));
    throw new Error("Task changed concurrently.");
  };
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Task changed concurrently"));
  expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("failed");
  expect(screen.queryByText("Mark task completed?")).not.toBeInTheDocument();
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
  fireEvent.click(await screen.findByRole("button", { name: /Task one/ }));
  fireEvent.click(screen.getByRole("button", { name: /Task two/ }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("Task two"));
  release({ structuredContent: { task: task("one") } });
  await waitFor(() => expect(screen.getByRole("region", { name: "Task detail" })).toHaveTextContent("Task two"));
});
