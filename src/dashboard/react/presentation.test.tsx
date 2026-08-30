import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { fixtureTask } from "./fixtures";
import { turnUsageView, usageStillCalculating, usageView } from "./presentation";
import { ShimmerText } from "./components/ShimmerText";
import { GitHubLinks } from "./components/GitHubLinks";
import { UsagePanel } from "./components/UsagePanel";

describe("token and working presentation", () => {
  test("keeps pending, calculating, ready cost, and unavailable wording distinct", () => {
    expect(usageView(fixtureTask()).label).toBe("Token usage pending");
    expect(usageView(fixtureTask({
      status: "completed",
      usage: { generationTurnRef: "turn-one", status: "calculating" },
    })).label).toBe("Calculating token usage");
    expect(usageView(fixtureTask({
      status: "completed",
      usage: {
        generationTurnRef: "turn-one",
        status: "available",
        task: { totalTokens: 12345, estimatedCostUsd: 0.1234 },
      },
    })).label).toBe("12,345 tokens · Estimated cost $0.1234");
    expect(usageView(fixtureTask({ status: "completed", usage: { status: "unavailable" } })).label)
      .toBe("Token usage unavailable");
    expect(usageView(fixtureTask({
      status: "completed",
      usage: { status: "unavailable", reason: "This task has no linked Codex thread." },
    })).label).toBe("This task has no linked Codex thread.");
    expect(usageView(fixtureTask({ status: "completed", usage: undefined })).label)
      .toBe("Calculating token usage");
  });

  test("keeps cumulative usage visible as known so far during a newer working turn", () => {
    const view = usageView(fixtureTask({
      status: "working",
      turnRef: "turn-two",
      usage: {
        generationTurnRef: "turn-one",
        status: "calculating",
        task: { totalTokens: 12345, estimatedCostUsd: 0.1234 },
      },
    }));
    expect(view.kind).toBe("ready");
    expect(view.label).toBe("12,345 tokens · Estimated cost $0.1234 · known so far");
    if (view.kind === "ready") expect(view.knownSoFar).toBe(true);
  });

  test("distinguishes available, pending, calculating, and unavailable per-turn usage", () => {
    const task = fixtureTask({
      usage: {
        status: "available",
        turns: {
          "turn-one": { status: "available", totalTokens: 330, estimatedCostUsd: 0.12 },
        },
      },
    });
    const completedTurn = {
      ...task.turns![0],
      result: {
        status: "completed" as const,
        summary: "Done.",
        updatedAt: task.updatedAt,
      },
    };
    expect(turnUsageView(task, completedTurn).label).toBe("330 tokens · Estimated cost $0.1200");
    expect(turnUsageView(task, { ...completedTurn, result: null }).label).toBe("Turn usage pending");
    expect(turnUsageView({
      ...task,
      usage: { status: "calculating", turns: { "turn-one": { status: "calculating" } } },
    }, completedTurn).label).toBe("Calculating turn usage");
    expect(turnUsageView({ ...task, usage: { status: "unavailable", turns: {} } }, completedTurn).label)
      .toBe("Turn usage unavailable");
  });

  test("polling is reserved for terminal usage that is actually calculating", () => {
    expect(usageStillCalculating(fixtureTask())).toBe(false);
    expect(usageStillCalculating(fixtureTask({
      status: "completed",
      usage: { generationTurnRef: "turn-one", status: "calculating" },
    }))).toBe(true);
    expect(usageStillCalculating(fixtureTask({
      status: "completed",
      usage: { status: "unavailable", turns: { old: { status: "calculating" } } },
    }))).toBe(true);
  });

  test("marks working text with the approved text shimmer state", () => {
    render(<ShimmerText>In progress</ShimmerText>);
    expect(screen.getByText("In progress")).toHaveClass("taskchef-shimmer");
    expect(screen.getByText("In progress")).toHaveAttribute("data-animation", "text-shimmer");
  });

  test("summarizes ready usage as four operator-facing cards", () => {
    render(
      <MantineProvider>
        <UsagePanel task={fixtureTask({
          status: "completed",
          usage: {
            generationTurnRef: "turn-one",
            status: "available",
            task: {
              inputTokens: 100,
              cachedInputTokens: 200,
              outputTokens: 30,
              reasoningOutputTokens: 10,
              totalTokens: 330,
              estimatedCostUsd: 0.12,
              models: { "gpt-5.6-sol": {}, "gpt-5.6-luna": {} },
            },
          },
        })} />
      </MantineProvider>,
    );

    expect(screen.getByText("Tokens").nextSibling).toHaveTextContent("330");
    expect(screen.getByText("Estimated cost").nextSibling).toHaveTextContent("$0.1200");
    expect(screen.getByText("Model").nextSibling).toHaveTextContent("gpt-5.6-sol, gpt-5.6-luna");
    expect(screen.getByText("Cache ratio").nextSibling).toHaveTextContent("67%");
    expect(screen.queryByText(/API-equivalent/i)).not.toBeInTheDocument();
  });

  test("uses the same borderless link treatment wherever links are rendered", () => {
    render(<MantineProvider><GitHubLinks task={fixtureTask()} /></MantineProvider>);
    expect(screen.getByRole("link")).toHaveClass("taskchef-github-link");
  });
});
