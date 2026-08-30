import type { DashboardSnapshot, ManualTransitionResponse, Task, TaskStatus } from "./types";

export interface DashboardStream {
  close(): void;
}

export function connectDashboard({
  onConnection,
  onError,
  onSnapshot,
}: {
  onConnection: (connected: boolean) => void;
  onError: (message: string) => void;
  onSnapshot: (snapshot: DashboardSnapshot) => void;
}): DashboardStream {
  const events = new EventSource("/api/events");
  events.addEventListener("open", () => onConnection(true));
  events.addEventListener("error", () => onConnection(false));
  events.addEventListener("snapshot", (event) => {
    onConnection(true);
    onSnapshot(JSON.parse((event as MessageEvent).data) as DashboardSnapshot);
  });
  events.addEventListener("dashboard-error", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { message?: string };
    onError(payload.message ?? "The task log is temporarily unavailable.");
  });
  return events;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message ?? "Request failed."), { payload });
  return payload as T;
}

export async function dashboardVersion(): Promise<string> {
  const health = await jsonRequest<{ taskchefVersion: string }>("/api/health");
  return health.taskchefVersion;
}

export async function taskDetail(taskId: string): Promise<Task> {
  return (await jsonRequest<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
}

export async function openInCodex(taskId: string): Promise<string | null> {
  const result = await jsonRequest<{ message?: string }>(
    `/api/tasks/${encodeURIComponent(taskId)}/open-codex`,
    { method: "POST" },
  );
  return result.message ?? null;
}

export async function manualTransition(
  task: Task,
  targetStatus: Exclude<TaskStatus, "working" | "needs_input" | null>,
  actionId: string,
): Promise<ManualTransitionResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const result = await jsonRequest<{ task: Task }>(
      `/api/tasks/${encodeURIComponent(task.id)}/manual-transition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          actionId,
          expected: {
            status: task.status,
            turnRef: task.turnRef,
            threadId: task.threadId,
            updatedAt: task.updatedAt,
          },
          targetStatus,
        }),
        signal: controller.signal,
      },
    );
    return { ok: true, task: result.task };
  } catch (error) {
    const payload = (error as { payload?: { code?: string; message?: string; task?: Task } }).payload;
    return {
      ok: false,
      code: payload?.code ?? (controller.signal.aborted ? "request_timeout" : "network_error"),
      message: payload?.message ?? (controller.signal.aborted
        ? "Task state change timed out. Try again."
        : "Task state changes are temporarily unavailable. Try again."),
      task: payload?.task ?? null,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}
