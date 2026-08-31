import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import type { NotificationSnapshot } from "../types";
import { NotificationCenter } from "./NotificationCenter";

const notification: NotificationSnapshot = {
  id: "task-completed",
  taskId: "11111111-1111-4111-8111-111111111111",
  title: "Review checkout reconciliation",
  status: "completed",
  event: "completed",
  turnRef: "turn-one",
  turnId: null,
  timestamp: "2026-08-30T08:10:00.000Z",
  summary: "Review completed.",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("notification portal stays non-modal until the operator chooses an action", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-30T12:10:00.000Z"));
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  render(
    <MantineProvider>
      <button autoFocus type="button">Detail action</button>
      <NotificationCenter
        notifications={[notification]}
        onClear={() => {}}
        onDismiss={onDismiss}
        onOpen={onOpen}
        tasks={[fixtureTask()]}
      />
    </MantineProvider>,
  );
  expect(screen.getByRole("button", { name: "Detail action" })).toHaveFocus();
  const panel = screen.getByRole("region", { name: "Task notifications" });
  expect(panel).toBeVisible();
  expect(panel.querySelector(".taskchef-notification-list")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Open current task details/ })).toHaveAccessibleDescription(
    /Review completed\. \d+ hours ago/,
  );
  expect(panel.nextElementSibling).toHaveTextContent(
    /Task completed\. Review checkout reconciliation\. Review completed\. Turn ref turn-one\. \d+ hours ago\./,
  );
  fireEvent.click(screen.getByRole("button", { name: /Open current task details/ }));
  expect(onOpen).toHaveBeenCalledWith(notification);
  fireEvent.click(screen.getByRole("button", { name: /Dismiss Task completed notification/ }));
  expect(onDismiss).toHaveBeenCalledWith(notification);
});

test("can render inside a focus-trapped task detail", () => {
  render(
    <MantineProvider>
      <div data-testid="detail-dialog">
        <NotificationCenter
          notifications={[notification]}
          onClear={() => {}}
          onDismiss={() => {}}
          onOpen={() => {}}
          tasks={[fixtureTask()]}
          withinPortal={false}
        />
      </div>
    </MantineProvider>,
  );
  expect(screen.getByTestId("detail-dialog")).toContainElement(
    screen.getByRole("region", { name: "Task notifications" }),
  );
});
