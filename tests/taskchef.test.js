import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as taskchef from "../index.js";

import {
  THREAD_RESOLUTION_CHECKPOINTS_MS,
  THREAD_RESOLUTION_TIMEOUT_MS,
  createAndRecordDelegation,
  addProject,
  buildTaskSummary,
  canonicalDirectory,
  doctorWorkspace,
  ensureWorkspaceInstructions,
  ensureWorkspaceSkills,
  filterTasks,
  hasExactTaskChefMarker,
  importProjects,
  initializeWorkspace,
  listProjects,
  readConfig,
  listTasks,
  readTask,
  recordTask,
  removeProject,
  resolveTask,
  requireSafeId,
  parseTaskChefMarker,
  prepareDelegation,
  validateConfig,
} from "../index.js";
import {
  pinTaskChefNpmSource,
  preserveSharedMarketplaceFile,
  resolveExpectedPublishedPlugin,
  updateSharedMarketplaceFile,
  validateExtractedPlugin,
  validatePublishedPluginPackage,
  validateSkillFrontmatter,
} from "../scripts/update-shared-marketplace.js";

const execFile = promisify(execFileCallback);
const FIXED_TIME = "2026-08-08T10:00:00.000Z";
const TASK_ID = "c0f010ff-84f2-4838-a69d-0ff1f5d721d7";
const SECOND_TASK_ID = "ea896202-04fc-4a46-a6a1-4c9f5d63edfe";

function threadList(threads = []) {
  return { schemaVersion: 4, pinnedThreads: [], threads };
}

function delegatedThreadRead(instruction) {
  return {
    schemaVersion: 1,
    turns: [{
      items: [{
        type: "userMessage",
        content: [{
          type: "text",
          text: `<codex_delegation><input>${instruction}</input></codex_delegation>`,
          codexDelegation: { sourceThreadId: "source", input: instruction },
        }],
      }],
    }],
  };
}

function delegationFixture(overrides = {}) {
  const recorded = [];
  const resolved = [];
  const clock = { value: 1_786_459_054_000 };
  return {
    input: {
      project: "/projects/example",
      title: "Fix retries",
      instruction: "Fix retry handling and test it.",
      target: {
        type: "project",
        projectId: "project-example",
        environment: { type: "worktree" },
      },
      taskId: TASK_ID,
      now: () => clock.value,
      waitImpl: async (delayMs) => { clock.value += delayMs; },
      recordTask: async (value) => recorded.push(value),
      resolveRecordedTask: async (value) => resolved.push(value),
      ...overrides,
    },
    recorded,
    resolved,
    clock,
  };
}

async function gitProject(parent, name, remote = null) {
  const project = path.join(parent, name);
  await mkdir(project, { recursive: true });
  await execFile("git", ["init", "-q"], { cwd: project });
  if (remote) await execFile("git", ["remote", "add", "origin", remote], { cwd: project });
  return realpath(project);
}

async function fixture(projectCount = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-v2-"));
  const workspace = path.join(root, "dispatcher");
  await initializeWorkspace(workspace);
  const projects = [];
  for (let index = 0; index < projectCount; index += 1) {
    const project = await gitProject(
      root,
      `project-${index + 1}`,
      `git@github.com:example/project-${index + 1}.git`,
    );
    projects.push(project);
    await addProject(workspace, {
      name: `project-${index + 1}`,
      path: project,
      description: `Fixture project ${index + 1}.`,
    });
  }
  return { root, workspace, projects };
}

function dispatchInput(project, id = "dispatch-1", threadId = `thread-${id}`) {
  return {
    id,
    project,
    title: "Echo input",
    instruction: "Create echo_input.py, test it, and report the result.",
    threadId,
  };
}

async function runCli(args, { input = "", cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      process.execPath,
      [path.resolve("bin/taskchef.js"), ...args],
      { cwd: cwd ?? process.cwd() },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    child.stdin.end(input);
  });
}

test("lightweight init creates a data-only workspace scaffold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-init-"));
  const workspace = path.join(root, "workspace");
  const initialized = await initializeWorkspace(workspace);

  assert.deepEqual(initialized.config.value, { schemaVersion: 1, projects: [] });
  assert.equal(initialized.config.action, "created");
  assert.deepEqual((await readdir(workspace)).sort(), ["AGENTS.md", "taskchef.json", "tasks.jsonl"]);
  assert.equal(await readFile(path.join(workspace, "tasks.jsonl"), "utf8"), "");

  const repeated = await initializeWorkspace(workspace);
  assert.equal(repeated.config.action, "unchanged");
  assert.equal(repeated.tasks.action, "unchanged");
  assert.equal(repeated.instructions.action, "unchanged");
  assert.deepEqual(repeated.legacySkills.removed, []);
});

test("public task history API uses task terminology", () => {
  for (const name of [
    "buildTaskSummary", "filterTasks", "listTasks", "readTask", "recordTask", "resolveTask",
  ]) {
    assert.equal(typeof taskchef[name], "function");
  }
  for (const name of [
    "buildDispatchSummary", "filterDispatches", "readDispatch", "readDispatches", "recordDispatch",
  ]) {
    assert.equal(name in taskchef, false);
  }
  assert.deepEqual(THREAD_RESOLUTION_CHECKPOINTS_MS, [10_000, 29_000]);
  assert.equal(THREAD_RESOLUTION_TIMEOUT_MS, 30_000);
});

test("delegation marker parsing requires the exact first-line full UUID marker", () => {
  const prepared = prepareDelegation("Do the work.", { taskId: TASK_ID });
  assert.equal(prepared.id, TASK_ID);
  assert.equal(prepared.instruction, `# taskchef_id=${TASK_ID}\n\nDo the work.`);
  assert.equal(parseTaskChefMarker(prepared.instruction), TASK_ID);
  assert.equal(parseTaskChefMarker(`prefix\n# taskchef_id=${TASK_ID}`), null);
  assert.equal(parseTaskChefMarker("# taskchef_id=short"), null);
  assert.equal(parseTaskChefMarker(`# taskchef_id=${TASK_ID} trailing`), null);
  assert.throws(
    () => prepareDelegation("Do the work.", { taskId: TASK_ID.toUpperCase() }),
    /lowercase full UUID/,
  );
  assert.throws(
    () => prepareDelegation(prepared.instruction, { taskId: TASK_ID }),
    /already contains a TaskChef marker/,
  );
});

test("marker verification ignores top-level delegation metadata", () => {
  assert.equal(hasExactTaskChefMarker({
    turns: [{
      items: [{
        type: "userMessage",
        codexDelegation: { input: `# taskchef_id=${TASK_ID}\n\nUntrusted location.` },
        content: [],
      }],
    }],
  }, TASK_ID), false);
});

test("delegation records an immediate durable thread ID and preserves its marker", async () => {
  const fixture = delegationFixture({
    resolveRecordedTask: undefined,
    listThreads: async () => assert.fail("immediate resolution must not list threads"),
    createThread: async ({ prompt }) => {
      assert.equal(parseTaskChefMarker(prompt), TASK_ID);
      return JSON.stringify({
        threadId: "019ff141-e290-74d0-bc4b-646e83d14bea",
        clientThreadId: "local:provisional-diagnostic",
        hostId: "local",
      });
    },
    readThread: async () => assert.fail("immediate resolution must not read threads"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded");
  assert.equal(result.resolution, "immediate");
  assert.equal(result.threadId, "019ff141-e290-74d0-bc4b-646e83d14bea");
  assert.equal(result.provisional, "local:provisional-diagnostic");
  assert.equal(fixture.recorded.length, 1);
  assert.equal(fixture.resolved.length, 0);
  assert.equal(fixture.recorded[0].threadId, result.threadId);
  assert.equal(parseTaskChefMarker(fixture.recorded[0].instruction), TASK_ID);
  assert.notEqual(fixture.recorded[0].threadId, result.provisional);
});

test("delegation resolves one delayed marker match after bounded discovery", async () => {
  let listCalls = 0;
  const waitDelays = [];
  const fixture = delegationFixture({
    listThreads: async () => {
      listCalls += 1;
      if (listCalls === 1) return JSON.stringify(threadList());
      return JSON.stringify(threadList([{
        id: "durable-thread",
        kind: "codex",
        hostId: "local",
        projectId: "project-example",
        title: "Fix retries…",
        createdAt: 1_786_459_054,
        environment: { type: "worktree" },
      }]));
    },
    createThread: async () => ({ clientThreadId: "local:pending" }),
    readThread: async ({ threadId }) => {
      assert.equal(threadId, "durable-thread");
      return JSON.stringify(
        delegatedThreadRead(`# taskchef_id=${TASK_ID}\n\nFix retry handling and test it.`),
      );
    },
    waitImpl: async (delayMs) => {
      assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
      waitDelays.push(delayMs);
      fixture.clock.value += delayMs;
    },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded");
  assert.equal(result.resolution, "discovered");
  assert.equal(result.threadId, "durable-thread");
  assert.equal(result.attempts, 2);
  assert.deepEqual(waitDelays, [10_000, 19_000]);
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
  assert.deepEqual(fixture.resolved, [{ id: TASK_ID, threadId: "durable-thread" }]);
});

test("delegation prefers one bounded native provisional-thread resolver when available", async () => {
  let nativeCalls = 0;
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "local:pending-native" }),
    listThreads: async () => assert.fail("native resolution must not list threads"),
    resolveProvisionalThread: async (input) => {
      nativeCalls += 1;
      assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
      assert.deepEqual(input, {
        provisionalId: "local:pending-native",
        clientThreadId: "local:pending-native",
        timeoutMs: 30_000,
      });
      return { threadId: "native-durable", hostId: "local" };
    },
    readThread: async ({ threadId }) => {
      assert.equal(threadId, "native-durable");
      return delegatedThreadRead(`# taskchef_id=${TASK_ID}\n\nFix retry handling and test it.`);
    },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded");
  assert.equal(result.resolution, "native");
  assert.equal(result.threadId, "native-durable");
  assert.equal(nativeCalls, 1);
  assert.deepEqual(fixture.resolved, [{ id: TASK_ID, threadId: "native-durable" }]);
});

test("delegation keeps the nullable record when native resolution times out", async () => {
  let nativeCalls = 0;
  const fixture = delegationFixture({
    createThread: async () => ({ pendingWorktreeId: "local:pending-native" }),
    listThreads: async () => assert.fail("native resolution must not list threads"),
    readThread: async () => assert.fail("an unresolved native result has no thread to read"),
    resolveProvisionalThread: async (input) => {
      nativeCalls += 1;
      assert.equal(input.pendingWorktreeId, "local:pending-native");
      return { status: "timeout" };
    },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "native-resolution-unresolved");
  assert.equal(result.threadId, null);
  assert.equal(nativeCalls, 1);
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
  assert.deepEqual(fixture.resolved, []);
});

test("delegation verifies a native resolver result against the exact structured marker", async () => {
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "local:pending-native" }),
    listThreads: async () => assert.fail("native resolution must not list threads"),
    resolveProvisionalThread: async () => ({ threadId: "wrong-native-thread" }),
    readThread: async () => delegatedThreadRead(
      `# taskchef_id=${SECOND_TASK_ID}\n\nA different delegation.`,
    ),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "native-resolution-unresolved");
  assert.equal(result.threadId, null);
  assert.deepEqual(fixture.resolved, []);
});

test("delegation rejects a native resolver that echoes the provisional ID", async () => {
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "local:native-echo" }),
    listThreads: async () => assert.fail("native resolution must not list threads"),
    resolveProvisionalThread: async () => ({ threadId: " local:native-echo " }),
    readThread: async () => assert.fail("a provisional ID must be rejected before reading"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "thread-discovery-error");
  assert.deepEqual(fixture.resolved, []);
  assert.equal(result.discoveryErrors[0].operation, "validateThreadId");
});

test("delegation rejects a different local native-resolver ID before reading", async () => {
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "client-without-local-prefix" }),
    listThreads: async () => assert.fail("native resolution must not list threads"),
    resolveProvisionalThread: async () => ({ threadId: "local:different-provisional" }),
    readThread: async () => assert.fail("local IDs must be rejected before reading"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "thread-discovery-error");
  assert.deepEqual(fixture.resolved, []);
  assert.equal(result.discoveryErrors[0].operation, "validateThreadId");
});

test("delegation does not verify or persist a native result returned after the deadline", async () => {
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "local:slow-native" }),
    listThreads: async () => assert.fail("native resolution must not list threads"),
    resolveProvisionalThread: async () => {
      fixture.clock.value += 30_001;
      return "late response must not be parsed as JSON";
    },
    readThread: async () => assert.fail("late native results must not start marker reads"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "resolution-deadline-exhausted");
  assert.deepEqual(fixture.resolved, []);
});

test("delegation does not start a second fallback snapshot after the deadline", async () => {
  let snapshots = 0;
  const waitDelays = [];
  const fixture = delegationFixture({
    listThreads: async () => {
      snapshots += 1;
      fixture.clock.value += 25_000;
      return threadList();
    },
    createThread: async () => ({ clientThreadId: "local:slow-tools" }),
    readThread: async () => assert.fail("there are no candidates to read"),
    waitImpl: async (delayMs) => {
      waitDelays.push(delayMs);
      fixture.clock.value += delayMs;
    },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.attempts, 1);
  assert.equal(snapshots, 1);
  assert.deepEqual(waitDelays, [10_000]);
});

test("delegation does not start a snapshot after a wait overshoots the deadline", async () => {
  let snapshots = 0;
  const fixture = delegationFixture({
    checkpointsMs: [29_999],
    timeoutMs: 30_000,
    createThread: async () => ({ clientThreadId: "local:timer-overshoot" }),
    listThreads: async () => { snapshots += 1; return threadList(); },
    readThread: async () => assert.fail("no snapshot should start after the deadline"),
    waitImpl: async (delayMs) => { fixture.clock.value += delayMs + 2; },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.attempts, 0);
  assert.equal(snapshots, 0);
});

test("delegation counts nullable-recording latency against native resolution", async () => {
  let nativeCalls = 0;
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "local:recording-delay" }),
    recordTask: async (value) => {
      fixture.recorded.push(value);
      fixture.clock.value += 30_000;
    },
    resolveProvisionalThread: async () => { nativeCalls += 1; },
    listThreads: async () => assert.fail("native resolution must not list threads"),
    readThread: async () => assert.fail("the deadline expired before native resolution"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "resolution-deadline-exhausted");
  assert.equal(nativeCalls, 0);
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
});

test("delegation leaves a provisional creation unresolved after the bounded no-match window", async () => {
  let snapshots = 0;
  const waitDelays = [];
  const fixture = delegationFixture({
    listThreads: async () => {
      snapshots += 1;
      return threadList();
    },
    createThread: async () => ({ clientThreadId: "local:pending-only" }),
    readThread: async () => assert.fail("there are no candidates to read"),
    waitImpl: async (delayMs) => {
      waitDelays.push(delayMs);
      fixture.clock.value += delayMs;
    },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "no-exact-marker-match");
  assert.equal(result.threadId, null);
  assert.equal(result.provisional, "local:pending-only");
  assert.equal(result.attempts, 2);
  assert.equal(snapshots, 2);
  assert.deepEqual(waitDelays, [10_000, 19_000]);
  assert.equal(fixture.recorded.length, 1);
  assert.equal(fixture.recorded[0].threadId, null);
  assert.equal(parseTaskChefMarker(fixture.recorded[0].instruction), TASK_ID);
});

test("delegation refuses multiple exact marker matches without recording either thread", async () => {
  const candidates = ["durable-a", "durable-b"].map((id) => ({
    id,
    kind: "codex",
    projectId: "project-example",
    title: "Fix retries",
    createdAt: 1_786_459_054,
    environment: { type: "worktree" },
  }));
  const fixture = delegationFixture({
    checkpointsMs: [1],
    timeoutMs: 2,
    listThreads: async () => threadList(candidates),
    createThread: async () => ({ pendingWorktreeId: "local:pending" }),
    readThread: async () => delegatedThreadRead(
      `# taskchef_id=${TASK_ID}\n\nFix retry handling and test it.`,
    ),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "multiple-exact-marker-matches");
  assert.deepEqual(result.matchingThreadIds, ["durable-a", "durable-b"]);
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
  assert.deepEqual(fixture.resolved, []);
});

test("delegation ignores plain-text marker echoes and records null instead of clientThreadId", async () => {
  const fixture = delegationFixture({
    checkpointsMs: [1],
    timeoutMs: 2,
    listThreads: async () => threadList([{
      id: "unverified-thread",
      kind: "codex",
      projectId: "project-example",
      title: "Fix retries",
      createdAt: 1_786_459_054,
    }]),
    createThread: async () => ({ clientThreadId: "client-only-id" }),
    readThread: async () => ({
      turns: [{
        items: [{
          type: "userMessage",
          content: [{ type: "text", text: `# taskchef_id=${TASK_ID}` }],
        }],
      }],
    }),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.provisional, "client-only-id");
  assert.equal(result.threadId, null);
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
  assert.notEqual(fixture.recorded[0].threadId, result.provisional);
});

test("delegation never persists a provisional ID echoed in the threadId field", async () => {
  const fixture = delegationFixture({
    checkpointsMs: [1],
    timeoutMs: 2,
    createThread: async () => ({
      threadId: " local:echoed-client-id ",
      clientThreadId: "local:echoed-client-id",
    }),
    listThreads: async () => threadList(),
    readThread: async () => assert.fail("there are no candidates to read"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.provisional, "local:echoed-client-id");
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
  assert.notEqual(fixture.recorded[0].threadId, result.provisional);
});

test("delegation treats a provisional-only threadId result as unresolved", async () => {
  const fixture = delegationFixture({
    checkpointsMs: [1],
    timeoutMs: 2,
    createThread: async () => ({ threadId: " local:provisional-only " }),
    listThreads: async () => threadList(),
    readThread: async () => assert.fail("there are no durable candidates to read"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.provisional, "local:provisional-only");
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
});

test("delegation excludes a provisional ID from fallback candidates", async () => {
  const fixture = delegationFixture({
    checkpointsMs: [1],
    timeoutMs: 2,
    createThread: async () => ({ clientThreadId: "local:fallback-echo" }),
    listThreads: async () => threadList([{
      id: "local:fallback-echo",
      kind: "codex",
      projectId: "project-example",
      createdAt: 1_786_459_054,
    }]),
    readThread: async () => assert.fail("a provisional ID must be filtered before reading"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.threadId, null);
  assert.deepEqual(fixture.resolved, []);
});

test("delegation stops after a fallback snapshot crosses the deadline", async () => {
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "local:slow-snapshot" }),
    listThreads: async () => {
      fixture.clock.value += 21_000;
      return "late snapshot must not be parsed as JSON";
    },
    readThread: async () => assert.fail("late snapshots must not start candidate reads"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "resolution-deadline-exhausted");
  assert.deepEqual(fixture.resolved, []);
});

test("delegation does not persist a marker read that completes after the deadline", async () => {
  let markerAccesses = 0;
  const fixture = delegationFixture({
    createThread: async () => ({ clientThreadId: "local:slow-read" }),
    listThreads: async () => threadList([{
      id: "late-read-thread",
      kind: "codex",
      projectId: "project-example",
      createdAt: 1_786_459_054,
    }]),
    readThread: async () => {
      fixture.clock.value += 21_000;
      return {
        turns: [{
          items: [{
            type: "userMessage",
            content: [{
              get codexDelegation() {
                markerAccesses += 1;
                return { input: `# taskchef_id=${TASK_ID}\n\nLate marker read.` };
              },
            }],
          }],
        }],
      };
    },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "resolution-deadline-exhausted");
  assert.deepEqual(fixture.resolved, []);
  assert.equal(markerAccesses, 0);
});

test("delegation still records a provisional task without a resolution adapter", async () => {
  const fixture = delegationFixture({
    resolveRecordedTask: undefined,
    createThread: async () => ({ clientThreadId: "local:no-resolution-adapter" }),
    listThreads: async () => assert.fail("resolution cannot run without its persistence adapter"),
    readThread: async () => assert.fail("resolution cannot run without its persistence adapter"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "task-resolution-unavailable");
  assert.equal(result.attempts, 0);
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
});

test("delegation preserves the marked task when thread snapshots fail", async () => {
  const fixture = delegationFixture({
    checkpointsMs: [1, 2],
    timeoutMs: 3,
    listThreads: async () => { throw new Error("snapshot unavailable"); },
    createThread: async () => ({ clientThreadId: "local:pending" }),
    readThread: async () => assert.fail("failed snapshots have no candidates"),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "thread-discovery-error");
  assert.equal(result.attempts, 2);
  assert.deepEqual(
    result.discoveryErrors.map((error) => error.operation),
    ["listThreads", "listThreads"],
  );
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
});

test("delegation does not resolve after an earlier discovery error", async () => {
  let snapshots = 0;
  const fixture = delegationFixture({
    checkpointsMs: [1, 2],
    timeoutMs: 3,
    listThreads: async () => {
      snapshots += 1;
      if (snapshots === 1) throw new Error("first snapshot unavailable");
      return threadList([{
        id: "later-match",
        kind: "codex",
        projectId: "project-example",
        createdAt: 1_786_459_054,
        environment: { type: "worktree" },
      }]);
    },
    createThread: async () => ({ clientThreadId: "local:pending" }),
    readThread: async () => delegatedThreadRead(
      `# taskchef_id=${TASK_ID}\n\nFix retry handling and test it.`,
    ),
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "thread-discovery-error");
  assert.deepEqual(result.matchingThreadIds, ["later-match"]);
  assert.deepEqual(fixture.resolved, []);
});

test("delegation preserves the marked task when a candidate read fails", async () => {
  const fixture = delegationFixture({
    checkpointsMs: [1],
    timeoutMs: 2,
    listThreads: async () => threadList([{
      id: "unreadable-thread",
      kind: "codex",
      projectId: "project-example",
      title: "Fix retries",
      createdAt: 1_786_459_054,
    }]),
    createThread: async () => ({ clientThreadId: "local:pending" }),
    readThread: async () => {
      throw new Error("thread unavailable");
    },
  });

  const result = await createAndRecordDelegation(fixture.input);
  assert.equal(result.status, "recorded-unresolved");
  assert.equal(result.reason, "thread-discovery-error");
  assert.deepEqual(result.discoveryErrors, [{
    attempt: 1,
    operation: "readThread",
    threadId: "unreadable-thread",
    message: "thread unavailable",
  }]);
  assert.deepEqual(fixture.recorded.map((entry) => entry.threadId), [null]);
});

test("init removes legacy TaskChef skill links without deleting unrelated skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-legacy-skills-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const skillsDirectory = path.join(workspace, ".agents", "skills");
  await mkdir(path.join(skillsDirectory, "other-skill"), { recursive: true });
  for (const skillName of ["taskchef-bootstrap", "taskchef-delegate", "taskchef-reconcile"]) {
    await symlink(path.join(root, "old-source", skillName), path.join(skillsDirectory, skillName));
  }

  const stale = await doctorWorkspace(workspace);
  assert.equal(stale.ok, false);
  assert.match(
    stale.checks.find((check) => check.name === "legacy-skill-links").message,
    /run workspace init/,
  );

  const refreshed = await initializeWorkspace(workspace);
  assert.deepEqual(
    refreshed.legacySkills.removed.map((link) => link.name),
    ["taskchef-bootstrap", "taskchef-delegate", "taskchef-reconcile"],
  );
  assert.equal((await lstat(path.join(skillsDirectory, "other-skill"))).isDirectory(), true);
  assert.equal((await doctorWorkspace(workspace)).ok, true);

  const compatibility = await ensureWorkspaceSkills(workspace);
  assert.equal(compatibility.directory, null);
  assert.deepEqual(
    compatibility.skills.map((skill) => skill.action),
    ["provided-by-plugin", "provided-by-plugin", "provided-by-plugin"],
  );

  const onlyLegacy = path.join(root, "only-legacy");
  await mkdir(path.join(onlyLegacy, ".agents", "skills"), { recursive: true });
  for (const skillName of ["taskchef-bootstrap", "taskchef-delegate", "taskchef-reconcile"]) {
    await symlink(path.join(root, "old-source", skillName), path.join(onlyLegacy, ".agents", "skills", skillName));
  }
  const cleaned = await initializeWorkspace(onlyLegacy);
  assert.equal(cleaned.legacySkills.removedDirectories.length, 2);
  await assert.rejects(lstat(path.join(onlyLegacy, ".agents")), { code: "ENOENT" });
});

test("init refuses to delete a non-symlink legacy TaskChef skill path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-legacy-skill-directory-"));
  const skillPath = path.join(root, ".agents", "skills", "taskchef-bootstrap");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "KEEP"), "user content\n");
  await assert.rejects(initializeWorkspace(root), /legacy TaskChef skill path is not a symlink/);
  assert.equal(await readFile(path.join(skillPath, "KEEP"), "utf8"), "user content\n");
});

test("init leaves unrelated symlinked agents paths untouched", async () => {
  for (const symlinkSkillsDirectory of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-unrelated-agents-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "KEEP"), "unrelated content\n");
    if (symlinkSkillsDirectory) {
      await mkdir(path.join(workspace, ".agents"));
      await symlink(outside, path.join(workspace, ".agents", "skills"), "dir");
    } else {
      await symlink(outside, path.join(workspace, ".agents"), "dir");
    }

    await initializeWorkspace(workspace);
    assert.equal(await readFile(path.join(outside, "KEEP"), "utf8"), "unrelated content\n");
    assert.equal((await doctorWorkspace(workspace)).ok, true);
  }
});

test("plugin manifest packages all skills and stays synchronized by release tooling", async () => {
  const manifest = JSON.parse(await readFile(path.resolve(".codex-plugin/plugin.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.equal(manifest.name, "taskchef");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(packageJson.files.includes(".codex-plugin"), true);
  assert.deepEqual(packageJson.bundleDependencies, ["proper-lockfile"]);
  const releaseConfig = JSON.parse(await readFile(path.resolve(".releaserc.json"), "utf8"));
  const releasePluginNames = releaseConfig.plugins.map((plugin) =>
    Array.isArray(plugin) ? plugin[0] : plugin);
  for (const pluginName of [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
  ]) {
    const plugin = releaseConfig.plugins.find((entry) =>
      Array.isArray(entry) && entry[0] === pluginName);
    assert.equal(plugin[1].preset, "conventionalcommits");
  }
  assert.ok(
    releasePluginNames.indexOf("@semantic-release/exec")
      < releasePluginNames.indexOf("@semantic-release/npm"),
    "the plugin manifest version must be synchronized before npm creates the release tarball",
  );
  const releaseGitPlugin = releaseConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git",
  );
  assert.deepEqual(
    releaseGitPlugin[1].assets,
    [".codex-plugin/plugin.json", "package-lock.json", "package.json"],
  );
  for (const skillName of ["taskchef-bootstrap", "taskchef-delegate", "taskchef-report"]) {
    assert.equal(
      (await lstat(path.resolve("skills", skillName, "SKILL.md"))).isFile(),
      true,
    );
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-plugin-version-"));
  await mkdir(path.join(root, ".codex-plugin"));
  await writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await execFile(process.execPath, [path.resolve("scripts/sync-plugin-version.js"), "2.3.4"], {
    cwd: root,
  });
  const synchronized = JSON.parse(
    await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(synchronized.version, "2.3.4");

  const outputPath = path.join(root, "github-output");
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["add", ".codex-plugin/plugin.json"], { cwd: root });
  await execFile("git", [
    "-c", "user.name=TaskChef Test", "-c", "user.email=test@example.com",
    "commit", "-m", "test release version",
  ], { cwd: root });
  await execFile(process.execPath, [path.resolve("scripts/write-release-version-output.js")], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
  });
  assert.equal(await readFile(outputPath, "utf8"), "version=\n");
  await execFile("git", ["tag", "v2.3.4"], { cwd: root });
  const taggedOutputPath = path.join(root, "tagged-github-output");
  await execFile(process.execPath, [path.resolve("scripts/write-release-version-output.js")], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: taggedOutputPath },
  });
  assert.equal(await readFile(taggedOutputPath, "utf8"), "version=2.3.4\n");
});

test("release automation pins the shared marketplace to the exact npm version", async () => {
  const marketplace = {
    name: "favoyang-plugins",
    plugins: [
      {
        name: "taskchef",
        source: {
          source: "url",
          url: "https://github.com/favoyang/taskchef.git",
          ref: "main",
        },
      },
    ],
  };
  const pinned = pinTaskChefNpmSource(marketplace, "2.3.4");
  assert.equal(pinned.changed, true);
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "npm",
    package: "taskchef",
    version: "2.3.4",
    registry: "https://registry.npmjs.org",
  });
  assert.equal(pinTaskChefNpmSource(marketplace, "2.3.4").changed, false);
  assert.throws(() => pinTaskChefNpmSource(marketplace, "latest"), /invalid TaskChef/);

  const packedRelease = [{
    id: "taskchef@2.3.4",
    files: [
      { path: ".codex-plugin/plugin.json" },
      { path: "bin/taskchef.js", mode: 0o755 },
      { path: "node_modules/proper-lockfile/package.json" },
      { path: "src/cli.js" },
      { path: "src/workspace.js" },
      { path: "skills/taskchef-bootstrap/SKILL.md" },
      { path: "skills/taskchef-delegate/SKILL.md" },
      { path: "skills/taskchef-report/SKILL.md" },
    ],
  }];
  assert.equal(validatePublishedPluginPackage(packedRelease, "2.3.4").id, "taskchef@2.3.4");
  assert.throws(
    () => validatePublishedPluginPackage([
      { ...packedRelease[0], files: packedRelease[0].files.slice(1) },
    ], "2.3.4"),
    /missing \.codex-plugin\/plugin\.json/,
  );
  assert.throws(
    () => validatePublishedPluginPackage([{
      ...packedRelease[0],
      files: packedRelease[0].files.map((file) =>
        file.path === "bin/taskchef.js" ? { ...file, mode: 0o644 } : file),
    }], "2.3.4"),
    /bin\/taskchef\.js is not executable/,
  );
  const currentPackage = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.equal(
    (await validateExtractedPlugin(path.resolve("."), currentPackage.version)).name,
    "taskchef",
  );
  assert.throws(
    () => validateSkillFrontmatter(
      "---\nname: taskchef-delegate\ndescription: [unterminated\n---\n",
      "taskchef-delegate",
    ),
    /invalid YAML/,
  );

  let registryAttempts = 0;
  const verifiedVersions = [];
  assert.equal(
    await resolveExpectedPublishedPlugin("2.3.4", {
      attempts: 2,
      delayMs: 0,
      readVersionImpl: async () => {
        registryAttempts += 1;
        return registryAttempts === 1 ? "1.0.2" : "2.3.4";
      },
      verifyVersionImpl: async (version) => {
        verifiedVersions.push(version);
      },
      waitImpl: async () => {},
    }),
    "2.3.4",
  );
  assert.equal(registryAttempts, 2);
  assert.deepEqual(verifiedVersions, ["2.3.4"]);

  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-marketplace-update-"));
  const marketplacePath = path.join(root, "marketplace.json");
  await writeFile(marketplacePath, `${JSON.stringify({
    name: "favoyang-plugins",
    plugins: [{
      name: "taskchef",
      source: {
        source: "url",
        url: "https://github.com/favoyang/taskchef.git",
        ref: "codex/taskchef-plugin",
      },
    }],
  })}\n`);
  assert.deepEqual(
    await preserveSharedMarketplaceFile(marketplacePath),
    { changed: true },
  );
  const fallbackMarketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(fallbackMarketplace.plugins[0].source.ref, "main");
  const result = await updateSharedMarketplaceFile(marketplacePath, "2.3.4");
  assert.deepEqual(result, { changed: true, version: "2.3.4" });
  const writtenMarketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(writtenMarketplace.plugins[0].source.version, "2.3.4");
  assert.deepEqual(
    await updateSharedMarketplaceFile(marketplacePath, "2.3.4"),
    { changed: false, version: "2.3.4" },
  );
  assert.deepEqual(
    await preserveSharedMarketplaceFile(marketplacePath),
    { changed: false },
  );

  const workflow = await readFile(path.resolve(".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /ssh-key: \$\{\{ secrets\.MARKETPLACE_DEPLOY_KEY \}\}/);
  assert.match(workflow, /node scripts\/update-shared-marketplace\.js shared-marketplace/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.match(workflow, /marketplace:\n[\s\S]+needs:\n\s+- test\n\s+- release/);
  assert.match(workflow, /marketplace:\n[\s\S]+always\(\)/);
  assert.match(workflow, /needs\.release\.result == 'success'/);
  assert.match(workflow, /needs\.release\.outputs\.expected-version != ''/);
  assert.match(workflow, /expected-version: \$\{\{ steps\.expected-version\.outputs\.version \}\}/);
  assert.match(workflow, /run: node scripts\/write-release-version-output\.js/);
  assert.match(workflow, /EXPECTED_VERSION: \$\{\{ needs\.release\.outputs\.expected-version \}\}/);
  assert.match(workflow, /update-shared-marketplace\.js shared-marketplace\/\.agents\/plugins\/marketplace\.json "\$EXPECTED_VERSION"/);
  assert.match(workflow, /steps\.marketplace-update\.outputs\.npm_ready != 'true'/);
});

test("init preserves existing configuration and merges managed instructions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-merge-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "AGENTS.md"), "# Personal instructions\n\n- Keep me.\n");
  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.instructions.action, "merged");
  const content = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
  assert.match(content, /Keep me/);
  assert.match(content, /\$taskchef-bootstrap/);
  assert.doesNotMatch(content, /For every ordinary user prompt/);
  assert.ok(content.indexOf("$taskchef-report") > content.indexOf("Answer directly only"));

  const project = await gitProject(root, "project");
  await addProject(workspace, { name: "project", path: project });
  await initializeWorkspace(workspace);
  assert.equal((await readConfig(workspace)).projects.length, 1);
});

test("delegate skill isolates trigger metadata and uses complete CLI commands", async () => {
  const content = await readFile(path.resolve("skills/taskchef-delegate/SKILL.md"), "utf8");
  const frontmatter = content.match(/^---\n([\s\S]+?)\n---/)?.[1] ?? "";
  assert.equal(
    frontmatter.match(/^description:.*$/m)?.[0],
    'description: "Dispatch actionable requests from an initialized TaskChef workspace into independently openable Codex project tasks. Use for ordinary work requests in a TaskChef workspace, explicit delegation, or splitting independent work across projects. Preserve unresolved delegations for later marker-based recovery, and never use subagents, hooks, schedules, daemons, or executor-completion waiting."',
  );
  assert.doesNotMatch(frontmatter, /\$[a-z0-9-]+/);
  assert.doesNotMatch(frontmatter, /\btaskchef-(?:bootstrap|report)\b/);

  const body = content.slice(content.indexOf("\n---", 4) + 4);
  const literals = [...body.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(
    literals.filter((literal) => /\btaskchef\.js(?:\s|$)/.test(literal)),
    [
      "<plugin-root>/bin/taskchef.js project list --json --workspace <workspace>",
      "<plugin-root>/bin/taskchef.js task record --json --workspace <workspace>",
      "<plugin-root>/bin/taskchef.js task resolve <task-id> --thread-id <thread-id> --json --workspace <workspace>",
    ],
  );
  assert.equal(literals.some((literal) => /^(?:doctor|workspace|task|dispatch)\s/.test(literal)), false);
  assert.match(body, /Do not take a pre-creation thread\s+snapshot/);
  assert.match(body, /call it exactly once with a timeout of at most 30 seconds/);
  assert.match(body, /at most two `list_threads`\s+snapshots with limit 50/);
  assert.match(body, /near 10 and 30 seconds/);
  assert.match(body, /Immediately record the marked instruction with `threadId: null`/);
  assert.match(body, /structured\s+`userMessage\.content\[\]\.codexDelegation\.input`/);
  assert.match(body, /Never persist a provisional `clientThreadId`/);
  assert.match(body, /If executor creation fails, do not record a task/);

  const backlog = await readFile(path.resolve("BACKLOG.md"), "utf8");
  assert.match(backlog, /openai\/codex#26861/);
  assert.match(backlog, /wait_for_thread\(clientThreadId, timeoutMs\)/);
  assert.match(backlog, /resolve_client_thread\(clientThreadId\)/);
});

test("report skill resolves exact nullable matches and reads live state once", async () => {
  const content = await readFile(path.resolve("skills/taskchef-report/SKILL.md"), "utf8");
  assert.match(content, /^name: taskchef-report$/m);
  assert.match(content, /taskchef\.js task show <task-id> --json --workspace/);
  assert.match(content, /taskchef\.js task list --project <name-or-path> --json --workspace/);
  assert.match(content, /Use the full list only when the user asks for an overview/);
  assert.match(content, /no more than\s+eight targets per call/);
  assert.match(content, /Never edit `tasks\.jsonl` directly/);
  assert.match(content, /Do not poll or wait/);
  assert.match(content, /entries whose `threadId` is `null`/);
  assert.match(content, /taskchef\.js task resolve <task-id> --thread-id <thread-id>/);
  assert.doesNotMatch(content, /task update|reconcile-candidates/);
});

test("init fails safely on malformed managed instruction markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-invalid-instructions-"));
  await writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- taskchef:dispatcher-instructions:start -->\ntruncated\n",
  );
  await assert.rejects(initializeWorkspace(root), /malformed TaskChef managed-block markers/);
  await assert.rejects(readFile(path.join(root, "taskchef.json"), "utf8"), { code: "ENOENT" });
});

test("init rejects a symlinked dispatch log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-symlinked-managed-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace);
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(workspace, "tasks.jsonl"));

  await assert.rejects(
    initializeWorkspace(workspace),
    /managed workspace path is not a regular file/,
  );
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("init rejects symlinked managed workspace files without reading them", async () => {
  for (const fileName of ["AGENTS.md", "taskchef.json", "tasks.jsonl"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-symlinked-file-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "sensitive outside content\n");
    await symlink(outside, path.join(workspace, fileName));

    await assert.rejects(
      initializeWorkspace(workspace),
      /managed workspace path is not a regular file/,
    );
    assert.equal(await readFile(outside, "utf8"), "sensitive outside content\n");
    assert.equal((await lstat(path.join(workspace, fileName))).isSymbolicLink(), true);
  }
});

test("project add detects Git roots and normalizes GitHub remotes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-project-add-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const projectPath = await gitProject(root, "source", "git@github.com:Example/source.git");
  const project = await addProject(workspace, {
    name: "source",
    path: projectPath,
    description: "Owns source code.",
  });
  assert.deepEqual(project, {
    name: "source",
    path: projectPath,
    isGitRepository: true,
    githubRepo: "https://github.com/Example/source",
    description: "Owns source code.",
  });
  await assert.rejects(addProject(workspace, { name: "duplicate", path: projectPath }), /duplicates/);

  const nested = path.join(projectPath, "nested");
  await mkdir(nested);
  await assert.rejects(addProject(workspace, { path: nested }), /Git repository root/);
});

test("project add supports non-Git directories and explicit GitHub suppression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-project-kinds-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const notes = path.join(root, "notes");
  await mkdir(notes);
  const folder = await addProject(workspace, { path: notes });
  assert.equal(folder.name, "notes");
  assert.equal(folder.isGitRepository, false);
  assert.equal(folder.githubRepo, null);
  await assert.rejects(
    addProject(workspace, { path: path.join(root, "missing") }),
    /does not exist/,
  );
});

test("project inspection reports Git execution failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-git-failure-"));
  const workspace = path.join(root, "workspace");
  const project = path.join(root, "project");
  await initializeWorkspace(workspace);
  await mkdir(project);
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(root, "missing-bin");
  try {
    await assert.rejects(
      addProject(workspace, { path: project }),
      /failed to inspect Git repository/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("project import merges by canonical path and preserves omitted curation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-import-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const first = await gitProject(root, "first");
  const second = await gitProject(root, "second");
  await addProject(workspace, {
    name: "curated-first",
    path: first,
    description: "Preserve this description.",
  });
  const merged = await importProjects(workspace, [{ path: first }, { name: "second", path: second }]);
  assert.equal(merged.mode, "merge");
  assert.equal(merged.projectCount, 2);
  const projects = await listProjects(workspace);
  assert.equal(projects.find((project) => project.path === first).name, "curated-first");
  assert.equal(
    projects.find((project) => project.path === first).description,
    "Preserve this description.",
  );

  const replaced = await importProjects(workspace, [{ name: "second-only", path: second }], {
    replace: true,
  });
  assert.equal(replaced.mode, "replace");
  assert.deepEqual((await listProjects(workspace)).map((project) => project.name), ["second-only"]);
  await assert.rejects(importProjects(workspace, {}), /JSON array/);
});

test("project removal and replacement preserve historical dispatch snapshots", async () => {
  const { root, workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0]), { now: FIXED_TIME });
  await removeProject(workspace, "project-1");
  assert.deepEqual(await listProjects(workspace), []);
  assert.equal((await readTask(workspace, "dispatch-1")).project.name, "project-1");

  const replacement = await gitProject(root, "replacement");
  const result = await importProjects(
    workspace,
    [{ name: "replacement", path: replacement }],
    { replace: true },
  );
  assert.deepEqual(result.projects.map((project) => project.path), [replacement]);
});

test("moved projects can be removed or replaced through configuration repair", async () => {
  const removable = await fixture(1);
  await rename(removable.projects[0], `${removable.projects[0]}-moved`);
  await initializeWorkspace(removable.workspace);
  const removed = await removeProject(removable.workspace, "project-1");
  assert.equal(removed.project.path, removable.projects[0]);
  assert.deepEqual(await listProjects(removable.workspace), []);

  const replaceable = await fixture(1);
  await rename(replaceable.projects[0], `${replaceable.projects[0]}-moved`);
  const replacement = await gitProject(replaceable.root, "replacement");
  const replaced = await importProjects(
    replaceable.workspace,
    [{ name: "replacement", path: replacement }],
    { replace: true },
  );
  assert.deepEqual(replaced.projects.map((project) => project.path), [replacement]);
});

test("configuration and dispatch schemas remain strict", async () => {
  await assert.rejects(
    validateConfig({ schemaVersion: 1, projects: [], hostId: "forbidden" }),
    /unsupported field: hostId/,
  );
  const { workspace, projects } = await fixture(1);
  await assert.rejects(
    recordTask(workspace, { ...dispatchInput(projects[0]), status: "running" }),
    /unsupported field: status/,
  );
  await assert.rejects(
    recordTask(workspace, dispatchInput(projects[0], "provisional", "local:client-id")),
    /provisional local ID/,
  );
  assert.throws(() => requireSafeId("../escape"), /unsupported characters/);
});

test("dispatch recording appends one immutable journey entry", async () => {
  const { workspace, projects } = await fixture(1);
  const recorded = await recordTask(workspace, dispatchInput(projects[0]), { now: FIXED_TIME });
  assert.equal(recorded.createdAt, FIXED_TIME);
  assert.equal(recorded.project.name, "project-1");
  assert.deepEqual(Object.keys(recorded), [
    "schemaVersion", "id", "project", "title", "instruction", "threadId", "createdAt",
  ]);
  const content = await readFile(path.join(workspace, "tasks.jsonl"), "utf8");
  assert.equal(content.split("\n").length, 2);
  assert.deepEqual(JSON.parse(content.trim()), recorded);
});

test("dispatch recording rejects duplicate IDs and thread IDs", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0], "dispatch-a", "thread-a"));
  await assert.rejects(
    recordTask(workspace, dispatchInput(projects[0], "dispatch-a", "thread-b")),
    /task already exists/,
  );
  await assert.rejects(
    recordTask(workspace, dispatchInput(projects[0], "dispatch-b", "thread-a")),
    /threadId is already recorded/,
  );
});

test("dispatch recording preserves multiple unresolved tasks with null thread IDs", async () => {
  const { workspace, projects } = await fixture(1);
  const firstPrepared = prepareDelegation("First unresolved task.", { taskId: TASK_ID });
  const secondPrepared = prepareDelegation(
    "Second unresolved task.",
    { taskId: SECOND_TASK_ID },
  );
  const first = await recordTask(
    workspace,
    {
      ...dispatchInput(projects[0], firstPrepared.id, null),
      instruction: firstPrepared.instruction,
    },
  );
  const second = await recordTask(
    workspace,
    {
      ...dispatchInput(projects[0], secondPrepared.id, null),
      instruction: secondPrepared.instruction,
    },
  );

  assert.equal(first.threadId, null);
  assert.equal(second.threadId, null);
  assert.deepEqual((await listTasks(workspace)).map((task) => task.threadId), [null, null]);
});

test("task resolution performs one atomic null-to-threadId transition", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Recover this task later.", { taskId: TASK_ID });
  const unresolved = await recordTask(workspace, {
    ...dispatchInput(projects[0], prepared.id, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });

  const resolved = await resolveTask(workspace, prepared.id, "durable-thread");
  assert.equal(resolved.threadId, "durable-thread");
  assert.equal(resolved.createdAt, unresolved.createdAt);
  assert.equal(resolved.instruction, unresolved.instruction);
  assert.deepEqual(await resolveTask(workspace, prepared.id, "durable-thread"), resolved);
  await assert.rejects(
    resolveTask(workspace, prepared.id, "different-thread"),
    /already has a different threadId/,
  );
  assert.deepEqual(await readTask(workspace, prepared.id), resolved);
});

test("task resolution validates the marker and durable thread ID uniqueness", async () => {
  const { workspace, projects } = await fixture(1);
  await assert.rejects(
    recordTask(workspace, dispatchInput(projects[0], "unmarked", null)),
    /null threadId must contain its exact TaskChef marker/,
  );

  const first = prepareDelegation("First unresolved task.", { taskId: TASK_ID });
  const second = prepareDelegation("Second unresolved task.", { taskId: SECOND_TASK_ID });
  await recordTask(workspace, {
    ...dispatchInput(projects[0], first.id, null),
    instruction: first.instruction,
  });
  await recordTask(workspace, {
    ...dispatchInput(projects[0], second.id, null),
    instruction: second.instruction,
  });
  await resolveTask(workspace, first.id, "shared-thread");
  await assert.rejects(
    resolveTask(workspace, second.id, "shared-thread"),
    /threadId is already recorded/,
  );
});

test("concurrent task resolution permits exactly one durable thread ID", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Resolve concurrently.", { taskId: TASK_ID });
  await recordTask(workspace, {
    ...dispatchInput(projects[0], prepared.id, null),
    instruction: prepared.instruction,
  });

  const settled = await Promise.allSettled([
    resolveTask(workspace, prepared.id, "race-thread-a"),
    resolveTask(workspace, prepared.id, "race-thread-b"),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    settled.find((result) => result.status === "rejected").reason.message,
    /already has a different threadId/,
  );
  assert.match((await readTask(workspace, prepared.id)).threadId, /^race-thread-[ab]$/);
});

test("concurrent dispatch recording cannot poison the journey", async () => {
  const { workspace, projects } = await fixture(1);
  const input = dispatchInput(projects[0], "same", "same-thread");
  const settled = await Promise.allSettled([
    recordTask(workspace, input),
    recordTask(workspace, input),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  assert.match(settled.find((item) => item.status === "rejected").reason.message, /already/);
  assert.deepEqual((await listTasks(workspace)).map((item) => item.id), ["same"]);
  await assert.rejects(lstat(path.join(workspace, ".taskchef-dispatch.lock")), { code: "ENOENT" });

  await Promise.all([
    recordTask(workspace, dispatchInput(projects[0], "distinct-a", "thread-distinct-a")),
    recordTask(workspace, dispatchInput(projects[0], "distinct-b", "thread-distinct-b")),
  ]);
  const ids = (await listTasks(workspace)).map((item) => item.id);
  assert.equal(ids[0], "same");
  assert.deepEqual(ids.slice(1).sort(), ["distinct-a", "distinct-b"]);

  const cliInput = JSON.stringify(dispatchInput(projects[0], "cross-process", "thread-cross"));
  const processes = await Promise.allSettled([
    runCli(["task", "record", "--json", "--workspace", workspace], { input: cliInput }),
    runCli(["task", "record", "--json", "--workspace", workspace], { input: cliInput }),
  ]);
  assert.equal(processes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(processes.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await listTasks(workspace)).filter((item) => item.id === "cross-process").length, 1);
});

test("dispatch operations recover an abandoned lock", async () => {
  const { workspace, projects } = await fixture(1);
  const lockPath = path.join(workspace, ".taskchef-dispatch.lock");
  await mkdir(lockPath);

  await recordTask(workspace, dispatchInput(projects[0], "after-crash", "thread-after-crash"));
  assert.deepEqual((await listTasks(workspace)).map((item) => item.id), ["after-crash"]);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("journey reads and doctor do not require workspace write access", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0]));
  const lockPath = path.join(workspace, ".taskchef-dispatch.lock");
  await chmod(workspace, 0o555);
  try {
    assert.equal((await listTasks(workspace)).length, 1);
    assert.equal((await doctorWorkspace(workspace)).ok, true);
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  } finally {
    await chmod(workspace, 0o755);
  }
});

test("dispatch list filters by historical project and summary counts the journey", async () => {
  const { workspace, projects } = await fixture(2);
  await recordTask(workspace, dispatchInput(projects[0], "first", "thread-first"));
  await recordTask(workspace, dispatchInput(projects[0], "second", "thread-second"));
  await recordTask(workspace, dispatchInput(projects[1], "third", "thread-third"));

  assert.deepEqual(
    (await filterTasks(workspace, { project: "PROJECT-1" })).map((item) => item.id),
    ["first", "second"],
  );
  assert.deepEqual(await filterTasks(workspace, { project: "unused" }), []);
  assert.deepEqual(await buildTaskSummary(workspace), {
    schemaVersion: 1,
    taskCount: 3,
    projectCounts: { "project-1": 2, "project-2": 1 },
  });
});

test("dispatch reader and workspace init reject malformed current JSONL", async () => {
  const { workspace } = await fixture(1);
  const log = path.join(workspace, "tasks.jsonl");
  await writeFile(log, "{bad}\n");
  await assert.rejects(listTasks(workspace), /line 1 is invalid JSON/);
  await assert.rejects(initializeWorkspace(workspace), /line 1 is invalid JSON/);
  await writeFile(log, JSON.stringify({ id: "incomplete" }));
  await assert.rejects(listTasks(workspace), /must end with a newline/);
  await writeFile(log, "\n");
  await assert.rejects(listTasks(workspace), /line 1 is empty/);
});

test("doctor reports healthy and stale workspaces without mutating them", async () => {
  const { workspace } = await fixture(1);
  const healthy = await doctorWorkspace(workspace);
  assert.equal(healthy.ok, true);
  await writeFile(path.join(workspace, "AGENTS.md"), "# stale\n");
  const stale = await doctorWorkspace(workspace);
  assert.equal(stale.ok, false);
  assert.equal(stale.checks.find((check) => check.name === "instructions").status, "fail");
  assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# stale\n");
  await ensureWorkspaceInstructions(workspace);
  assert.equal((await doctorWorkspace(workspace)).ok, true);
});

test("workspace init and doctor do not recognize the removed task-directory format", async () => {
  const { workspace } = await fixture(1);
  const obsoleteTaskPath = path.join(workspace, "tasks", "obsolete-1", "task.json");
  await mkdir(path.dirname(obsoleteTaskPath), { recursive: true });
  await writeFile(obsoleteTaskPath, "obsolete task data\n");

  const initialized = await initializeWorkspace(workspace);
  assert.equal("legacyTasks" in initialized, false);
  assert.equal(await readFile(obsoleteTaskPath, "utf8"), "obsolete task data\n");
  assert.deepEqual(await listTasks(workspace), []);

  const diagnosis = await doctorWorkspace(workspace);
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.checks.some((check) => check.name === "legacy-tasks"), false);
});

test("CLI implements the bootstrap, project, doctor, and task surface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-cli-v2-"));
  const workspace = path.join(root, "workspace");
  const first = await gitProject(root, "first", "https://github.com/example/first.git");
  const second = await gitProject(root, "second");

  const initialized = await runCli(["workspace", "init", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(initialized.stdout).config.action, "created");
  const repeated = await runCli(["workspace", "init", "--workspace", workspace]);
  assert.match(repeated.stdout, /Task log: unchanged/);
  assert.doesNotMatch(repeated.stdout, /Legacy tasks:/);
  const added = await runCli([
    "project", "add", first, "--name", "first", "--json", "--workspace", workspace,
  ]);
  assert.equal(JSON.parse(added.stdout).githubRepo, "https://github.com/example/first");
  const imported = await runCli([
    "project", "import", "-", "--json", "--workspace", workspace,
  ], { input: JSON.stringify([{ name: "second", path: second }]) });
  assert.equal(JSON.parse(imported.stdout).projectCount, 2);
  const projects = await runCli(["project", "list", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(projects.stdout).projectCount, 2);

  await runCli(["task", "record", "--json", "--workspace", workspace], {
    input: JSON.stringify(dispatchInput(first)),
  });
  const prepared = prepareDelegation("Recover this CLI task.", { taskId: TASK_ID });
  await assert.rejects(
    runCli(["task", "record", "--json", "--workspace", workspace], {
      input: JSON.stringify(dispatchInput(first, "cli-provisional", "local:client-id")),
    }),
    (error) => error.code === 1 && /provisional local ID/.test(error.stderr),
  );
  await runCli(["task", "record", "--json", "--workspace", workspace], {
    input: JSON.stringify({
      ...dispatchInput(first, prepared.id, null),
      instruction: prepared.instruction,
    }),
  });
  await assert.rejects(
    runCli([
      "task", "resolve", prepared.id, "--thread-id", "local:client-id",
      "--json", "--workspace", workspace,
    ]),
    (error) => error.code === 1 && /provisional local ID/.test(error.stderr),
  );
  const resolved = await runCli([
    "task", "resolve", prepared.id, "--thread-id", "cli-durable-thread",
    "--json", "--workspace", workspace,
  ]);
  assert.equal(JSON.parse(resolved.stdout).threadId, "cli-durable-thread");
  const shown = await runCli(["task", "show", "dispatch-1", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(shown.stdout).id, "dispatch-1");
  const listed = await runCli([
    "task", "list", "--project", "first", "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(
    JSON.parse(listed.stdout).tasks.map((item) => item.id),
    ["dispatch-1", TASK_ID],
  );
  const summary = await runCli(["task", "summary", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(summary.stdout).taskCount, 2);
  assert.equal(JSON.parse(summary.stdout).projectCounts.first, 2);
  const doctor = await runCli(["doctor", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
});

test("CLI rejects removed legacy commands", async () => {
  for (const args of [
    ["workspace", "ensure-instructions", "--json"],
    ["workspace", "ensure-skills", "--json"],
    ["config", "validate", "--json"],
    ["task", "snapshot", "--json"],
    ["dispatch", "record", "--json"],
    ["dispatch", "list", "--json"],
  ]) {
    await assert.rejects(
      runCli(args),
      (error) => error.code === 2 && /Unknown command/.test(error.stderr),
    );
  }
});
