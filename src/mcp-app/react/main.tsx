import { App } from "@modelcontextprotocol/ext-apps";
import { ActionIcon, Alert, Box, Button, Group, MantineProvider, createTheme, Paper, SegmentedControl, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { IconRefresh, IconSearch, IconSettings } from "@tabler/icons-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardSnapshot, Task, Project } from "../../dashboard/react/types";
import { filterTasks } from "../../dashboard/state.js";
import { TaskBoard } from "../../dashboard/react/components/TaskBoard";
import { TaskCard } from "../../dashboard/react/components/TaskCard";
import { TaskDetail } from "../../dashboard/react/components/TaskDetail";
import { RelativeTimeProvider } from "../../dashboard/react/components/RelativeTime";
import { NextNotificationCenter, type NextNotification, type NextNotificationState } from "./NextNotificationCenter";
import { ProjectPicker } from "./ProjectPicker";
import brandIcon from "../../../assets/taskchef-dark.svg";
import "@mantine/core/styles.css";
import "../../dashboard/react/styles.css";
import "./styles.css";

const theme = createTheme({
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: { fontFamily: "inherit" },
  colors: { dark: ["#dcdcdc", "#cdcdcd", "#afafaf", "#808080", "#414141", "#353535", "#282828", "#212121", "#181818", "#131313"] },
});

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

interface VisibilitySettings { showExec: boolean; showCli: boolean; showArchived: boolean; }
function eligibleForView(task: Task, showCli: boolean, showArchived: boolean, showExec: boolean) {
  return (showExec || task.observed?.source !== "exec") && (showCli || task.observed?.source !== "cli") && (showArchived || !task.observed?.archive);
}

async function loadReplyImage(task: Task): Promise<string | null> {
  const result = await call<{ dataUrl: string | null }>("taskchef_app_image", { taskId: task.id, expectedTurnId: task.turnId, expectedUrl: task.replyImage?.url });
  return result.dataUrl;
}

const NEXT_LANES = [{ status: "scheduled", label: "Scheduled", emptyMessage: "No scheduled chats" }, { status: "working", label: "Running", emptyMessage: "No chats running" }, { status: "needs_input", label: "Waiting for input/review", emptyMessage: "No chats waiting for input or review" }, { status: "completed", label: "Done", emptyMessage: "No completed chats" }, { status: "archived", label: "Archived", emptyMessage: "No archived chats" }, { status: null, label: "Unverified", emptyMessage: "No unverified chats" }] as const;

interface ScanStats { cacheHit?: boolean; scheduleErrors?: number; source?: "database"; mode: string; checkedAt: string; error?: string; intervalSeconds?: number; fullIntervalSeconds?: number; indexedFiles?: number; activeFiles?: number | null; archivedFiles?: number | null; parsedFiles?: number | null; visibleFiles?: number; unreadFiles?: number; errors?: number; }

export function TaskChefApp() {
  const [displayMode, setDisplayMode] = useState(bridge.getHostContext?.()?.displayMode ?? "unknown");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [registeredProjects, setRegisteredProjects] = useState<Project[]>([]);
  const [{ showExec, showCli, showArchived }, setVisibility] = useState<VisibilitySettings>({ showExec: false, showCli: false, showArchived: false });
  const [scan, setScan] = useState<ScanStats | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detailError, setDetailError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NextNotificationState>({ revision: 0, items: [] });
  const [toasts, setToasts] = useState<NextNotification[]>([]);
  const notificationRevision = useRef(-1);
  const seenNotifications = useRef<Set<string> | null>(null);
  const toastTimers = useRef(new Map<string, number>());
  const dismissToast = useCallback((id: string) => {
    window.clearTimeout(toastTimers.current.get(id));
    toastTimers.current.delete(id);
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);
  const receiveNotifications = useCallback((next?: NextNotificationState) => {
    if (!next || next.revision < notificationRevision.current) return;
    notificationRevision.current = next.revision;
    setNotifications(next);
    const added = seenNotifications.current ? next.items.filter((item) => !seenNotifications.current!.has(item.id)) : [];
    seenNotifications.current = new Set(next.items.map((item) => item.id));
    if (added.length) {
      setToasts((items) => [...added, ...items].slice(0, 3));
      for (const item of added) toastTimers.current.set(item.id, window.setTimeout(() => dismissToast(item.id), 5000));
    }
  }, [dismissToast]);
  useEffect(() => () => { for (const timer of toastTimers.current.values()) window.clearTimeout(timer); }, []);
  async function notificationAction(action: "read" | "read_all" | "clear", id?: string) {
    try {
      const result = await call<{ notifications: NextNotificationState }>("taskchef_app_notifications", { action, ...(id ? { id } : {}) });
      receiveNotifications(result.notifications);
      if (action === "clear") { for (const item of toasts) dismissToast(item.id); }
    } catch (cause) { setError(String(cause)); }
  }
  async function actionError(operation: "open" | "done" | "copy" | "settings", cause: unknown, task?: Task) {
    try {
      const result = await call<{ notifications: NextNotificationState }>("taskchef_app_notifications", { action: "error", operation, error: String(cause).slice(0, 1000), ...(task ? { taskId: task.id } : {}) });
      receiveNotifications(result.notifications);
    } catch (notificationError) { setError(`${String(cause)}. ${String(notificationError)}`); }
  }
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("all");
  const [status, setStatus] = useState("");
  // Keep the list implementation for later, but expose only Board. Ignore old saved List choices.
  const [view, setView] = useState<"board" | "list">("board");
  const [completedLimit, setCompletedLimit] = useState(5);
  const [archivedLimit, setArchivedLimit] = useState(5);
  const [now, setNow] = useState(() => Date.now());
  const selectedRef = useRef<Task | null>(null);
  const selectionVersion = useRef(0);
  const notificationSelection = useRef(false);
  const detailRequestVersion = useRef(0);
  const refreshVersion = useRef(0);
  const revisionRef = useRef<number | null>(null);
  const displayModeRef = useRef(displayMode);
  const previousDisplayMode = useRef(displayMode);
  displayModeRef.current = displayMode;
  const refresh = useCallback(async (force = false) => {
    const version = ++refreshVersion.current;
    const initialSelection = selectionVersion.current;
    const data = await call<{ snapshot: DashboardSnapshot & { revision: number; scan: ScanStats; projects?: Project[] }; unchanged?: never; scan?: never; settings: VisibilitySettings; settingsUrl?: string | null; notifications?: NextNotificationState } | { unchanged: true; revision: number; scan: ScanStats; snapshot?: never; settings: VisibilitySettings; settingsUrl?: string | null; notifications?: NextNotificationState }>(
      "taskchef_app_snapshot", { ...(revisionRef.current === null ? {} : { revision: revisionRef.current }), ...(force ? { force: true } : {}) },
    );
    if (version !== refreshVersion.current) return;
    receiveNotifications(data.notifications);
    setVisibility(data.settings);
    if (data.snapshot) {
      revisionRef.current = data.snapshot.revision;
      setTasks(data.snapshot.healthy === false ? [] : data.snapshot.tasks);
      setRegisteredProjects(data.snapshot.healthy === false ? [] : data.snapshot.projects ?? []);
      setScan(data.snapshot.scan);
      setError(data.snapshot.healthy === false ? data.snapshot.scan.error?.startsWith("TaskChef Next")
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
  }, [receiveNotifications]);
  useEffect(() => {
    logLifecycle("mounted");
    const onVisibility = () => {
      const next = document.visibilityState;
      logLifecycle("visibilitychange");
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
  const eligibleTasks = useMemo(() => tasks.filter((task) => eligibleForView(task, showCli, showArchived, showExec)), [tasks, showCli, showArchived, showExec]);
  useEffect(() => {
    setProject("");
    setCompletedLimit(5);
    setArchivedLimit(5);
    if (!showArchived) setStatus((current) => current === "archived" ? "" : current);
  }, [showExec, showCli, showArchived]);
  const lanes = NEXT_LANES.filter((lane) => lane.status !== "archived" || showArchived);
  useEffect(() => {
    if (!selected || notificationSelection.current || eligibleForView(selected, showCli, showArchived, showExec)) return;
    selectionVersion.current += 1;
    selectedRef.current = null;
    setSelected(null);
    setOpened(false);
    setDetailError(null);
  }, [selected, showCli, showArchived, showExec]);
  const projects = useMemo(() => {
    const items = registeredProjects.length ? registeredProjects : [...new Map(eligibleTasks
      .filter((task) => task.project.id !== "projectless")
      .map((task) => [task.project.id || task.project.path || task.project.name, task.project])).values()];
    const recent = new Map<string, number>();
    for (const task of eligibleTasks) {
      const key = task.project.id || task.project.path || task.project.name;
      const timestamp = Date.parse(task.updatedAt);
      if (Number.isFinite(timestamp)) recent.set(key, Math.max(recent.get(key) ?? 0, timestamp));
    }
    return [
      { label: "All projects", value: "" },
      ...items.map((item) => ({ label: items.some((other) => other !== item && other.name === item.name)
        ? `${item.name} (${item.path})` : item.name, value: item.id || item.path || item.name, path: item.path, updatedAt: recent.get(item.id || item.path || item.name) })),
      { label: "No project", value: "projectless" },
    ];
  }, [eligibleTasks, registeredProjects]);
  useEffect(() => { if (project && !projects.some((item) => item.value === project)) setProject(""); }, [project, projects]);
  const projectTasks = useMemo(() => eligibleTasks.filter((task) => !project || (task.project.id || task.project.path || task.project.name) === project), [eligibleTasks, project]);
  const boardTasks: Task[] = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return filterTasks(projectTasks, { date, now }).filter((task: Task) => {
      const content = `${task.title}\n${task.replyExcerpt ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => content.includes(term));
    });
  }, [projectTasks, date, now, search]);
  const visible = useMemo(() => boardTasks.filter((task) => !status || (task.status ?? "unverified") === status), [boardTasks, status]);
  const statusOptions = [{ label: `All ${boardTasks.length}`, value: "" }, ...lanes.map(({ label, status: value }) => ({
    label: `${label} ${boardTasks.filter((task) => task.status === value).length}`, value: value ?? "unverified",
  }))];

  function changeView(value: string) {
    if (value !== "board" && value !== "list") return;
    setView(value);
    try { window.localStorage.setItem(VIEW_KEY, value); } catch { /* Keep the selection in memory. */ }
  }
  async function select(task: Task, fromNotification = false) {
    notificationSelection.current = fromNotification;
    const selection = ++selectionVersion.current;
    const detailRequest = ++detailRequestVersion.current;
    selectedRef.current = task;
    setSelected(task);
    setOpened(true);
    setDetailError(null);
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
      await call("taskchef_app_open_chat", { taskId: task.id });
    } catch (cause) {
      await actionError("open", cause, task);
    }
    finally { setBusy(false); }
  }
  async function markDone(task: Task) {
    if (!task.turnId) return;
    setBusy(true);
    try {
      const result = await call<{ task: Task; notifications?: NextNotificationState }>("taskchef_app_set_done", { taskId: task.id, expectedTurnId: task.turnId, done: true });
      if (selectedRef.current?.id === task.id) { selectedRef.current = result.task; setSelected(result.task); }
      receiveNotifications(result.notifications);
      await refresh(true).catch((cause) => { setTasks([]); setError(String(cause)); });
    } catch (cause) { await actionError("done", cause, task); }
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
  return <MantineProvider theme={theme} forceColorScheme="dark">
    <RelativeTimeProvider now={now}>
      <Box className={`taskchef-app-shell${displayMode === "inline" ? " taskchef-app-inline" : ""}`}>
        <header className="taskchef-app-header">
          <Group className="taskchef-app-brand" gap="xs" wrap="nowrap"><img alt="" aria-hidden className="taskchef-app-mark" src={brandIcon} /><Title order={1}>TaskChef Next</Title></Group>
          {displayMode !== "inline" && <Group className="taskchef-app-filters" gap="xs" wrap="nowrap">
            <ProjectPicker data={projects} onChange={(value) => { setProject(value); setCompletedLimit(5); }} value={project} />
            <Select className="taskchef-app-date" aria-label="Updated" data={[{ label: "Latest 24 hours", value: "24h" }, { label: "Latest 7 days", value: "7d" }, { label: "All time", value: "all" }]} onChange={(value) => { setDate(value ?? "all"); setCompletedLimit(5); }} value={date} size="xs" />
            <TextInput className="taskchef-app-search" aria-label="Search cards" placeholder="Search cards" type="search" leftSection={<IconSearch size={14} aria-hidden />} value={search} onChange={(event) => { setSearch(event.currentTarget.value); setCompletedLimit(5); setArchivedLimit(5); }} size="xs" />
          </Group>}
          <Group className="taskchef-app-actions" gap="xs" wrap="nowrap">
          <NextNotificationCenter state={notifications} toasts={toasts} onAction={notificationAction} onDismiss={dismissToast} onOpen={(item) => { const task = tasks.find((task) => task.id === item.taskId); if (task) void select(task, true); else void actionError("open", new Error("This chat is no longer available.")); }} />
          <ActionIcon aria-label="Settings" title="Plugin settings" onClick={() => void (async () => {
            try { await call("taskchef_app_open_settings", {}); }
            catch (cause) { await actionError("settings", cause); }
          })()} variant="subtle"><IconSettings size={17} /></ActionIcon>
          <ActionIcon aria-label="Refresh" onClick={() => void refresh(true).catch((cause) => setError(String(cause)))} variant="subtle"><IconRefresh size={17} /></ActionIcon></Group>
        </header>
        {displayMode === "inline" ? <main className="taskchef-inline-main">
          {error ? <Alert color="red" role="alert">{error}</Alert> : <>
            <Text size="sm">{eligibleTasks.length} eligible top-level chats</Text>
            <Stack gap="xs" mt="xs">
              {eligibleTasks.slice(0, 3).map((task) => <Button key={task.id} onClick={() => void openChat(task)} variant="subtle">{task.title}</Button>)}
            </Stack>
          </>}
        </main> : <>
        <main className={`taskchef-app-main${view === "list" ? " taskchef-app-main-list" : ""}`}>
          {view === "list" && <Paper className="taskchef-toolbar" radius={0}>
            <Box className="taskchef-app-status"><SegmentedControl aria-label="Status" data={statusOptions} onChange={setStatus} size="xs" value={status} withItemsBorders={false} /></Box>
          </Paper>}
          {!!scan?.scheduleErrors && <Alert color="yellow" role="alert">{scan.scheduleErrors} schedule files could not be read; schedule placement may be incomplete.</Alert>}
          {view === "list" && <Text aria-live="polite" className="taskchef-results-summary" id="task-results-summary">Tasks: {visible.length} of {eligibleTasks.length}</Text>}
          {error && <Alert color="red" role="alert" mt="sm">{error}</Alert>}
          {!error && (view === "board" ? <TaskBoard loadImage={loadReplyImage} groupInterruptedWithWaiting lanes={[...lanes]} completedLimit={completedLimit} archivedLimit={archivedLimit} onMoreArchived={() => setArchivedLimit((limit) => limit + 5)} onMoreCompleted={() => setCompletedLimit((limit) => limit + 5)} onOpenCodex={(task) => void openChat(task)} onOpenDetail={(task) => void select(task)} tasks={boardTasks} />
            : <Stack aria-describedby="task-results-summary" aria-label="Tasks" className="taskchef-list" component="section" gap="sm" mt="xs">
              {visible.map((task) => <TaskCard key={task.id} onOpenCodex={(item) => void openChat(item)} onOpenDetail={(item) => void select(item)} task={task} />)}
              {visible.length === 0 && <Paper className="taskchef-empty" p="lg" ta="center" withBorder><Title order={2} size="h5">No tasks match these filters</Title><Text c="dimmed" size="sm">Choose a different project, update window, or status.</Text></Paper>}
            </Stack>)}
        </main>
        </>}
      </Box>
      <TaskDetail extraActions={selected && !selected.manualDone && !selected.observed?.archive && selected.observed?.lastTurnEvent !== "inProgress" ? <Button size="compact-sm" disabled={busy} onClick={() => void markDone(selected)}>Mark Done</Button> : undefined} busy={busy} error={detailError} highlightTurnRef={null} onClose={closeDetail} onCopy={() => {
        if (!selected) return;
        const task = selected;
        void (async () => { try { await navigator.clipboard.writeText(task.id); } catch (cause) { await actionError("copy", cause, task); } })();
      }} onOpenCodex={() => selected && void openChat(selected)} onTransition={async () => ({ ok: false })} opened={opened} task={selected} readOnly />
    </RelativeTimeProvider>
  </MantineProvider>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<TaskChefApp />);
