import { App } from "@modelcontextprotocol/ext-apps";
import { ActionIcon, Alert, Box, Button, Group, MantineProvider, Paper, SegmentedControl, Select, Stack, Text, Title } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardSnapshot, Task } from "../../dashboard/react/types";
import { filterTasks, manualTransitionExpectedState, statusFilterCounts, STATUS_FILTERS, taskMatchesManualTransitionExpected } from "../../dashboard/state.js";
import { TaskBoard } from "../../dashboard/react/components/TaskBoard";
import { TaskCard } from "../../dashboard/react/components/TaskCard";
import { TaskDetail } from "../../dashboard/react/components/TaskDetail";
import { RelativeTimeProvider } from "../../dashboard/react/components/RelativeTime";
import brandIcon from "../../../assets/taskchef-dark.svg";
import "@mantine/core/styles.css";
import "../../dashboard/react/styles.css";
import "./styles.css";

const bridge = new App({ name: "TaskChef board", version: "1.0.0" });
const connected = bridge.connect();

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  await connected;
  const result = await bridge.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text ?? "TaskChef request failed.");
  return result.structuredContent as T;
}

const VIEW_KEY = "taskchef.app.view";
function initialView(): "board" | "list" {
  try { return window.localStorage.getItem(VIEW_KEY) === "board" ? "board" : "list"; }
  catch { return "list"; }
}

export function TaskChefApp() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [date, setDate] = useState("all");
  const [status, setStatus] = useState("");
  const [view, setView] = useState(initialView);
  const [completedLimit, setCompletedLimit] = useState(5);
  const [now, setNow] = useState(() => Date.now());
  const selectedRef = useRef<Task | null>(null);
  const selectionVersion = useRef(0);
  const detailRequestVersion = useRef(0);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const initialSelection = selectionVersion.current;
    const data = await call<{ snapshot: DashboardSnapshot }>("taskchef_app_snapshot");
    if (version !== refreshVersion.current) return;
    setTasks(data.snapshot.tasks);
    setNow(Date.now());
    setError(data.snapshot.healthy === false ? "Task log is temporarily unavailable. Showing the last valid snapshot." : null);
    const selectedTask = selectedRef.current;
    if (!selectedTask || initialSelection !== selectionVersion.current) return;
    const selection = selectionVersion.current;
    const clearRemovedTask = () => {
      selectionVersion.current += 1;
      selectedRef.current = null;
      setSelected(null);
      setOpened(false);
      setDetailError(null);
    };
    if (data.snapshot.healthy !== false && !data.snapshot.tasks.some((task) => task.id === selectedTask.id)) {
      clearRemovedTask();
      return;
    }
    const detailRequest = ++detailRequestVersion.current;
    try {
      const detail = await call<{ task: Task }>("taskchef_app_task", { taskId: selectedTask.id });
      if (version !== refreshVersion.current || selection !== selectionVersion.current || detailRequest !== detailRequestVersion.current || selectedRef.current?.id !== detail.task.id) return;
      selectedRef.current = detail.task;
      setSelected(detail.task);
      setDetailError(null);
    } catch (cause) {
      if (version !== refreshVersion.current || selection !== selectionVersion.current || detailRequest !== detailRequestVersion.current) return;
      if (cause instanceof Error && cause.message === "Task not found.") clearRemovedTask();
      else setDetailError(String(cause));
    }
  }, []);
  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
    const timer = window.setInterval(() => { void refresh().catch((cause) => setError(String(cause))); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const projects = useMemo(() => [
    { label: "All projects", value: "" },
    ...[...new Set(tasks.map((task) => task.project.name))].sort().map((value) => ({ label: value, value })),
  ], [tasks]);
  const visible: Task[] = useMemo(() => filterTasks(tasks, { project, date, status, now }), [tasks, project, date, status, now]);
  const boardTasks: Task[] = useMemo(() => filterTasks(tasks, { project, date, now }), [tasks, project, date, now]);
  const counts = useMemo(() => statusFilterCounts(tasks, { project, date, now }), [tasks, project, date, now]);
  const statusOptions = STATUS_FILTERS.map(({ label, value }: { label: string; value: string }) => ({
    label: counts[value] > 0 ? `${label} ${counts[value]}` : label,
    value,
  }));

  function changeView(value: string) {
    if (value !== "board" && value !== "list") return;
    setView(value);
    try { window.localStorage.setItem(VIEW_KEY, value); } catch { /* Keep the selection in memory. */ }
  }
  async function select(task: Task) {
    const selection = ++selectionVersion.current;
    const detailRequest = ++detailRequestVersion.current;
    selectedRef.current = task;
    setSelected(task);
    setOpened(true);
    setDetailError(null);
    setNotice(null);
    try {
      const result = await call<{ task: Task }>("taskchef_app_task", { taskId: task.id });
      if (selection !== selectionVersion.current || detailRequest !== detailRequestVersion.current) return;
      selectedRef.current = result.task;
      setSelected(result.task);
    } catch (cause) {
      if (selection === selectionVersion.current && detailRequest === detailRequestVersion.current) setDetailError(String(cause));
    }
  }
  async function openChat(task: Task) {
    setBusy(true);
    try {
      const result = await call<{ message: string }>("taskchef_app_open_chat", { taskId: task.id });
      setNotice(result.message);
    } catch (cause) {
      if (selectedRef.current?.id === task.id) setDetailError(String(cause));
      else setError(String(cause));
    }
    finally { setBusy(false); }
  }
  async function transition(targetStatus: "completed" | "failed", actionId: string) {
    const requestTask = selectedRef.current;
    if (!requestTask) return { ok: false };
    const selection = selectionVersion.current;
    const expected = manualTransitionExpectedState(requestTask);
    setBusy(true);
    setDetailError(null);
    try {
      const result = await call<{ task: Task }>("taskchef_app_transition", {
        taskId: requestTask.id, actionId,
        expected, targetStatus,
      });
      if (selection === selectionVersion.current && taskMatchesManualTransitionExpected(selectedRef.current, expected)) {
        selectedRef.current = result.task;
        setSelected(result.task);
      }
      setTasks((current) => current.map((task) => task.id === result.task.id && taskMatchesManualTransitionExpected(task, expected) ? { ...task, ...result.task } : task));
      setNotice(`Marked ${result.task.status?.replace("_", " ")}.`);
      void refresh().catch((cause) => setError(String(cause)));
      return { ok: true };
    } catch (cause) {
      await refresh().catch(() => {});
      setDetailError(`${String(cause)} The task has been refreshed; review its current state before trying again.`);
      return { ok: false, rotateActionId: true };
    } finally { setBusy(false); }
  }
  function closeDetail() {
    if (busy) return;
    selectionVersion.current += 1;
    selectedRef.current = null;
    setOpened(false);
    setSelected(null);
    setDetailError(null);
  }
  return <MantineProvider forceColorScheme="dark">
    <RelativeTimeProvider now={now}>
      <Box className="taskchef-app-shell">
        <header className="taskchef-app-header">
          <Group gap="xs" wrap="nowrap"><img alt="" aria-hidden className="taskchef-app-mark" src={brandIcon} /><Title order={1}>TaskChef <span>Dashboard</span></Title></Group>
          <ActionIcon aria-label="Refresh" onClick={() => void refresh().catch((cause) => setError(String(cause)))} variant="subtle"><IconRefresh size={17} /></ActionIcon>
        </header>
        <main className={`taskchef-app-main${view === "list" ? " taskchef-app-main-list" : ""}`}>
          <Paper className="taskchef-toolbar" radius={0}>
            <Stack gap="sm">
              <SegmentedControl aria-label="View" className="taskchef-app-view" data={[{ label: "Board", value: "board" }, { label: "List", value: "list" }]} onChange={changeView} size="xs" value={view} withItemsBorders={false} />
              <Group className="taskchef-app-filters" gap="xs" wrap="nowrap">
                <Select aria-label="Project" data={projects} onChange={(value) => { setProject(value ?? ""); setCompletedLimit(5); }} value={project} size="xs" />
                <Select aria-label="Updated" data={[{ label: "Latest 24 hours", value: "24h" }, { label: "Latest 7 days", value: "7d" }, { label: "All time", value: "all" }]} onChange={(value) => { setDate(value ?? "all"); setCompletedLimit(5); }} value={date} size="xs" />
              </Group>
              {view === "list" && <Box className="taskchef-app-status"><SegmentedControl aria-label="Status" data={statusOptions} onChange={setStatus} size="xs" value={status} withItemsBorders={false} /></Box>}
            </Stack>
          </Paper>
          {view === "list" && <Text aria-live="polite" className="taskchef-results-summary" id="task-results-summary">Tasks: {visible.length} of {tasks.length}</Text>}
          {error && <Alert color="yellow" role="alert" mt="sm">{error}</Alert>}
          {notice && !opened && <Alert color="teal" role="status" mt="sm">{notice}</Alert>}
          {view === "board" ? <TaskBoard completedLimit={completedLimit} onMoreCompleted={() => setCompletedLimit((limit) => limit + 5)} onOpenCodex={(task) => void openChat(task)} onOpenDetail={(task) => void select(task)} tasks={boardTasks} />
            : <Stack aria-describedby="task-results-summary" aria-label="Tasks" className="taskchef-list" component="section" gap="sm" mt="xs">
              {visible.map((task) => <TaskCard key={task.id} onOpenCodex={(item) => void openChat(item)} onOpenDetail={(item) => void select(item)} task={task} />)}
              {visible.length === 0 && <Paper className="taskchef-empty" p="lg" ta="center" withBorder><Title order={2} size="h5">No tasks match these filters</Title><Text c="dimmed" size="sm">Choose a different project, update window, or status.</Text></Paper>}
            </Stack>}
        </main>
      </Box>
      <TaskDetail busy={busy} error={detailError} highlightTurnRef={null} onClose={closeDetail} onCopy={() => {
        if (!selected) return;
        void navigator.clipboard.writeText(selected.id).then(() => setNotice("Task ID copied."), () => setNotice("Clipboard unavailable. Copy the ID from metadata."));
      }} onOpenCodex={() => selected && void openChat(selected)} onTransition={transition} opened={opened} task={selected} notice={notice} />
    </RelativeTimeProvider>
  </MantineProvider>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<TaskChefApp />);
