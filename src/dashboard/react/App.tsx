import {
  Alert,
  ActionIcon,
  AppShell,
  Box,
  CloseButton,
  Container,
  Group,
  MantineProvider,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Title,
  Tooltip,
  createTheme,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { IconAlertTriangle, IconCircleFilled, IconMoon, IconSun } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dismissNotification,
  filterTasks,
  manualTransitionExpectedState,
  reconcileManualTransitionResponse,
  reconcileNotifications,
  statusFilterCounts,
  STATUS_FILTERS,
} from "../state.js";
import { connectDashboard, dashboardVersion, manualTransition, openInCodex, taskDetail } from "./api";
import { clearNotificationHistory, notificationClicked } from "./overlay-state";
import { usageStillCalculating } from "./presentation";
import type { DashboardSnapshot, NotificationSnapshot, Task } from "./types";
import { NotificationCenter } from "./components/NotificationCenter";
import { TaskCard } from "./components/TaskCard";
import { TaskDetail } from "./components/TaskDetail";
import { RelativeTimeProvider } from "./components/RelativeTime";

const theme = createTheme({
  primaryColor: "teal",
  colors: {
    teal: [
      "#e6fcf5",
      "#c3fae8",
      "#96f2d7",
      "#63e6be",
      "#38d9a9",
      "#20c997",
      "#087f5b",
      "#067052",
      "#055e46",
      "#044d39",
    ],
  },
  defaultRadius: "md",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  headings: { fontFamily: "inherit", fontWeight: "680" },
  components: {
    Button: { defaultProps: { radius: "md" } },
    Paper: { defaultProps: { radius: "md" } },
  },
});
const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="taskchef-style-nonce"]')?.content;

interface NotificationState {
  initialized: boolean;
  announcements: NotificationSnapshot[];
  notifications: NotificationSnapshot[];
  seenIds: Set<string>;
  signatures: Map<string, string>;
}

export function DashboardApp({
  connect = true,
  initialTasks = [],
}: {
  connect?: boolean;
  initialTasks?: Task[];
}) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("all");
  const [now, setNow] = useState(() => Date.now());
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpened, setDetailOpened] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);
  const [highlightTurnRef, setHighlightTurnRef] = useState<string | null>(null);
  const [notificationState, setNotificationState] = useState<NotificationState>({
    initialized: initialTasks.length > 0,
    announcements: [],
    notifications: [],
    seenIds: new Set(),
    signatures: new Map(),
  });
  const selectedId = selectedTask?.id ?? null;
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const detailGeneration = useRef(0);
  const detailListUpdatedAt = useRef<string | null>(null);

  const applySnapshot = useCallback((snapshot: DashboardSnapshot) => {
    setTasks(snapshot.tasks);
    setNotificationState((current) => {
      const reconciled = reconcileNotifications(current, snapshot.tasks);
      return {
        initialized: true,
        announcements: reconciled.additions,
        notifications: reconciled.notifications,
        seenIds: reconciled.seenIds,
        signatures: reconciled.signatures,
      };
    });
    setMessage(snapshot.healthy === false
      ? "The task log is temporarily unavailable. Showing the last valid snapshot."
      : null);
    const currentSelectedId = selectedIdRef.current;
    if (currentSelectedId) {
      const updated = snapshot.tasks.find((task) => task.id === currentSelectedId);
      if (updated) setSelectedTask((current) => current ? { ...current, ...updated } : updated);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connect) return;
    void dashboardVersion().then(setVersion).catch(() => setVersion(null));
    const stream = connectDashboard({
      onConnection: setConnected,
      onError: setMessage,
      onSnapshot: applySnapshot,
    });
    return () => stream.close();
  }, [applySnapshot, connect]);

  const loadDetail = useCallback(async (task: Task, focusTurnRef: string | null = null) => {
    const generation = ++detailGeneration.current;
    detailListUpdatedAt.current = task.updatedAt;
    setSelectedTask((current) => current?.id === task.id ? { ...current, ...task } : task);
    setDetailOpened(true);
    setHighlightTurnRef(focusTurnRef);
    setDetailError(null);
    setDetailNotice(null);
    try {
      for (let attempt = 0; attempt <= 40; attempt += 1) {
        if (generation !== detailGeneration.current) return;
        const detail = await taskDetail(task.id);
        if (generation !== detailGeneration.current) return;
        setSelectedTask(detail);
        if (!usageStillCalculating(detail) || attempt === 40) return;
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      }
    } catch {
      if (generation === detailGeneration.current) {
        setDetailError("Task activity is temporarily unavailable. Showing the latest list snapshot.");
      }
    }
  }, []);

  useEffect(() => {
    if (!detailOpened || !selectedId || !connect) return;
    const listTask = tasks.find((task) => task.id === selectedId);
    if (!listTask || listTask.updatedAt === detailListUpdatedAt.current) return;
    void loadDetail(listTask, highlightTurnRef);
    // A task signature update while detail is open refreshes the full projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.find((task) => task.id === selectedId)?.updatedAt]);

  const projects = useMemo(() => [
    { label: "All projects", value: "" },
    ...[...new Set(tasks.map((task) => task.project.name))].sort().map((value) => ({ label: value, value })),
  ], [tasks]);
  const visible = useMemo(() => filterTasks(tasks, { project, status, date, now }), [tasks, project, status, date, now]);
  const counts = useMemo(() => statusFilterCounts(tasks, { project, date, now }), [tasks, project, date, now]);
  const statusData = STATUS_FILTERS.map(({ label, value }: { label: string; value: string }) => ({
    label: counts[value] > 0 ? `${label} ${counts[value]}` : label,
    value,
  }));

  async function handleOpenCodex(task: Task) {
    setDetailBusy(true);
    try {
      const result = await openInCodex(task.id);
      if (result) setMessage(result);
    } catch {
      setMessage("Codex could not be opened. Open the project and select the recorded task instead.");
    } finally {
      setDetailBusy(false);
    }
  }

  async function handleTransition(targetStatus: "completed" | "failed", actionId: string) {
    if (!selectedTask) return { ok: false };
    const requestTask = selectedTask;
    const expected = manualTransitionExpectedState(requestTask);
    setDetailBusy(true);
    setDetailError(null);
    const result = await manualTransition(requestTask, targetStatus, actionId);
    setDetailBusy(false);
    if (result.task) {
      setSelectedTask((current) => reconcileManualTransitionResponse({
        requestTask,
        expected,
        responseTask: result.task,
        selectedTask: current,
      }));
      setTasks((current) => current.map((candidate) => candidate.id === requestTask.id
        ? reconcileManualTransitionResponse({
          requestTask,
          expected,
          responseTask: result.task,
          selectedTask: candidate,
        })
        : candidate));
    }
    if (result.ok && result.task) {
      setHighlightTurnRef(result.task.turnRef ?? result.task.turnId);
      return { ok: true };
    } else {
      setDetailError(result.message ?? "Task state could not be changed.");
      return { ok: false, rotateActionId: result.code === "stale_task" };
    }
  }

  function handleNotificationOpen(notification: NotificationSnapshot) {
    const currentTask = tasks.find((task) => task.id === notification.taskId);
    const overlay = notificationClicked({
      detailTaskId: selectedId,
      detailOpened,
      highlightTurnRef,
      notifications: notificationState.notifications,
      refreshGeneration: detailGeneration.current,
    }, notification, Boolean(currentTask));
    setNotificationState((current) => ({ ...current, notifications: overlay.notifications }));
    if (!currentTask) {
      setMessage("This task is no longer present in the current snapshot.");
      return;
    }
    void loadDetail(currentTask, overlay.highlightTurnRef);
  }

  return (
    <MantineProvider
      defaultColorScheme="auto"
      getStyleNonce={styleNonce ? () => styleNonce : undefined}
      theme={theme}
    >
      <RelativeTimeProvider now={now}>
      <AppShell className="taskchef-shell" padding={0}>
        <Container className="taskchef-header" component="header" size={1080}>
          <Group className="taskchef-header-layout" align="stretch" justify="space-between" wrap="nowrap">
            <Box className="taskchef-header-copy">
              <Text c="var(--taskchef-accent)" fw={750} size="xs" tt="uppercase">TaskChef {version && <span className="taskchef-version">v{version}</span>}</Text>
              <Group gap="sm" mt={5} wrap="nowrap">
                <BrandIcon />
                <Title order={1} size="h2">Dashboard</Title>
              </Group>
            </Box>
            <Stack align="flex-end" className="taskchef-header-actions" gap={0} justify="space-between">
              <Group aria-live="polite" className="taskchef-connection" gap={7} role="status" wrap="nowrap">
                <IconCircleFilled aria-hidden color={connected ? "var(--mantine-color-teal-6)" : "var(--mantine-color-yellow-6)"} size={9} />
                <Text c="dimmed" size="xs">{connected ? "Live" : connect ? "Connecting…" : "Fixture preview"}</Text>
              </Group>
              <ThemeToggle />
            </Stack>
          </Group>
        </Container>

        <AppShell.Main>
          <Container className="taskchef-main" pb={80} size={1080}>
            <Paper className="taskchef-toolbar" p="sm" radius="md" withBorder>
              <Stack gap="sm">
                <Group align="end" gap="sm">
                  <Select aria-label="Project" data={projects} label="Project" onChange={(value) => setProject(value ?? "")} size="sm" value={project} />
                  <Select
                    aria-label="Updated"
                    data={[{ label: "Latest 24 hours", value: "24h" }, { label: "Latest 7 days", value: "7d" }, { label: "All time", value: "all" }]}
                    label="Updated"
                    onChange={(value) => setDate(value ?? "all")}
                    size="sm"
                    value={date}
                  />
                  <Box className="taskchef-task-count-field">
                    <Text className="taskchef-filter-label" mb={3}>Tasks</Text>
                    <Text className="taskchef-count-value" size="sm">{visible.length} of {tasks.length}</Text>
                  </Box>
                </Group>
                <Box>
                  <Text className="taskchef-filter-label" mb={5}>Status</Text>
                  <SegmentedControl aria-label="Status" data={statusData} fullWidth onChange={setStatus} size="xs" value={status} />
                </Box>
              </Stack>
            </Paper>

            {message && (
              <Alert color="yellow" icon={<IconAlertTriangle aria-hidden size={17} />} mt="md" role="status">
                <Group gap="sm" justify="space-between" wrap="nowrap">
                  <Text size="sm">{message}</Text>
                  <CloseButton aria-label="Dismiss dashboard message" onClick={() => setMessage(null)} size="sm" />
                </Group>
              </Alert>
            )}

            <Stack aria-label="Tasks" component="section" gap="sm" mt="md">
              {visible.map((task: Task) => (
                <TaskCard key={task.id} onOpenCodex={handleOpenCodex} onOpenDetail={(value) => void loadDetail(value)} task={task} />
              ))}
              {visible.length === 0 && (
                <Paper className="taskchef-empty" p={48} ta="center" withBorder>
                  <Title order={2} size="h4">No tasks match these filters</Title>
                  <Text c="dimmed" mt={4} size="sm">Choose a different project, date, or status.</Text>
                </Paper>
              )}
            </Stack>
          </Container>
        </AppShell.Main>
      </AppShell>

      <TaskDetail
        busy={detailBusy}
        error={detailError}
        highlightTurnRef={highlightTurnRef}
        onClose={() => {
          if (!detailBusy) {
            detailGeneration.current += 1;
            setDetailOpened(false);
            setHighlightTurnRef(null);
          }
        }}
        onCopy={() => {
          if (!selectedTask) return;
          setDetailNotice(null);
          void navigator.clipboard.writeText(selectedTask.id).then(
            () => setDetailNotice("Task ID copied."),
            () => setDetailNotice("Clipboard access is unavailable. Copy the Task ID from metadata."),
          );
        }}
        onOpenCodex={() => selectedTask && void handleOpenCodex(selectedTask)}
        onTransition={handleTransition}
        opened={detailOpened}
        task={selectedTask}
        notice={detailNotice}
        notifications={detailOpened ? (
          <NotificationCenter
            announcements={notificationState.announcements}
            notifications={notificationState.notifications}
            onClear={() => setNotificationState((current) => ({
              ...current,
              notifications: clearNotificationHistory({
                detailTaskId: selectedId,
                detailOpened,
                highlightTurnRef,
                notifications: current.notifications,
                refreshGeneration: detailGeneration.current,
              }).notifications,
            }))}
            onDismiss={(notification) => setNotificationState((current) => ({ ...current, notifications: dismissNotification(current.notifications, notification.id) }))}
            onOpen={handleNotificationOpen}
            tasks={tasks}
            withinPortal={false}
          />
        ) : null}
      />
      {!detailOpened && (
        <NotificationCenter
          announcements={notificationState.announcements}
          notifications={notificationState.notifications}
          onClear={() => setNotificationState((current) => ({
            ...current,
            notifications: clearNotificationHistory({
              detailTaskId: selectedId,
              detailOpened,
              highlightTurnRef,
              notifications: current.notifications,
              refreshGeneration: detailGeneration.current,
            }).notifications,
          }))}
          onDismiss={(notification) => setNotificationState((current) => ({ ...current, notifications: dismissNotification(current.notifications, notification.id) }))}
          onOpen={handleNotificationOpen}
          tasks={tasks}
        />
      )}
      </RelativeTimeProvider>
    </MantineProvider>
  );
}

function ThemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("light");
  const next = colorScheme === "dark" ? "light" : "dark";
  return (
    <Tooltip label={`Use ${next} theme`}>
      <ActionIcon
        aria-label={`Use ${next} theme`}
        color="gray"
        onClick={() => setColorScheme(next)}
        size="lg"
        variant="subtle"
      >
        {colorScheme === "dark" ? <IconSun aria-hidden size={18} /> : <IconMoon aria-hidden size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}

function BrandIcon() {
  const colorScheme = useComputedColorScheme("light");
  return (
    <img
      alt=""
      aria-hidden
      className="taskchef-brand-icon"
      height="42"
      src={colorScheme === "dark" ? "/assets/taskchef-dark.svg" : "/assets/taskchef.svg"}
      width="42"
    />
  );
}

export default DashboardApp;
