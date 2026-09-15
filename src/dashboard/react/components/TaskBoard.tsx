import { Box, Button, Paper, Stack, Text, Title } from "@mantine/core";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { IconArrowUpRight } from "@tabler/icons-react";
import { hasLinkedCodexThread, latestTurnPresentation } from "../../state.js";
import type { Task, TaskStatus } from "../types";
import { LinkedText } from "./LinkedText";
import { RelativeTime } from "./RelativeTime";

const lanes: { status: TaskStatus; label: string }[] = [
  { status: "working", label: "Working" },
  { status: "needs_input", label: "Needs input" },
  { status: "completed", label: "Completed" },
  { status: "failed", label: "Failed" },
  { status: null, label: "Unresolved" },
];
const knownStatuses = new Set<TaskStatus>(["working", "needs_input", "completed", "failed"]);

function laneFor(task: Task): TaskStatus {
  return knownStatuses.has(task.status) ? task.status : null;
}

export function TaskBoard({
  completedLimit,
  onMoreCompleted,
  onOpenCodex,
  onOpenDetail,
  tasks,
}: {
  completedLimit: number;
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

  const visibleLanes = lanes.filter((lane) => lane.status !== null || tasks.some((task) => laneFor(task) === null));
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
      {visibleLanes.map(({ status, label }) => {
        const matching = tasks.filter((task) => laneFor(task) === status);
        const shown = status === "completed" ? matching.slice(0, completedLimit) : matching;
        return (
          <Box aria-label={`${label}, ${matching.length} tasks`} className="taskchef-board-lane" component="section" key={label}>
            <Box className="taskchef-board-lane-heading">
              <Title order={2} size="h5">{label}</Title>
              <Text aria-label={`${matching.length} tasks`} c="dimmed" size="sm">{matching.length}</Text>
            </Box>
            <Stack gap="sm">
              {shown.map((task) => <BoardCard key={task.id} onOpenCodex={onOpenCodex} onOpenDetail={onOpenDetail} task={task} />)}
              {matching.length === 0 && <Text c="dimmed" className="taskchef-board-empty" size="sm">No tasks</Text>}
              {status === "completed" && matching.length > shown.length && (
                <Button className="taskchef-board-more" onClick={onMoreCompleted} size="compact-sm" variant="subtle">
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

function BoardCard({ task, onOpenCodex, onOpenDetail }: {
  task: Task;
  onOpenCodex: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
}) {
  const latest = latestTurnPresentation(task);
  const excerpt = task.status === "working" ? latest.requestSummary : latest.resultSummary;
  const linked = hasLinkedCodexThread(task);
  return (
    <Paper className="taskchef-board-card" component="article" px="sm" pt="sm" pb={6} withBorder>
      <Title className="taskchef-board-title" order={3} size="h5">
        <button className="taskchef-title-button" onClick={() => onOpenDetail(task)} type="button">{task.title}</button>
      </Title>
      <Text className="taskchef-board-project" size="xs">{task.project.name}</Text>
      <Text className="taskchef-board-excerpt taskchef-preserve-lines" size="sm">
        <LinkedText task={task} text={excerpt} />
      </Text>
      <Box className="taskchef-board-card-footer">
        <RelativeTime label="Updated time" value={task.meaningfulUpdatedAt ?? task.updatedAt} />
        {linked ? (
          <button aria-label={`Open chat for ${task.title}`} className="taskchef-board-chat" onClick={() => onOpenCodex(task)} title="Open chat" type="button">
            <IconArrowUpRight aria-hidden size={19} stroke={1.6} />
          </button>
        ) : task.status === "working" ? <Text c="dimmed" className="taskchef-board-link-pending" size="xs">Chat link pending</Text> : null}
      </Box>
    </Paper>
  );
}
