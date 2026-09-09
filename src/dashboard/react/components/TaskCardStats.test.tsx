import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { TaskCard } from "./TaskCard";
import { TaskCardStats } from "./TaskCardStats";

afterEach(cleanup);

function renderStats(task = fixtureTask()) {
  return render(<MantineProvider><TaskCardStats task={task} /></MantineProvider>);
}

describe("task card stats", () => {
  test("renders the four metrics in order with compact values and full accessibility", () => {
    const { container } = renderStats(fixtureTask({
      status: "completed",
      turns: undefined,
      reportedWork: { terminalTurns: 1, validTurns: 1, totalMilliseconds: 1_112_000 },
      usage: {
        status: "available",
        updatedAt: "2026-08-30T09:00:00.000Z",
        task: {
          totalTokens: 1_324_567,
          estimatedCostUsd: 12.3449,
          sourceUpdatedAt: "2026-08-30T09:00:00.000Z",
        },
      },
    }));
    const stats = container.querySelector(".taskchef-card-stats") as HTMLElement;
    expect(stats).not.toBeNull();
    const cells = [...stats.children] as HTMLElement[];
    expect(cells).toHaveLength(4);
    expect(within(cells[0]).getByLabelText(/updated time/i)).toBeVisible();
    expect(within(cells[1]).getByLabelText(/reported work 18m 32s/i)).toBeVisible();
    expect(within(cells[2]).getByLabelText(/1,324,567 tokens/i)).toHaveTextContent("1.32M tokens");
    expect(within(cells[3]).getByLabelText(/estimated cost \$12\.34/i)).toHaveTextContent("est. $12.34");
    expect(within(cells[2]).getByRole("status")).toHaveTextContent(/1,324,567 tokens.*estimated cost \$12\.34/i);
  });

  test("keeps known tokens when cost is missing and never substitutes zero", () => {
    renderStats(fixtureTask({
      status: "completed",
      usage: { status: "available", task: { totalTokens: 1_324_567, estimatedCostUsd: null } },
    }));
    expect(screen.getByLabelText(/1,324,567 tokens/i)).toHaveTextContent("1.32M tokens");
    expect(screen.getByLabelText(/estimated cost unavailable/i)).toHaveTextContent("est. n/a");
  });

  test("shows metric details to keyboard users on focus", () => {
    vi.useFakeTimers();
    renderStats(fixtureTask({
      status: "completed",
      usage: { status: "available", task: { totalTokens: 1_324_567, estimatedCostUsd: 12.3449 } },
    }));
    const cost = screen.getByLabelText(/estimated cost \$12\.34/i);
    fireEvent.focus(cost);
    vi.advanceTimersByTime(150);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Unrounded estimate: $12.3449");
    vi.useRealTimers();
  });

  test("shows pending, calculating, and unavailable states in both usage cells", () => {
    const { rerender } = renderStats();
    expect(screen.getByLabelText("Tokens pending")).toHaveTextContent("Pending");
    expect(screen.getByLabelText("Estimated cost pending")).toHaveTextContent("Pending");
    expect(screen.getAllByText("Pending").every((node) => node.classList.contains("taskchef-shimmer"))).toBe(true);

    rerender(<MantineProvider><TaskCardStats task={fixtureTask({
      status: "completed",
      usage: { generationTurnRef: "turn-one", status: "calculating" },
    })} /></MantineProvider>);
    expect(screen.getByLabelText("Tokens calculating")).toHaveTextContent("Calculating");
    expect(screen.getByLabelText("Estimated cost calculating")).toHaveTextContent("Calculating");

    rerender(<MantineProvider><TaskCardStats task={fixtureTask({
      status: "completed",
      usage: { status: "unavailable", reason: "No matching cached boundary." },
    })} /></MantineProvider>);
    expect(screen.getByLabelText(/token usage unavailable: no matching/i)).toHaveTextContent("n/a tokens");
    expect(screen.getByLabelText(/estimated cost unavailable: no matching/i)).toHaveTextContent("est. n/a");
  });

  test("retains known totals and marks both usage values as updating", () => {
    renderStats(fixtureTask({
      status: "working",
      turnRef: "turn-two",
      usage: {
        generationTurnRef: "turn-one",
        status: "calculating",
        task: { totalTokens: 1_324_567, estimatedCostUsd: 12.3449 },
      },
    }));
    expect(screen.getByLabelText(/1,324,567 tokens; updating/i)).toHaveTextContent("1.32M tokens · Updating…");
    expect(screen.getByLabelText(/estimated cost \$12\.34; updating/i)).toHaveTextContent("est. $12.34 · Updating…");
  });

  test("places Open chat beneath the status badge and keeps callbacks working", () => {
    const openChat = vi.fn();
    const openDetail = vi.fn();
    const { container } = render(<MantineProvider><TaskCard
      onOpenCodex={openChat}
      onOpenDetail={openDetail}
      task={fixtureTask()}
    /></MantineProvider>);
    const metadata = container.querySelector(".taskchef-card-metadata") as HTMLElement;
    expect(metadata.children[0]).toHaveClass("taskchef-status-badge");
    expect(within(metadata).getByRole("button", { name: /open chat/i })).toBe(metadata.children[1]);
    fireEvent.click(within(metadata).getByRole("button", { name: /open chat/i }));
    fireEvent.click(screen.getByRole("button", { name: /^review checkout reconciliation$/i }));
    expect(openChat).toHaveBeenCalledOnce();
    expect(openDetail).toHaveBeenCalledOnce();
  });

  test("toggles the updated time while keeping the selected History icon", () => {
    const { container } = renderStats(fixtureTask({ meaningfulUpdatedAt: "2026-08-30T08:00:00.000Z" }));
    const time = screen.getByLabelText(/updated time for review checkout reconciliation/i);
    expect(container.querySelector(".tabler-icon-history")).not.toBeNull();
    fireEvent.click(time);
    expect(time).toHaveAccessibleName(/show relative time/i);
  });
});
