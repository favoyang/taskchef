import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DashboardApp } from "./App";
import { fixtureTask } from "./fixtures";
import type { DashboardSnapshot } from "./types";

const apiMocks = vi.hoisted(() => ({
  connectDashboard: vi.fn(),
  dashboardVersion: vi.fn(),
  manualTransition: vi.fn(),
  openInCodex: vi.fn(),
  taskDetail: vi.fn(),
}));

vi.mock("./api", () => apiMocks);
vi.mock("./components/NotificationCenter", () => ({ NotificationCenter: () => null }));
vi.mock("./components/TaskCard", () => ({ TaskCard: () => null }));
vi.mock("./components/TaskDetail", () => ({ TaskDetail: () => null }));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.dashboardVersion.mockResolvedValue("7.25.1");
});

test("places the filtered task count below the toolbar and updates it from live snapshots", () => {
  const recent = new Date().toISOString();
  const tasks = [
    fixtureTask({
      id: "11111111-1111-4111-8111-111111111111",
      project: { name: "Another project", path: "/tmp/another", githubRepos: [] },
      status: "completed",
      meaningfulUpdatedAt: recent,
      updatedAt: recent,
    }),
    fixtureTask({
      id: "22222222-2222-4222-8222-222222222222",
      project: { name: "Another project", path: "/tmp/another", githubRepos: [] },
      meaningfulUpdatedAt: recent,
      updatedAt: recent,
    }),
    fixtureTask({
      id: "33333333-3333-4333-8333-333333333333",
      status: "completed",
    }),
  ];
  let onSnapshot: ((snapshot: DashboardSnapshot) => void) | undefined;
  apiMocks.connectDashboard.mockImplementation((handlers) => {
    onSnapshot = handlers.onSnapshot;
    return { close: vi.fn() };
  });

  render(
    <DashboardApp
      initialFilters={{ date: "24h", project: "Another project", status: "completed" }}
      initialTasks={tasks}
    />,
  );
  const projectFilter = screen.getByRole("combobox", { name: "Project" });
  const dateFilter = screen.getByRole("combobox", { name: "Updated" });
  const toolbar = document.querySelector<HTMLElement>(".taskchef-toolbar");
  const summary = document.querySelector<HTMLElement>(".taskchef-results-summary");
  const taskList = screen.getByRole("region", { name: "Tasks" });

  expect(projectFilter).toHaveValue("Another project");
  expect(dateFilter).toHaveValue("Latest 24 hours");
  expect(screen.getByRole("radio", { name: /Completed/ })).toBeChecked();
  expect(summary).toHaveTextContent("Tasks: 1 of 3");
  expect(toolbar).not.toContainElement(summary);
  expect(toolbar?.nextElementSibling).toBe(summary);
  expect(taskList).toHaveAttribute("aria-describedby", summary?.id);

  act(() => {
    onSnapshot?.({
      tasks: [
        tasks[0],
        fixtureTask({
          id: "44444444-4444-4444-8444-444444444444",
          project: { name: "Another project", path: "/tmp/another", githubRepos: [] },
          status: "completed",
          meaningfulUpdatedAt: recent,
          updatedAt: recent,
        }),
      ],
    });
  });

  expect(summary).toHaveTextContent("Tasks: 2 of 2");
  expect(summary).toHaveAttribute("aria-live", "polite");
}, 60_000);
