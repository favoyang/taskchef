import type { NotificationSnapshot, Task } from "./types";

export interface OverlayState {
  detailTaskId: string | null;
  detailOpened: boolean;
  highlightTurnRef: string | null;
  notifications: NotificationSnapshot[];
  refreshGeneration: number;
}

export function notificationAppeared(
  state: OverlayState,
  notifications: NotificationSnapshot[],
): OverlayState {
  // Visibility changes only; focus remains where the operator left it.
  return { ...state, notifications };
}

export function notificationClicked(
  state: OverlayState,
  notification: NotificationSnapshot,
  taskAvailable: boolean,
): OverlayState {
  const notifications = state.notifications.filter(({ id }) => id !== notification.id);
  if (!taskAvailable) return { ...state, notifications };
  return {
    ...state,
    detailTaskId: notification.taskId,
    detailOpened: true,
    highlightTurnRef: notification.turnRef ?? notification.turnId,
    notifications,
    refreshGeneration: state.refreshGeneration + 1,
  };
}

export function clearNotificationHistory(state: OverlayState): OverlayState {
  return { ...state, notifications: [] };
}

export function mergeListTaskIntoDetail(current: Task, updated: Task): Task {
  const currentIsDetail = Array.isArray(current.turns) && Array.isArray(current.results);
  const updatedIsList = !Array.isArray(updated.turns) && !Array.isArray(updated.results);
  return {
    ...current,
    ...updated,
    ...(currentIsDetail && updatedIsList
      ? { results: current.results, turns: current.turns, usage: current.usage }
      : {}),
  };
}

export function listUsageSignature(task: Task | null | undefined): string {
  return JSON.stringify([
    task?.usage?.generationTurnRef ?? null,
    task?.usage?.status ?? null,
    task?.usage?.updatedAt ?? null,
    task?.usage?.task?.totalTokens ?? null,
    task?.usage?.task?.estimatedCostUsd ?? null,
  ]);
}
