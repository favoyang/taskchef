import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { ActivityTimeline } from "./ActivityTimeline";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-08-30T08:18:32.000Z");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  const task = fixtureTask();
  render(<MantineProvider><ActivityTimeline highlightTurnRef={null} task={task} /></MantineProvider>);
  expect(screen.getByText("Elapsed so far").nextSibling).toHaveTextContent("18m 32s");
  expect(screen.getByText("Tokens").nextSibling).toHaveTextContent("Pending");
  expect(screen.getByText("Estimated cost").nextSibling).toHaveTextContent("Pending");

  act(() => vi.advanceTimersByTime(2_000));

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
