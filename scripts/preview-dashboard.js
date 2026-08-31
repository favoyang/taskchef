#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addProject,
  createDashboardServer,
  initializeWorkspace,
  linkTask,
  manuallyTransitionTask,
  prepareDelegation,
  readTask,
  recordTask,
  reportTaskState,
} from "../index.js";
import { writeUsageStore } from "../src/usage.js";

const port = Number.parseInt(process.env.TASKCHEF_PREVIEW_PORT ?? "4321", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 3210) {
  throw new Error("TASKCHEF_PREVIEW_PORT must be a valid non-canonical port");
}

const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-mantine-preview-"));
const workspace = path.join(root, "dispatcher");
const projectPath = path.join(root, "safe-fixture-project");
await mkdir(projectPath);
await initializeWorkspace(workspace);
await addProject(workspace, {
  name: "TaskChef Preview",
  path: projectPath,
  description: "Synthetic operator-review data. No live TaskChef content.",
  githubRepos: [
    "https://github.com/favoyang/taskchef",
    "https://github.com/favoyang/guzuoshou-workspace",
  ],
});

const definitions = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    threadId: "019ffb69-57a6-7801-8b7a-8ff4c32a398c",
    turnRef: "01a03275-d530-7043-ab4a-513a1ad6ae1e",
    title: "Review checkout reconciliation",
    request: "Inspect the isolated checkout and summarize the operator-facing state.",
    terminal: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    threadId: "019ffb69-57a6-7801-8b7a-8ff4c32a398d",
    turnRef: "01a03275-d531-7043-ab4a-513a1ad6ae1e",
    title: "Calculate terminal token usage",
    request: "Verify the terminal usage reconciliation state.",
    terminal: "completed",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    threadId: "019ffb69-57a6-7801-8b7a-8ff4c32a398e",
    turnRef: "01a03275-d532-7043-ab4a-513a1ad6ae1e",
    title: "Confirm packaged preview assets",
    request: "Confirm deterministic package contents and usage estimate display for https://github.com/favoyang/taskchef/pull/83.",
    relatedReview: [
      "https://github.com/favoyang/taskchef/pull/83",
      "https://github.com/favoyang/guzuoshou-workspace/issues/124",
      "https://github.com/favoyang/taskchef/issues/79",
      "https://github.com/favoyang/guzuoshou-workspace/pull/109",
      "https://github.com/favoyang/taskchef/issues/80",
      "https://github.com/favoyang/guzuoshou-workspace/issues/108",
      "https://github.com/favoyang/taskchef/pull/82",
      "https://github.com/favoyang/guzuoshou-workspace/pull/112",
      "https://github.com/favoyang/guzuoshou-workspace/issues/114",
      "https://github.com/favoyang/guzuoshou-workspace/issues/115",
      "https://github.com/favoyang/guzuoshou-workspace/pull/118",
    ].join(", "),
    terminal: "completed",
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    threadId: "019ffb69-57a6-7801-8b7a-8ff4c32a398f",
    turnRef: "01a03275-d533-7043-ab4a-513a1ad6ae1e",
    title: "Resolve fixture accessibility question",
    request: "Choose whether the fixture should retain the compact mobile drawer.",
    terminal: "needs_input",
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    threadId: "019ffb69-57a6-7801-8b7a-8ff4c32a3990",
    turnRef: "01a03275-d534-7043-ab4a-513a1ad6ae1e",
    title: "Review unpriced cached token usage",
    request: "Confirm that known tokens remain visible when estimated cost is unavailable.",
    terminal: "completed",
  },
];

for (const definition of definitions) {
  await recordTask(workspace, {
    id: definition.id,
    project: projectPath,
    title: definition.title,
    instruction: prepareDelegation(
      `${definition.request}\n\nRelated review: ${definition.relatedReview ?? "https://github.com/favoyang/taskchef/pull/24"}`,
      { taskId: definition.id },
    ).instruction,
    threadId: null,
  });
  await linkTask(workspace, definition.id, definition.threadId);
  await reportTaskState(workspace, {
    taskId: definition.id,
    threadId: definition.threadId,
    turnRef: definition.turnRef,
    turnId: null,
    status: "working",
    requestSummary: definition.request,
  });
  if (definition.terminal) {
    await reportTaskState(workspace, {
      taskId: definition.id,
      threadId: definition.threadId,
      turnRef: definition.turnRef,
      turnId: null,
      status: definition.terminal,
      summary: definition.terminal === "needs_input"
        ? "Operator input is needed before the fixture choice is finalized."
        : "The safe fixture task completed successfully.",
    });
  }
}

function usageRecord(definition, {
  status,
  totalTokens = 0,
  estimatedCostUsd = null,
  reason,
}) {
  const updatedAt = new Date().toISOString();
  return {
    threadId: definition.threadId,
    generationTurnRef: definition.turnRef,
    generationTurnCount: 1,
    generationTerminal: definition.terminal !== null,
    zeroBaselineTurnRef: null,
    status,
    updatedAt,
    retryAfter: null,
    task: status === "available" ? {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens,
      estimatedCostUsd,
      costStatus: estimatedCostUsd === null ? "unavailable" : "estimated",
      models: {},
      provenance: {
        provider: "ccusage",
        version: "20.0.20",
        pricingMode: "offline",
        costCoverage: "ccusage_reported",
        sessionCount: 1,
      },
      sampledAt: updatedAt,
      sourceUpdatedAt: updatedAt,
    } : null,
    turns: status === "calculating"
      ? { [definition.turnRef]: { status: "calculating", updatedAt } }
      : {},
    boundaries: {},
    ...(reason ? { reason } : {}),
  };
}

const usageStore = {
  schemaVersion: 1,
  tasks: {
    [definitions[1].id]: usageRecord(definitions[1], { status: "calculating" }),
    [definitions[2].id]: usageRecord(definitions[2], {
      status: "available",
      totalTokens: 1_324_567,
      estimatedCostUsd: 12.3449,
    }),
    [definitions[3].id]: usageRecord(definitions[3], {
      status: "unavailable",
      reason: "No matching synthetic usage boundary.",
    }),
    [definitions[4].id]: usageRecord(definitions[4], {
      status: "available",
      totalTokens: 84_210,
      estimatedCostUsd: null,
    }),
  },
};
await writeUsageStore(workspace, usageStore);

const usageTracker = {
  async get(task) {
    if (task.id === definitions[0].id) {
      return { generationTurnRef: task.turnRef, status: "calculating", task: null, turns: {} };
    }
    if (task.id === definitions[1].id) {
      return { generationTurnRef: task.turnRef, status: "calculating", task: null, turns: {} };
    }
    if (task.id === definitions[2].id) {
      const ready = {
        inputTokens: 18420,
        cachedInputTokens: 7300,
        outputTokens: 2410,
        reasoningOutputTokens: 810,
        totalTokens: 1_324_567,
        estimatedCostUsd: 12.3449,
        models: { "gpt-5.6-sol": {}, "gpt-5.6-luna": {} },
      };
      return {
        generationTurnRef: task.turnRef,
        status: "available",
        task: ready,
        turns: { [task.turnRef]: { ...ready, status: "available" } },
      };
    }
    return { generationTurnRef: task.turnRef, status: "unavailable", reason: "No matching synthetic usage boundary.", task: null, turns: {} };
  },
};

const server = await createDashboardServer({
  workspace,
  port,
  launcher: "standalone",
  monitorOptions: { pollIntervalMs: 500 },
  openProject: async () => {},
  openThread: async () => {},
  usageTracker,
});

console.log(`TaskChef Mantine preview: ${server.url}`);
console.log(`Safe fixture workspace: ${workspace}`);
console.log("A synthetic notification alternates between completed and failed every 20 seconds.");
console.log("The calculating usage fixture becomes available after 20 seconds.");

const usageTransitionTimer = setTimeout(async () => {
  usageStore.tasks[definitions[1].id] = usageRecord(definitions[1], {
    status: "available",
    totalTokens: 48_320,
    estimatedCostUsd: 0.987,
  });
  await writeUsageStore(workspace, usageStore);
}, 20_000);

let nextStatus = "failed";
const notificationTimer = setInterval(async () => {
  try {
    const task = await readTask(workspace, definitions[3].id);
    await manuallyTransitionTask(workspace, task.id, {
      actionId: randomUUID(),
      expected: {
        status: task.status,
        turnRef: task.turnRef,
        threadId: task.threadId,
        updatedAt: task.updatedAt,
      },
      targetStatus: nextStatus,
    });
    nextStatus = nextStatus === "failed" ? "completed" : "failed";
  } catch (error) {
    console.error(`Preview notification update failed: ${error.message}`);
  }
}, 20_000);

async function close() {
  clearInterval(notificationTimer);
  clearTimeout(usageTransitionTimer);
  await server.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
