import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { TaskBoard } from "./TaskBoard";

afterEach(cleanup);

function task(id: number, status: ReturnType<typeof fixtureTask>["status"], title = `Task ${id}`) {
  return fixtureTask({
    id: `11111111-1111-4111-8111-${String(id).padStart(12, "0")}`,
    title,
    status,
  });
}

function pointer(target: Element, type: string, pointerType: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.assign(event, { pointerType, pointerId, isPrimary: true });
  fireEvent(target, event);
}

test("groups by task status, counts all completed tasks, and reveals five more", () => {
  const tasks = [task(1, "working"), task(2, "needs_input"), ...Array.from({ length: 11 }, (_, index) => task(index + 3, "completed")), task(20, "failed"), task(21, null)];
  const more = vi.fn();
  const { rerender } = render(<MantineProvider><TaskBoard tasks={tasks} completedLimit={5} onMoreCompleted={more} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} /></MantineProvider>);
  expect(screen.getByRole("region", { name: "Task board" })).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("region", { name: "Working, 1 tasks" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Needs input, 1 tasks" })).toBeInTheDocument();
  const completed = screen.getByRole("region", { name: "Completed, 11 tasks" });
  expect(within(completed).getAllByRole("article")).toHaveLength(5);
  fireEvent.click(within(completed).getByRole("button", { name: "Show 5 more · 5 of 11" }));
  expect(more).toHaveBeenCalledOnce();
  rerender(<MantineProvider><TaskBoard tasks={tasks} completedLimit={10} onMoreCompleted={more} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} /></MantineProvider>);
  expect(within(screen.getByRole("region", { name: "Completed, 11 tasks" })).getAllByRole("article")).toHaveLength(10);
  expect(screen.getByRole("region", { name: "Failed, 1 tasks" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Unresolved, 1 tasks" })).toBeInTheDocument();
});

test("uses current request for working and latest historical result for finished tasks", () => {
  const working = task(1, "working", "Working task");
  const completed = task(2, "completed", "Finished task");
  completed.latestTurn = { ...completed.latestTurn!, requestSummary: "New request", result: { status: "completed", summary: "Latest reported result", updatedAt: completed.updatedAt } };
  completed.lastResult = { status: "completed", summary: "Old reported result", updatedAt: completed.updatedAt };
  const onOpenDetail = vi.fn();
  const onOpenCodex = vi.fn();
  render(<MantineProvider><TaskBoard tasks={[working, completed]} completedLimit={5} onMoreCompleted={vi.fn()} onOpenCodex={onOpenCodex} onOpenDetail={onOpenDetail} /></MantineProvider>);
  const workingLane = screen.getByRole("region", { name: "Working, 1 tasks" });
  expect(workingLane).toHaveTextContent("Review the operator-facing task state.");
  expect(workingLane).not.toHaveTextContent("In progress");
  const completedLane = screen.getByRole("region", { name: "Completed, 1 tasks" });
  expect(completedLane).toHaveTextContent("Latest reported result");
  expect(completedLane).not.toHaveTextContent("Old reported result");
  const completedCard = within(completedLane).getByRole("article");
  expect(completedCard.firstElementChild).toHaveClass("taskchef-board-title");
  expect(completedCard.children[1]).toHaveClass("taskchef-board-project");
  fireEvent.click(within(completedLane).getByRole("button", { name: "Finished task" }));
  expect(onOpenDetail).toHaveBeenCalledWith(completed);
  fireEvent.click(within(completedLane).getByRole("button", { name: "Open chat for Finished task" }));
  expect(onOpenCodex).toHaveBeenCalledWith(completed);
});

test("unlinked working tasks show pending text without a chat action", () => {
  const working = task(1, "working");
  working.threadId = null;
  const failed = task(2, "failed");
  failed.threadId = "invalid";
  render(<MantineProvider><TaskBoard tasks={[working, failed]} completedLimit={5} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} /></MantineProvider>);
  expect(screen.getByRole("region", { name: "Working, 1 tasks" })).toHaveTextContent("Chat link pending");
  expect(screen.queryByRole("button", { name: /Open chat/ })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Failed, 1 tasks" })).not.toHaveTextContent("Chat link pending");
});

test("unexpected status appears in Unresolved instead of disappearing", () => {
  const unexpected = task(1, "working");
  unexpected.status = "paused" as typeof unexpected.status;
  render(<MantineProvider><TaskBoard tasks={[unexpected]} completedLimit={5} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} /></MantineProvider>);
  expect(within(screen.getByRole("region", { name: "Unresolved, 1 tasks" })).getByRole("article")).toBeInTheDocument();
});

test("mouse drag pans from empty lane space without activating a card", () => {
  const onOpenDetail = vi.fn();
  render(<MantineProvider><TaskBoard tasks={[task(1, "working")]} completedLimit={5} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={onOpenDetail} /></MantineProvider>);
  const board = screen.getByRole("region", { name: "Task board" });
  const lane = screen.getByRole("region", { name: "Working, 1 tasks" });
  Object.defineProperties(board, { scrollWidth: { value: 1700 }, clientWidth: { value: 700 } });
  const capture = vi.fn();
  const release = vi.fn();
  board.setPointerCapture = capture;
  board.hasPointerCapture = () => true;
  board.releasePointerCapture = release;

  pointer(lane, "pointerdown", "mouse", 200);
  expect(capture).toHaveBeenCalledWith(1);
  pointer(board, "pointermove", "mouse", 197);
  expect(board.scrollLeft).toBe(0);
  pointer(board, "pointermove", "mouse", 120);
  expect(board.scrollLeft).toBe(80);
  pointer(board, "pointerup", "mouse", 120);
  expect(release).toHaveBeenCalledWith(1);
  expect(board).not.toHaveClass("taskchef-board-dragging");
  fireEvent.click(within(lane).getByRole("button", { name: "Task 1" }));
  expect(onOpenDetail).not.toHaveBeenCalled();
});

test("card controls and touch gestures do not start mouse panning", () => {
  const onOpenDetail = vi.fn();
  render(<MantineProvider><TaskBoard tasks={[task(1, "working")]} completedLimit={5} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={onOpenDetail} /></MantineProvider>);
  const board = screen.getByRole("region", { name: "Task board" });
  const lane = screen.getByRole("region", { name: "Working, 1 tasks" });
  Object.defineProperties(board, { scrollWidth: { value: 1700 }, clientWidth: { value: 700 } });
  const capture = vi.fn();
  board.setPointerCapture = capture;
  const title = within(lane).getByRole("button", { name: "Task 1" });
  pointer(title, "pointerdown", "mouse", 200);
  pointer(lane, "pointerdown", "touch", 200, 2);
  pointer(board, "pointermove", "touch", 120, 2);
  expect(capture).not.toHaveBeenCalled();
  expect(board.scrollLeft).toBe(0);
  fireEvent.click(title);
  expect(onOpenDetail).toHaveBeenCalledOnce();
});
