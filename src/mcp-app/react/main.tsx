import { App } from "@modelcontextprotocol/ext-apps";
import { ActionIcon, Alert, Box, Button, Group, MantineProvider, Paper, SegmentedControl, Select, Stack, Text, Title } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardSnapshot, Task } from "../../dashboard/react/types";
import { filterTasks, statusFilterCounts, STATUS_FILTERS, taskStatusLabel } from "../../dashboard/state.js";
import { TaskBoard } from "../../dashboard/react/components/TaskBoard";
import { TaskCard } from "../../dashboard/react/components/TaskCard";
import { TaskDetail } from "../../dashboard/react/components/TaskDetail";
import { RelativeTimeProvider } from "../../dashboard/react/components/RelativeTime";
import brandIcon from "../../../assets/taskchef-dark.svg";
import "@mantine/core/styles.css";
import "../../dashboard/react/styles.css";
import "./styles.css";

const bridge = new App({ name: "TaskChef Next", version: "1.0.0" });
const connected = bridge.connect();

function logLifecycle(event: string, displayMode = bridge.getHostContext?.()?.displayMode ?? "unknown") {
  console.warn(`[TaskChef] TaskChef Next lifecycle: ${event} ${JSON.stringify({ visibility: document.visibilityState, displayMode })}`);
}

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

interface ScanStats { source?: "database"; mode: string; checkedAt: string; error?: string; intervalSeconds?: number; fullIntervalSeconds?: number; indexedFiles?: number; activeFiles?: number | null; archivedFiles?: number | null; parsedFiles?: number | null; visibleFiles?: number; unreadFiles?: number; errors?: number; }

export function TaskChefApp() {
  const [displayMode, setDisplayMode] = useState(bridge.getHostContext?.()?.displayMode ?? "unknown");
  const [visibility, setVisibility] = useState(document.visibilityState);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scan, setScan] = useState<ScanStats | null>(null);
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
  const revisionRef = useRef<number | null>(null);
  const displayModeRef = useRef(displayMode);
  const previousDisplayMode = useRef(displayMode);
  displayModeRef.current = displayMode;
  const refresh = useCallback(async (force = false) => {
    const version = ++refreshVersion.current;
    const initialSelection = selectionVersion.current;
    const data = await call<{ snapshot: DashboardSnapshot & { revision: number; scan: ScanStats }; unchanged?: never; scan?: never } | { unchanged: true; revision: number; scan: ScanStats; snapshot?: never }>(
      "taskchef_app_snapshot", { ...(revisionRef.current === null ? {} : { revision: revisionRef.current }), ...(force ? { force: true } : {}) },
    );
    if (version !== refreshVersion.current) return;
    if (data.snapshot) {
      revisionRef.current = data.snapshot.revision;
      setTasks(data.snapshot.healthy === false ? [] : data.snapshot.tasks);
      setScan(data.snapshot.scan);
      setError(data.snapshot.healthy === false ? data.snapshot.scan.error?.startsWith("TaskChef Next requires Node.js")
        ? data.snapshot.scan.error
        : "TaskChef Next cannot read the Codex databases. Check that state_5.sqlite and thread_history_1.sqlite are available and compatible, then refresh." : null);
      if (data.snapshot.healthy === false) {
        selectedRef.current = null;
        selectionVersion.current += 1;
        setSelected(null);
        setOpened(false);
        setDetailError(null);
        return;
      }
    } else { setScan(data.scan); setError(null); }
    setNow(Date.now());
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
    if (data.snapshot && data.snapshot.healthy !== false && !data.snapshot.tasks.some((task) => task.id === selectedTask.id)) {
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
    logLifecycle("mounted");
    const onVisibility = () => {
      const next = document.visibilityState;
      logLifecycle("visibilitychange");
      setVisibility(next);
      if (next === "visible" && displayModeRef.current !== "inline") void refresh(true).catch((cause) => { setTasks([]); setError(String(cause)); });
    };
    const onPageHide = () => {
      logLifecycle("pagehide");
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    bridge.onhostcontextchanged = (context) => {
      const next = context.displayMode ?? bridge.getHostContext?.()?.displayMode ?? "unknown";
      logLifecycle("host context changed", next);
      setDisplayMode(next);
    };
    bridge.onteardown = () => {
      logLifecycle("host teardown");
      return {};
    };
    void connected.then(() => setDisplayMode(bridge.getHostContext?.()?.displayMode ?? "unknown"));
    void refresh().catch((cause) => { setTasks([]); setError(String(cause)); });
    return () => {
      logLifecycle("unmounted");
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [refresh]);
  useEffect(() => {
    if (previousDisplayMode.current === "inline" && displayMode !== "inline" && document.visibilityState === "visible") {
      void refresh(true).catch((cause) => { setTasks([]); setError(String(cause)); });
    }
    previousDisplayMode.current = displayMode;
    if (displayMode === "inline") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh().catch((cause) => { setTasks([]); setError(String(cause)); });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [displayMode, refresh]);
  const projects = useMemo(() => [
    { label: "All projects", value: "" },
    ...[...new Map(tasks.map((task) => [task.project.path || task.project.name, task.project])).values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      .map((item, _, items) => ({
        label: items.some((other) => other !== item && other.name === item.name) ? `${item.name} (${item.path})` : item.name,
        value: item.path || item.name,
      })),
  ], [tasks]);
  const projectTasks = useMemo(() => tasks.filter((task) => !project || (task.project.path || task.project.name) === project), [tasks, project]);
  const visible: Task[] = useMemo(() => filterTasks(projectTasks, { date, status, now }), [projectTasks, date, status, now]);
  const boardTasks: Task[] = useMemo(() => filterTasks(projectTasks, { date, now }), [projectTasks, date, now]);
  const counts = useMemo(() => statusFilterCounts(projectTasks, { date, now }), [projectTasks, date, now]);
  const sidebarCounts: Record<string, number> = { ...counts, unresolved: boardTasks.filter((task) => taskStatusLabel(task) === "unresolved").length };
  const statusOptions = [...STATUS_FILTERS, { label: "Unresolved", value: "unresolved" }].map(({ label, value }: { label: string; value: string }) => ({
    label: sidebarCounts[value] > 0 ? `${label} ${sidebarCounts[value]}` : label,
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
      <Box className={`taskchef-app-shell${displayMode === "inline" ? " taskchef-app-inline" : ""}`}>
        <header className="taskchef-app-header">
          <Group gap="xs" wrap="nowrap"><img alt="" aria-hidden className="taskchef-app-mark" src={brandIcon} /><Title order={1}>TaskChef Next</Title></Group>
          <ActionIcon aria-label="Refresh" onClick={() => void refresh(true).catch((cause) => setError(String(cause)))} variant="subtle"><IconRefresh size={17} /></ActionIcon>
        </header>
        <Text className="taskchef-app-diagnostics" size="xs">View: {displayMode} · document: {visibility}</Text>
        {displayMode === "inline" ? <main className="taskchef-inline-main">
          {error ? <Alert color="red" role="alert">{error}</Alert> : <>
            <Text size="sm">{tasks.length} recent top-level chats</Text>
            <Stack gap="xs" mt="xs">
              {tasks.slice(0, 3).map((task) => <Button key={task.id} onClick={() => void openChat(task)} variant="subtle">{task.title}</Button>)}
            </Stack>
          </>}
        </main> : <>
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
          {scan && <Paper className="taskchef-scan-info" p="xs" withBorder><Text size="xs">Read-only database · {scan.mode} · checked {new Date(scan.checkedAt).toLocaleTimeString()}{scan.intervalSeconds != null ? ` · checks every ${scan.intervalSeconds}s when document is visible` : ""}</Text>{scan.indexedFiles != null && <Text c="dimmed" size="xs">{scan.visibleFiles} shown of {scan.indexedFiles} top-level chats; {scan.unreadFiles} outside recent limit.</Text>}<Text c="dimmed" size="xs">Data: chat ID, title (may contain user text), timestamps, project directory, archive flag, direct child count, latest turn status. Latest turn status does not establish task outcome.</Text></Paper>}
          {view === "list" && <Text aria-live="polite" className="taskchef-results-summary" id="task-results-summary">Tasks: {visible.length} of {tasks.length}</Text>}
          {error && <Alert color="red" role="alert" mt="sm">{error}</Alert>}
          {notice && !opened && <Alert color="teal" role="status" mt="sm">{notice}</Alert>}
          {!error && (view === "board" ? <TaskBoard completedLimit={completedLimit} onMoreCompleted={() => setCompletedLimit((limit) => limit + 5)} onOpenCodex={(task) => void openChat(task)} onOpenDetail={(task) => void select(task)} tasks={boardTasks} />
            : <Stack aria-describedby="task-results-summary" aria-label="Tasks" className="taskchef-list" component="section" gap="sm" mt="xs">
              {visible.map((task) => <TaskCard key={task.id} onOpenCodex={(item) => void openChat(item)} onOpenDetail={(item) => void select(item)} task={task} />)}
              {visible.length === 0 && <Paper className="taskchef-empty" p="lg" ta="center" withBorder><Title order={2} size="h5">No tasks match these filters</Title><Text c="dimmed" size="sm">Choose a different project, update window, or status.</Text></Paper>}
            </Stack>)}
        </main>
        </>}
      </Box>
      <TaskDetail busy={busy} error={detailError} highlightTurnRef={null} onClose={closeDetail} onCopy={() => {
        if (!selected) return;
        void navigator.clipboard.writeText(selected.id).then(() => setNotice("Task ID copied."), () => setNotice("Clipboard unavailable. Copy the ID from metadata."));
      }} onOpenCodex={() => selected && void openChat(selected)} onTransition={async () => ({ ok: false })} opened={opened} task={selected} notice={notice} readOnly />
    </RelativeTimeProvider>
  </MantineProvider>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<TaskChefApp />);
