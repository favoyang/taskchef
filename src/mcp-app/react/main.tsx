import { App } from "@modelcontextprotocol/ext-apps";
import { MantineProvider, Button, Group, Badge } from "@mantine/core";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Task, TaskStatus } from "../../dashboard/react/types";
import { latestTurnPresentation } from "../../dashboard/state.js";
import "@mantine/core/styles.css";
import "./styles.css";

const bridge = new App({ name: "TaskChef board", version: "1.0.0" });
const connected = bridge.connect();
const lanes: Array<{ status: TaskStatus; name: string }> = [
  { status: "working", name: "Working" },
  { status: "needs_input", name: "Needs input" },
  { status: "completed", name: "Completed" },
  { status: "failed", name: "Failed" },
  { status: null, name: "Unresolved" },
];
const knownStatuses = new Set<TaskStatus>(["working", "needs_input", "completed", "failed"]);
const laneFor = (task: Task): TaskStatus => knownStatuses.has(task.status) ? task.status : null;

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  await connected;
  const result = await bridge.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text ?? "TaskChef request failed.");
  return result.structuredContent as T;
}

export function TaskChefApp() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [pending, setPending] = useState<"completed" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedRef = useRef<Task | null>(null);
  const selectionVersion = useRef(0);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const initialSelection = selectionVersion.current;
    const data = await call<{ snapshot: { tasks: Task[]; healthy: boolean } }>("taskchef_app_snapshot");
    if (version !== refreshVersion.current) return;
    setTasks(data.snapshot.tasks);
    if (!data.snapshot.healthy) setError("Task log is temporarily unavailable. Showing the last valid snapshot.");
    else setError(null);
    const selectedTask = selectedRef.current;
    if (!selectedTask || initialSelection !== selectionVersion.current) return;
    const selection = selectionVersion.current;
    const clearRemovedTask = () => {
      selectionVersion.current += 1;
      selectedRef.current = null;
      setSelected(null);
      setPending(null);
    };
    if (data.snapshot.healthy && !data.snapshot.tasks.some((task) => task.id === selectedTask.id)) {
      clearRemovedTask();
      return;
    }
    let detail: { task: Task };
    try {
      detail = await call<{ task: Task }>("taskchef_app_task", { taskId: selectedTask.id });
    } catch (cause) {
      if (version !== refreshVersion.current || selection !== selectionVersion.current) return;
      if (cause instanceof Error && cause.message === "Task not found.") {
        clearRemovedTask();
        return;
      }
      throw cause;
    }
    if (version !== refreshVersion.current || selection !== selectionVersion.current) return;
    if (selectedRef.current?.id !== detail.task.id) return;
    if (["status", "turnRef", "threadId", "updatedAt"].some((key) => selectedRef.current?.[key as keyof Task] !== detail.task[key as keyof Task])) setPending(null);
    selectedRef.current = detail.task;
    setSelected(detail.task);
  }, []);
  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
    const timer = window.setInterval(() => { void refresh().catch((cause) => setError(String(cause))); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  async function select(task: Task) {
    const selection = ++selectionVersion.current;
    selectedRef.current = task;
    setPending(null);
    setNotice(null);
    setError(null);
    try {
      const result = await call<{ task: Task }>("taskchef_app_task", { taskId: task.id });
      if (selection !== selectionVersion.current) return;
      selectedRef.current = result.task;
      setSelected(result.task);
    } catch (cause) {
      if (selection === selectionVersion.current) {
        selectedRef.current = null;
        setError(String(cause));
      }
    }
  }
  async function openChat() {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await call<{ message: string }>("taskchef_app_open_chat", { taskId: selected.id });
      setNotice(result.message);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!selected || !pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ task: Task }>("taskchef_app_transition", {
        taskId: selected.id,
        actionId: crypto.randomUUID(),
        expected: { status: selected.status, turnRef: selected.turnRef, threadId: selected.threadId, updatedAt: selected.updatedAt },
        targetStatus: pending,
      });
      if (selectedRef.current?.id === result.task.id) {
        selectedRef.current = result.task;
        setSelected(result.task);
      }
      setPending(null);
      setNotice(`Marked ${result.task.status}.`);
      await refresh();
    } catch (cause) {
      setPending(null);
      try { await refresh(); } catch { /* Keep the transition error visible. */ }
      setError(`${String(cause)} The task has been refreshed; review its current state before trying again.`);
    } finally { setBusy(false); }
  }
  return <main>
    <header className="topbar"><div><h1>TaskChef</h1><p>Task board</p></div><Button onClick={() => void refresh().catch((cause) => setError(String(cause)))} size="compact-xs" variant="subtle">Refresh</Button></header>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {selected ? <section className="detail" aria-label="Task detail">
      <Button onClick={() => { selectionVersion.current += 1; selectedRef.current = null; setSelected(null); setPending(null); }} size="compact-xs" variant="subtle">← Board</Button>
      <p className="eyebrow">{selected.project.name}</p><h2>{selected.title}</h2><Badge color={selected.status === "failed" ? "red" : selected.status === "completed" ? "teal" : selected.status === "needs_input" ? "yellow" : "blue"}>{selected.status?.replace("_", " ") ?? "Unresolved"}</Badge>
      <Group mt="md" gap="xs"><Button disabled={busy} onClick={() => void openChat()} size="compact-sm" variant="default">Open chat ↗</Button>
      {selected.status && (["completed", "failed"] as const).filter((status) => status !== selected.status).map((status) => <Button disabled={busy} key={status} onClick={() => setPending(status)} size="compact-sm" variant="light" color={status === "failed" ? "red" : "teal"}>Mark {status}</Button>)}</Group>
      {pending && <div className="confirm" role="alert"><strong>Mark task {pending}?</strong><p>This interrupts active work and appends an audited manual dashboard turn.</p><Group gap="xs"><Button loading={busy} onClick={() => void confirm()} size="compact-sm" color={pending === "failed" ? "red" : "teal"}>Confirm</Button><Button disabled={busy} onClick={() => setPending(null)} size="compact-sm" variant="default">Cancel</Button></Group></div>}
      <section><h3>Latest activity</h3><p className="preserve">{selected.status === "working" ? latestTurnPresentation(selected).requestSummary : latestTurnPresentation(selected).resultSummary}</p></section>
      {Boolean(selected.turns?.length) && <section><h3>Turn history</h3><ol className="turns">{selected.turns?.slice().reverse().map((turn, index) => <li key={`${turn.turnRef ?? turn.startedAt}-${index}`}><small>{new Date(turn.startedAt).toLocaleString()}</small><p className="preserve">{turn.requestSummary ?? "Request not recorded"}</p>{turn.result && <p className="preserve"><strong>{turn.result.status.replace("_", " ")}: </strong>{turn.result.summary}</p>}</li>)}</ol></section>}
      <section><h3>Original instruction</h3><pre>{selected.instruction}</pre></section>
      <section><h3>Task details</h3><dl><dt>Task ID</dt><dd>{selected.id}</dd><dt>Thread ID</dt><dd>{selected.threadId ?? "Pending"}</dd><dt>Updated</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></dl></section>
    </section> : <div className="board">{lanes.filter((lane) => lane.status !== null || tasks.some((task) => laneFor(task) === null)).map((lane) => {
      const matching = tasks.filter((task) => laneFor(task) === lane.status);
      return <section key={lane.name} className="lane"><div className="lane-head"><h2>{lane.name}</h2><span>{matching.length}</span></div>
        {matching.length ? matching.map((task) => <button className="card" key={task.id} onClick={() => void select(task)}><strong>{task.title}</strong><small>{task.project.name} · {new Date(task.meaningfulUpdatedAt ?? task.updatedAt).toLocaleDateString()}</small><span>{task.status === "working" ? latestTurnPresentation(task).requestSummary : latestTurnPresentation(task).resultSummary}</span></button>) : <p className="empty">No tasks</p>}</section>;
    })}</div>}
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<MantineProvider forceColorScheme="dark"><TaskChefApp /></MantineProvider>);
