import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ElementType, ReactNode } from "react";
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
vi.mock("./components/TaskBoard", () => ({ TaskBoard: ({ tasks, completedLimit, onMoreCompleted }: { tasks: ReturnType<typeof fixtureTask>[]; completedLimit: number; onMoreCompleted: () => void }) => (
  <section aria-label="Task board" data-completed-limit={completedLimit}>
    {tasks.map((task) => <span key={task.id}>{task.title}</span>)}
    <button onClick={onMoreCompleted}>Show more</button>
  </section>
) }));
vi.mock("./components/TaskDetail", () => ({ TaskDetail: () => null }));
vi.mock("@tabler/icons-react", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  const Icon = (props: Record<string, unknown>) => createElement("svg", props);
  return {
    IconArrowLeft: Icon,
    IconSettings: Icon,
    IconAlertTriangle: Icon,
    IconCircleFilled: Icon,
    IconMoon: Icon,
    IconSun: Icon,
  };
});
vi.mock("@mantine/core", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  const primitive = (tag: string) => ({
    align: _align,
    c: _color,
    children,
    component,
    fw: _fontWeight,
    gap: _gap,
    justify: _justify,
    mb: _marginBottom,
    mt: _marginTop,
    p: _padding,
    pb: _paddingBottom,
    radius: _radius,
    size: _size,
    ta: _textAlign,
    tt: _textTransform,
    withBorder: _withBorder,
    wrap: _wrap,
    ...props
  }: Record<string, unknown> & { children?: ReactNode; component?: ElementType }) => (
    createElement(component ?? tag, props, children)
  );
  const AppShell = Object.assign(primitive("div"), { Main: primitive("main") });
  const Select = ({
    "aria-label": ariaLabel,
    data,
    label,
    onChange,
    value,
  }: {
    "aria-label": string;
    data: Array<string | { label: string; value: string }>;
    label: string;
    onChange: (value: string | null) => void;
    value: string;
  }) => {
    const options = data.map((item) => typeof item === "string"
      ? { label: item, value: item }
      : item);
    const selected = options.find((item) => item.value === value)?.label ?? value;
    return createElement("label", null, label, createElement(
      "select",
      {
        "aria-label": ariaLabel,
        onChange: (event: { currentTarget: { value: string } }) => {
          const next = options.find((item) => item.label === event.currentTarget.value);
          onChange(next?.value ?? null);
        },
        value: selected,
      },
      options.map((item) => createElement("option", { key: item.value, value: item.label }, item.label)),
    ));
  };
  const SegmentedControl = ({
    "aria-label": ariaLabel,
    data,
    onChange,
    value,
  }: {
    "aria-label": string;
    data: Array<{ label: string; value: string }>;
    onChange: (value: string) => void;
    value: string;
  }) => createElement(
    "div",
    { "aria-label": ariaLabel, role: "radiogroup" },
    data.map((item) => createElement(
      "label",
      { key: item.value },
      createElement("input", {
        checked: item.value === value,
        name: ariaLabel,
        onChange: () => onChange(item.value),
        type: "radio",
      }),
      item.label,
    )),
  );
  return {
    ActionIcon: primitive("button"),
    Alert: primitive("div"),
    AppShell,
    Box: primitive("div"),
    Button: primitive("button"),
    CloseButton: primitive("button"),
    Container: primitive("div"),
    Group: primitive("div"),
    MantineProvider: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Paper: primitive("div"),
    SegmentedControl,
    Select,
    Stack: primitive("div"),
    Text: primitive("p"),
    Title: primitive("h1"),
    Tooltip: primitive("div"),
    createTheme: (theme: unknown) => theme,
    useComputedColorScheme: () => "light",
    useMantineColorScheme: () => ({ setColorScheme: vi.fn() }),
  };
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.innerWidth = 1024;
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
      initialFilters={{ project: "Another project", status: "completed" }}
      initialTasks={tasks}
    />,
  );
  const headerActions = document.querySelector<HTMLElement>(".taskchef-header-actions")!;
  const headerIconRow = within(headerActions).getByRole("link", { name: "Settings" }).parentElement?.parentElement;
  expect(headerActions.firstElementChild).toBe(within(headerActions).getByRole("status"));
  expect(headerActions.lastElementChild).toHaveClass("taskchef-header-icon-row");
  expect(headerIconRow).toBe(headerActions.lastElementChild);
  expect(within(headerActions).getByRole("link", { name: "Settings" })).toHaveClass("taskchef-icon-button");
  expect(within(headerActions).getByRole("button", { name: "Use dark theme" })).toHaveClass("taskchef-icon-button");
  const projectFilter = screen.getByRole("combobox", { name: "Project" });
  const viewSwitch = screen.getByRole("radiogroup", { name: "View" });
  const toolbar = document.querySelector<HTMLElement>(".taskchef-toolbar");
  const summary = document.querySelector<HTMLElement>(".taskchef-results-summary");
  const taskList = screen.getByRole("region", { name: "Tasks" });

  expect(projectFilter).toHaveValue("Another project");
  expect(screen.getByRole("combobox", { name: "Updated" })).toHaveValue("All time");
  expect(toolbar?.firstElementChild?.firstElementChild).toContainElement(viewSwitch);
  expect(viewSwitch.compareDocumentPosition(projectFilter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

test("Board ignores the List status filter and restores it on return", () => {
  window.innerWidth = 1280;
  const tasks = [
    fixtureTask({ id: "one", title: "Working task" }),
    fixtureTask({ id: "two", title: "Completed task", status: "completed" }),
  ];
  render(<DashboardApp connect={false} initialFilters={{ status: "completed" }} initialTasks={tasks} />);
  expect(screen.getByRole("radio", { name: /Completed/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  const toolbar = document.querySelector<HTMLElement>(".taskchef-toolbar");
  expect(toolbar?.firstElementChild?.firstElementChild).toContainElement(screen.getByRole("radiogroup", { name: "View" }));
  expect(screen.getByRole("radiogroup", { name: "View" }).compareDocumentPosition(screen.getByRole("combobox", { name: "Project" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Status" })).not.toBeInTheDocument();
  expect(screen.queryByText("Tasks: 1 of 2")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Task board" })).toHaveTextContent("Working task");
  expect(screen.getByRole("region", { name: "Task board" })).toHaveTextContent("Completed task");
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.getByRole("radio", { name: /Completed/ })).toBeChecked();
  expect(screen.getByText("Tasks: 1 of 2")).toBeInTheDocument();
});

test("Board preference and view switch remain available across screen widths", () => {
  window.innerWidth = 1280;
  const { unmount } = render(<DashboardApp connect={false} />);
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(window.localStorage.getItem("taskchef.dashboard.view")).toBe("board");
  expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
  act(() => { window.innerWidth = 375; window.dispatchEvent(new Event("resize")); });
  expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  act(() => { window.innerWidth = 1200; window.dispatchEvent(new Event("resize")); });
  expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
  unmount();
  window.innerWidth = 375;
  render(<DashboardApp connect={false} />);
  expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
});

test("storage failure keeps the selected view in memory", () => {
  window.innerWidth = 1280;
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<DashboardApp connect={false} />);
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
  setItem.mockRestore();
});

test("completed expansion survives view changes and resets for project", () => {
  window.innerWidth = 1280;
  render(<DashboardApp connect={false} initialTasks={[fixtureTask({ project: { name: "Project A", path: "/tmp/a", githubRepos: [] } })]} />);
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  const board = screen.getByRole("region", { name: "Task board" });
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(board).toHaveAttribute("data-completed-limit", "10");
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(screen.getByRole("region", { name: "Task board" })).toHaveAttribute("data-completed-limit", "10");
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "Project A" } });
  expect(screen.getByRole("region", { name: "Task board" })).toHaveAttribute("data-completed-limit", "5");
});

test("Updated filters both views and List counts, and resets completed expansion", () => {
  const recent = new Date().toISOString();
  const tasks = [
    fixtureTask({ id: "recent", title: "Recent task", status: "completed", updatedAt: recent, meaningfulUpdatedAt: recent }),
    fixtureTask({ id: "old", title: "Older task", status: "completed", updatedAt: "2020-01-01T00:00:00.000Z", meaningfulUpdatedAt: "2020-01-01T00:00:00.000Z" }),
  ];
  render(<DashboardApp connect={false} initialTasks={tasks} />);
  const updated = screen.getByRole("combobox", { name: "Updated" });
  expect(updated).toHaveValue("All time");
  expect(screen.getByText("Tasks: 2 of 2")).toBeInTheDocument();
  fireEvent.change(updated, { target: { value: "Latest 24 hours" } });
  expect(screen.getByText("Tasks: 1 of 2")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Completed 1" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(screen.getByRole("region", { name: "Task board" })).toHaveTextContent("Recent task");
  expect(screen.getByRole("region", { name: "Task board" })).not.toHaveTextContent("Older task");
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(screen.getByRole("region", { name: "Task board" })).toHaveAttribute("data-completed-limit", "10");
  fireEvent.change(updated, { target: { value: "Latest 7 days" } });
  expect(screen.getByRole("region", { name: "Task board" })).toHaveAttribute("data-completed-limit", "5");
  fireEvent.change(updated, { target: { value: "All time" } });
  expect(screen.getByRole("region", { name: "Task board" })).toHaveTextContent("Older task");
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.getByText("Tasks: 2 of 2")).toBeInTheDocument();
});

test("old tasks remain available in List and Board", () => {
  const oldTask = fixtureTask({ id: "old", title: "Older task", updatedAt: "2020-01-01T00:00:00.000Z", meaningfulUpdatedAt: "2020-01-01T00:00:00.000Z" });
  render(<DashboardApp connect={false} initialTasks={[oldTask]} />);
  expect(screen.getByText("Tasks: 1 of 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Board" }));
  expect(screen.getByRole("region", { name: "Task board" })).toHaveTextContent("Older task");
});
