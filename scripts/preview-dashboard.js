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
  githubRepos: ["https://github.com/example/taskchef-preview"],
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
    request: "Confirm deterministic package contents and usage estimate display.",
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
];

for (const definition of definitions) {
  await recordTask(workspace, {
    id: definition.id,
    project: projectPath,
    title: definition.title,
    instruction: prepareDelegation(
      `${definition.request}\n\nRelated review: https://github.com/example/taskchef-preview/pull/24`,
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
        totalTokens: 20830,
        estimatedCostUsd: 0.1432,
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
  await server.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
