import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateCcusageSessions,
  compactUsageStore,
  readUsageStore,
  readCcusageThreadUsage,
  usageDelta,
  writeUsageStore,
} from "../src/usage.js";
import { createUsageTracker } from "../src/usage-tracker.js";

const THREAD_ID = "01a047b4-b28e-7fe3-8d08-92311bcaad9e";
const FIRST_TURN = "ce886d09-f19a-4299-a6d0-6190ac1b77cb";
const SECOND_TURN = "98d66c9f-58e8-4ba6-9f46-286ab64db1ce";
const THIRD_TURN = "28c5c2f7-e735-48c9-b788-65ea2c383513";

function session(suffix, values = {}) {
  const inputTokens = values.inputTokens ?? 10;
  const cacheReadTokens = values.cacheReadTokens ?? 20;
  const outputTokens = values.outputTokens ?? 5;
  return {
    sessionId: `2026/08/28/rollout-${THREAD_ID}${suffix}`,
    sessionFile: `rollout-${THREAD_ID}${suffix}`,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    reasoningOutputTokens: values.reasoningOutputTokens ?? 2,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    costUSD: values.costUSD ?? 0.02,
    lastActivity: values.lastActivity ?? "2026-08-28T13:40:00.000Z",
    models: {
      [values.model ?? "gpt-test"]: {
        inputTokens,
        cacheReadTokens,
        outputTokens,
        reasoningOutputTokens: values.reasoningOutputTokens ?? 2,
        totalTokens: inputTokens + cacheReadTokens + outputTokens,
      },
    },
  };
}

test("ccusage adapter aggregates every session segment for one exact Codex thread", () => {
  const usage = aggregateCcusageSessions({
    sessions: [
      session(""),
      session("_01a04878-e7d8-7d12-a393-c91eea3483fb", {
        inputTokens: 3,
        cacheReadTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        costUSD: 0.01,
        model: "gpt-test-next",
        lastActivity: "2026-08-28T13:41:00.000Z",
      }),
      { ...session(""), sessionId: "rollout-019ffb69-57a6-7801-8b7a-8ff4c32a398c",
        sessionFile: "rollout-019ffb69-57a6-7801-8b7a-8ff4c32a398c" },
      { ...session(""),
        sessionId: `rollout-019ffb69-57a6-7801-8b7a-8ff4c32a398c_${THREAD_ID}`,
        sessionFile: `rollout-019ffb69-57a6-7801-8b7a-8ff4c32a398c_${THREAD_ID}` },
    ],
  }, THREAD_ID, { sampledAt: "2026-08-28T13:42:00.000Z", version: "20.0.14" });

  assert.equal(usage.inputTokens, 13);
  assert.equal(usage.cachedInputTokens, 24);
  assert.equal(usage.outputTokens, 7);
  assert.equal(usage.reasoningOutputTokens, 3);
  assert.equal(usage.totalTokens, 44);
  assert.equal(usage.estimatedCostUsd, 0.03);
  assert.equal(usage.provenance.sessionCount, 2);
  assert.deepEqual(Object.keys(usage.models).sort(), ["gpt-test", "gpt-test-next"]);
  assert.equal(usage.sourceUpdatedAt, "2026-08-28T13:41:00.000Z");
});

test("ccusage adapter keeps zero-priced positive usage explicitly cost-unavailable", () => {
  const usage = aggregateCcusageSessions({ sessions: [session("", { costUSD: 0 })] }, THREAD_ID);
  assert.equal(usage.estimatedCostUsd, null);
  assert.equal(usage.costStatus, "unavailable");
});

test("ccusage adapter does not present a partial aggregate cost as complete", () => {
  const usage = aggregateCcusageSessions({ sessions: [
    session("", { costUSD: 0.02 }),
    session("_01a04878-e7d8-7d12-a393-c91eea3483fb", { costUSD: 0 }),
  ] }, THREAD_ID);
  assert.equal(usage.estimatedCostUsd, null);
  assert.equal(usage.costStatus, "unavailable");
});

test("ccusage adapter retains tokens when analyzer pricing is missing", () => {
  const unpriced = session("");
  delete unpriced.costUSD;
  const usage = aggregateCcusageSessions({ sessions: [unpriced] }, THREAD_ID);
  assert.equal(usage.totalTokens, 35);
  assert.equal(usage.estimatedCostUsd, null);
  assert.equal(usage.costStatus, "unavailable");
});

test("ccusage model names cannot mutate object prototypes", () => {
  const crafted = session("");
  const modelUsage = crafted.models["gpt-test"];
  crafted.models = Object.fromEntries([
    ["__proto__", modelUsage],
    ["constructor", modelUsage],
    ["prototype", modelUsage],
  ]);
  const usage = aggregateCcusageSessions({ sessions: [crafted] }, THREAD_ID);
  assert.deepEqual(Object.keys(usage.models).sort(), ["__proto__", "constructor", "prototype"]);
  assert.equal(({}).inputTokens, undefined);
});

test("ccusage execution is offline, bounded, structured, and optional", async () => {
  const calls = [];
  const run = async (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === "--version") return { stdout: "ccusage 20.0.14\n" };
    return { stdout: JSON.stringify({ sessions: [session("")] }) };
  };
  const usage = await readCcusageThreadUsage(THREAD_ID, { run });
  assert.equal(usage.provenance.version, "20.0.14");
  assert.deepEqual(calls[1].args, ["codex", "session", "--json", "--offline"]);
  assert.equal(calls[1].options.timeout, 8_000);
  await assert.rejects(
    readCcusageThreadUsage(THREAD_ID, { run: async () => { const error = new Error(); error.code = "ENOENT"; throw error; } }),
    /not installed/,
  );
});

test("turn deltas preserve cached and reasoning subsets and reject decreasing snapshots", () => {
  const previous = aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID);
  const current = aggregateCcusageSessions({ sessions: [session("", {
    inputTokens: 13,
    cacheReadTokens: 27,
    outputTokens: 9,
    reasoningOutputTokens: 4,
    costUSD: 0.03,
  })] }, THREAD_ID);
  assert.deepEqual(usageDelta(current, previous), {
    inputTokens: 3,
    cachedInputTokens: 7,
    outputTokens: 4,
    reasoningOutputTokens: 2,
    totalTokens: 14,
    estimatedCostUsd: 0.009999999999999998,
    costStatus: "estimated",
  });
  assert.equal(usageDelta(previous, current), null);
});

test("a decreasing price invalidates only cost while preserving token deltas", () => {
  const previous = aggregateCcusageSessions({ sessions: [session("", { costUSD: 0.05 })] }, THREAD_ID);
  const current = aggregateCcusageSessions({ sessions: [session("", {
    inputTokens: 13,
    cacheReadTokens: 27,
    outputTokens: 9,
    reasoningOutputTokens: 4,
    costUSD: 0.04,
  })] }, THREAD_ID);
  const delta = usageDelta(current, previous);
  assert.equal(delta.totalTokens, 14);
  assert.equal(delta.estimatedCostUsd, null);
  assert.equal(delta.costStatus, "unavailable");
});

test("positive token growth with unchanged cumulative cost is cost-unavailable", () => {
  const previous = aggregateCcusageSessions({ sessions: [session("", { costUSD: 0.05 })] }, THREAD_ID);
  const current = aggregateCcusageSessions({ sessions: [session("", {
    inputTokens: 13,
    cacheReadTokens: 27,
    outputTokens: 9,
    reasoningOutputTokens: 4,
    costUSD: 0.05,
  })] }, THREAD_ID);
  const delta = usageDelta(current, previous);
  assert.equal(delta.totalTokens, 14);
  assert.equal(delta.estimatedCostUsd, null);
  assert.equal(delta.costStatus, "unavailable");
});

test("tracker backfills task totals but leaves historical turns without boundaries unavailable", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions(
      { sessions: [session("")] },
      THREAD_ID,
      { sampledAt: "2026-08-28T13:42:00.000Z", version: "20.0.14" },
    ),
  });
  const task = {
    id: "task-one",
    threadId: THREAD_ID,
    turns: [
      { turnRef: FIRST_TURN, result: { status: "completed" } },
      { turnRef: SECOND_TURN, result: { status: "completed" } },
    ],
    latestTurn: { turnRef: SECOND_TURN, result: { status: "completed" } },
  };

  const initial = await tracker.get(task);
  assert.equal(initial.status, "calculating");
  let store;
  for (let spin = 0; spin < 100; spin += 1) {
    if (timers.length > 0) await timers.shift()();
    else await new Promise((resolve) => setImmediate(resolve));
    try {
      store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
      if (store.tasks[task.id]?.status === "available") break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  assert.ok(store, "usage cache should be written by the background calculation");
  assert.equal(store.tasks[task.id].status, "available");
  assert.equal(store.tasks[task.id].task.totalTokens, 35);
  assert.equal(store.tasks[task.id].turns[FIRST_TURN].status, "unavailable");
  assert.equal(store.tasks[task.id].turns[SECOND_TURN].status, "unavailable");
});

test("tracker never assigns a historical one-turn task total to that turn", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-one-history-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  const task = {
    id: "task-one-history",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  assert.equal((await tracker.get(task)).status, "calculating");
  let store;
  for (let spin = 0; spin < 100; spin += 1) {
    if (timers.length > 0) await timers.shift()();
    else await new Promise((resolve) => setImmediate(resolve));
    try {
      store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
      if (store.tasks[task.id]?.status === "available") break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  assert.ok(store, "historical usage cache should be written");
  assert.equal(store.tasks[task.id].task.totalTokens, 35);
  assert.equal(store.tasks[task.id].turns[FIRST_TURN].status, "unavailable");
  assert.equal(store.tasks[task.id].boundaries[FIRST_TURN].totalTokens, 35);
});

test("tracker records adjacent cumulative boundaries as per-turn token and cost deltas", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-delta-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  let snapshot = aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID);
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => snapshot,
  });
  const first = {
    id: "task-delta",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: null }],
    latestTurn: { turnRef: FIRST_TURN, result: null },
  };
  await tracker.observe(first);
  const completedFirst = {
    ...first,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await tracker.observe(completedFirst);
  while (timers.length > 0) await timers.shift()();

  snapshot = aggregateCcusageSessions({ sessions: [session("", {
    inputTokens: 15,
    cacheReadTokens: 22,
    outputTokens: 8,
    reasoningOutputTokens: 3,
    costUSD: 0.03,
  })] }, THREAD_ID);
  const second = {
    ...completedFirst,
    turns: [...completedFirst.turns, { turnRef: SECOND_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: SECOND_TURN, result: { status: "completed" } },
  };
  await tracker.observe(second);
  while (timers.length > 0) await timers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[second.id].turns[FIRST_TURN].totalTokens, 35);
  assert.equal(store.tasks[second.id].turns[SECOND_TURN].totalTokens, 10);
  assert.equal(store.tasks[second.id].turns[SECOND_TURN].estimatedCostUsd, 0.009999999999999998);
  assert.equal(store.tasks[second.id].turns[SECOND_TURN].provenance.provider, "ccusage");
  assert.ok(store.tasks[second.id].turns[SECOND_TURN].sampledAt);
});

test("a stable pre-turn snapshot waits for advancement before recording a boundary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-stale-stable-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const firstSnapshot = aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID);
  const advancedSnapshot = aggregateCcusageSessions({ sessions: [session("", {
    inputTokens: 15, cacheReadTokens: 22, outputTokens: 8, costUSD: 0.03,
  })] }, THREAD_ID);
  let snapshots = [firstSnapshot, firstSnapshot];
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0, 0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => snapshots.shift() ?? advancedSnapshot,
  });
  const workingFirst = {
    id: "task-stale-stable",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: null }],
    latestTurn: { turnRef: FIRST_TURN, result: null },
  };
  await tracker.observe(workingFirst);
  const completedFirst = {
    ...workingFirst,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await tracker.observe(completedFirst);
  while (timers.length > 0) await timers.shift()();

  snapshots = [firstSnapshot, firstSnapshot, advancedSnapshot, advancedSnapshot];
  const completedSecond = {
    ...completedFirst,
    turns: [...completedFirst.turns, { turnRef: SECOND_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: SECOND_TURN, result: { status: "completed" } },
  };
  await tracker.observe(completedSecond);
  while (timers.length > 0) await timers.shift()();
  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[completedSecond.id].turns[SECOND_TURN].status, "available");
  assert.equal(store.tasks[completedSecond.id].turns[SECOND_TURN].totalTokens, 10);
  assert.equal(store.tasks[completedSecond.id].boundaries[SECOND_TURN].totalTokens, 45);
});

test("a newer turn invalidates an older deferred job instead of misattributing tokens", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-overlap-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  const first = {
    id: "task-overlap",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await tracker.observe(first);
  await tracker.observe({
    ...first,
    turns: [...first.turns, { turnRef: SECOND_TURN, result: null }],
    latestTurn: { turnRef: SECOND_TURN, result: null },
  });
  await timers.shift()();
  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[first.id].turns[FIRST_TURN].status, "unavailable");
  assert.equal(store.tasks[first.id].boundaries[FIRST_TURN], undefined);
});

test("a shared cache generation rejects stale reconciliation from another tracker", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-shared-overlap-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const staleTimers = [];
  const staleTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { staleTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  const first = {
    id: "task-shared-overlap",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await staleTracker.observe(first);

  const currentTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer() { return { unref() {} }; },
  });
  await currentTracker.observe({
    ...first,
    turns: [...first.turns, { turnRef: SECOND_TURN, result: null }],
    latestTurn: { turnRef: SECOND_TURN, result: null },
  });
  while (staleTimers.length > 0) await staleTimers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[first.id].generationTurnRef, SECOND_TURN);
  assert.equal(store.tasks[first.id].turns[FIRST_TURN].status, "unavailable");
  assert.equal(store.tasks[first.id].boundaries[FIRST_TURN], undefined);
});

test("a stale terminal observer cannot roll back a newer working generation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-generation-order-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const staleTimers = [];
  const newerTracker = createUsageTracker({ workspace, setTimer() { return { unref() {} }; } });
  const olderTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { staleTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  const olderTerminal = {
    id: "task-generation-order",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  const newerWorking = {
    ...olderTerminal,
    turns: [...olderTerminal.turns, { turnRef: SECOND_TURN, result: null }],
    latestTurn: { turnRef: SECOND_TURN, result: null },
  };
  await newerTracker.observe(newerWorking);
  await olderTracker.observe(olderTerminal);
  while (staleTimers.length > 0) await staleTimers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[olderTerminal.id].generationTurnRef, SECOND_TURN);
  assert.equal(store.tasks[olderTerminal.id].generationTurnCount, 2);
  assert.equal(store.tasks[olderTerminal.id].boundaries[FIRST_TURN], undefined);
});

test("an unstable final sample updates the task total but never becomes a turn boundary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-unstable-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  let sample = 10;
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("", {
      inputTokens: sample++, cacheReadTokens: 0, outputTokens: 0, costUSD: 0.01,
    })] }, THREAD_ID),
  });
  const task = {
    id: "task-unstable",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await tracker.observe(task);
  while (timers.length > 0) await timers.shift()();
  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[task.id].status, "available");
  assert.equal(store.tasks[task.id].turns[FIRST_TURN].status, "unavailable");
  assert.equal(store.tasks[task.id].boundaries[FIRST_TURN], undefined);
});

test("a new tracker resumes a terminal calculation persisted by an exited process", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-restart-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const abandonedTimers = [];
  const task = {
    id: "task-restart",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  const firstTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0],
    setTimer(callback) { abandonedTimers.push(callback); return { unref() {} }; },
  });
  await firstTracker.observe({
    ...task,
    turns: [{ turnRef: FIRST_TURN, result: null }],
    latestTurn: { turnRef: FIRST_TURN, result: null },
  });
  await firstTracker.observe(task);

  const resumedTimers = [];
  const secondTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { resumedTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  assert.equal((await secondTracker.get(task)).status, "calculating");
  for (let spin = 0; spin < 100 && resumedTimers.length === 0; spin += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  while (resumedTimers.length > 0) await resumedTimers.shift()();
  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[task.id].status, "available");
  assert.equal(store.tasks[task.id].turns[FIRST_TURN].status, "available");
});

test("a duplicate terminal report cannot degrade an available turn across trackers", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-duplicate-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const firstTimers = [];
  const task = {
    id: "task-duplicate",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: null }],
    latestTurn: { turnRef: FIRST_TURN, result: null },
  };
  const firstTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { firstTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  await firstTracker.observe(task);
  const completed = {
    ...task,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await firstTracker.observe(completed);
  while (firstTimers.length > 0) await firstTimers.shift()();

  const duplicateTimers = [];
  const duplicateTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0],
    setTimer(callback) { duplicateTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => { throw new Error("temporary analyzer failure"); },
  });
  const duplicateState = await duplicateTracker.observe(completed);
  assert.equal(duplicateState.status, "available");
  while (duplicateTimers.length > 0) await duplicateTimers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[completed.id].status, "available");
  assert.equal(store.tasks[completed.id].turns[FIRST_TURN].status, "available");
  assert.equal(store.tasks[completed.id].turns[FIRST_TURN].totalTokens, 35);
});

test("a late tracker cannot rewrite another tracker's reliable boundary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-monotonic-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const stableTimers = [];
  const unstableTimers = [];
  const working = {
    id: "task-monotonic",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: null }],
    latestTurn: { turnRef: FIRST_TURN, result: null },
  };
  const stableTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { stableTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  const lateTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { unstableTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("", {
      inputTokens: 20, cacheReadTokens: 20, outputTokens: 5, costUSD: 0.03,
    })] }, THREAD_ID),
  });
  await stableTracker.observe(working);
  const completed = {
    ...working,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await stableTracker.observe(completed);
  await lateTracker.observe(completed);
  while (stableTimers.length > 0) await stableTimers.shift()();
  while (unstableTimers.length > 0) await unstableTimers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[completed.id].turns[FIRST_TURN].status, "available");
  assert.equal(store.tasks[completed.id].turns[FIRST_TURN].totalTokens, 35);
  assert.equal(store.tasks[completed.id].boundaries[FIRST_TURN].totalTokens, 35);
  assert.equal(store.tasks[completed.id].task.totalTokens, 45);
});

test("an older cross-tracker snapshot cannot replace a newer historical boundary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-freshness-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const oldTimers = [];
  const newTimers = [];
  const task = {
    id: "task-freshness",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  const oldTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { oldTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("", {
      inputTokens: 75, cacheReadTokens: 20, outputTokens: 5, costUSD: 0.03,
    })] }, THREAD_ID, { sampledAt: "2026-08-28T13:00:00.000Z" }),
  });
  const newTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { newTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("", {
      inputTokens: 175, cacheReadTokens: 20, outputTokens: 5, costUSD: 0.05,
    })] }, THREAD_ID, { sampledAt: "2026-08-28T14:00:00.000Z" }),
  });
  await oldTracker.observe(task);
  await newTracker.observe(task);
  while (newTimers.length > 0) await newTimers.shift()();
  while (oldTimers.length > 0) await oldTimers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[task.id].task.totalTokens, 200);
  assert.equal(store.tasks[task.id].boundaries[FIRST_TURN].totalTokens, 200);
  assert.equal(store.tasks[task.id].turns[FIRST_TURN].status, "unavailable");
});

test("opening a working task cannot occupy its terminal reconciliation job", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-working-get-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  const working = {
    id: "task-working-get",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: null }],
    latestTurn: { turnRef: FIRST_TURN, result: null },
  };
  assert.equal((await tracker.get(working)).status, "calculating");
  for (let spin = 0; spin < 100; spin += 1) {
    if (await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8").catch(() => null)) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(timers.length, 0);

  await tracker.observe({
    ...working,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  });
  assert.equal(timers.length, 1);
  while (timers.length > 0) await timers.shift()();
  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[working.id].turns[FIRST_TURN].status, "available");
});

test("linked tasks with no turns never schedule usage reconciliation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-no-turns-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  let scheduled = 0;
  const tracker = createUsageTracker({
    workspace,
    setTimer() { scheduled += 1; return { unref() {} }; },
  });
  const task = { id: "task-no-turns", threadId: THREAD_ID, turns: [], latestTurn: null };
  assert.equal((await tracker.get(task)).status, "unavailable");
  assert.equal((await tracker.get(task)).status, "unavailable");
  assert.equal(scheduled, 0);
});

test("manual dashboard turns never schedule or establish Codex usage boundaries", async () => {
  for (const [name, priorStatus, withBoundary] of [
    ["needs-input", "needs_input", true],
    ["interrupted-working", "interrupted", false],
  ]) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), `taskchef-usage-manual-${name}-`));
    await writeFile(path.join(workspace, "tasks.jsonl"), "");
    const snapshot = aggregateCcusageSessions(
      { sessions: [session("")] },
      THREAD_ID,
      { sampledAt: "2026-08-28T14:00:00.000Z" },
    );
    await writeUsageStore(workspace, {
      schemaVersion: 1,
      tasks: {
        [name]: {
          threadId: THREAD_ID,
          generationTurnRef: FIRST_TURN,
          generationTurnCount: 1,
          generationTerminal: priorStatus !== "interrupted",
          zeroBaselineTurnRef: null,
          status: "available",
          updatedAt: snapshot.sampledAt,
          retryAfter: null,
          task: snapshot,
          turns: {
            [FIRST_TURN]: {
              status: "unavailable",
              reason: "Fixture boundary state.",
              updatedAt: snapshot.sampledAt,
            },
          },
          boundaries: withBoundary ? { [FIRST_TURN]: snapshot } : {},
        },
      },
    });
    let scheduled = 0;
    const tracker = createUsageTracker({
      workspace,
      setTimer() { scheduled += 1; return { unref() {} }; },
    });
    const manualTurn = {
      turnRef: SECOND_TURN,
      turnId: null,
      provenance: { kind: "dashboard_manual" },
      result: { status: "completed" },
    };
    const task = {
      id: name,
      threadId: THREAD_ID,
      turns: [
        { turnRef: FIRST_TURN, provenance: { kind: "mcp" }, result: { status: priorStatus } },
        manualTurn,
      ],
      latestTurn: manualTurn,
    };
    const usage = await tracker.observe(task);
    assert.equal(scheduled, 0);
    assert.equal(usage.status, "available");
    assert.equal(usage.task.totalTokens, snapshot.totalTokens);
    assert.deepEqual(usage.turns[SECOND_TURN], {
      status: "unavailable",
      reason: "Administrative action; no Codex usage boundary.",
      updatedAt: usage.turns[SECOND_TURN].updatedAt,
    });
    assert.equal(usage.boundaries[SECOND_TURN], undefined);
    assert.equal((await tracker.get(task)).turns[SECOND_TURN].reason,
      "Administrative action; no Codex usage boundary.");
  }
});

test("a later executor turn skips a manual action when selecting its prior usage boundary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-after-manual-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const previous = aggregateCcusageSessions(
    { sessions: [session("")] },
    THREAD_ID,
    { sampledAt: "2026-08-28T14:00:00.000Z" },
  );
  await writeUsageStore(workspace, {
    schemaVersion: 1,
    tasks: {
      "after-manual": {
        threadId: THREAD_ID,
        generationTurnRef: SECOND_TURN,
        generationTurnCount: 2,
        generationTerminal: false,
        zeroBaselineTurnRef: null,
        status: "available",
        updatedAt: previous.sampledAt,
        retryAfter: null,
        task: previous,
        turns: {
          [FIRST_TURN]: { status: "unavailable", reason: "Fixture.", updatedAt: previous.sampledAt },
          [SECOND_TURN]: {
            status: "unavailable",
            reason: "Administrative action; no Codex usage boundary.",
            updatedAt: previous.sampledAt,
          },
        },
        boundaries: { [FIRST_TURN]: previous },
      },
    },
  });
  const timers = [];
  const advanced = aggregateCcusageSessions({ sessions: [session("", {
    inputTokens: 20,
    cacheReadTokens: 20,
    outputTokens: 10,
    costUSD: 0.04,
  })] }, THREAD_ID, { sampledAt: "2026-08-28T14:01:00.000Z" });
  let current = previous;
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0, 0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => current,
  });
  const manualTurn = {
    turnRef: SECOND_TURN,
    provenance: { kind: "dashboard_manual" },
    result: { status: "completed" },
  };
  const executorTurn = {
    turnRef: THIRD_TURN,
    provenance: { kind: "mcp" },
    result: { status: "completed" },
  };
  const task = {
    id: "after-manual",
    threadId: THREAD_ID,
    turns: [
      { turnRef: FIRST_TURN, provenance: { kind: "mcp" }, result: { status: "needs_input" } },
      manualTurn,
      executorTurn,
    ],
    latestTurn: executorTurn,
  };
  await tracker.observe(task);
  await timers.shift()();
  await timers.shift()();
  const calculating = await tracker.get(task);
  assert.equal(calculating.turns[THIRD_TURN].status, "calculating");
  assert.equal(timers.length, 1);

  current = advanced;
  while (timers.length > 0) await timers.shift()();
  const usage = await tracker.get(task);
  assert.equal(usage.turns[THIRD_TURN].status, "available");
  assert.equal(usage.turns[THIRD_TURN].totalTokens, advanced.totalTokens - previous.totalTokens);
  assert.equal(usage.boundaries[SECOND_TURN], undefined);
});

test("a failed job cannot make the next turn's first sample appear stable", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-fingerprint-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const snapshot = aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID);
  let phase = "failing";
  let failureCalls = 0;
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => {
      if (phase === "failing" && failureCalls++ > 0) throw new Error("temporary analyzer failure");
      return snapshot;
    },
  });
  const first = {
    id: "task-fingerprint",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  await tracker.observe(first);
  while (timers.length > 0) await timers.shift()();

  phase = "next";
  const workingSecond = {
    ...first,
    turns: [...first.turns, { turnRef: SECOND_TURN, result: null }],
    latestTurn: { turnRef: SECOND_TURN, result: null },
  };
  await tracker.observe(workingSecond);
  const completedSecond = {
    ...workingSecond,
    turns: [...first.turns, { turnRef: SECOND_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: SECOND_TURN, result: { status: "completed" } },
  };
  await tracker.observe(completedSecond);
  await timers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[first.id].status, "calculating");
  assert.equal(store.tasks[first.id].turns[SECOND_TURN].status, "calculating");
});

test("retrying unavailable usage returns calculating until recovery is visible", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-recovery-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const failedTimers = [];
  const task = {
    id: "task-recovery",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  const failingTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0],
    retryCooldownMs: 0,
    setTimer(callback) { failedTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => { throw new Error("temporary analyzer failure"); },
  });
  await failingTracker.observe(task);
  while (failedTimers.length > 0) await failedTimers.shift()();

  const recoveryTimers = [];
  const recoveryTracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { recoveryTimers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  assert.equal((await recoveryTracker.get(task)).status, "calculating");
  for (let spin = 0; spin < 100 && recoveryTimers.length === 0; spin += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  while (recoveryTimers.length > 0) await recoveryTimers.shift()();
  assert.equal((await recoveryTracker.get(task)).status, "available");
});

test("permanent analyzer failure settles as unavailable during its retry cooldown", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-cooldown-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const task = {
    id: "task-cooldown",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => { throw new Error("permanent analyzer failure"); },
  });
  await tracker.observe(task);
  while (timers.length > 0) await timers.shift()();
  assert.equal((await tracker.get(task)).status, "unavailable");
  assert.equal(timers.length, 0);
});

test("interrupted latest turns never produce a usage boundary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-interrupted-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  let scheduled = 0;
  const task = {
    id: "task-interrupted",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: { status: "interrupted" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "interrupted" } },
  };
  const tracker = createUsageTracker({
    workspace,
    setTimer() { scheduled += 1; return { unref() {} }; },
  });
  const observed = await tracker.observe(task);
  assert.equal(observed.turns[FIRST_TURN].status, "unavailable");
  assert.equal(scheduled, 0);
  assert.equal((await tracker.get(task)).turns[FIRST_TURN].status, "unavailable");
});

test("working and terminal observations serialize to preserve the first-turn baseline", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-observation-order-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const working = {
    id: "task-observation-order",
    threadId: THREAD_ID,
    turns: [{ turnRef: FIRST_TURN, result: null }],
    latestTurn: { turnRef: FIRST_TURN, result: null },
  };
  const terminal = {
    ...working,
    turns: [{ turnRef: FIRST_TURN, result: { status: "completed" } }],
    latestTurn: { turnRef: FIRST_TURN, result: { status: "completed" } },
  };
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  await Promise.all([tracker.observe(working), tracker.observe(terminal)]);
  while (timers.length > 0) await timers.shift()();
  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  assert.equal(store.tasks[working.id].zeroBaselineTurnRef, FIRST_TURN);
  assert.equal(store.tasks[working.id].turns[FIRST_TURN].status, "available");
});

test("usage cache compaction retains recent tasks and only useful boundary history", async () => {
  const tasks = Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [
    `task-${index}`,
    {
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      turns: Object.fromEntries(Array.from({ length: 300 }, (__, turn) => [`turn-${turn}`, { turn }])),
      boundaries: Object.fromEntries(Array.from({ length: 10 }, (__, turn) => [`turn-${turn}`, { turn }])),
    },
  ]));
  const compacted = compactUsageStore({ schemaVersion: 1, tasks });
  assert.equal(Object.keys(compacted.tasks).length, 1_000);
  assert.ok(compacted.tasks["task-2000"]);
  assert.equal(Object.keys(compacted.tasks["task-2000"].turns).length, 250);
  assert.deepEqual(Object.keys(compacted.tasks["task-2000"].boundaries), ["turn-9"]);
});

test("repeated observations never rehydrate trimmed turns ahead of recent history", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-turn-compaction-"));
  await writeFile(path.join(workspace, "tasks.jsonl"), "");
  const timers = [];
  const turns = Array.from({ length: 300 }, (_, index) => ({
    turnRef: `turn-${index}`,
    result: { status: "completed" },
  }));
  const task = {
    id: "task-turn-compaction",
    threadId: THREAD_ID,
    turns,
    latestTurn: turns.at(-1),
  };
  const tracker = createUsageTracker({
    workspace,
    retryDelaysMs: [0, 0],
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    readThreadUsage: async () => aggregateCcusageSessions({ sessions: [session("")] }, THREAD_ID),
  });
  await tracker.observe(task);
  while (timers.length > 0) await timers.shift()();
  await tracker.observe(task);
  while (timers.length > 0) await timers.shift()();

  const store = JSON.parse(await readFile(path.join(workspace, ".taskchef-usage.json"), "utf8"));
  const retained = Object.keys(store.tasks[task.id].turns);
  assert.equal(retained.length, 250);
  assert.equal(retained[0], "turn-50");
  assert.equal(retained.at(-1), "turn-299");
});

test("an oversized derived cache is recoverable and replaced by a bounded write", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "taskchef-usage-oversized-"));
  const cachePath = path.join(workspace, ".taskchef-usage.json");
  await writeFile(cachePath, Buffer.alloc((16 * 1024 * 1024) + 1));
  assert.deepEqual(await readUsageStore(workspace), { schemaVersion: 1, tasks: {} });
  await writeUsageStore(workspace, { schemaVersion: 1, tasks: {} });
  assert.ok((await stat(cachePath)).size < 16 * 1024 * 1024);
  assert.deepEqual(await readUsageStore(workspace), { schemaVersion: 1, tasks: {} });
  await writeFile(cachePath, JSON.stringify({
    schemaVersion: 1,
    tasks: Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [`task-${index}`, {}])),
  }));
  assert.deepEqual(await readUsageStore(workspace), { schemaVersion: 1, tasks: {} });
});
