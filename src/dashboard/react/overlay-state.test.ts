import { describe, expect, test } from "vitest";
import type { NotificationSnapshot } from "./types";
import {
  clearNotificationHistory,
  notificationAppeared,
  notificationClicked,
  type OverlayState,
} from "./overlay-state";

const taskUpdate: NotificationSnapshot = {
  id: "task-one-completed",
  taskId: "task-one",
  title: "Review reconciliation",
  status: "completed",
  event: "completed",
  turnRef: "turn-two",
  turnId: null,
  timestamp: "2026-08-30T08:10:00.000Z",
  summary: "Review completed.",
};
const unrelated: NotificationSnapshot = {
  ...taskUpdate,
  id: "task-two-failed",
  taskId: "task-two",
  title: "Validate fixture",
  status: "failed",
  event: "failed",
  turnRef: "turn-three",
};

function state(overrides: Partial<OverlayState> = {}): OverlayState {
  return {
    detailTaskId: null,
    detailOpened: false,
    highlightTurnRef: null,
    notifications: [],
    refreshGeneration: 0,
    ...overrides,
  };
}

describe("overlay coordination", () => {
  test("a later notification changes visibility without changing the open detail", () => {
    const open = state({ detailTaskId: "task-one", detailOpened: true });
    expect(notificationAppeared(open, [taskUpdate])).toEqual({
      ...open,
      notifications: [taskUpdate],
    });
  });

  test("clicking a notification dismisses only it and opens its detail above prior content", () => {
    const next = notificationClicked(state({ notifications: [taskUpdate, unrelated] }), taskUpdate, true);
    expect(next.detailOpened).toBe(true);
    expect(next.detailTaskId).toBe("task-one");
    expect(next.highlightTurnRef).toBe("turn-two");
    expect(next.notifications).toEqual([unrelated]);
    expect(next.refreshGeneration).toBe(1);
  });

  test("clicking an update for the already-open task refreshes and highlights without closing unrelated messages", () => {
    const current = state({
      detailTaskId: "task-one",
      detailOpened: true,
      notifications: [taskUpdate, unrelated],
      refreshGeneration: 4,
    });
    const next = notificationClicked(current, taskUpdate, true);
    expect(next.detailTaskId).toBe(current.detailTaskId);
    expect(next.detailOpened).toBe(true);
    expect(next.highlightTurnRef).toBe("turn-two");
    expect(next.refreshGeneration).toBe(5);
    expect(next.notifications).toEqual([unrelated]);
  });

  test("clearing notification history leaves detail state untouched", () => {
    const current = state({ detailTaskId: "task-one", detailOpened: true, notifications: [taskUpdate] });
    expect(clearNotificationHistory(current)).toEqual({ ...current, notifications: [] });
  });
});
