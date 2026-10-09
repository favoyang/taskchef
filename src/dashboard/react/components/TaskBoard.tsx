import { PullRequestBadges } from "./PullRequestBadges";
import { Badge, Box, Button, Paper, Stack, Text, Title } from "@mantine/core";
import { useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { IconArrowUpRight } from "@tabler/icons-react";
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
              <Title order={2} size="h5">{label}</Title>
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
    <Paper className="taskchef-board-card" component="article" px="sm" pt="sm" pb={6} withBorder>
      {task.observed && task.replyImage && <ReplyCover key={`${task.turnId}:${task.replyImage.url}`} task={task} loadImage={loadImage} onOpen={() => onOpenDetail(task)} />}
      <Title className="taskchef-board-title" order={3} size="h5">
        <button className="taskchef-title-button" onClick={() => onOpenDetail(task)} type="button">{task.title}</button>
      </Title>
      <Text className="taskchef-board-project" size="xs">{task.project.name}</Text>
      {task.status === "interrupted" && <Badge color="orange" size="xs" variant="light">Interrupted</Badge>}
      {task.scheduled && <Text size="xs" c="violet">Active schedule</Text>}
      <Text component="div" className="taskchef-board-excerpt taskchef-preserve-lines" style={task.observed ? { WebkitLineClamp: 2, lineClamp: 2 } : undefined} size="sm">
        {task.observed ? <ReplyMarkdown compact text={excerpt} /> : <LinkedText task={task} text={excerpt} />}
      </Text>
      <PullRequestBadges pullRequests={task.pullRequests} />
      <Box className="taskchef-board-card-footer">
        {task.observed && task.status === "working"
          ? <ElapsedTime startedAt={task.observed.lastTurnEventAt} />
          : <RelativeTime calendar={!!task.observed} icon={task.observed ? false : undefined} label="Updated time" value={task.meaningfulUpdatedAt ?? task.updatedAt} durationMs={task.observed ? task.observed.latestTurnDurationMs ?? null : undefined} />}
        {linked ? (
          <button aria-label={`Open chat for ${task.title}`} className="taskchef-board-chat" onClick={() => onOpenCodex(task)} title="Open chat" type="button">
            <IconArrowUpRight aria-hidden size={19} stroke={1.6} />
          </button>
        ) : task.status === "working" ? <Text c="dimmed" className="taskchef-board-link-pending" size="xs">Chat link pending</Text> : null}
      </Box>
    </Paper>
  );
}
