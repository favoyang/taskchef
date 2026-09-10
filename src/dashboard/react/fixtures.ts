import type { Task } from "./types";

export function fixtureTask(overrides: Partial<Task> = {}): Task {
  const timestamp = "2026-08-30T08:00:00.000Z";
  const id = overrides.id ?? "11111111-1111-4111-8111-111111111111";
  return {
    id,
    schemaVersion: 10,
    title: "Review checkout reconciliation",
    instruction: "Verify the isolated dashboard fixture without using live TaskChef data.",
    project: {
      name: "TaskChef Preview",
      path: "/tmp/taskchef-preview-project",
      githubRepos: ["https://github.com/example/taskchef-preview"],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    meaningfulUpdatedAt: timestamp,
    updatedBy: "mcp",
    status: "working",
    summary: null,
    threadId: "019ffb69-57a6-7801-8b7a-8ff4c32a398c",
    turnRef: "turn-one",
    turnId: null,
    lastResult: null,
    latestTurn: {
      requestSummary: "Review the operator-facing task state.",
      result: null,
      startedAt: timestamp,
      turnRef: "turn-one",
      turnId: null,
    },
    turns: [{
      requestSummary: "Review the operator-facing task state.",
      result: null,
      startedAt: timestamp,
      turnRef: "turn-one",
      turnId: null,
    }],
    results: [],
    usage: { generationTurnRef: "turn-one", status: "pending" },
    relatedGitHubLinks: [{
      label: "example/taskchef-preview#24",
      owner: "example",
      repository: "taskchef-preview",
      number: "24",
      type: "pull",
      url: "https://github.com/example/taskchef-preview/pull/24",
    }],
    ...overrides,
  };
}
