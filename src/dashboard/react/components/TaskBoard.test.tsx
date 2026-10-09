import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

test("observed running cards show elapsed time and return to a date when the turn ends", () => {
  const running = task(1, "working");
  running.observed = { archive: false, lastTurnEvent: "inProgress", lastTurnEventAt: new Date(Date.now() - 754000).toISOString(), recentFileActivity: true };
  const props = { completedLimit: 5, onMoreCompleted: vi.fn(), onOpenCodex: vi.fn(), onOpenDetail: vi.fn() };
  const { rerender } = render(<MantineProvider><TaskBoard {...props} tasks={[running]} /></MantineProvider>);
  expect(screen.getByLabelText(/^Elapsed time:/)).toHaveTextContent(/^12m$/);
  expect(screen.queryByRole("button", { name: /^Updated time:/ })).not.toBeInTheDocument();
  rerender(<MantineProvider><TaskBoard {...props} tasks={[{ ...running, status: "needs_input" }]} /></MantineProvider>);
  expect(screen.queryByLabelText(/^Elapsed time:/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Updated time:/ })).toBeInTheDocument();
});

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


test("keeps Archived separate from Done and limits archived cards", () => {
  const archived = Array.from({ length: 8 }, (_, index) => task(index + 10, "archived"));
  const more = vi.fn();
  render(<MantineProvider><TaskBoard lanes={[{ status: "completed", label: "Done" }, { status: "archived", label: "Archived" }]} tasks={[task(1, "completed"), ...archived]} completedLimit={5} onMoreArchived={more} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} /></MantineProvider>);
  expect(within(screen.getByRole("region", { name: "Done, 1 tasks" })).getAllByRole("article")).toHaveLength(1);
  const archive = screen.getByRole("region", { name: "Archived, 8 tasks" });
  expect(within(archive).getAllByRole("article")).toHaveLength(5);
  fireEvent.click(within(archive).getByRole("button", { name: "Show 3 more · 5 of 8" }));
  expect(more).toHaveBeenCalledOnce();
});


test("Done and Archived expand independently", () => {
  const done = Array.from({ length: 8 }, (_, i) => task(i, "completed"));
  const archived = Array.from({ length: 8 }, (_, i) => task(i + 20, "archived"));
  const moreDone = vi.fn(); const moreArchived = vi.fn();
  const props = { lanes: [{ status: "completed" as const, label: "Done" }, { status: "archived" as const, label: "Archived" }], tasks: [...done, ...archived], completedLimit: 5, onMoreCompleted: moreDone, onMoreArchived: moreArchived, onOpenCodex: vi.fn(), onOpenDetail: vi.fn() };
  const { rerender } = render(<MantineProvider><TaskBoard {...props} archivedLimit={5} /></MantineProvider>);
  const archiveLane = screen.getByRole("region", { name: "Archived, 8 tasks" });
  fireEvent.click(within(archiveLane).getByRole("button", { name: /Show 3 more/ }));
  expect(moreArchived).toHaveBeenCalledOnce(); expect(moreDone).not.toHaveBeenCalled();
  rerender(<MantineProvider><TaskBoard {...props} archivedLimit={10} /></MantineProvider>);
  expect(within(screen.getByRole("region", { name: "Done, 8 tasks" })).getAllByRole("article")).toHaveLength(5);
  expect(within(screen.getByRole("region", { name: "Archived, 8 tasks" })).getAllByRole("article")).toHaveLength(8);
});


test("Next groups interrupted cards under Waiting with a tag and keeps empty Scheduled", () => {
  const lanes = [{ status: "scheduled" as const, label: "Scheduled", emptyMessage: "No scheduled chats" }, { status: "needs_input" as const, label: "Waiting for input/review" }, { status: "completed" as const, label: "Done" }];
  const interrupted = task(1, "interrupted");
  const { rerender } = render(<MantineProvider><TaskBoard lanes={lanes} tasks={[interrupted]} groupInterruptedWithWaiting completedLimit={5} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} /></MantineProvider>);
  expect(within(screen.getByRole("region", { name: "Scheduled, 0 tasks" })).getByText("No scheduled chats")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "Waiting for input/review, 1 tasks" })).getByText("Interrupted")).toBeVisible();
  expect(screen.queryByRole("region", { name: /Unverified/ })).not.toBeInTheDocument();
  rerender(<MantineProvider><TaskBoard lanes={lanes} tasks={[interrupted, task(2, "scheduled")]} groupInterruptedWithWaiting completedLimit={5} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} /></MantineProvider>);
  expect(screen.getByRole("region", { name: "Scheduled, 1 tasks" })).toBeVisible();
});


test("reports only intersecting cards and does not observe unrendered Done cards", () => {
  let notify!: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  try {
    const onVisibleTasksChange = vi.fn();
    const tasks = [task(1,"working"),task(2,"completed"),task(3,"completed")];
    const view = render(<MantineProvider><TaskBoard tasks={tasks} completedLimit={1} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} onVisibleTasksChange={onVisibleTasksChange} /></MantineProvider>);
    const cards = observe.mock.calls.map(([element]) => element as HTMLElement);
    expect(cards).toHaveLength(2);
    act(() => notify([{target:cards[0],isIntersecting:true},{target:cards[1],isIntersecting:false}] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(onVisibleTasksChange).toHaveBeenLastCalledWith([cards[0].dataset.chatId]);
    act(() => notify([{target:cards[0],isIntersecting:false},{target:cards[1],isIntersecting:true}] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(onVisibleTasksChange).toHaveBeenLastCalledWith([cards[1].dataset.chatId]);
    const observations = observe.mock.calls.length;
    const previousNotify = notify;
    view.rerender(<MantineProvider><TaskBoard tasks={tasks.map(item => ({...item, summary:"Updated reply"}))} completedLimit={1} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} onVisibleTasksChange={onVisibleTasksChange} /></MantineProvider>);
    expect(observe.mock.calls.length).toBe(observations);
    view.rerender(<MantineProvider><TaskBoard tasks={[tasks[0]]} completedLimit={1} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} onVisibleTasksChange={onVisibleTasksChange} /></MantineProvider>);
    expect(onVisibleTasksChange).toHaveBeenLastCalledWith([]);
    act(() => previousNotify([{target:cards[0],isIntersecting:true}] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(onVisibleTasksChange).toHaveBeenLastCalledWith([]);
    view.rerender(<MantineProvider><TaskBoard tasks={[]} completedLimit={1} onMoreCompleted={vi.fn()} onOpenCodex={vi.fn()} onOpenDetail={vi.fn()} onVisibleTasksChange={onVisibleTasksChange} /></MantineProvider>);
    expect(onVisibleTasksChange).toHaveBeenLastCalledWith([]);
    onVisibleTasksChange.mockClear();
    view.unmount();
    expect(onVisibleTasksChange).toHaveBeenLastCalledWith([]);
    expect(disconnect).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
