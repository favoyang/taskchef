import { MantineProvider } from "@mantine/core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { fixtureTask } from "./fixtures";
import {
  formatCompactTokens,
  formatEstimatedCost,
  turnUsageView,
  usageStillCalculating,
  usageView,
} from "./presentation";
import { ShimmerText } from "./components/ShimmerText";
import { GitHubLinks } from "./components/GitHubLinks";
import { LinkedText } from "./components/LinkedText";
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
    })).label).toBe("12.35K tokens · Estimated cost $0.12");
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
    expect(view.label).toBe("12.35K tokens · Estimated cost $0.12 · known so far");
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
    expect(turnUsageView(task, completedTurn).label).toBe("330 tokens · Estimated cost $0.12");
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
    expect(screen.getByText("Estimated cost").nextSibling).toHaveTextContent("$0.12");
    expect(screen.getByText("Model").nextSibling).toHaveTextContent("gpt-5.6-sol, gpt-5.6-luna");
    expect(screen.getByText("Cache ratio").nextSibling).toHaveTextContent("67%");
    expect(screen.queryByText(/API-equivalent/i)).not.toBeInTheDocument();
  });

  test("uses the same borderless link treatment wherever links are rendered", () => {
    render(<MantineProvider><GitHubLinks task={fixtureTask()} /></MantineProvider>);
    expect(screen.getByRole("link")).toHaveClass("taskchef-github-link");
  });

  test("formats compact token boundaries without scientific notation", () => {
    expect([
      0,
      999,
      1_000,
      1_100,
      12_345,
      999_999,
      1_320_000,
      1_000_000_000,
    ].map((value) => formatCompactTokens(value, "en-US"))).toEqual([
      "0",
      "999",
      "1K",
      "1.1K",
      "12.35K",
      "1M",
      "1.32M",
      "1B",
    ]);
  });

  test("formats estimates to two decimals across zero, sub-cent, missing, and large values", () => {
    expect(formatEstimatedCost(0, "en-US")).toBe("$0.00");
    expect(formatEstimatedCost(0.0049, "en-US")).toBe("$0.00");
    expect(formatEstimatedCost(12.344, "en-US")).toBe("$12.34");
    expect(formatEstimatedCost(12.345, "en-US")).toBe("$12.35");
    expect(formatEstimatedCost(null, "en-US")).toBe("—");
    expect(formatEstimatedCost(Number.NaN, "en-US")).toBe("—");
    expect(formatEstimatedCost(1_234_567_890.125, "en-US")).toBe("$1,234,567,890.13");
  });

  test("exposes full token precision and the unrounded estimate on ready metric cards", () => {
    render(
      <MantineProvider>
        <UsagePanel task={fixtureTask({
          status: "completed",
          usage: {
            status: "available",
            task: { totalTokens: 1_324_567, estimatedCostUsd: 12.3449 },
          },
        })} />
      </MantineProvider>,
    );
    expect(screen.getByLabelText("1,324,567 tokens")).toHaveTextContent("1.32M");
    expect(screen.getByLabelText("1,324,567 tokens")).toHaveAttribute("title", "1,324,567 tokens");
    expect(screen.getByLabelText("Estimated cost $12.34")).toHaveTextContent("$12.34");
    expect(screen.getByLabelText("Estimated cost $12.34")).toHaveAttribute(
      "title",
      "Unrounded estimate: $12.3449",
    );
  });

  test("groups, deduplicates, and naturally sorts compact related links by repository", () => {
    const task = fixtureTask({
      relatedGitHubLinks: [
        ["taskchef", "83", "pull"],
        ["guzuoshou-workspace", "124", "issue"],
        ["taskchef", "79", "issue"],
        ["guzuoshou-workspace", "108", "issue"],
        ["taskchef", "80", "issue"],
        ["guzuoshou-workspace", "109", "pull"],
        ["taskchef", "79", "pull"],
      ].map(([repository, number, type]) => ({
        label: `favoyang/${repository}#${number}`,
        number,
        owner: "favoyang",
        repository,
        type: type as "issue" | "pull",
        url: `https://github.com/favoyang/${repository}/${type === "pull" ? "pull" : "issues"}/${number}`,
      })),
    });
    const { container } = render(<MantineProvider><GitHubLinks task={task} /></MantineProvider>);
    const groups = container.querySelectorAll(".taskchef-github-group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0] as HTMLElement).getAllByRole("link").map((link) => link.textContent))
      .toEqual(["taskchef #79", "#80", "#83"]);
    expect(within(groups[1] as HTMLElement).getAllByRole("link").map((link) => link.textContent))
      .toEqual(["guzuoshou-workspace #108", "#109", "#124"]);
    const first = screen.getByRole("link", { name: /favoyang\/taskchef Issue #79/ });
    expect(first).toHaveAttribute("href", "https://github.com/favoyang/taskchef/issues/79");
    expect(first).toHaveAttribute("target", "_blank");
    expect(first).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByText(/PR #|Issue #/)).not.toBeInTheDocument();
  });

  test("keeps established inline request and result link labels", () => {
    const task = fixtureTask({
      project: {
        name: "TaskChef Preview",
        path: "/tmp/taskchef-preview-project",
        githubRepos: ["https://github.com/favoyang/taskchef"],
      },
      relatedGitHubRepository: "favoyang/taskchef",
    });
    const { container } = render(
      <MantineProvider>
        <div>
          <LinkedText task={task} text="Review https://github.com/favoyang/taskchef/pull/83." />
        </div>
      </MantineProvider>,
    );
    expect(within(container).getByRole("link", { name: /favoyang\/taskchef PR #83/ }))
      .toHaveTextContent("taskchef PR #83");
  });
});
