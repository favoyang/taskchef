import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fixtureTask } from "../fixtures";
import { TaskCard } from "./TaskCard";
import { TaskUsageSummary } from "./TaskUsageSummary";

afterEach(cleanup);

function renderUsage(task = fixtureTask()) {
  return render(<MantineProvider><TaskUsageSummary task={task} /></MantineProvider>);
}

describe("task list usage summary", () => {
  test("uses shared compact token and currency formatting with full-value accessibility", () => {
    renderUsage(fixtureTask({
      status: "completed",
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
    const summary = screen.getByText("1.32M tokens · est. $12.34");
    expect(summary).toHaveAttribute("data-usage-state", "ready");
    expect(summary).toHaveAccessibleName(/1,324,567 tokens; estimated cost \$12\.34/i);
    expect(summary).toHaveAttribute("title", expect.stringContaining("unrounded estimate $12.3449"));
  });

  test("states cost unavailability without replacing a known token total with zero", () => {
    renderUsage(fixtureTask({
      status: "completed",
      usage: { status: "available", task: { totalTokens: 1_324_567, estimatedCostUsd: null } },
    }));
    expect(screen.getByText("1.32M tokens · cost unavailable")).toHaveAccessibleName(
      /1,324,567 tokens; estimated cost unavailable/i,
    );
  });

  test("keeps pending and calculating wording distinct and uses the restrained shimmer", () => {
    const { rerender } = renderUsage();
    expect(screen.getByText("Token usage pending")).toHaveClass("taskchef-shimmer");
    rerender(
      <MantineProvider>
        <TaskUsageSummary task={fixtureTask({
          status: "completed",
          usage: { generationTurnRef: "turn-one", status: "calculating" },
        })} />
      </MantineProvider>,
    );
    expect(screen.getByText("Calculating token usage")).toHaveClass("taskchef-shimmer");
  });

  test("shows a quiet explicit unavailable state with the cache reason in its tooltip", () => {
    renderUsage(fixtureTask({
      status: "completed",
      usage: { status: "unavailable", reason: "No matching cached boundary." },
    }));
    const summary = screen.getByText("Token usage unavailable");
    expect(summary).toHaveAttribute("data-usage-state", "unavailable");
    expect(summary).toHaveAttribute("title", "No matching cached boundary.");
  });

  test("places usage directly beneath the primary status badge in a responsive metadata block", () => {
    const { container } = render(
      <MantineProvider>
        <TaskCard
          onOpenCodex={vi.fn()}
          onOpenDetail={vi.fn()}
          task={fixtureTask()}
        />
      </MantineProvider>,
    );
    const metadata = container.querySelector(".taskchef-card-metadata");
    expect(metadata).not.toBeNull();
    expect(metadata?.children[0]).toHaveClass("taskchef-status-badge");
    expect(metadata?.children[1]).toHaveClass("taskchef-task-usage");
    expect(screen.getByRole("button", { name: /^review checkout reconciliation$/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /open chat/i })).toBeVisible();
  });
});
