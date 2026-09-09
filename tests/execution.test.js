import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addProject,
  initializeWorkspace,
  linkTask,
  listTasks,
  manuallyTransitionTask,
  migrateTaskLog,
  recordTask,
  reportTaskPhase,
  reportTaskResult,
  reportTaskState,
} from "../src/workspace.js";
import { prepareDelegation } from "../src/delegation.js";
import { assertOrchestratedCompletion } from "../src/execution.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "018f2a01-0000-7000-8000-000000000001";
const FIRST_TURN = "018f2a01-0000-7000-8000-000000000002";
const SECOND_TURN = "018f2a01-0000-7000-8000-000000000003";
const CHILD_ID = "018f2a01-0000-7000-8000-000000000004";

const parentResolution = {
  requestedModel: null,
  requestedEffort: null,
  source: null,
  status: "missing",
  resolvedAt: "2026-09-10T00:00:00.000Z",
  model: null,
  effort: null,
  effectiveModel: null,
  effectiveEffort: null,
};

const implementerResolution = {
  ...parentResolution,
  source: "~/.codex/agents/implementer.toml",
  status: "configured",
  model: "gpt-fixture",
  effort: "high",
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-execution-"));
  const project = path.join(root, "project");
  const workspace = path.join(root, "workspace");
  await mkdir(project);
  await initializeWorkspace(workspace);
  await addProject(workspace, { name: "Project", path: project });
  const prepared = prepareDelegation("Implement the accepted change.", { taskId: TASK_ID });
  await recordTask(workspace, {
    id: TASK_ID,
    project,
    title: "Orchestrated task",
    instruction: prepared.instruction,
    threadId: null,
    executionMode: "orchestrated",
    executionContractVersion: 1,
    parentResolution,
  });
  await linkTask(workspace, TASK_ID, PARENT_ID);
  return { workspace };
}

async function startTurn(workspace, turnRef = FIRST_TURN, intent = "implement") {
  return reportTaskState(workspace, {
    taskId: TASK_ID,
    threadId: PARENT_ID,
    turnRef,
    turnId: turnRef,
    status: "working",
    summary: null,
    requestSummary: "Implement the accepted change.",
    intent,
    acceptedScope: "Change only the fixture behavior and its tests.",
    planRef: null,
  });
}

function event(overrides) {
  return {
    taskId: TASK_ID,
    parentThreadId: PARENT_ID,
    turnRef: FIRST_TURN,
    eventId: "21111111-1111-4111-8111-111111111111",
    expectedRevision: 0,
    operation: "reserve",
    phaseId: "implement-1",
    kind: "implement",
    attempt: 1,
    role: "implementer",
    resolution: implementerResolution,
    writer: true,
    reviewPassId: null,
    ...overrides,
  };
}

test("orchestrated lifecycle records sequential phases and gates semantic completion", async () => {
  const { workspace } = await fixture();
  await startTurn(workspace);
  const reserved = await reportTaskPhase(workspace, event({}));
  assert.equal(reserved.executionRevision, 1);
  assert.equal(reserved.phase.writerGeneration, 1);
  await assert.rejects(
    reportTaskState(workspace, {
      taskId: TASK_ID, threadId: PARENT_ID, turnRef: FIRST_TURN, turnId: FIRST_TURN,
      status: "completed", summary: "Too early.",
    }),
    /every phase to be terminal|missing completed phases/,
  );
  const duplicate = await reportTaskPhase(workspace, event({}));
  assert.equal(duplicate.idempotent, true);
  await assert.rejects(
    reportTaskPhase(workspace, event({ writer: false })),
    /eventId is already used with different content/,
  );
  await reportTaskPhase(workspace, event({
    eventId: "21111111-1111-4111-8111-111111111112",
    expectedRevision: 1,
    operation: "start",
    agentHandle: "opaque-agent-handle",
  }));
  await reportTaskPhase(workspace, event({
    eventId: "21111111-1111-4111-8111-111111111113",
    expectedRevision: 2,
    operation: "bind",
    threadId: CHILD_ID,
    bindingProvenance: "native",
  }));
  await reportTaskPhase(workspace, event({
    eventId: "21111111-1111-4111-8111-111111111114",
    expectedRevision: 3,
    operation: "finish",
    state: "completed",
    summary: "Implemented and validated the fixture.",
    artifacts: ["src/fixture.js", "npm test (passed)"],
  }));
  await reportTaskPhase(workspace, event({
    eventId: "31111111-1111-4111-8111-111111111111",
    expectedRevision: 4,
    operation: "reserve",
    phaseId: "review-1",
    kind: "review",
    attempt: 1,
    role: "reviewer",
    resolution: { ...parentResolution, source: null },
    writer: false,
    reviewPassId: "review-pass-1",
  }));
  await reportTaskPhase(workspace, event({
    eventId: "31111111-1111-4111-8111-111111111112",
    expectedRevision: 5,
    operation: "start",
    phaseId: "review-1",
    agentHandle: "reviewer-handle",
  }));
  await reportTaskPhase(workspace, event({
    eventId: "31111111-1111-4111-8111-111111111113",
    expectedRevision: 6,
    operation: "finish",
    phaseId: "review-1",
    state: "completed",
    summary: "CLEAN",
    artifacts: [],
  }));
  const completed = await reportTaskState(workspace, {
    taskId: TASK_ID,
    threadId: PARENT_ID,
    turnRef: FIRST_TURN,
    turnId: FIRST_TURN,
    status: "completed",
    summary: "Implemented, validated, and independently reviewed.",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.executionRevision, 7);
  assert.equal(completed.latestTurn.phases.length, 2);
});

test("a reserved phase can be interrupted before its child starts", async () => {
  {
    const { workspace } = await fixture();
    await startTurn(workspace);
    await reportTaskPhase(workspace, event({}));
    const interrupted = await reportTaskPhase(workspace, event({
      eventId: "21111111-1111-4111-8111-111111111119",
      expectedRevision: 1,
      operation: "finish",
      state: "interrupted",
      summary: "The reservation was cancelled before spawn.",
      artifacts: [],
    }));
    assert.equal(interrupted.phase.state, "interrupted");
    assert.equal(interrupted.phase.agentHandle, null);
  }

  for (const status of ["failed", "needs_input"]) {
    const { workspace } = await fixture();
    await startTurn(workspace);
    await reportTaskPhase(workspace, event({}));
    const terminal = await reportTaskState(workspace, {
      taskId: TASK_ID,
      threadId: PARENT_ID,
      turnRef: FIRST_TURN,
      turnId: FIRST_TURN,
      status,
      summary: `Parent reported ${status} before spawn.`,
    });
    assert.equal(terminal.latestTurn.phases[0].state, "interrupted");
    assert.equal(terminal.latestTurn.phases[0].agentHandle, null);
  }

  {
    const { workspace } = await fixture();
    await startTurn(workspace);
    await reportTaskPhase(workspace, event({}));
    const recovered = await startTurn(workspace, SECOND_TURN, "continue_plan");
    assert.equal(recovered.turns[0].phases[0].state, "interrupted");
    assert.equal(recovered.turns[0].phases[0].agentHandle, null);
  }
});

test("writer generations remain valid after one hundred execution revisions", async () => {
  const { workspace } = await fixture();
  await startTurn(workspace);
  const taskLog = path.join(workspace, "tasks.jsonl");
  const current = JSON.parse((await readFile(taskLog, "utf8")).trim());
  current.executionRevision = 100;
  await writeFile(taskLog, `${JSON.stringify(current)}\n`);

  const reserved = await reportTaskPhase(workspace, event({ expectedRevision: 100 }));
  assert.equal(reserved.executionRevision, 101);
  assert.equal(reserved.phase.writerGeneration, 101);
});

test("completion requires the latest review after the latest writer", () => {
  const implementation = (attempt) => ({ kind: "implement", attempt, writer: true, state: "completed" });
  const review = (attempt, state) => ({ kind: "review", attempt, writer: false, state });
  const task = (phases) => {
    const latestTurn = { intent: "implement", phases };
    return { executionMode: "orchestrated", turns: [latestTurn], latestTurn };
  };

  assert.doesNotThrow(() => assertOrchestratedCompletion(task([
    implementation(1), review(1, "completed"),
  ])));
  assert.throws(() => assertOrchestratedCompletion(task([
    implementation(1), review(1, "completed"), implementation(2), review(2, "failed"),
  ])), /missing completed phases: review/);
  assert.throws(() => assertOrchestratedCompletion(task([
    implementation(1), review(1, "completed"), implementation(2),
  ])), /missing completed phases: review/);
  assert.doesNotThrow(() => assertOrchestratedCompletion(task([
    implementation(1), review(1, "completed"), implementation(2),
    review(2, "failed"), review(3, "completed"),
  ])));
});

test("phase reducer rejects stale revisions, concurrent phases, and child-as-parent binding", async () => {
  const { workspace } = await fixture();
  await startTurn(workspace);
  await reportTaskPhase(workspace, event({}));
  await assert.rejects(
    reportTaskPhase(workspace, event({
      eventId: "41111111-1111-4111-8111-111111111111",
      expectedRevision: 1,
      phaseId: "review-1",
      kind: "review",
      role: "reviewer",
      writer: false,
      reviewPassId: "review-pass-1",
    })),
    /another phase is already active/,
  );
  await assert.rejects(
    reportTaskPhase(workspace, event({
      eventId: "41111111-1111-4111-8111-111111111112",
      expectedRevision: 0,
      operation: "start",
      agentHandle: "handle",
    })),
    /expected revision 0 but current revision is 1/,
  );
  await reportTaskPhase(workspace, event({
    eventId: "41111111-1111-4111-8111-111111111113",
    expectedRevision: 1,
    operation: "start",
    agentHandle: "handle",
  }));
  await assert.rejects(
    reportTaskPhase(workspace, event({
      eventId: "41111111-1111-4111-8111-111111111114",
      expectedRevision: 2,
      operation: "bind",
      threadId: PARENT_ID,
      bindingProvenance: "child_asserted",
    })),
    /parent thread as a descendant/,
  );
});

test("active orchestrated phases fence manual dashboard outcomes", async () => {
  const { workspace } = await fixture();
  await startTurn(workspace);
  const reserved = await reportTaskPhase(workspace, event({}));
  await assert.rejects(
    manuallyTransitionTask(workspace, TASK_ID, {
      actionId: "61111111-1111-4111-8111-111111111111",
      expected: {
        status: reserved.task.status,
        turnRef: reserved.task.turnRef,
        threadId: reserved.task.threadId,
        updatedAt: reserved.task.updatedAt,
      },
      targetStatus: "failed",
    }),
    (error) => error.code === "active_phase",
  );
  assert.equal((await listTasks(workspace))[0].status, "working");
});

test("new lifecycle turn fences unfinished phases and legacy result alias cannot bypass orchestration", async () => {
  const { workspace } = await fixture();
  await startTurn(workspace);
  await reportTaskPhase(workspace, event({}));
  await reportTaskPhase(workspace, event({
    eventId: "51111111-1111-4111-8111-111111111111",
    expectedRevision: 1,
    operation: "start",
    agentHandle: "handle",
  }));
  const recovered = await startTurn(workspace, SECOND_TURN, "continue_plan");
  assert.equal(recovered.turns[0].result.status, "interrupted");
  assert.equal(recovered.turns[0].phases[0].state, "interrupted");
  assert.equal(recovered.executionRevision, 3);
  await assert.rejects(
    reportTaskResult(workspace, {
      taskId: TASK_ID,
      threadId: PARENT_ID,
      turnRef: SECOND_TURN,
      turnId: SECOND_TURN,
      status: "failed",
      summary: "Legacy callback.",
    }),
    /cannot write an orchestrated task/,
  );
  assert.equal((await listTasks(workspace))[0].status, "working");
});

test("a legacy task explicitly adopts orchestration only on a new working turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-adopt-"));
  const project = path.join(root, "project");
  const workspace = path.join(root, "workspace");
  await mkdir(project);
  await initializeWorkspace(workspace);
  await addProject(workspace, { name: "Project", path: project });
  const prepared = prepareDelegation("Continue the saved plan.", { taskId: TASK_ID });
  await recordTask(workspace, {
    id: TASK_ID, project, title: "Legacy", instruction: prepared.instruction, threadId: null,
  });
  await linkTask(workspace, TASK_ID, PARENT_ID);
  const adopted = await reportTaskState(workspace, {
    taskId: TASK_ID,
    threadId: PARENT_ID,
    turnRef: FIRST_TURN,
    turnId: FIRST_TURN,
    status: "working",
    summary: null,
    requestSummary: "Implement the accepted plan.",
    intent: "continue_plan",
    acceptedScope: "Implement the accepted saved plan without expanding it.",
    planRef: {
      repository: "https://github.com/example/project",
      path: "plans/change.md",
      revision: "abc123",
      contentHash: "deadbeef",
    },
    executionContractVersion: 1,
    parentResolution,
  });
  assert.equal(adopted.executionMode, "orchestrated");
  assert.equal(adopted.latestTurn.intent, "continue_plan");
  await assert.rejects(
    reportTaskState(workspace, {
      taskId: TASK_ID,
      threadId: PARENT_ID,
      turnRef: FIRST_TURN,
      turnId: FIRST_TURN,
      status: "working",
      summary: null,
      requestSummary: "Implement the accepted plan.",
      intent: "continue_plan",
      acceptedScope: "Implement the accepted saved plan without expanding it.",
      planRef: adopted.latestTurn.planRef,
      executionContractVersion: 1,
      parentResolution,
    }),
    /adoption is accepted only when starting a new turn/,
  );
});

test("a schema 10 task with historical turns can adopt orchestration directly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-adopt-schema10-"));
  const project = path.join(root, "project");
  const workspace = path.join(root, "workspace");
  await mkdir(project);
  await initializeWorkspace(workspace);
  await addProject(workspace, { name: "Project", path: project });
  const prepared = prepareDelegation("Continue a historical task.", { taskId: TASK_ID });
  await recordTask(workspace, {
    id: TASK_ID, project, title: "Historical legacy", instruction: prepared.instruction, threadId: null,
  });
  await linkTask(workspace, TASK_ID, PARENT_ID);
  await reportTaskState(workspace, {
    taskId: TASK_ID,
    threadId: PARENT_ID,
    turnRef: FIRST_TURN,
    turnId: FIRST_TURN,
    status: "working",
    summary: null,
    requestSummary: "Finish the historical request.",
  });
  await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: PARENT_ID,
    turnRef: FIRST_TURN,
    turnId: FIRST_TURN,
    status: "completed",
    summary: "Historical request completed.",
  });

  const taskLog = path.join(workspace, "tasks.jsonl");
  const historical = JSON.parse((await readFile(taskLog, "utf8")).trim());
  delete historical.executionMode;
  delete historical.executionRevision;
  delete historical.parentResolution;
  historical.schemaVersion = 10;
  for (const turn of historical.turns) {
    delete turn.intent;
    delete turn.acceptedScope;
    delete turn.planRef;
    delete turn.phases;
  }
  await writeFile(taskLog, `${JSON.stringify(historical)}\n`);

  const adopted = await reportTaskState(workspace, {
    taskId: TASK_ID,
    threadId: PARENT_ID,
    turnRef: SECOND_TURN,
    turnId: SECOND_TURN,
    status: "working",
    summary: null,
    requestSummary: "Implement the accepted follow-up.",
    intent: "continue_plan",
    acceptedScope: "Implement only the accepted follow-up.",
    planRef: null,
    executionContractVersion: 1,
    parentResolution,
  });
  assert.equal(adopted.schemaVersion, 11);
  assert.equal(adopted.executionMode, "orchestrated");
  assert.equal(adopted.turns[0].intent, null);
  assert.deepEqual(adopted.turns[0].phases, []);
  assert.equal(adopted.latestTurn.intent, "continue_plan");
});

test("schema 10 records migrate to schema 11 as explicit legacy execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-schema10-"));
  const project = path.join(root, "project");
  const workspace = path.join(root, "workspace");
  await mkdir(project);
  await initializeWorkspace(workspace);
  await addProject(workspace, { name: "Project", path: project });
  const prepared = prepareDelegation("Preserve a historical task.", { taskId: TASK_ID });
  await recordTask(workspace, {
    id: TASK_ID, project, title: "Historical", instruction: prepared.instruction, threadId: null,
  });
  const taskLog = path.join(workspace, "tasks.jsonl");
  const current = JSON.parse((await readFile(taskLog, "utf8")).trim());
  delete current.executionMode;
  delete current.executionRevision;
  delete current.parentResolution;
  current.schemaVersion = 10;
  await writeFile(taskLog, `${JSON.stringify(current)}\n`);

  const readable = (await listTasks(workspace))[0];
  assert.equal(readable.schemaVersion, 10);
  assert.equal(readable.executionMode, "legacy");
  const migration = await migrateTaskLog(workspace);
  assert.equal(migration.schemaVersion, 11);
  assert.match(migration.backupPath, /pre-v11-/);
  const migrated = (await listTasks(workspace))[0];
  assert.equal(migrated.executionMode, "legacy");
  assert.equal(migrated.executionRevision, 0);
  assert.equal(migrated.parentResolution, null);
});
