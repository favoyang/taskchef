import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { fixtureTask } from "./fixtures";
import {
  durationBetween,
  formatCompactTokens,
  formatEstimatedCost,
  formatReportedDuration,
  taskReportedWorkView,
  turnReportedWorkView,
  turnUsageMetricsView,
  turnUsageView,
  usageStillCalculating,
  usageView,
} from "./presentation";
import { ShimmerText } from "./components/ShimmerText";
import { GitHubLinks } from "./components/GitHubLinks";
import { LinkedText } from "./components/LinkedText";
import { UsagePanel } from "./components/UsagePanel";

afterEach(cleanup);

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

  test("summarizes ready usage and reported work as one operator-facing metric group", () => {
    const completedTurn = {
      ...fixtureTask().turns![0],
      result: {
        status: "completed" as const,
        summary: "Done.",
        updatedAt: "2026-08-30T08:18:32.000Z",
      },
    };
    render(
      <MantineProvider>
        <UsagePanel task={fixtureTask({
          status: "completed",
          turns: [completedTurn],
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
    expect(screen.getByText("Total reported work").nextSibling).toHaveTextContent("18m 32s");
    expect(screen.getByLabelText(/total reported work 18m 32s.*wall-clock/i)).toBeVisible();
    expect(screen.getByText("Model").nextSibling).toHaveTextContent("gpt-5.6-sol, gpt-5.6-luna");
    expect(screen.getByText("Cache ratio").nextSibling).toHaveTextContent("67%");
    expect(screen.queryByText(/API-equivalent/i)).not.toBeInTheDocument();
  });

  test("keeps reported work visible across pending, calculating, and unavailable usage", () => {
    for (const [task, expected, accessibleCost] of [
      [fixtureTask(), "Pending", "Estimated cost pending"],
      [
        fixtureTask({ status: "completed", usage: { status: "calculating" } }),
        "Calculating",
        "Estimated cost calculating",
      ],
      [
        fixtureTask({ status: "completed", usage: { status: "unavailable" } }),
        "Unavailable",
        "Estimated cost unavailable: Token usage unavailable",
      ],
    ] as const) {
      render(<MantineProvider><UsagePanel task={task} /></MantineProvider>);
      expect(screen.getByText("Tokens").nextSibling).toHaveTextContent(expected);
      expect(screen.getByText("Estimated cost").nextSibling).toHaveTextContent(expected);
      expect(screen.getByLabelText(accessibleCost)).toBeVisible();
      expect(screen.getByText("Total reported work").nextSibling).toHaveTextContent("Not yet reported");
      cleanup();
    }
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

describe("reported wall-clock work presentation", () => {
  test("covers formatting, derivation, unavailable boundaries, usage states, and accessibility", () => {
    expect(formatReportedDuration(500)).toBe("<1s");
    expect(formatReportedDuration(32_999)).toBe("32s");
    expect(formatReportedDuration((18 * 60 + 32) * 1_000 + 999)).toBe("18m 32s");
    expect(formatReportedDuration((2 * 60 + 14) * 60 * 1_000 + 59_999)).toBe("2h 14m");
    expect(formatReportedDuration((27 * 60 + 59) * 60 * 1_000)).toBe("1d 3h");
    expect(formatReportedDuration(-1)).toBeNull();
    expect(formatReportedDuration(Number.NaN)).toBeNull();

    {
    const task = fixtureTask({
      status: "working",
      turns: [
        {
          requestSummary: "First turn",
          startedAt: "2026-08-30T08:00:00.000Z",
          turnRef: "turn-one",
          turnId: null,
          result: {
            status: "completed",
            summary: "First done",
            updatedAt: "2026-08-30T08:18:32.000Z",
          },
        },
        {
          requestSummary: "Second turn after a long idle gap",
          startedAt: "2026-08-30T18:00:00.000Z",
          turnRef: "turn-two",
          turnId: null,
          result: {
            status: "failed",
            summary: "Second done",
            updatedAt: "2026-08-30T20:14:00.000Z",
          },
        },
        {
          requestSummary: "Active follow-up",
          startedAt: "2026-08-31T08:00:00.000Z",
          turnRef: "turn-three",
          turnId: null,
          result: null,
        },
      ],
    });
    const view = taskReportedWorkView(task);
    expect(view.kind).toBe("available");
    expect(view.value).toBe("2h 32m");
    expect(view.title).toMatch(/idle gaps are excluded/i);
    }

    {
    const invalid = fixtureTask({
      status: "completed",
      turns: [{
        requestSummary: "Historical turn",
        startedAt: "not-a-date",
        turnRef: "turn-one",
        turnId: null,
        result: { status: "completed", summary: "Done", updatedAt: "2026-08-30T08:00:00.000Z" },
      }],
    });
    expect(taskReportedWorkView(invalid)).toMatchObject({ kind: "unavailable", value: "Unavailable" });
    expect(durationBetween("2026-08-30T08:01:00.000Z", "2026-08-30T08:00:00.000Z")).toBeNull();
    expect(durationBetween("2026-02-30T08:00:00.000Z", "2026-03-02T08:01:00.000Z")).toBeNull();
    expect(durationBetween("March 2, 2026 08:00:00 UTC", "2026-03-02T08:01:00.000Z")).toBeNull();
    expect(turnReportedWorkView(invalid.turns![0])).toMatchObject({
      kind: "unavailable",
      label: "Elapsed",
      value: "Unavailable",
    });
    }

    {
    const terminalResult = {
      status: "completed" as const,
      summary: "Done.",
      updatedAt: "2026-08-30T08:00:00.000Z",
    };
    const legacyTurn = {
      requestSummary: null,
      startedAt: terminalResult.updatedAt,
      turnRef: "legacy-turn",
      turnId: null,
      provenance: { kind: "legacy" },
      result: terminalResult,
    };
    const terminalOnlyTurn = {
      ...legacyTurn,
      turnRef: "terminal-only-turn",
      provenance: { kind: "mcp" },
    };
    for (const turn of [legacyTurn, terminalOnlyTurn]) {
      expect(turnReportedWorkView(turn)).toMatchObject({ kind: "unavailable", value: "Unavailable" });
      expect(taskReportedWorkView(fixtureTask({ status: "completed", turns: [turn] })))
        .toMatchObject({ kind: "unavailable", value: "Unavailable" });
    }
    }

    {
    const observed = {
      requestSummary: "Perform the observed turn.",
      startedAt: "2026-08-30T08:00:00.000Z",
      turnRef: "observed-turn",
      turnId: null,
      provenance: { kind: "mcp" },
      result: {
        status: "completed" as const,
        summary: "Done.",
        updatedAt: "2026-08-30T08:00:00.000Z",
      },
    };
    expect(turnReportedWorkView(observed)).toMatchObject({ kind: "unavailable", value: "Unavailable" });
    expect(turnReportedWorkView({
      ...observed,
      result: { ...observed.result, updatedAt: "2026-08-30T08:00:00.500Z" },
    })).toMatchObject({ kind: "available", value: "<1s" });
    }

    {
    const compactTerminal = fixtureTask({
      status: "completed",
      turns: undefined,
      latestTurn: {
        ...fixtureTask().latestTurn!,
        result: {
          status: "completed",
          summary: "Done.",
          updatedAt: "2026-08-30T08:18:32.000Z",
        },
      },
    });
    expect(taskReportedWorkView(compactTerminal)).toMatchObject({
      kind: "unavailable",
      value: "Unavailable",
    });
    render(<MantineProvider><UsagePanel task={compactTerminal} /></MantineProvider>);
    expect(screen.getByText("Total reported work").nextSibling).toHaveTextContent("Unavailable");
    cleanup();
    }

    {
    const priorResult = {
      status: "completed" as const,
      summary: "Prior turn done.",
      updatedAt: "2026-08-30T08:18:32.000Z",
      turnRef: "turn-one",
      turnId: null,
    };
    expect(taskReportedWorkView(fixtureTask({
      status: "working",
      turnRef: "turn-two",
      turns: undefined,
      lastResult: priorResult,
      results: undefined,
    }))).toMatchObject({ kind: "unavailable", value: "Unavailable" });
    }

    {
    render(
      <MantineProvider>
        <UsagePanel task={fixtureTask({
          status: "completed",
          usage: { status: "unavailable", reason: "No matching cached boundary." },
        })} />
      </MantineProvider>,
    );
    expect(screen.getByText("No matching cached boundary.")).toBeVisible();
    expect(screen.getByLabelText("No matching cached boundary.")).toBeVisible();
    cleanup();
    }

    {
    const task = fixtureTask();
    expect(turnReportedWorkView(task.turns![0], Date.parse("2026-08-30T08:18:32.000Z"))).toMatchObject({
      label: "Elapsed so far",
      value: "18m 32s",
    });
    expect(turnUsageMetricsView(task, task.turns![0])).toMatchObject({
      animated: true,
      cost: { value: "Pending" },
      tokens: { value: "Pending" },
    });
    }
  });
});
