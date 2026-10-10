import { CardStatusLine } from "./CardStatusIcons";
import { Badge, Box, Button, Paper, Stack, Text, Title } from "@mantine/core";
import { useLayoutEffect, useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { IconArrowUpRight, IconFolder } from "@tabler/icons-react";
import { hasLinkedCodexThread, latestTurnPresentation } from "../../state.js";
import type { Task, TaskStatus } from "../types";
import { LinkedText } from "./LinkedText";
import { ReplyMarkdown } from "./ReplyMarkdown";
import { ReplyCover } from "./ReplyCover";
import { ElapsedTime, RelativeTime } from "./RelativeTime";

const defaultLanes: { status: TaskStatus; label: string; emptyMessage?: string }[] = [
  { status: "working", label: "Working" },
  { status: "needs_input", label: "Needs input" },
  { status: "completed", label: "Completed" },
  { status: "failed", label: "Failed" },
  { status: null, label: "Unresolved" },
];
export function TaskBoard({
  lanes = defaultLanes,
  groupInterruptedWithWaiting = false,
  loadImage,
  doneNotice,
  onVisibleTasksChange,
  completedLimit,
  archivedLimit = 5,
  onMoreArchived,
  onMoreCompleted,
  onOpenCodex,
  onOpenDetail,
  tasks,
}: {
  groupInterruptedWithWaiting?: boolean;
  doneNotice?: ReactNode;
  onVisibleTasksChange?: (ids: string[]) => void;
  loadImage?: (task: Task) => Promise<string | null>;
  lanes?: { status: TaskStatus; label: string; emptyMessage?: string }[];
  completedLimit: number;
  archivedLimit?: number;
  onMoreArchived?: () => void;
  onMoreCompleted: () => void;
  onOpenCodex: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
  tasks: Task[];
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; scrollLeft: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  // Observe the same DOM cards across reply updates; rebuild only when cards or lanes change.
  const cardLayoutKey = JSON.stringify(tasks.map(({ id, status }) => [id, status]));
  useLayoutEffect(() => {
    if (!onVisibleTasksChange || !boardRef.current || typeof IntersectionObserver === "undefined") return;
    onVisibleTasksChange([]);
    const visible = new Set<string>();
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!active) return;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.chatId;
        if (!id) continue;
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      onVisibleTasksChange([...visible].sort());
    });
    const cards = boardRef.current.querySelectorAll("[data-chat-id]");
    for (const card of cards) observer.observe(card);
    return () => { active = false; observer.disconnect(); onVisibleTasksChange([]); };
  }, [cardLayoutKey, completedLimit, archivedLimit, onVisibleTasksChange]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
    const target = event.target as Element;
    if (target.closest("button, a, input, textarea, select, [contenteditable], .taskchef-board-card, h1, h2, h3, p, span")) return;
    const board = boardRef.current;
    if (!board || board.scrollWidth <= board.clientWidth) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, scrollLeft: board.scrollLeft, moved: false };
    board.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const board = boardRef.current;
    if (!drag || !board || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(delta) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      board.classList.add("taskchef-board-dragging");
    }
    event.preventDefault();
    board.scrollLeft = drag.scrollLeft - delta;
  }

  function endPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const board = boardRef.current;
    if (!drag || !board || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    board.classList.remove("taskchef-board-dragging");
    if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
  }

  const knownStatuses = new Set(lanes.map((lane) => lane.status));
  const laneFor = (task: Task): TaskStatus => groupInterruptedWithWaiting && task.status === "interrupted" ? "needs_input" : knownStatuses.has(task.status) ? task.status : null;
  const visibleLanes = lanes.filter((lane) => (lane.status !== null || tasks.some((task) => laneFor(task) === null)));
  return (
    <Box
      aria-label="Task board"
      className="taskchef-board"
      component="section"
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      }}
      onPointerCancel={endPointer}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      ref={boardRef}
      tabIndex={0}
    >
      {visibleLanes.map(({ status, label, emptyMessage }) => {
        const matching = tasks.filter((task) => laneFor(task) === status);
        const shown = (status === "completed" || status === "archived") ? matching.slice(0, status === "archived" ? archivedLimit : completedLimit) : matching;
        return (
          <Box aria-label={`${label}, ${matching.length} tasks`} className="taskchef-board-lane" component="section" key={label}>
            <Box className="taskchef-board-lane-heading">
              <Box className="taskchef-board-lane-title">
                <Title order={2} size="h5">{label}</Title>
                {status === "working" && label === "Running" && matching.length > 0 && (
                  <svg aria-label="Running chats" role="img" className="taskchef-running-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path opacity="0.3" d="M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z" fill="currentColor" />
                    <path d="M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z" fill="currentColor" />
                  </svg>
                )}
              </Box>
              {matching.length > 0 && <Text aria-label={`${matching.length} tasks`} c="dimmed" size="sm">{matching.length}</Text>}
            </Box>
            <Stack gap="sm">
              {status === "completed" && doneNotice}
              {shown.map((task) => <BoardCard loadImage={loadImage} key={task.id} onOpenCodex={onOpenCodex} onOpenDetail={onOpenDetail} task={task} />)}
              {matching.length === 0 && <Text c="dimmed" className="taskchef-board-empty" size="sm">{emptyMessage ?? "No tasks"}</Text>}
              {(status === "completed" || status === "archived") && matching.length > shown.length && (
                <Button className="taskchef-board-more" onClick={status === "archived" ? onMoreArchived : onMoreCompleted} size="compact-sm" variant="subtle">
                  Show {Math.min(5, matching.length - shown.length)} more · {shown.length} of {matching.length}
                </Button>
              )}
            </Stack>
          </Box>
        );
      })}
    </Box>
  );
}

function BoardCard({ task, onOpenCodex, onOpenDetail, loadImage }: {
  loadImage?: (task: Task) => Promise<string | null>;
  task: Task;
  onOpenCodex: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
}) {
  const latest = latestTurnPresentation(task);
  const excerpt = task.observed ? task.replyExcerpt || "No reply text to show for this turn."
    : task.status === "working" ? latest.requestSummary : latest.resultSummary;
  const linked = hasLinkedCodexThread(task);
  return (
    <Paper data-chat-id={task.id} className="taskchef-board-card" component="article" px="sm" pt="sm" pb={6} withBorder>
      {task.observed && task.replyImage && <ReplyCover key={`${task.turnId}:${task.replyImage.url}`} task={task} loadImage={loadImage} onOpen={() => onOpenDetail(task)} />}
      <Title className="taskchef-board-title" order={3} size="h5">
        <button className="taskchef-title-button" onClick={() => onOpenDetail(task)} type="button">{task.title}</button>
      </Title>
      <Text className="taskchef-board-project" size="xs"><IconFolder size={14} stroke={1.5} aria-hidden /><span>{task.project.name}</span></Text>
      {task.status === "interrupted" && <Badge color="orange" size="xs" variant="light">Interrupted</Badge>}
      <Text component="div" className="taskchef-board-excerpt taskchef-preserve-lines" style={task.observed ? { WebkitLineClamp: 2, lineClamp: 2 } : undefined} size="sm">
        {task.observed ? <ReplyMarkdown compact text={excerpt} /> : <LinkedText task={task} text={excerpt} />}
      </Text>
      <Box className="taskchef-board-card-footer">
        <CardStatusLine subagentCount={task.observed?.directChildCount} pullRequests={task.pullRequests} scheduled={task.scheduled} nextRunAt={task.nextRunAt} durationMs={task.observed?.latestTurnDurationMs} startedAt={task.observed && task.status === "working" ? task.observed.lastTurnEventAt : null}>
        {task.observed && task.status === "working"
          ? <ElapsedTime tooltipEnabled={false} startedAt={task.observed.lastTurnEventAt} />
          : <RelativeTime tooltipEnabled={false} calendar={!!task.observed} icon={task.observed ? false : undefined} label="Updated time" value={task.meaningfulUpdatedAt ?? task.updatedAt} durationMs={task.observed ? task.observed.latestTurnDurationMs ?? null : undefined} />}
        </CardStatusLine>
        {linked ? (
          <button aria-label={`Open chat for ${task.title}`} className="taskchef-board-chat" onClick={() => onOpenCodex(task)} title="Open chat" type="button">
            <IconArrowUpRight aria-hidden size={19} stroke={1.6} />
          </button>
        ) : task.status === "working" ? <Text c="dimmed" className="taskchef-board-link-pending" size="xs">Chat link pending</Text> : null}
      </Box>
    </Paper>
  );
}
