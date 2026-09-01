import { act, cleanup, render, screen } from "@testing-library/react";
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
vi.mock("./components/TaskDetail", () => ({ TaskDetail: () => null }));
vi.mock("@tabler/icons-react", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  const Icon = (props: Record<string, unknown>) => createElement("svg", props);
  return {
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
