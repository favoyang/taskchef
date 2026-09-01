import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { ActivityTimeline } from "./ActivityTimeline";
import { ManualTransitionConfirmation, type TerminalStatus } from "./TaskDetail";

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

test("renders tokens, estimated cost, and terminal elapsed time as one compact group", () => {
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
      turns: { "turn-one": { status: "available", totalTokens: 330, estimatedCostUsd: 0.12 } },
    },
  });
  const { container } = render(
    <MantineProvider><ActivityTimeline highlightTurnRef={null} task={task} /></MantineProvider>,
  );
  const metrics = container.querySelector(".taskchef-turn-metrics") as HTMLElement;
  expect(metrics).not.toBeNull();
  expect(within(metrics).getByText("Tokens").nextSibling).toHaveTextContent("330");
  expect(within(metrics).getByText("Estimated cost").nextSibling).toHaveTextContent("$0.12");
  expect(within(metrics).getByText("Elapsed").nextSibling).toHaveTextContent("18m 32s");
  expect(within(metrics).getByLabelText(/completed turn reported wall-clock elapsed time/i)).toBeVisible();
});

test("updates active elapsed so far without turning it into total reported work", () => {
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
  expect(screen.getByText("Elapsed so far").nextSibling).toHaveTextContent("18m 32s");
  expect(screen.getByText("Tokens").nextSibling).toHaveTextContent("Pending");
  expect(screen.getByText("Estimated cost").nextSibling).toHaveTextContent("Pending");

  act(() => {
    now += 2_000;
    tick?.();
  });

  expect(screen.getByText("Elapsed so far").nextSibling).toHaveTextContent("18m 34s");
});

test("shows an explicit unavailable elapsed state for malformed and reversed timestamps", () => {
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
  expect(screen.getByText("Elapsed").nextSibling).toHaveTextContent("Unavailable");
  expect(screen.getByLabelText(/elapsed unavailable.*reported wall-clock/i)).toBeVisible();
  expect(screen.getByText("Manual dashboard turns do not have usage boundaries.")).toBeVisible();
  expect(screen.getByLabelText(/tokens unavailable: manual dashboard turns/i)).toBeVisible();
});

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
