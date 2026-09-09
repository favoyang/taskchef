import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { ActivityTimeline } from "./ActivityTimeline";
import {
  ExecutionPanel,
  ManualTransitionConfirmation,
  TaskDetail,
  manualTransitionTargets,
  type TerminalStatus,
} from "./TaskDetail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("clears a manual-transition confirmation only after success", async () => {
  const onTransition = vi.fn().mockResolvedValue({ ok: true });
  render(<ConfirmationHarness onTransition={onTransition} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Mark task completed?");
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() => expect(onTransition).toHaveBeenCalledWith("completed", expect.any(String)));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("heading", { name: "Task title" })).toHaveFocus());
});

test("retains a manual-transition confirmation after failure", async () => {
  const onTransition = vi.fn().mockResolvedValue({ ok: false });
  render(<ConfirmationHarness onTransition={onTransition} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() => expect(onTransition).toHaveBeenCalledWith("completed", expect.any(String)));
  expect(screen.getByRole("alert")).toHaveTextContent("Mark task completed?");
});

test("reuses an action ID for retryable failures and rotates it after a stale task", async () => {
  const onTransition = vi.fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: false, rotateActionId: true })
    .mockResolvedValueOnce({ ok: false });
  render(<ConfirmationHarness onTransition={onTransition} />);
  const confirm = screen.getByRole("button", { name: "Confirm" });
  fireEvent.click(confirm);
  await waitFor(() => expect(onTransition).toHaveBeenCalledTimes(1));
  const firstActionId = onTransition.mock.calls[0][1];
  fireEvent.click(confirm);
  await waitFor(() => expect(onTransition).toHaveBeenCalledTimes(2));
  expect(onTransition.mock.calls[1][1]).toBe(firstActionId);
  fireEvent.click(confirm);
  await waitFor(() => expect(onTransition).toHaveBeenCalledTimes(3));
  expect(onTransition.mock.calls[2][1]).not.toBe(firstActionId);
});

test("covers terminal, active, and unavailable timeline metrics", () => {
  {
  const task = fixtureTask({
    status: "completed",
    turns: [{
      ...fixtureTask().turns![0],
      result: {
        status: "completed",
        summary: "Done.",
        updatedAt: "2026-08-30T08:18:32.000Z",
      },
    }],
    usage: {
      status: "available",
      turns: { "turn-one": { status: "available", totalTokens: 1_324_567, estimatedCostUsd: 0.12 } },
    },
  });
  const { container } = render(
    <MantineProvider><ActivityTimeline highlightTurnRef={null} task={task} /></MantineProvider>,
  );
  const stats = container.querySelector(".taskchef-turn-stats") as HTMLElement;
  expect(stats).not.toBeNull();
  expect(container.querySelector(".taskchef-turn-heading .taskchef-status-badge"))
    .toHaveTextContent("completed");
  expect(screen.queryByText(/^Turn ref:/)).not.toBeInTheDocument();
  const cells = [...stats.children] as HTMLElement[];
  expect(cells).toHaveLength(4);
  expect(within(cells[0]).getByLabelText(/^Turn update time:/i)).toBeVisible();
  expect(cells[0].querySelector(".tabler-icon-history")).not.toBeNull();
  expect(within(cells[1]).getByLabelText(/completed turn reported wall-clock elapsed time/i))
    .toHaveTextContent("18m 32s");
  expect(cells[1].querySelector(".tabler-icon-hourglass")).not.toBeNull();
  expect(within(cells[2]).getByLabelText("1,324,567 tokens")).toHaveTextContent("1.32M");
  expect(cells[2].querySelector(".tabler-icon-stack-2")).not.toBeNull();
  expect(within(cells[3]).getByLabelText("Estimated cost $0.12")).toHaveTextContent("0.12");
  expect(within(cells[3]).getByLabelText("Estimated cost $0.12")).not.toHaveTextContent("$");
  expect(cells[3].querySelector(".tabler-icon-currency-dollar")).not.toBeNull();
  cleanup();
  }

  {
  let now = Date.parse("2026-08-30T08:18:32.000Z");
  let tick: (() => void) | undefined;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler) => {
    tick = handler as () => void;
    return 1;
  }) as typeof window.setInterval);
  vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
  const task = fixtureTask();
  render(<MantineProvider><ActivityTimeline highlightTurnRef={null} task={task} /></MantineProvider>);
  expect(screen.getByLabelText(/current turn reported wall-clock elapsed time/i))
    .toHaveTextContent("18m 32s");
  expect(screen.getByLabelText("Tokens pending")).toHaveTextContent("Pending");
  expect(screen.getByLabelText("Estimated cost pending")).toHaveTextContent("Pending");

  act(() => {
    now += 2_000;
    tick?.();
  });

  expect(screen.getByLabelText(/current turn reported wall-clock elapsed time/i))
    .toHaveTextContent("18m 34s");
  cleanup();
  vi.restoreAllMocks();
  }

  {
  const task = fixtureTask({
    status: "completed",
    turns: [{
      ...fixtureTask().turns![0],
      startedAt: "2026-08-30T08:18:33.000Z",
      result: {
        status: "completed",
        summary: "Done.",
        updatedAt: "2026-08-30T08:18:32.000Z",
      },
    }],
    usage: {
      status: "unavailable",
      turns: {
        "turn-one": {
          status: "unavailable",
          reason: "Manual dashboard turns do not have usage boundaries.",
        },
      },
    },
  });
  render(<MantineProvider><ActivityTimeline highlightTurnRef={null} task={task} /></MantineProvider>);
  expect(screen.getByLabelText(/elapsed unavailable.*reported wall-clock/i))
    .toHaveTextContent("n/a");
  expect(screen.getByText("Manual dashboard turns do not have usage boundaries.")).toBeVisible();
  expect(screen.getByLabelText(/tokens unavailable: manual dashboard turns/i)).toBeVisible();
  }
});

test("renders orchestrated scope, plan, phase identity, and partial usage coverage", () => {
  const task = orchestratedFixture();
  render(
    <MantineProvider>
      <ExecutionPanel task={task} />
    </MantineProvider>,
  );
  const execution = screen.getByRole("region", { name: "Execution" });
  expect(screen.getByRole("heading", { name: "Execution" })).toBeVisible();
  expect(screen.getByText("orchestrated")).toBeVisible();
  expect(execution).toHaveTextContent("Intent: implement");
  expect(execution).toHaveTextContent("Accepted scope: Update the focused dashboard surface only.");
  expect(execution).toHaveTextContent("plans/stable-orchestrator.md @ abc123");
  expect(execution).toHaveTextContent("Current phase: implement attempt 1");
  expect(execution).toHaveTextContent("child asserted");
});

test("hides manual outcomes while an orchestrated phase is active", () => {
  const task = orchestratedFixture();
  expect(manualTransitionTargets(task)).toEqual([]);
  render(
    <MantineProvider>
      <TaskDetail
        busy={false}
        error={null}
        highlightTurnRef={null}
        notice={null}
        onClose={vi.fn()}
        onCopy={vi.fn()}
        onOpenCodex={vi.fn()}
        onTransition={vi.fn()}
        opened
        task={task}
      />
    </MantineProvider>,
  );
  expect(screen.getByRole("button", { name: "More task actions" })).toBeVisible();
  expect(screen.queryByText("Mark completed")).not.toBeInTheDocument();
  expect(screen.queryByText("Mark failed")).not.toBeInTheDocument();
});

function orchestratedFixture() {
  const task = fixtureTask({
    executionMode: "orchestrated",
    executionRevision: 3,
    usage: {
      status: "available",
      task: { totalTokens: 1200, estimatedCostUsd: 0.03 },
      coverage: {
        status: "partial",
        scope: "parent_only",
        includedMembers: 1,
        missingMembers: 1,
        reason: "Exclusive child totals are unavailable.",
      },
    },
  });
  task.latestTurn = {
    ...task.latestTurn!,
    intent: "implement",
    acceptedScope: "Update the focused dashboard surface only.",
    planRef: {
      repository: "https://github.com/example/taskchef",
      path: "plans/stable-orchestrator.md",
      revision: "abc123",
      contentHash: "deadbeef",
    },
    phases: [{
      phaseId: "implement-1",
      kind: "implement",
      attempt: 1,
      role: "implementer",
      resolution: {
        requestedModel: null,
        requestedEffort: null,
        source: "~/.codex/agents/implementer.toml",
        status: "configured",
        resolvedAt: task.updatedAt,
        model: "gpt-5.6-sol",
        effort: "high",
        effectiveModel: null,
        effectiveEffort: null,
      },
      agentHandle: "opaque-handle",
      threadBinding: {
        threadId: "018f2a01-0000-7000-8000-000000000004",
        provenance: "child_asserted",
      },
      writer: true,
      writerGeneration: 1,
      state: "running",
      startedAt: task.updatedAt,
      endedAt: null,
      result: null,
      reviewPassId: null,
    }],
  };
  task.turns = [task.latestTurn];
  return task;
}

function ConfirmationHarness({ onTransition }: { onTransition: (status: TerminalStatus, actionId: string) => Promise<{ ok: boolean; rotateActionId?: boolean }> }) {
  const [opened, setOpened] = useState(true);
  return (
    <MantineProvider>
      <h2 id="task-detail-title" tabIndex={-1}>Task title</h2>
      {opened && (
        <ManualTransitionConfirmation
          busy={false}
          onCancel={() => setOpened(false)}
          onTransition={onTransition}
          status="completed"
        />
      )}
    </MantineProvider>
  );
}
