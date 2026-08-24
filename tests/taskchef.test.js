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
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import mermaidParser from "mermaid";
import lockfile from "proper-lockfile";
import * as taskchef from "../index.js";

import {
  EXECUTOR_OWNERSHIP_PARAGRAPH,
  EXECUTOR_LINK_PARAGRAPH,
  EXECUTOR_RESULT_PARAGRAPH,
  createAndRecordDelegation,
  createTaskChefMcpServer,
  prepareDispatch,
  addProject,
  buildTaskSummary,
  canonicalGithubRepository,
  canonicalDirectory,
  defaultWorkspacePath,
  discoverCodexCli,
  doctorWorkspace,
  ensureWorkspaceInstructions,
  ensureWorkspaceSkills,
  filterTasks,
  importProjects,
  initializeWorkspace,
  linkTask,
  listProjects,
  readConfig,
  listTasks,
  matchProjectForGithubUrl,
  openThreadInCodex,
  readTask,
  recordTask,
  reportTaskResult,
  removeProject,
  resolveTask,
  requireSafeId,
  parseTaskChefMarker,
  prepareDelegation,
  resolveWorkspacePath,
  validateConfig,
} from "../index.js";
import { assertTaskRecordStdin } from "../src/cli.js";
import { acquireWorkspaceLock } from "../src/workspace.js";
import {
  cleanBenchmarkResults,
  normalizeBenchmarkResult,
  writeBenchmarkResult,
} from "../scripts/e2e-benchmark.js";
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
const BENCHMARK_THREAD_ID = "00000000-0000-7000-8000-000000000000";
const SELF_LINK_THREAD_ID = "019ffb69-57a6-7801-8b7a-8ff4c32a398c";
const OTHER_THREAD_ID = "019ffb69-57a6-7801-8b7a-8ff4c32a398d";
const FIRST_RESULT_TURN_ID = "01a03275-d530-7043-ab4a-513a1ad6ae1e";
const SECOND_RESULT_TURN_ID = "01a03275-d531-7043-ab4a-513a1ad6ae1e";

function e2eBenchmarkInput() {
  return {
    schemaVersion: 2,
    benchmark: "taskchef-executor-self-link-e2e",
    taskchefVersion: "5.1.1",
    runId: "baseline-t2-count",
    startedAt: "2026-08-13T06:30:00.000Z",
    completedAt: "2026-08-13T06:30:05.000Z",
    workload: {
      project: "t2",
      title: "Count from 1 to 10",
      prompt: "Print the integers from 1 through 10.",
    },
    task: {
      taskId: TASK_ID,
      threadId: BENCHMARK_THREAD_ID,
      clientThreadId: null,
      recorded: true,
      linked: true,
    },
    turns: { needsInput: FIRST_RESULT_TURN_ID, completion: SECOND_RESULT_TURN_ID },
    events: {
      preparedAt: "2026-08-13T06:30:00.000Z",
      recordedAt: "2026-08-13T06:30:00.100Z",
      createdAt: "2026-08-13T06:30:00.200Z",
      linkedAt: "2026-08-13T06:30:00.300Z",
      needsInputAt: "2026-08-13T06:30:01.000Z",
      followedUpAt: "2026-08-13T06:30:03.000Z",
      completedAt: "2026-08-13T06:30:05.000Z",
    },
    validation: {
      exactMarkerCorrelated: true,
      noDispatcherPostCreateReads: true,
      childIdentityVerified: true,
      parentIdentityRejected: true,
      linkRetryVerified: true,
      needsInputVerified: true,
      followUpTurnFresh: true,
      dashboardDeepLinkVerified: true,
      outputVerified: true,
    },
    summary: undefined,
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

async function runCli(args, { input = "", cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      process.execPath,
      [path.resolve("bin/taskchef.js"), ...args],
      { cwd: cwd ?? process.cwd(), env: { ...process.env, ...env } },
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

  assert.deepEqual(initialized.config.value, { schemaVersion: 2, projects: [] });
  assert.equal(initialized.config.action, "created");
  assert.deepEqual((await readdir(workspace)).sort(), ["AGENTS.md", "taskchef.json", "tasks.jsonl"]);
  assert.equal(await readFile(path.join(workspace, "tasks.jsonl"), "utf8"), "");
  assert.equal((await stat(workspace)).mode & 0o777, 0o700);
  for (const fileName of ["AGENTS.md", "taskchef.json", "tasks.jsonl"]) {
    assert.equal((await stat(path.join(workspace, fileName))).mode & 0o777, 0o600);
  }

  const repeated = await initializeWorkspace(workspace);
  assert.equal(repeated.config.action, "unchanged");
  assert.equal(repeated.tasks.action, "unchanged");
  assert.equal(repeated.instructions.action, "unchanged");
  assert.deepEqual(repeated.legacySkills.removed, []);
});

test("workspace resolution prefers explicit, environment, then the per-user default", () => {
  const homedir = "/Users/example";
  assert.equal(defaultWorkspacePath({ homedir }), "/Users/example/.agents/taskchef");
  assert.deepEqual(resolveWorkspacePath({ homedir, cwd: "/tmp", env: {} }), {
    workspace: "/Users/example/.agents/taskchef",
    source: "default",
  });
  assert.deepEqual(resolveWorkspacePath({
    homedir,
    cwd: "/tmp",
    env: { TASKCHEF_WORKSPACE: "~/shared-taskchef" },
  }), {
    workspace: "/Users/example/shared-taskchef",
    source: "environment",
  });
  assert.deepEqual(resolveWorkspacePath({
    explicit: "./chosen",
    homedir,
    cwd: "/tmp",
    env: { TASKCHEF_WORKSPACE: "/ignored" },
  }), {
    workspace: "/tmp/chosen",
    source: "explicit",
  });
  assert.throws(
    () => resolveWorkspacePath({ homedir, env: { TASKCHEF_WORKSPACE: "" } }),
    /must be a non-empty path/,
  );
  assert.throws(
    () => resolveWorkspacePath({ homedir, cwd: "/tmp", env: { TASKCHEF_WORKSPACE: "relative" } }),
    /must be an absolute path or start with ~\//,
  );
});

test("CLI uses the per-user default independently of its current directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "taskchef-home-"));
  const firstCwd = await mkdtemp(path.join(os.tmpdir(), "taskchef-cwd-a-"));
  const secondCwd = await mkdtemp(path.join(os.tmpdir(), "taskchef-cwd-b-"));
  const initialized = JSON.parse((await runCli(["workspace", "init", "--json"], {
    cwd: firstCwd,
    env: { HOME: home },
  })).stdout);
  assert.equal(initialized.workspace, path.join(await realpath(home), ".agents", "taskchef"));
  assert.equal(initialized.resolutionSource, "default");
  const resolved = JSON.parse((await runCli(["workspace", "path", "--json"], {
    cwd: secondCwd,
    env: { HOME: home },
  })).stdout);
  assert.equal(resolved.workspace, initialized.workspace);
  assert.equal(resolved.exists, true);
});

test("Codex CLI discovery prefers a desktop-bundled PATH candidate and validates app support", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-codex-cli-"));
  const genericDirectory = path.join(root, "generic");
  const bundledDirectory = path.join(root, "ChatGPT.app", "Contents", "Resources");
  await Promise.all([
    mkdir(genericDirectory),
    mkdir(bundledDirectory, { recursive: true }),
  ]);
  await writeFile(path.join(genericDirectory, "codex"), [
    "#!/bin/sh",
    "printf 'Usage: codex app [OPTIONS] [PATH]\\n'",
    "",
  ].join("\n"), { mode: 0o700 });
  const bundled = path.join(bundledDirectory, "codex");
  await writeFile(bundled, "#!/bin/sh\nprintf 'Usage: codex app [OPTIONS] [PATH]\\n'\n", { mode: 0o700 });
  const found = await discoverCodexCli({
    env: { PATH: [genericDirectory, bundledDirectory].join(path.delimiter) },
  });
  assert.equal(found.path, bundled);
  assert.equal(found.source, "desktop-path");
});

test("Codex CLI discovery preserves a multicall shim invocation path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-codex-shim-"));
  const target = path.join(root, "mise");
  const shim = path.join(root, "codex");
  await writeFile(target, [
    "#!/bin/sh",
    "if [ \"${0##*/}\" != \"codex\" ]; then exit 2; fi",
    "if [ \"$1\" = \"app\" ] && [ \"$2\" = \"--help\" ]; then",
    "  printf 'Usage: codex app [OPTIONS] [PATH]\\n'",
    "  exit 0",
    "fi",
    "exit 2",
    "",
  ].join("\n"), { mode: 0o700 });
  await symlink(target, shim);
  const found = await discoverCodexCli({ explicit: shim });
  assert.equal(found.path, shim);
  assert.equal(found.source, "explicit");
});

test("Codex CLI discovery never probes lower-precedence PATH entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-codex-path-order-"));
  const firstDirectory = path.join(root, "first");
  const secondDirectory = path.join(root, "second");
  const lowerProbe = path.join(root, "lower-probed");
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  await writeFile(path.join(firstDirectory, "codex"), [
    "#!/bin/sh",
    "printf 'Usage: codex app [OPTIONS] [PATH]\\n'",
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(path.join(secondDirectory, "codex"), [
    "#!/bin/sh",
    `printf 'invoked\\n' > ${JSON.stringify(lowerProbe)}`,
    "exit 2",
    "",
  ].join("\n"), { mode: 0o700 });
  const found = await discoverCodexCli({
    env: { PATH: [firstDirectory, secondDirectory].join(path.delimiter) },
  });
  assert.equal(found.path, path.join(firstDirectory, "codex"));
  await assert.rejects(lstat(lowerProbe), { code: "ENOENT" });
});

test("Codex thread opening uses the registered desktop deep link", async () => {
  const invocations = [];
  const threadId = "019FFB69-57A6-7801-8B7A-8FF4C32A398C";
  const result = await openThreadInCodex(threadId, {
    platform: "darwin",
    run: async (...args) => { invocations.push(args); },
  });
  assert.deepEqual(invocations, [[
    "/usr/bin/open",
    [`codex://threads/${threadId}`],
    { timeout: 10_000, killSignal: "SIGKILL" },
  ]]);
  assert.equal(result.mechanism, "codex-deep-link");
  assert.equal(result.threadId, threadId);
});

test("Codex thread opening rejects missing and legacy opaque thread IDs", async () => {
  await assert.rejects(openThreadInCodex(""), /not supported/);
  await assert.rejects(openThreadInCodex("durable-thread"), /not supported/);
});

test("workspace init can request Codex app opening through an explicit validated CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-register-"));
  const workspace = path.join(root, "workspace");
  const log = path.join(root, "codex.log");
  const codex = path.join(root, "codex");
  await writeFile(codex, [
    "#!/bin/sh",
    "if [ \"$1\" = \"app\" ] && [ \"$2\" = \"--help\" ]; then",
    "  printf 'Usage: codex app [OPTIONS] [PATH]\\n'",
    "  exit 0",
    "fi",
    `printf '%s\\n' \"$*\" >> ${JSON.stringify(log)}`,
    "",
  ].join("\n"), { mode: 0o700 });
  const result = JSON.parse((await runCli([
    "workspace", "init", "--register-codex", "--codex-cli", codex,
    "--workspace", workspace, "--json",
  ])).stdout);
  assert.equal(result.registration.status, "requested");
  assert.equal(await readFile(log, "utf8"), `app ${await realpath(workspace)}\n`);
});

test("Codex opening failure leaves an initialized workspace and returns structured recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-register-failure-"));
  const workspace = path.join(root, "workspace");
  await assert.rejects(
    runCli([
      "workspace", "init", "--register-codex", "--codex-cli", path.join(root, "missing"),
      "--workspace", workspace, "--json",
    ]),
    (error) => {
      assert.equal(error.code, 5);
      const result = JSON.parse(error.stdout);
      assert.equal(result.registration.status, "failed");
      assert.match(result.registration.reason, /not executable/);
      return true;
    },
  );
  assert.deepEqual((await readdir(workspace)).sort(), ["AGENTS.md", "taskchef.json", "tasks.jsonl"]);
});

test("public task history API uses task terminology", () => {
  for (const name of [
    "buildTaskSummary", "filterTasks", "listTasks", "prepareDispatch", "readTask", "recordTask",
    "linkTask", "resolveTask", "reportTaskResult",
  ]) {
    assert.equal(typeof taskchef[name], "function");
  }
  for (const name of [
    "buildDispatchSummary", "filterDispatches", "readDispatch", "readDispatches", "recordDispatch",
  ]) {
    assert.equal(name in taskchef, false);
  }
  for (const name of [
    "filterThreadCandidates", "hasExactTaskChefMarker", "listThreadEntries",
    "structuredDelegatedInputs", "startTaskFromHook",
    "THREAD_RESOLUTION_CHECKPOINTS_MS", "THREAD_RESOLUTION_CLOCK_SKEW_MS",
    "THREAD_RESOLUTION_RECENT_LIMIT", "THREAD_RESOLUTION_TIMEOUT_MS",
  ]) {
    assert.equal(name in taskchef, false);
  }
});

test("dispatch preparation combines canonical routing data and correlation values", async () => {
  const { workspace, projects } = await fixture(2);
  const prepared = await prepareDispatch(workspace, {
    taskId: TASK_ID,
    now: () => FIXED_TIME,
  });

  assert.equal(prepared.schemaVersion, 1);
  assert.equal(prepared.workspace, await realpath(workspace));
  assert.equal(prepared.taskId, TASK_ID);
  assert.equal(prepared.preparedAt, FIXED_TIME);
  assert.equal(prepared.marker, `<!-- taskchef_id=${TASK_ID} -->`);
  assert.equal(prepared.projectCount, 2);
  assert.deepEqual(prepared.projects.map((project) => project.path), projects);
  await assert.rejects(
    prepareDispatch(workspace, { taskId: "not-a-uuid" }),
    /lowercase full UUID/,
  );
  await assert.rejects(
    prepareDispatch(workspace, { taskId: TASK_ID, now: () => "not-a-time" }),
    /preparedAt must be an ISO 8601 timestamp/,
  );
});

test("structured MCP tools prepare, record, self-link, and report through canonical workspace APIs", async () => {
  const { workspace, projects } = await fixture(1);
  const server = createTaskChefMcpServer({ workspace });
  const client = new Client({ name: "taskchef-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      "prepare_dispatch",
      "record_task",
      "link_task",
      "report_result",
    ]);
    assert.equal(listed.tools[0].annotations.readOnlyHint, true);
    assert.equal(listed.tools[1].annotations.readOnlyHint, false);
    assert.equal(listed.tools[1].annotations.destructiveHint, false);
    assert.equal(listed.tools[1].annotations.openWorldHint, false);
    assert.equal(listed.tools[3].annotations.destructiveHint, true);
    assert.deepEqual(Object.keys(listed.tools[3].inputSchema.properties).sort(), [
      "status", "summary", "taskId", "threadId", "turnId",
    ]);
    for (const tool of listed.tools) {
      assert.equal("workspace" in (tool.inputSchema.properties ?? {}), false);
    }

    const preparedResult = await client.callTool({ name: "prepare_dispatch", arguments: {} });
    const prepared = preparedResult.structuredContent.preparation;
    assert.equal(prepared.workspace, await realpath(workspace));
    assert.equal(prepared.projectCount, 1);

    const instruction = `${prepared.marker}\n\nImplement and test the requested change.`;
    const recordedResult = await client.callTool({
      name: "record_task",
      arguments: {
        id: prepared.taskId,
        project: projects[0],
        title: "MCP task",
        instruction,
        threadId: null,
      },
    });
    assert.equal(recordedResult.structuredContent.task.id, prepared.taskId);
    assert.equal(recordedResult.structuredContent.task.threadId, null);

    const unmarkedResult = await client.callTool({
      name: "record_task",
      arguments: {
        id: SECOND_TASK_ID,
        project: projects[0],
        title: "Unmarked MCP task",
        instruction: "This input has no correlation marker.",
        threadId: null,
      },
    });
    assert.equal(unmarkedResult.isError, true);
    assert.match(unmarkedResult.content[0].text, /must start with its exact TaskChef marker/);
    await assert.rejects(readTask(workspace, SECOND_TASK_ID), /task not found/);

    const resolvedResult = await client.callTool({
      name: "link_task",
      arguments: { taskId: prepared.taskId, threadId: SELF_LINK_THREAD_ID },
    });
    assert.equal(resolvedResult.structuredContent.task.threadId, SELF_LINK_THREAD_ID);
    const completedResult = await client.callTool({
      name: "report_result",
      arguments: {
        taskId: prepared.taskId,
        threadId: SELF_LINK_THREAD_ID,
        turnId: FIRST_RESULT_TURN_ID,
        status: "completed",
        summary: "Implemented and verified the change.",
      },
    });
    assert.equal(completedResult.structuredContent.task.status, "completed");
    assert.equal((await readTask(workspace, prepared.taskId)).summary,
      "Implemented and verified the change.");
    const missingTurnResult = await client.callTool({
      name: "report_result",
      arguments: {
        taskId: prepared.taskId,
        threadId: SELF_LINK_THREAD_ID,
        turnId: null,
        status: "completed",
        summary: "This linked result lacks turn evidence.",
      },
    });
    assert.equal(missingTurnResult.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("bundled stdio MCP entry resolves TASKCHEF_WORKSPACE without model path input", async () => {
  const { workspace } = await fixture(1);
  const client = new Client({ name: "taskchef-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("mcp/server.js")],
    cwd: path.resolve("."),
    env: { ...process.env, TASKCHEF_WORKSPACE: workspace },
  });
  await client.connect(transport);
  try {
    const prepared = await client.callTool({ name: "prepare_dispatch", arguments: {} });
    assert.equal(prepared.structuredContent.preparation.workspace, await realpath(workspace));
  } finally {
    await client.close();
  }
});

test("task recording rejects interactive stdin before waiting for EOF", () => {
  assert.doesNotThrow(() => assertTaskRecordStdin({ isTTY: false }));
  assert.throws(
    () => assertTaskRecordStdin({ isTTY: true }),
    /requires non-interactive JSON on standard input/,
  );
});

test("workspace lock retries contention but fails permanent permission errors immediately", async () => {
  for (const code of ["EPERM", "EACCES"]) {
    const permissionError = Object.assign(new Error("denied"), { code });
    let permissionAttempts = 0;
    await assert.rejects(
      acquireWorkspaceLock("/workspace", {
        lock: async () => {
          permissionAttempts += 1;
          throw permissionError;
        },
        waitImpl: async () => assert.fail("permanent errors must not wait"),
      }),
      (error) => error === permissionError,
    );
    assert.equal(permissionAttempts, 1);
  }

  const contentionError = Object.assign(new Error("busy"), { code: "ELOCKED" });
  let contentionAttempts = 0;
  const waits = [];
  const release = async () => {};
  assert.equal(await acquireWorkspaceLock("/workspace", {
    lock: async () => {
      contentionAttempts += 1;
      if (contentionAttempts < 3) throw contentionError;
      return release;
    },
    waitImpl: async (delayMs) => waits.push(delayMs),
  }), release);
  assert.equal(contentionAttempts, 3);
  assert.deepEqual(waits, [100, 100]);
});

test("end-to-end self-link benchmark derives summary and writes a timestamped result", async () => {
  const input = e2eBenchmarkInput();
  delete input.summary;
  const normalized = normalizeBenchmarkResult(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(normalized.summary, {
    totalWallMs: 5_000,
    provisionalPath: false,
    linked: true,
    freshFollowUp: true,
  });

  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "taskchef-e2e-results-"));
  const written = await writeBenchmarkResult(input, outputDirectory);
  assert.match(path.basename(written.outputPath), /taskchef-executor-self-link-e2e\.json$/);
  assert.equal(written.result.taskchefVersion,
    JSON.parse(await readFile(path.resolve("package.json"), "utf8")).version);
  assert.deepEqual(
    normalizeBenchmarkResult(JSON.parse(await readFile(written.outputPath, "utf8")), {
      requireDerived: true,
    }).summary,
    normalized.summary,
  );
});

test("end-to-end self-link benchmark cleanup removes only managed results", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "taskchef-e2e-clean-"));
  const managed = "2026-08-13T06-30-00.000Z-taskchef-executor-self-link-e2e.json";
  await writeFile(path.join(outputDirectory, managed), "{}\n");
  await writeFile(path.join(outputDirectory, "keep.json"), "{}\n");
  await writeFile(
    path.join(outputDirectory, "2026-08-13Tnotes-taskchef-executor-self-link-e2e.json"),
    "{}\n",
  );
  await writeFile(
    path.join(outputDirectory, "9999-99-99T99-99-99.999Z-taskchef-executor-self-link-e2e.json"),
    "{}\n",
  );
  assert.deepEqual(await cleanBenchmarkResults(outputDirectory), [managed]);
  assert.deepEqual((await readdir(outputDirectory)).sort(), [
    "2026-08-13Tnotes-taskchef-executor-self-link-e2e.json",
    "9999-99-99T99-99-99.999Z-taskchef-executor-self-link-e2e.json",
    "keep.json",
  ]);
});

test("end-to-end self-link benchmark enforces record order, child identity, and fresh turns", () => {
  const provisional = e2eBenchmarkInput();
  provisional.task.clientThreadId = "local:pending";
  assert.equal(normalizeBenchmarkResult(provisional).summary.provisionalPath, true);

  const staleTurn = e2eBenchmarkInput();
  staleTurn.turns.completion = staleTurn.turns.needsInput;
  assert.throws(() => normalizeBenchmarkResult(staleTurn), /newer turn ID/);

  const reversedTurns = e2eBenchmarkInput();
  reversedTurns.turns.completion = "01a03275-d52f-7043-ab4a-513a1ad6ae1e";
  assert.throws(() => normalizeBenchmarkResult(reversedTurns), /newer turn ID/);

  const nonnativeTurn = e2eBenchmarkInput();
  nonnativeTurn.turns.needsInput = "turn-needs-input";
  assert.throws(() => normalizeBenchmarkResult(nonnativeTurn), /canonical Codex UUIDv7/);

  const nonnativeThread = e2eBenchmarkInput();
  nonnativeThread.task.threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.throws(() => normalizeBenchmarkResult(nonnativeThread), /canonical Codex UUIDv7/);

  const createBeforeRecord = e2eBenchmarkInput();
  createBeforeRecord.events.recordedAt = "2026-08-13T06:30:00.300Z";
  createBeforeRecord.events.createdAt = "2026-08-13T06:30:00.200Z";
  assert.throws(() => normalizeBenchmarkResult(createBeforeRecord), /events must be ordered|record must precede/);

  const parentIdentity = e2eBenchmarkInput();
  parentIdentity.validation.parentIdentityRejected = false;
  assert.throws(
    () => normalizeBenchmarkResult(parentIdentity),
    /validation.parentIdentityRejected must be true/,
  );

  const malformedThread = e2eBenchmarkInput();
  malformedThread.task.threadId = "parent-thread";
  assert.throws(() => normalizeBenchmarkResult(malformedThread), /canonical Codex UUIDv7/);

  const noncanonicalTimestamp = e2eBenchmarkInput();
  noncanonicalTimestamp.startedAt = "2026-08-13T06:30:00Z";
  assert.throws(
    () => normalizeBenchmarkResult(noncanonicalTimestamp),
    /canonical four-digit-year UTC timestamp/,
  );
});

test("delegation marker parsing requires the exact first-line full UUID marker", () => {
  const prepared = prepareDelegation("Do the work.", { taskId: TASK_ID });
  assert.equal(prepared.id, TASK_ID);
  assert.equal(
    prepared.instruction,
    `<!-- taskchef_id=${TASK_ID} -->\n\n${EXECUTOR_OWNERSHIP_PARAGRAPH}\n\n${EXECUTOR_LINK_PARAGRAPH}\n\n${EXECUTOR_RESULT_PARAGRAPH}\n\nDo the work.`,
  );
  const [marker, blankLine] = prepared.instruction.split("\n", 2);
  assert.equal(marker, `<!-- taskchef_id=${TASK_ID} -->`);
  assert.equal(blankLine, "");
  assert.match(marker, /^<!-- [^-][\s\S]* -->$/);
  assert.doesNotMatch(marker, /^#{1,6}(?:\s|$)/);
  assert.equal(parseTaskChefMarker(prepared.instruction), TASK_ID);
  assert.equal(parseTaskChefMarker(`prefix\n<!-- taskchef_id=${TASK_ID} -->`), null);
  assert.equal(parseTaskChefMarker("<!-- taskchef_id=short -->"), null);
  assert.equal(parseTaskChefMarker(`<!-- taskchef_id=${TASK_ID} --> trailing`), null);
  assert.equal(parseTaskChefMarker(`<!-- taskchef_id=${TASK_ID.toUpperCase()} -->`), null);
  assert.equal(parseTaskChefMarker(`<!--  taskchef_id=${TASK_ID} -->`), null);
  assert.equal(parseTaskChefMarker(`<!-- taskchef_id=${TASK_ID}-->`), null);
  assert.equal(parseTaskChefMarker(`<!-- taskchef_id=${TASK_ID} -->\nDo the work.`), null);
  assert.equal(parseTaskChefMarker(`<!-- taskchef_id=${TASK_ID} -->\r\nDo the work.`), null);
  assert.equal(parseTaskChefMarker(`# taskchef_id=${TASK_ID}\n\nDo the work.`), null);
  assert.equal(
    parseTaskChefMarker(
      `# taskchef_id=${TASK_ID}\n\nHistorical work.`,
      { allowLegacyHeading: true },
    ),
    TASK_ID,
  );
  assert.equal(
    parseTaskChefMarker(`<!-- taskchef_id=${TASK_ID} -->\r\n\r\nDo the work.`),
    TASK_ID,
  );
  assert.throws(
    () => prepareDelegation("Do the work.", { taskId: TASK_ID.toUpperCase() }),
    /lowercase full UUID/,
  );
  assert.throws(
    () => prepareDelegation(prepared.instruction, { taskId: TASK_ID }),
    /already contains a TaskChef marker/,
  );
});

test("README task record and task show examples preserve exact executor lifecycle paragraphs", async () => {
  const readme = await readFile(path.resolve("README.md"), "utf8");
  for (const paragraph of [
    EXECUTOR_OWNERSHIP_PARAGRAPH,
    EXECUTOR_LINK_PARAGRAPH,
    EXECUTOR_RESULT_PARAGRAPH,
  ]) {
    assert.ok(readme.split(paragraph).length - 1 >= 2);
  }
});

test("minimal delegation records before creation and leaves even durable creation self-link pending", async () => {
  const order = [];
  const recorded = [];
  const resolved = [];
  const result = await createAndRecordDelegation({
    project: "/projects/example",
    title: "Minimal dispatch",
    instruction: "Implement and test it.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: async (task) => { order.push("record"); recorded.push(task); },
    createThread: async () => {
      order.push("create");
      return { threadId: "durable-thread", hostId: "local" };
    },
    resolveRecordedTask: async (task) => { order.push("resolve"); resolved.push(task); },
  });

  assert.deepEqual(order, ["record", "create"]);
  assert.equal(recorded[0].threadId, null);
  assert.equal(result.status, "recorded-link-pending");
  assert.equal(result.resolution, "executor-self-link");
  assert.equal(result.threadId, null);
  assert.deepEqual(resolved, []);
  assert.match(recorded[0].instruction, /link_task MCP tool/);
  assert.match(recorded[0].instruction, /report_result MCP tool/);
});

test("minimal delegation returns immediately with provisional creation link-pending", async () => {
  let createCalls = 0;
  const result = await createAndRecordDelegation({
    project: "/projects/example",
    title: "Hook resolution",
    instruction: "Implement and test it.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: async () => {},
    createThread: async () => {
      createCalls += 1;
      return { clientThreadId: "local:pending" };
    },
  });

  assert.equal(createCalls, 1);
  assert.equal(result.status, "recorded-link-pending");
  assert.equal(result.resolution, "executor-self-link");
  assert.equal(result.threadId, null);
  assert.equal(result.provisional, "local:pending");
});

test("split delegation records and creates one distinct task per outcome", async () => {
  const { workspace, projects } = await fixture(1);
  const created = [];
  const outcomes = [
    { id: TASK_ID, title: "First outcome", instruction: "Implement the first outcome." },
    { id: SECOND_TASK_ID, title: "Second outcome", instruction: "Implement the second outcome." },
  ];

  const results = await Promise.all(outcomes.map((outcome, index) =>
    createAndRecordDelegation({
      project: projects[0],
      title: outcome.title,
      instruction: outcome.instruction,
      target: { type: "project", projectId: "project-example" },
      taskId: outcome.id,
      recordTask: ({ project: _projectPath, ...task }) => recordTask(workspace, {
        ...task,
        project: projects[0],
      }),
      createThread: async ({ prompt }) => {
        created.push(prompt);
        return { threadId: `durable-split-${index}` };
      },
      resolveRecordedTask: ({ id, threadId }) => resolveTask(workspace, id, threadId),
    })));

  assert.deepEqual(results.map((result) => result.threadId), [null, null]);
  await Promise.all(outcomes.map((outcome, index) =>
    linkTask(workspace, outcome.id, [SELF_LINK_THREAD_ID, OTHER_THREAD_ID][index])));
  assert.equal(new Set(created.map((prompt) => parseTaskChefMarker(prompt))).size, 2);
  assert.deepEqual((await listTasks(workspace)).map((task) => task.id).sort(), [
    TASK_ID,
    SECOND_TASK_ID,
  ].sort());
});

test("provisional executor self-links exact child and reports fresh follow-up turns", async () => {
  const { workspace, projects } = await fixture(1);
  let childPrompt;
  const created = await createAndRecordDelegation({
    project: projects[0],
    title: "Provisional self-link journey",
    instruction: "Pause for approval, then complete.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: ({ project: _projectPath, ...task }) => recordTask(workspace, {
      ...task,
      project: projects[0],
    }),
    createThread: async ({ prompt }) => {
      childPrompt = prompt;
      return { clientThreadId: "local:provisional-child", hostId: "local" };
    },
  });

  assert.equal(created.status, "recorded-link-pending");
  assert.equal(created.provisional, "local:provisional-child");
  assert.equal(parseTaskChefMarker(childPrompt), TASK_ID);
  assert.equal((await readTask(workspace, TASK_ID)).threadId, null);
  await assert.rejects(linkTask(workspace, TASK_ID, "local:provisional-child"), /provisional/);

  const childThreadId = SELF_LINK_THREAD_ID;
  await linkTask(workspace, TASK_ID, childThreadId);
  await assert.rejects(linkTask(workspace, TASK_ID, OTHER_THREAD_ID), /different threadId/);
  let result = await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: childThreadId,
    turnId: FIRST_RESULT_TURN_ID,
    status: "needs_input",
    summary: "Approval is required to continue.",
  });
  assert.equal(result.status, "needs_input");
  result = await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: childThreadId,
    turnId: SECOND_RESULT_TURN_ID,
    status: "completed",
    summary: "Approval received and work completed.",
  });
  assert.equal(result.turnId, SECOND_RESULT_TURN_ID);
  assert.equal(result.threadId, childThreadId);
  assert.equal((await readFile(path.join(workspace, "tasks.jsonl"), "utf8")).trim().split("\n").length, 1);
});

test("minimal delegation does not let a dispatcher-owned durable ID bypass self-linking", async () => {
  const result = await createAndRecordDelegation({
    project: "/projects/example",
    title: "Durable recovery",
    instruction: "Implement and test it.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: async () => {},
    createThread: async () => ({ threadId: "durable-created-thread" }),
  });

  assert.equal(result.status, "recorded-link-pending");
  assert.equal(result.resolution, "executor-self-link");
  assert.equal(result.threadId, null);
  assert.equal("createdThreadId" in result, false);
});

test("minimal delegation ignores dispatcher resolution callbacks and never retries creation", async () => {
  let createCalls = 0;
  const result = await createAndRecordDelegation({
    project: "/projects/example",
    title: "Resolution recovery",
    instruction: "Implement and test it.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: async () => {},
    createThread: async () => {
      createCalls += 1;
      return { threadId: "durable-created-thread" };
    },
    resolveRecordedTask: async () => { throw new Error("record lock unavailable"); },
  });

  assert.equal(createCalls, 1);
  assert.equal(result.status, "recorded-link-pending");
  assert.equal(result.resolution, "executor-self-link");
  assert.equal(result.threadId, null);
});

test("minimal delegation preserves and marks the task failed when executor creation fails", async () => {
  const reported = [];
  await assert.rejects(createAndRecordDelegation({
    project: "/projects/example",
    title: "Failed creation",
    instruction: "Implement and test it.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: async () => {},
    createThread: async () => { throw new Error("host unavailable"); },
    reportRecordedResult: async (result) => reported.push(result),
  }), (error) => {
    assert.match(error.message, /host unavailable/);
    assert.equal(error.taskChefTaskId, TASK_ID);
    assert.equal(error.taskChefResultReporting, "recorded");
    return true;
  });
  assert.deepEqual(reported, [{
    taskId: TASK_ID,
    threadId: null,
    turnId: null,
    status: "failed",
    summary: "Executor creation failed before the executor started.",
  }]);
});

test("creation failure reporting is bounded, redacted, and cannot mask the original error", async () => {
  const sensitiveError = new Error(`token=secret-value ${"x".repeat(3_000)}`);
  const reported = [];
  await assert.rejects(createAndRecordDelegation({
    project: "/projects/example",
    title: "Safe failed creation",
    instruction: "Implement and test it.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: async () => {},
    createThread: async () => { throw sensitiveError; },
    reportRecordedResult: async (result) => {
      reported.push(result);
      throw new Error("result storage unavailable");
    },
  }), (error) => {
    assert.equal(error, sensitiveError);
    assert.equal(error.taskChefTaskId, TASK_ID);
    assert.equal(error.taskChefResultReporting, "failed");
    return true;
  });
  assert.equal(reported[0].summary, "Executor creation failed before the executor started.");
  assert.doesNotMatch(reported[0].summary, /secret-value|xxx/);
});

test("creation errors expose recovery identity when result reporting is unavailable", async () => {
  await assert.rejects(createAndRecordDelegation({
    project: "/projects/example",
    title: "Recover unreported creation",
    instruction: "Implement and test it.",
    target: { type: "project", projectId: "project-example" },
    taskId: TASK_ID,
    recordTask: async () => {},
    createThread: async () => { throw new Error("host unavailable"); },
  }), (error) => {
    assert.equal(error.taskChefTaskId, TASK_ID);
    assert.equal(error.taskChefResultReporting, "unavailable");
    return true;
  });
});

test("executor self-linking rejects parent identity, retries idempotently, and keeps result turns fresh", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Wait for a decision, then finish.", { taskId: TASK_ID });
  await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });
  let current = await linkTask(workspace, TASK_ID, SELF_LINK_THREAD_ID, {
    now: "2026-08-19T01:00:00.000Z",
  });
  assert.equal(current.threadId, SELF_LINK_THREAD_ID);
  assert.equal(current.status, "working");
  assert.equal(current.turnId, null);
  assert.equal(current.updatedBy, "mcp");
  assert.deepEqual(await linkTask(workspace, TASK_ID, SELF_LINK_THREAD_ID, {
    now: "2026-08-19T01:00:30.000Z",
  }), current);
  assert.equal(current.updatedAt, "2026-08-19T01:00:00.000Z");
  await assert.rejects(linkTask(workspace, TASK_ID, OTHER_THREAD_ID), /different threadId/);

  current = await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: SELF_LINK_THREAD_ID,
    turnId: FIRST_RESULT_TURN_ID,
    status: "needs_input",
    summary: "Approve deployment to continue.",
  }, { now: "2026-08-19T01:01:00.000Z" });
  assert.equal(current.status, "needs_input");

  current = await readTask(workspace, TASK_ID);
  assert.equal(current.status, "needs_input");
  assert.equal(current.turnId, FIRST_RESULT_TURN_ID);
  assert.equal(current.updatedBy, "mcp");

  await assert.rejects(reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: SELF_LINK_THREAD_ID,
    turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "completed",
    summary: "A non-native turn ID must not be accepted.",
  }), /canonical Codex UUIDv7/);

  assert.deepEqual(await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: SELF_LINK_THREAD_ID.toUpperCase(),
    turnId: FIRST_RESULT_TURN_ID,
    status: "needs_input",
    summary: "Approve deployment to continue.",
  }), current);
  await assert.rejects(reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: SELF_LINK_THREAD_ID,
    turnId: FIRST_RESULT_TURN_ID,
    status: "completed",
    summary: "This stale turn must not complete the task.",
  }), /turn already has a different semantic result/);

  current = await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: SELF_LINK_THREAD_ID,
    turnId: SECOND_RESULT_TURN_ID,
    status: "completed",
    summary: "Deployment approved and completed successfully.",
  }, { now: "2026-08-19T01:03:00.000Z" });
  assert.equal(current.status, "completed");
  assert.equal(current.turnId, SECOND_RESULT_TURN_ID);
  await assert.rejects(reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: SELF_LINK_THREAD_ID,
    turnId: FIRST_RESULT_TURN_ID,
    status: "failed",
    summary: "A replayed earlier turn must not replace completion.",
  }), /turnId must be newer than the stored turnId/);
  assert.equal(current.updatedBy, "mcp");
  assert.equal((await readFile(path.join(workspace, "tasks.jsonl"), "utf8")).trim().split("\n").length, 1);
});

test("concurrent semantic callbacks update different tasks without duplicate lines or lost writes", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0], TASK_ID, "thread-one"), {
    now: FIXED_TIME,
  });
  await recordTask(workspace, dispatchInput(projects[0], SECOND_TASK_ID, "thread-two"), {
    now: FIXED_TIME,
  });

  await Promise.all([
    reportTaskResult(workspace, {
      taskId: TASK_ID,
      threadId: "thread-one",
      turnId: "turn-one",
      status: "completed",
      summary: "First task completed.",
    }, { now: "2026-08-19T02:00:00.000Z" }),
    reportTaskResult(workspace, {
      taskId: SECOND_TASK_ID,
      threadId: "thread-two",
      turnId: "turn-two",
      status: "needs_input",
      summary: "Second task needs a product decision.",
    }, { now: "2026-08-19T02:00:01.000Z" }),
  ]);

  const tasks = await listTasks(workspace);
  assert.deepEqual(tasks.map((task) => [task.id, task.status]), [
    [TASK_ID, "completed"],
    [SECOND_TASK_ID, "needs_input"],
  ]);
  assert.equal((await readFile(path.join(workspace, "tasks.jsonl"), "utf8")).trim().split("\n").length, 2);
  await assert.rejects(reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: "thread-two",
    turnId: "wrong-thread-turn",
    status: "failed",
    summary: "Must not overwrite another task.",
  }), /does not match recorded threadId/);
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
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.composerIcon, "./assets/taskchef.svg");
  assert.equal(manifest.interface.logo, "./assets/taskchef.svg");
  assert.equal(manifest.interface.logoDark, "./assets/taskchef-dark.svg");
  for (const assetPath of [manifest.interface.logo, manifest.interface.logoDark]) {
    const asset = await readFile(path.resolve(assetPath));
    assert.ok(asset.length > 0, `${assetPath} must point to a non-empty packaged asset`);
  }
  assert.equal(packageJson.files.includes(".codex-plugin"), true);
  assert.equal(packageJson.files.includes(".mcp.json"), true);
  assert.equal(packageJson.files.includes("assets"), true);
  assert.equal(packageJson.files.includes("docs/delegation-design.md"), true);
  assert.equal(packageJson.files.includes("mcp"), true);
  assert.equal(packageJson.files.includes("scripts/benchmark-dispatch-prepare.js"), true);
  assert.equal(packageJson.files.includes("scripts/e2e-benchmark.js"), true);
  assert.deepEqual(packageJson.bundleDependencies, [
    "@modelcontextprotocol/sdk",
    "proper-lockfile",
    "zod",
  ]);
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

test("delegation design documents MCP calls and field transitions as focused Markdown sequences", async () => {
  const design = await readFile(path.resolve("docs/delegation-design.md"), "utf8");
  const diagrams = [...design.matchAll(/```mermaid\n(sequenceDiagram[\s\S]*?)```/g)]
    .map((match) => match[1]);
  assert.equal(diagrams.length, 5, "each lifecycle logic point should have a focused diagram");
  for (const diagram of diagrams) {
    const parsed = await mermaidParser.parse(diagram);
    assert.equal(parsed.diagramType, "sequence");
    assert.ok(
      diagram.trim().split("\n").length <= 28,
      "each lifecycle diagram should remain small enough to scan",
    );
  }
  const mermaid = diagrams.join("\n");
  const calls = [...new Set(
    [...mermaid.matchAll(/\b(prepare_dispatch|record_task|link_task|report_result)\(/g)]
      .map((match) => match[1]),
  )];
  assert.deepEqual(calls.sort(), ["link_task", "prepare_dispatch", "record_task", "report_result"]);
  for (const call of calls) {
    assert.match(design, new RegExp(`${call}\\(`));
  }
  const fields = [
    "threadId=null",
    "status=working",
    "summary=null",
    "turnId=null",
    "updatedBy=dispatcher",
    "updatedBy=mcp",
  ];
  for (const field of fields) {
    assert.match(design, new RegExp(field));
  }
  assert.match(design, /exactly one native creation call and never retries/);
  const semanticLabels = mermaid.split("\n").flatMap((line) => {
    const statement = line.trim();
    const frame = statement.match(/^(?:alt|else)\s+(.+)$/)?.[1];
    if (frame) return [frame];
    if (!statement.startsWith("Note ") && !statement.includes(":")) return [];
    const separator = statement.indexOf(":");
    return separator === -1 ? [] : [statement.slice(separator + 1)];
  }).map((label) => label
    .replaceAll("#59;", ";")
    .replace(/<br\s*\/?>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
  assert.ok(semanticLabels.length > 30, "sequences should retain their detailed lifecycle labels");
  for (const label of [
    "Creation result is not executor identity authority",
    "Created-task directive; dispatcher returns immediately",
    "Read own CODEX_THREAD_ID",
    "Exact read of this executor thread",
    "Exact native read after follow-up",
    "Native creation fails after record_task",
    "Keep threadId=null and turnId=null Set status=failed, summary, updatedAt, updatedBy=mcp",
    "Creation failure with preserved TaskChef taskId",
    "Initial link stops before commit",
    "Link commits but response is lost",
  ]) {
    assert.ok(semanticLabels.includes(label), `sequences should retain identity-critical label: ${label}`);
  }
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
      { path: ".mcp.json" },
      { path: "assets/taskchef-dark.svg" },
      { path: "assets/taskchef.svg" },
      { path: "bin/taskchef.js", mode: 0o755 },
      { path: "mcp/server.js" },
      { path: "node_modules/@modelcontextprotocol/sdk/package.json" },
      { path: "node_modules/proper-lockfile/package.json" },
      { path: "node_modules/zod/package.json" },
      { path: "src/cli.js" },
      { path: "src/delegation.js" },
      { path: "src/mcp.js" },
      { path: "src/workspace-path.js" },
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
  assert.equal(packedRelease[0].files.some((file) => file.path.startsWith("hooks/")), false);
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

test("delegate skill isolates trigger metadata and requires structured workspace tools", async () => {
  const content = await readFile(path.resolve("skills/taskchef-delegate/SKILL.md"), "utf8");
  const frontmatter = content.match(/^---\n([\s\S]+?)\n---/)?.[1] ?? "";
  assert.match(frontmatter, /require executor self-linking/);
  assert.doesNotMatch(frontmatter, /ordinary work requests in the TaskChef project/i);
  assert.doesNotMatch(frontmatter, /\$[a-z0-9-]+/);

  const body = content.slice(content.indexOf("\n---", 4) + 4);
  for (const toolName of ["prepare_dispatch", "record_task", "link_task", "report_result"]) {
    assert.match(body, new RegExp(`\\b${toolName}\\b`));
  }
  assert.match(body, /Never fall back to shell writes/i);
  assert.match(
    body,
    /initial structured `codexDelegation\.input` starts with an exact[\s\S]+already owns that delegated\s+assignment/i,
  );
  assert.match(body, /Never reuse a task ID or marker/i);
  assert.match(body, /Before creating each executor, call `record_task` exactly once/i);
  assert.match(body, /Do not call `link_task` from the dispatcher/i);
  assert.match(body, /Never use CODEX_SESSION_ID or the parent or delegator thread ID/i);
  assert.match(body, /current turn ID obtained by reading that exact thread/i);
  assert.match(body, /A follow-up must use the\s+new turn ID/i);
  assert.match(body, /return immediately/i);
  assert.match(body, /If creation fails after recording, call `report_result`/);
  assert.doesNotMatch(body, /bounded identity-resolution|Stop at 30 seconds|resolve_task immediately/i);
});

test("bootstrap skill initializes and verifies the canonical Codex project without hard-coded paths", async () => {
  const content = await readFile(path.resolve("skills/taskchef-bootstrap/SKILL.md"), "utf8");
  assert.match(content, /taskchef\.js workspace path --json|workspace path --json/);
  assert.match(content, /workspace init --register-codex --json/);
  assert.match(content, /list native projects once more/);
  assert.match(content, /~\/\.agents\/taskchef/);
  assert.match(content, /never invoke\s+`codex add`/);
  assert.doesNotMatch(content, /\/Applications\/[^\s]+\.app\/Contents\/Resources\/codex/);
});

test("report skill keeps overviews cheap and reads newer focused tasks once", async () => {
  const content = await readFile(path.resolve("skills/taskchef-report/SKILL.md"), "utf8");
  assert.match(content, /^name: taskchef-report$/m);
  assert.match(content, /taskchef\.js workspace path --json/);
  assert.match(content, /taskchef\.js task show <task-id> --json/);
  assert.match(content, /taskchef\.js task list --project <name-or-path> --json/);
  assert.match(content, /Use the full list only when the user asks for an overview/);
  assert.doesNotMatch(content, /`# taskchef_id=/);
  assert.match(content, /no more than\s+eight targets\s+per call/);
  assert.match(content, /Never edit `tasks\.jsonl` directly/);
  assert.match(content, /Do not poll or wait/);
  assert.match(content, /last seven\s+days/);
  assert.match(content, /omit older terminal entries by default/);
  assert.match(content, /one recent `list_threads` metadata snapshot/);
  assert.match(content, /whole report/);
  assert.match(content, /active\s+or awaiting native approval immediately overrides a cached result without a\s+detailed read/i);
  assert.match(content, /trust the latest MCP result by default in a broad overview/i);
  assert.match(content, /focused task, title, or project report/i);
  assert.match(content, /later than the cached result `updatedAt`, by any amount/i);
  assert.match(content, /If\s+focused metadata is not newer, trust the cache/i);
  assert.doesNotMatch(content, /30-second|30 seconds newer/);
  assert.match(content, /newer turn without a callback\s+makes the cache stale/i);
  assert.match(content, /interrupted or cancelled callback turn\s+cannot prove completion/i);
  assert.match(content, /only a snapshot with\s+`updatedBy: mcp`, a result status, a non-null summary, and a non-null turn ID\s+is a cached semantic result/i);
  assert.match(content, /Any `working` snapshot has no semantic\s+callback, including a self-linked `updatedBy: mcp` snapshot/i);
  assert.match(content, /task is inactive and no callback\s+exists, report the outcome as unknown/);
  assert.match(content, /null thread\/turn IDs as a fresh\s+executor-creation failure/);
  assert.match(content, /schema 4 null identity is executor\s+link-pending/);
  assert.match(content, /schema 1-3 null\s+identity is a legacy recovery candidate/);
  assert.match(content, /No live read is possible or needed/);
  assert.match(content, /no semantic callback/);
  assert.doesNotMatch(content, /task update|reconcile-candidates/);
});

test("plugin package omits lifecycle hooks", async () => {
  await assert.rejects(lstat(path.resolve("hooks/hooks.json")), { code: "ENOENT" });
  await assert.rejects(lstat(path.resolve("src/hook.js")), { code: "ENOENT" });
  assert.equal((await readFile(path.resolve("package.json"), "utf8")).includes('"hooks"'), false);
});

test("comparison documentation describes executor self-linking instead of dispatcher search", async () => {
  const comparison = await readFile(path.resolve("docs/firstmate-taskchef-comparison.md"), "utf8");
  assert.match(comparison, /executor registers its own\s+durable child identity through `link_task`/);
  assert.match(comparison, /dispatcher neither searches recent tasks nor repairs identity/);
  assert.doesNotMatch(comparison, /briefly searches|tries briefly to find|repairs the link/);
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

test("init rejects a symlinked workspace root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-symlink-root-"));
  const outside = path.join(root, "outside");
  const workspace = path.join(root, "workspace");
  await mkdir(outside);
  await symlink(outside, workspace);
  await assert.rejects(initializeWorkspace(workspace), /workspace path is not a real directory/);
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
    githubRepos: ["https://github.com/Example/source"],
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
  assert.deepEqual(folder.githubRepos, []);
  await assert.rejects(
    addProject(workspace, { path: path.join(root, "missing") }),
    /does not exist/,
  );
});

test("schemaVersion 1 configuration normalizes read-only and migrates on init", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-schema-migration-"));
  const workspace = path.join(root, "workspace");
  const first = await gitProject(root, "first");
  const notes = path.join(root, "notes");
  await mkdir(workspace);
  await mkdir(notes);
  await writeFile(path.join(workspace, "taskchef.json"), `${JSON.stringify({
    schemaVersion: 1,
    projects: [{
      name: "first",
      path: first,
      isGitRepository: true,
      githubRepo: "https://github.com/Example/first",
    }, {
      name: "notes",
      path: notes,
      isGitRepository: false,
      githubRepo: null,
    }],
  }, null, 2)}\n`);
  await writeFile(path.join(workspace, "tasks.jsonl"), "");

  assert.deepEqual((await readConfig(workspace)).projects.map((project) => project.githubRepos), [
    ["https://github.com/Example/first"],
    [],
  ]);
  assert.equal(JSON.parse(await readFile(path.join(workspace, "taskchef.json"), "utf8")).schemaVersion, 1);

  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.config.action, "migrated");
  const persisted = JSON.parse(await readFile(path.join(workspace, "taskchef.json"), "utf8"));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.projects.some((project) => "githubRepo" in project), false);
  assert.deepEqual(persisted.projects.map((project) => project.githubRepos), [
    ["https://github.com/Example/first"],
    [],
  ]);
});

test("GitHub repository lists canonicalize and deduplicate common remote spellings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-repositories-"));
  const workspace = path.join(root, "workspace");
  const projectPath = await gitProject(root, "workspace-project");
  await initializeWorkspace(workspace);
  const project = await addProject(workspace, {
    path: projectPath,
    githubRepos: [
      "git@github.com:Example/child.git",
      "https://github.com/example/CHILD/",
      "http://www.github.com/Example/other.git",
    ],
  });
  assert.deepEqual(project.githubRepos, [
    "https://github.com/Example/child",
    "https://github.com/Example/other",
  ]);
  assert.equal(canonicalGithubRepository("ssh://git@github.com/Owner/repository.git"),
    "https://github.com/Owner/repository");
  await assert.rejects(
    validateConfig({
      schemaVersion: 2,
      projects: [{ ...project, githubRepos: "https://github.com/Example/child" }],
    }),
    /must be an array/,
  );
});

test("GitHub issue and pull request URLs route only on one unique configured repository", () => {
  const projects = [{
    name: "monorepo-workspace",
    githubRepos: [
      "https://github.com/Example/child-one",
      "https://github.com/Example/child-two",
    ],
  }, {
    name: "other",
    githubRepos: ["https://github.com/elsewhere/other"],
  }];
  const issue = matchProjectForGithubUrl(
    "http://www.github.com/example/CHILD-TWO.git/issues/42?notification_referrer_id=1",
    projects,
  );
  assert.equal(issue.status, "matched");
  assert.equal(issue.project.name, "monorepo-workspace");
  assert.equal(
    matchProjectForGithubUrl("https://github.com/elsewhere/other/pull/7/files", projects).project.name,
    "other",
  );
  assert.equal(
    matchProjectForGithubUrl("https://github.com/unconfigured/repository/issues/1", projects).status,
    "unmatched",
  );

  const ambiguous = matchProjectForGithubUrl(
    "https://github.com/example/child-one/pull/9",
    [...projects, { name: "duplicate", githubRepos: ["https://github.com/EXAMPLE/CHILD-ONE.git"] }],
  );
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.projects.map((project) => project.name), [
    "monorepo-workspace",
    "duplicate",
  ]);
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
    githubRepos: ["https://github.com/example/first-child"],
  });
  const merged = await importProjects(workspace, [{
    path: first,
    githubRepos: [
      "http://www.github.com/EXAMPLE/first-child.git/",
      "https://github.com/example/second-child",
    ],
  }, { name: "second", path: second }]);
  assert.equal(merged.mode, "merge");
  assert.equal(merged.projectCount, 2);
  const projects = await listProjects(workspace);
  assert.equal(projects.find((project) => project.path === first).name, "curated-first");
  assert.equal(
    projects.find((project) => project.path === first).description,
    "Preserve this description.",
  );
  assert.deepEqual(projects.find((project) => project.path === first).githubRepos, [
    "https://github.com/example/first-child",
    "https://github.com/example/second-child",
  ]);

  const replaced = await importProjects(workspace, [{ name: "second-only", path: second }], {
    replace: true,
  });
  assert.equal(replaced.mode, "replace");
  assert.deepEqual((await listProjects(workspace)).map((project) => project.name), ["second-only"]);
  await assert.rejects(importProjects(workspace, {}), /JSON array/);
});

test("concurrent project configuration writes do not lose updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-config-race-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const projects = await Promise.all([
    gitProject(root, "first"),
    gitProject(root, "second"),
    gitProject(root, "third"),
  ]);
  await Promise.all(projects.map((project, index) => addProject(workspace, {
    name: `project-${index + 1}`,
    path: project,
  })));
  assert.deepEqual((await listProjects(workspace)).map((project) => project.name), [
    "project-1", "project-2", "project-3",
  ]);
});

test("workspace cannot be configured inside a delegation project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-self-route-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  await assert.rejects(
    addProject(workspace, { name: "taskchef", path: workspace }),
    /cannot be configured as its own delegation project/,
  );
  await assert.rejects(
    importProjects(workspace, [{ name: "taskchef", path: workspace }]),
    /cannot be configured as its own delegation project/,
  );
  await assert.rejects(
    addProject(workspace, { name: "ancestor", path: root }),
    /inside a delegation project/,
  );
  await assert.rejects(
    importProjects(workspace, [{ name: "ancestor", path: root }]),
    /inside a delegation project/,
  );
  await writeFile(path.join(workspace, "taskchef.json"), `${JSON.stringify({
    schemaVersion: 2,
    projects: [{
      name: "ancestor",
      path: root,
      isGitRepository: false,
      githubRepos: [],
    }],
  })}\n`);
  await assert.rejects(readConfig(workspace), /inside a delegation project/);
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

test("dispatch recording appends one working task entry", async () => {
  const { workspace, projects } = await fixture(1);
  const recorded = await recordTask(workspace, dispatchInput(projects[0]), { now: FIXED_TIME });
  assert.equal(recorded.createdAt, FIXED_TIME);
  assert.equal(recorded.schemaVersion, 4);
  assert.equal(recorded.project.name, "project-1");
  assert.deepEqual(recorded.project.githubRepos, ["https://github.com/example/project-1"]);
  assert.deepEqual(Object.keys(recorded), [
    "schemaVersion", "id", "project", "title", "instruction", "threadId", "createdAt",
    "status", "summary", "turnId", "updatedAt", "updatedBy",
  ]);
  assert.equal(recorded.status, "working");
  assert.equal(recorded.updatedBy, "dispatcher");
  const content = await readFile(path.join(workspace, "tasks.jsonl"), "utf8");
  assert.equal(content.split("\n").length, 2);
  assert.deepEqual(JSON.parse(content.trim()), recorded);
});

test("durable direct recording remains marker-independent", async () => {
  const { workspace, projects } = await fixture(1);
  const recorded = await recordTask(
    workspace,
    dispatchInput(projects[0], "direct-record", "durable-thread"),
    { now: FIXED_TIME },
  );

  assert.equal(recorded.id, "direct-record");
  assert.equal(recorded.instruction, "Create echo_input.py, test it, and report the result.");
  assert.equal(recorded.threadId, "durable-thread");
  await assert.rejects(
    resolveTask(workspace, "direct-record", "durable-thread"),
    /only available for legacy pre-self-linking records/,
  );
});

test("old heading markers remain history-readable but cannot be newly recorded or resolved", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Historical unresolved task.", { taskId: TASK_ID });
  const recorded = await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });
  const legacyInstruction = `# taskchef_id=${TASK_ID}\n\nHistorical unresolved task.`;
  const historical = { ...recorded, instruction: legacyInstruction };
  const logPath = path.join(workspace, "tasks.jsonl");
  await writeFile(logPath, `${JSON.stringify(historical)}\n`);

  assert.equal((await listTasks(workspace))[0].instruction, legacyInstruction);
  await assert.rejects(
    recordTask(workspace, {
      ...dispatchInput(projects[0], SECOND_TASK_ID, null),
      instruction: `# taskchef_id=${SECOND_TASK_ID}\n\nNew unresolved task.`,
    }),
    /null threadId must contain its exact TaskChef marker/,
  );
  await assert.rejects(
    recordTask(workspace, {
      ...dispatchInput(projects[0], SECOND_TASK_ID, null),
      instruction: `<!-- taskchef_id=${SECOND_TASK_ID} -->\nMissing blank line.`,
    }),
    /null threadId must contain its exact TaskChef marker/,
  );
  await assert.rejects(
    resolveTask(workspace, TASK_ID, "durable-thread"),
    /only available for legacy pre-self-linking records/,
  );
});

test("historical heading markers retain their prior first-line read compatibility", async () => {
  for (const legacyInstruction of [
    `# taskchef_id=${TASK_ID}\nHistorical body without a blank separator.`,
    `# taskchef_id=${TASK_ID}`,
  ]) {
    const { workspace, projects } = await fixture(1);
    const historical = {
      schemaVersion: 2,
      id: TASK_ID,
      project: {
        name: "project-1",
        path: projects[0],
        isGitRepository: true,
        githubRepos: ["https://github.com/example/project-1"],
        description: "Fixture project 1.",
      },
      title: "Historical unresolved task",
      instruction: legacyInstruction,
      threadId: null,
      createdAt: FIXED_TIME,
    };
    await writeFile(
      path.join(workspace, "tasks.jsonl"),
      `${JSON.stringify(historical)}\n`,
    );

    assert.equal((await listTasks(workspace))[0].instruction, legacyInstruction);
    await assert.rejects(
      resolveTask(workspace, TASK_ID, "durable-thread"),
      /does not contain its exact TaskChef marker/,
    );
  }
});

test("legacy task snapshots normalize repository scalars without eager log rewrites", async () => {
  const { workspace, projects } = await fixture(1);
  const recorded = await recordTask(workspace, dispatchInput(projects[0]), { now: FIXED_TIME });
  const { githubRepos, ...legacyProject } = recorded.project;
  const {
    status, summary, turnId, updatedAt, updatedBy, ...legacyRecord
  } = recorded;
  const legacy = {
    ...legacyRecord,
    schemaVersion: 1,
    project: { ...legacyProject, githubRepo: githubRepos[0] },
  };
  const logPath = path.join(workspace, "tasks.jsonl");
  await writeFile(logPath, `${JSON.stringify(legacy)}\n`);

  const [normalized] = await listTasks(workspace);
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.status, null);
  assert.deepEqual(normalized.project.githubRepos, ["https://github.com/example/project-1"]);
  assert.deepEqual(JSON.parse((await readFile(logPath, "utf8")).trim()), legacy);
});

test("resolving a legacy task preserves every unrelated history line byte-for-byte", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Resolve the legacy task.", { taskId: TASK_ID });
  const unresolved = await recordTask(workspace, {
    ...dispatchInput(projects[0], prepared.id, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });
  const unrelated = await recordTask(
    workspace,
    dispatchInput(projects[0], "unrelated", "unrelated-thread"),
  );
  const { githubRepos, ...legacyProject } = unresolved.project;
  const {
    status, summary, turnId, updatedAt, updatedBy, ...legacyRecord
  } = unresolved;
  const legacy = {
    ...legacyRecord,
    schemaVersion: 1,
    project: { ...legacyProject, githubRepo: githubRepos[0] },
  };
  const legacyLine = JSON.stringify(legacy);
  const unrelatedLine = `  ${JSON.stringify(unrelated)}  `;
  const logPath = path.join(workspace, "tasks.jsonl");
  await writeFile(logPath, `${legacyLine}\n${unrelatedLine}\n`);

  const resolved = await resolveTask(workspace, prepared.id, "resolved-legacy-thread");
  assert.equal(resolved.schemaVersion, 1);
  assert.deepEqual(resolved.project.githubRepos, githubRepos);
  const [updatedLegacyLine, preservedUnrelatedLine] = (await readFile(logPath, "utf8"))
    .slice(0, -1)
    .split("\n");
  assert.deepEqual(JSON.parse(updatedLegacyLine), {
    ...legacy,
    threadId: "resolved-legacy-thread",
  });
  assert.equal(preservedUnrelatedLine, unrelatedLine);
});

test("legacy resolution rejects a case-variant duplicate Codex UUID", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Resolve the legacy task.", { taskId: TASK_ID });
  const unresolved = await recordTask(workspace, {
    ...dispatchInput(projects[0], prepared.id, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });
  const occupied = await recordTask(
    workspace,
    dispatchInput(projects[0], SECOND_TASK_ID, SELF_LINK_THREAD_ID),
    { now: FIXED_TIME },
  );
  const { status, summary, turnId, updatedAt, updatedBy, ...legacy } = unresolved;
  await writeFile(
    path.join(workspace, "tasks.jsonl"),
    `${JSON.stringify({ ...legacy, schemaVersion: 2 })}\n${JSON.stringify(occupied)}\n`,
  );
  await assert.rejects(
    resolveTask(workspace, TASK_ID, SELF_LINK_THREAD_ID.toUpperCase()),
    /threadId is already recorded/,
  );
});

test("schema 3 legacy resolution refreshes dispatcher state without upgrading history", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Resolve the stateful legacy task.", { taskId: TASK_ID });
  const current = await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });
  const schema3 = { ...current, schemaVersion: 3 };
  await writeFile(path.join(workspace, "tasks.jsonl"), `${JSON.stringify(schema3)}\n`);

  const resolvedAt = "2026-08-24T03:00:00.000Z";
  const resolved = await resolveTask(workspace, TASK_ID, SELF_LINK_THREAD_ID, {
    now: resolvedAt,
  });
  assert.equal(resolved.threadId, SELF_LINK_THREAD_ID);
  assert.equal(resolved.updatedAt, resolvedAt);
  assert.equal(resolved.updatedBy, "dispatcher");
  const persisted = JSON.parse((await readFile(path.join(workspace, "tasks.jsonl"), "utf8")).trim());
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.threadId, SELF_LINK_THREAD_ID);
  assert.equal(persisted.updatedAt, resolvedAt);
  assert.equal(persisted.updatedBy, "dispatcher");
});

test("marked legacy callbacks remain schema 3 across multiple opaque turns", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Continue the marked legacy task.", { taskId: TASK_ID });
  const current = await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });
  await writeFile(
    path.join(workspace, "tasks.jsonl"),
    `${JSON.stringify({ ...current, schemaVersion: 3 })}\n`,
  );
  await resolveTask(workspace, TASK_ID, "legacy-thread", {
    now: "2026-08-24T03:00:00.000Z",
  });
  await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: "legacy-thread",
    turnId: "legacy-turn-1",
    status: "needs_input",
    summary: "A legacy decision is required.",
  });
  const completed = await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: "legacy-thread",
    turnId: "legacy-turn-2",
    status: "completed",
    summary: "The legacy task completed.",
  });
  assert.equal(completed.turnId, "legacy-turn-2");
  assert.equal(
    JSON.parse((await readFile(path.join(workspace, "tasks.jsonl"), "utf8")).trim()).schemaVersion,
    3,
  );
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
  await recordTask(workspace, dispatchInput(projects[0], "dispatch-c", SELF_LINK_THREAD_ID));
  await assert.rejects(
    recordTask(workspace, dispatchInput(projects[0], "dispatch-d", SELF_LINK_THREAD_ID.toUpperCase())),
    /threadId is already recorded/,
  );
});

test("task log validation rejects mixed-case duplicates of one Codex UUID", async () => {
  const { workspace, projects } = await fixture(1);
  const first = await recordTask(
    workspace,
    dispatchInput(projects[0], TASK_ID, SELF_LINK_THREAD_ID),
    { now: FIXED_TIME },
  );
  const duplicate = {
    ...first,
    id: SECOND_TASK_ID,
    threadId: SELF_LINK_THREAD_ID.toUpperCase(),
  };
  await writeFile(
    path.join(workspace, "tasks.jsonl"),
    `${JSON.stringify(first)}\n${JSON.stringify(duplicate)}\n`,
  );
  await assert.rejects(listTasks(workspace), /duplicate task threadId/);
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

test("task linking performs one atomic null-to-threadId transition", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Recover this task later.", { taskId: TASK_ID });
  const unresolved = await recordTask(workspace, {
    ...dispatchInput(projects[0], prepared.id, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });

  const resolved = await linkTask(workspace, prepared.id, SELF_LINK_THREAD_ID);
  assert.equal(resolved.threadId, SELF_LINK_THREAD_ID);
  assert.equal(resolved.createdAt, unresolved.createdAt);
  assert.equal(resolved.instruction, unresolved.instruction);
  assert.deepEqual(await linkTask(workspace, prepared.id, SELF_LINK_THREAD_ID), resolved);
  await assert.rejects(
    linkTask(workspace, prepared.id, OTHER_THREAD_ID),
    /already has a different threadId/,
  );
  assert.deepEqual(await readTask(workspace, prepared.id), resolved);
});

test("task linking accepts uppercase native UUIDs and stores one canonical identity", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Link this task.", { taskId: TASK_ID });
  await recordTask(workspace, {
    ...dispatchInput(projects[0], prepared.id, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });

  const linked = await linkTask(workspace, prepared.id, SELF_LINK_THREAD_ID.toUpperCase());
  assert.equal(linked.threadId, SELF_LINK_THREAD_ID);
  assert.deepEqual(await linkTask(workspace, prepared.id, SELF_LINK_THREAD_ID), linked);
});

test("task linking rejects dispatcher-prebound schema 4 identities", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0], TASK_ID, SELF_LINK_THREAD_ID), {
    now: FIXED_TIME,
  });
  await assert.rejects(
    linkTask(workspace, TASK_ID, SELF_LINK_THREAD_ID),
    /not an eligible link-pending dispatcher record/,
  );
  await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: SELF_LINK_THREAD_ID,
    turnId: "direct-record-turn",
    status: "completed",
    summary: "Direct records retain legacy result compatibility.",
  });
  await assert.rejects(
    linkTask(workspace, TASK_ID, SELF_LINK_THREAD_ID),
    /does not contain its exact TaskChef marker/,
  );

  const marked = prepareDelegation("Marked but prebound.", { taskId: SECOND_TASK_ID });
  await assert.rejects(
    recordTask(workspace, {
      ...dispatchInput(projects[0], SECOND_TASK_ID, OTHER_THREAD_ID),
      instruction: marked.instruction,
    }, { now: FIXED_TIME }),
    /must be recorded with threadId: null/,
  );
});

test("task linking cannot revive a terminal creation-failure record", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Creation will fail.", { taskId: TASK_ID });
  await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, null),
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });
  await reportTaskResult(workspace, {
    taskId: TASK_ID,
    threadId: null,
    turnId: null,
    status: "failed",
    summary: "Executor creation failed.",
  });
  await assert.rejects(
    linkTask(workspace, TASK_ID, SELF_LINK_THREAD_ID),
    /not an eligible link-pending dispatcher record/,
  );
});

test("task linking validates the marker and durable thread ID uniqueness", async () => {
  const { workspace, projects } = await fixture(1);
  await assert.rejects(linkTask(workspace, "missing-task", SELF_LINK_THREAD_ID), /task not found/);
  await assert.rejects(linkTask(workspace, TASK_ID, "not-a-codex-uuid"), /canonical Codex UUIDv7/);
  await assert.rejects(
    linkTask(workspace, TASK_ID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    /canonical Codex UUIDv7/,
  );
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
  await linkTask(workspace, first.id, SELF_LINK_THREAD_ID);
  await assert.rejects(
    linkTask(workspace, second.id, SELF_LINK_THREAD_ID.toUpperCase()),
    /threadId is already recorded/,
  );
});

test("concurrent task linking permits exactly one durable thread ID", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("Resolve concurrently.", { taskId: TASK_ID });
  await recordTask(workspace, {
    ...dispatchInput(projects[0], prepared.id, null),
    instruction: prepared.instruction,
  });

  const settled = await Promise.allSettled([
    linkTask(workspace, prepared.id, SELF_LINK_THREAD_ID),
    linkTask(workspace, prepared.id, OTHER_THREAD_ID),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    settled.find((result) => result.status === "rejected").reason.message,
    /already has a different threadId/,
  );
  assert.ok([SELF_LINK_THREAD_ID, OTHER_THREAD_ID].includes((await readTask(workspace, prepared.id)).threadId));
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
  await assert.rejects(lstat(path.join(workspace, ".taskchef-workspace.lock")), { code: "ENOENT" });

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
  const lockPath = path.join(workspace, ".taskchef-workspace.lock");
  await mkdir(lockPath);
  const abandonedAt = new Date(Date.now() - 700_000);
  await utimes(lockPath, abandonedAt, abandonedAt);

  await recordTask(workspace, dispatchInput(projects[0], "after-crash", "thread-after-crash"));
  assert.deepEqual((await listTasks(workspace)).map((item) => item.id), ["after-crash"]);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("a live workspace writer is not reaped after the former five-second stale window", async () => {
  const { workspace, projects } = await fixture(1);
  const lockPath = path.join(workspace, ".taskchef-workspace.lock");
  const release = await lockfile.lock(workspace, {
    realpath: false,
    lockfilePath: lockPath,
    stale: 600_000,
    update: 10_000,
  });
  const startedAt = Date.now();
  const recording = recordTask(
    workspace,
    dispatchInput(projects[0], "after-live-writer", "thread-after-live-writer"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5_200));
  assert.equal((await listTasks(workspace)).length, 0);
  await release();
  await recording;
  assert.ok(Date.now() - startedAt >= 5_000);
  assert.deepEqual((await listTasks(workspace)).map((item) => item.id), ["after-live-writer"]);
});

test("journey reads and doctor do not require workspace write access", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0]));
  const lockPath = path.join(workspace, ".taskchef-workspace.lock");
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
    "project", "add", first, "--name", "first",
    "--github-repo", "https://github.com/example/first-child",
    "--github-repo", "git@github.com:example/second-child.git",
    "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(added.stdout).githubRepos, [
    "https://github.com/example/first-child",
    "https://github.com/example/second-child",
  ]);
  const imported = await runCli([
    "project", "import", "-", "--json", "--workspace", workspace,
  ], { input: JSON.stringify([{ name: "second", path: second }]) });
  assert.equal(JSON.parse(imported.stdout).projectCount, 2);
  const projects = await runCli(["project", "list", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(projects.stdout).projectCount, 2);
  const preparedDispatch = JSON.parse((await runCli([
    "dispatch", "prepare", "--json", "--workspace", workspace,
  ])).stdout);
  assert.equal(preparedDispatch.workspace, await realpath(workspace));
  assert.equal(preparedDispatch.workspaceSource, "explicit");
  assert.equal(preparedDispatch.projectCount, 2);
  assert.match(preparedDispatch.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(preparedDispatch.marker, `<!-- taskchef_id=${preparedDispatch.taskId} -->`);
  assert.ok(Date.parse(preparedDispatch.preparedAt));

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
  await assert.rejects(
    runCli([
      "task", "resolve", prepared.id, "--thread-id", "cli-durable-thread",
      "--json", "--workspace", workspace,
    ]),
    (error) => error.code === 1 && /only available for legacy pre-self-linking records/.test(error.stderr),
  );
  const cliTaskLog = path.join(workspace, "tasks.jsonl");
  const cliRecords = (await readFile(cliTaskLog, "utf8")).trimEnd().split("\n").map(JSON.parse);
  const legacyCliRecords = cliRecords.map((record) => record.id === prepared.id
    ? { ...record, schemaVersion: 3 }
    : record);
  await writeFile(cliTaskLog, `${legacyCliRecords.map(JSON.stringify).join("\n")}\n`);
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
    [TASK_ID, "dispatch-1"],
  );
  const summary = await runCli(["task", "summary", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(summary.stdout).taskCount, 2);
  assert.equal(JSON.parse(summary.stdout).projectCounts.first, 2);
  const doctor = await runCli(["doctor", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
});

test("CLI project list groups repositories without repeating project details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-project-list-"));
  const workspace = path.join(root, "workspace");
  const multiPath = path.join(root, "multi");
  const singlePath = path.join(root, "single");
  const zeroPath = path.join(root, "zero");
  await mkdir(multiPath);
  await mkdir(singlePath);
  await mkdir(zeroPath);
  await initializeWorkspace(workspace);
  const multi = await addProject(workspace, {
    name: "multi",
    path: multiPath,
    githubRepos: [
      "https://github.com/example/one",
      "https://github.com/example/two",
      "https://github.com/example/three",
    ],
  });
  const zero = await addProject(workspace, {
    name: "zero",
    path: zeroPath,
    githubRepos: [],
  });
  const single = await addProject(workspace, {
    name: "single",
    path: singlePath,
    githubRepos: ["https://github.com/example/only"],
  });

  const human = await runCli(["project", "list", "--workspace", workspace]);
  const header = "NAME    KIND    GITHUB REPOSITORY                 PATH";
  assert.equal(human.stdout, [
    header,
    `multi   folder  https://github.com/example/one    ${multi.path}`,
    "                https://github.com/example/two",
    "                https://github.com/example/three",
    `single  folder  https://github.com/example/only   ${single.path}`,
    `zero    folder  -                                 ${zero.path}`,
    "",
  ].join("\n"));
  assert.equal(human.stdout.split("\n")[0], header);
  assert.equal(human.stdout.match(/https:\/\/github\.com\/example\//g)?.length, 4);
  assert.doesNotMatch(human.stdout, /[├└]─|\t/);
  const lines = human.stdout.trimEnd().split("\n");
  assert.equal(lines.filter((line) => line.startsWith("multi ")).length, 1);
  assert.equal(lines.filter((line) => line.startsWith("single ")).length, 1);
  assert.equal(lines.filter((line) => line.startsWith("zero ")).length, 1);
  assert.equal(lines.filter((line) => line.includes(multi.path)).length, 1);
  assert.equal(lines.some((line) => /\s+$/.test(line)), false);

  const json = await runCli(["project", "list", "--json", "--workspace", workspace]);
  assert.deepEqual(JSON.parse(json.stdout), {
    projectCount: 3,
    projects: [multi, single, zero],
  });
});

test("CLI task list uses TITLE PROJECT STATUS UPDATED ID THREAD ID order, filters, sorts, and preserves JSON", async () => {
  const { workspace, projects } = await fixture(2);
  const longTitle = "Investigate and document a deliberately long retry-handling failure title";
  const first = await recordTask(workspace, {
    ...dispatchInput(projects[0], "task-first", "thread-first"),
    title: longTitle,
  }, { now: FIXED_TIME });
  await recordTask(workspace, dispatchInput(projects[1], "task-second", "thread-second"), {
    now: "2026-08-08T11:00:00.000Z",
  });
  const newest = await recordTask(
    workspace,
    dispatchInput(projects[0], "task-newest", "thread-newest"),
    { now: "2026-08-08T12:00:00.000+05:00" },
  );
  const latest = await recordTask(
    workspace,
    dispatchInput(projects[0], "task-latest", "thread-latest"),
    { now: "2026-08-08T08:00:00.000Z" },
  );

  const human = await runCli([
    "task", "list", "--project", "project-1", "--workspace", workspace,
  ]);
  const createdWidth = "2026-08-08T12:00:00.000+05:00".length;
  const header = `${"TITLE".padEnd(longTitle.length)}  PROJECT    STATUS   ${"UPDATED".padEnd(createdWidth)}  ${"ID".padEnd("task-newest".length)}  THREAD ID`;
  assert.equal(human.stdout, [
    header,
    `${longTitle}  project-1  working  ${FIXED_TIME.padEnd(createdWidth)}  ${"task-first".padEnd("task-newest".length)}  thread-first`,
    `${"Echo input".padEnd(longTitle.length)}  project-1  working  ${"2026-08-08T08:00:00.000Z".padEnd(createdWidth)}  ${"task-latest".padEnd("task-newest".length)}  thread-latest`,
    `${"Echo input".padEnd(longTitle.length)}  project-1  working  2026-08-08T12:00:00.000+05:00  task-newest  thread-newest`,
    "",
  ].join("\n"));
  assert.deepEqual(human.stdout.trimEnd().split("\n")[0].trim().split(/\s{2,}/), [
    "TITLE", "PROJECT", "STATUS", "UPDATED", "ID", "THREAD ID",
  ]);
  assert.doesNotMatch(human.stdout, /task-second/);

  const json = await runCli([
    "task", "list", "--project", "PROJECT-1", "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(json.stdout), {
    taskCount: 3,
    tasks: [first, latest, newest],
  });
  const ascendingHuman = await runCli([
    "task", "list", "--project", "project-1", "--ascending", "--workspace", workspace,
  ]);
  assert.equal(ascendingHuman.stdout, [
    header,
    `${"Echo input".padEnd(longTitle.length)}  project-1  working  2026-08-08T12:00:00.000+05:00  task-newest  thread-newest`,
    `${"Echo input".padEnd(longTitle.length)}  project-1  working  ${"2026-08-08T08:00:00.000Z".padEnd(createdWidth)}  ${"task-latest".padEnd("task-newest".length)}  thread-latest`,
    `${longTitle}  project-1  working  ${FIXED_TIME.padEnd(createdWidth)}  ${"task-first".padEnd("task-newest".length)}  thread-first`,
    "",
  ].join("\n"));
  const ascendingJson = await runCli([
    "task", "list", "--project", "project-1", "--ascending", "--json",
    "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(ascendingJson.stdout), {
    taskCount: 3,
    tasks: [newest, latest, first],
  });
});

test("CLI task list abbreviates UUIDs, shows null thread IDs, and supports --full-id", async () => {
  const { workspace, projects } = await fixture(1);
  const threadId = "019ff141-e290-74d0-bc4b-646e83d14bea";
  const resolved = await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, threadId),
    title: "Resolved",
  }, { now: FIXED_TIME });
  const prepared = prepareDelegation("Recover this task later.", { taskId: SECOND_TASK_ID });
  const unresolved = await recordTask(workspace, {
    ...dispatchInput(projects[0], SECOND_TASK_ID, null),
    title: "Unresolved",
    instruction: prepared.instruction,
  }, { now: "2026-08-08T11:00:00.000Z" });

  const abbreviated = await runCli(["task", "list", "--workspace", workspace]);
  const abbreviatedRows = abbreviated.stdout.trimEnd().split("\n")
    .map((line) => line.trim().split(/\s{2,}/));
  assert.deepEqual(abbreviatedRows, [
    ["TITLE", "PROJECT", "STATUS", "UPDATED", "ID", "THREAD ID"],
    ["Unresolved", "project-1", "working", "2026-08-08T11:00:00.000Z", "ea896202", "-"],
    ["Resolved", "project-1", "working", FIXED_TIME, "c0f010ff", "019ff141"],
  ]);

  const full = await runCli(["task", "list", "--full-id", "--workspace", workspace]);
  const fullRows = full.stdout.trimEnd().split("\n")
    .map((line) => line.trim().split(/\s{2,}/));
  assert.deepEqual(fullRows, [
    ["TITLE", "PROJECT", "STATUS", "UPDATED", "ID", "THREAD ID"],
    ["Unresolved", "project-1", "working", "2026-08-08T11:00:00.000Z", SECOND_TASK_ID, "-"],
    ["Resolved", "project-1", "working", FIXED_TIME, TASK_ID, threadId],
  ]);

  const json = await runCli([
    "task", "list", "--full-id", "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(json.stdout), {
    taskCount: 2,
    tasks: [unresolved, resolved],
  });
});

test("CLI task show prints human details for full and unique short IDs", async () => {
  const { workspace, projects } = await fixture(1);
  const recorded = await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, "show-thread"),
    title: "Show by short ID",
  }, { now: FIXED_TIME });

  const listed = await runCli(["task", "list", "--workspace", workspace]);
  assert.match(listed.stdout, /\bc0f010ff\b/);

  const expected = [
    "Title: Show by short ID",
    "Project: project-1",
    "Status: working",
    "Summary: -",
    `Project path: ${projects[0]}`,
    `Created: ${FIXED_TIME}`,
    `Updated: ${FIXED_TIME}`,
    "Updated by: dispatcher",
    `Task ID: ${TASK_ID}`,
    "Thread ID: show-thread",
    "Turn ID: -",
    "Instruction:",
    recorded.instruction,
    "",
  ].join("\n");
  const fullHuman = await runCli(["task", "show", TASK_ID, "--workspace", workspace]);
  assert.equal(fullHuman.stdout, expected);
  const shortHuman = await runCli(["task", "show", "c0f010ff", "--workspace", workspace]);
  assert.equal(shortHuman.stdout, expected);
});

test("CLI task show preserves complete JSON for full and unique short IDs", async () => {
  const { workspace, projects } = await fixture(1);
  const recorded = await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, "show-thread"),
    title: "Show as JSON",
  }, { now: FIXED_TIME });

  const fullJson = await runCli([
    "task", "show", TASK_ID, "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(fullJson.stdout), recorded);
  const shortJson = await runCli([
    "task", "show", "c0f010ff", "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(shortJson.stdout), recorded);
});

test("CLI task show preserves multiline instructions and renders a null thread ID clearly", async () => {
  const { workspace, projects } = await fixture(1);
  const prepared = prepareDelegation("First line.\n\n- Keep this list.\n  - Keep its indentation.", {
    taskId: TASK_ID,
  });
  const recorded = await recordTask(workspace, {
    ...dispatchInput(projects[0], TASK_ID, null),
    title: "Unresolved multiline task",
    instruction: prepared.instruction,
  }, { now: FIXED_TIME });

  const human = await runCli(["task", "show", "c0f010ff", "--workspace", workspace]);
  const instruction = human.stdout.slice(human.stdout.indexOf("Instruction:\n") + 13, -1);
  assert.equal(instruction, recorded.instruction);
  assert.match(human.stdout, /^Thread ID: -$/m);

  const json = await runCli([
    "task", "show", TASK_ID, "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(json.stdout), recorded);
});

test("CLI task show escapes line breaks in labeled details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-v2-"));
  const workspace = path.join(root, "dispatcher");
  await initializeWorkspace(workspace);
  const project = await gitProject(root, "project\nThread ID: forged");
  await addProject(workspace, {
    name: "project\r\nInstruction: forged",
    path: project,
    description: "Line break fixture.",
  });
  const recorded = await recordTask(workspace, {
    ...dispatchInput(project, TASK_ID, "show-thread"),
    title: "First line\nProject: forged",
    instruction: "Keep this\nmultiline instruction.",
  }, { now: FIXED_TIME });

  const human = await runCli(["task", "show", TASK_ID, "--workspace", workspace]);
  assert.equal(human.stdout, [
    "Title: First line\\nProject: forged",
    "Project: project\\r\\nInstruction: forged",
    "Status: working",
    "Summary: -",
    `Project path: ${project.replaceAll("\n", "\\n")}`,
    `Created: ${FIXED_TIME}`,
    `Updated: ${FIXED_TIME}`,
    "Updated by: dispatcher",
    `Task ID: ${TASK_ID}`,
    "Thread ID: show-thread",
    "Turn ID: -",
    "Instruction:",
    recorded.instruction,
    "",
  ].join("\n"));
});

test("CLI help distinguishes human task show output from complete JSON", async () => {
  const help = await runCli(["help"]);
  assert.match(
    help.stdout,
    /Task show prints human-readable details by default; --json prints the complete task object\./,
  );
});

test("CLI task show rejects missing, ambiguous, malformed, short, and wrong-case prefixes", async () => {
  const { workspace, projects } = await fixture(1);
  const collision = "c0f010ff-1111-4111-8111-111111111111";
  await recordTask(workspace, dispatchInput(projects[0], TASK_ID, "first-thread"));
  await recordTask(workspace, dispatchInput(projects[0], collision, "second-thread"));

  for (const [taskId, pattern] of [
    ["deadbeef", /task not found for ID prefix: deadbeef.*task list --full-id/],
    ["c0f010ff", /task ID prefix is ambiguous: c0f010ff.*pass the full task ID/],
    ["nothexid", /malformed task ID prefix: nothexid.*8 hexadecimal characters/],
    ["c0f010f", /task ID prefix is too short: c0f010f.*all 8 characters/],
    ["C0F010FF", /task not found for ID prefix: C0F010FF/],
    ["bad/id!!", /taskId contains unsupported characters/],
  ]) {
    for (const outputArgs of [[], ["--json"]]) {
      await assert.rejects(
        runCli([
          "task", "show", taskId, ...outputArgs, "--workspace", workspace,
        ]),
        (error) => error.code === 1 && error.stdout === "" && pattern.test(error.stderr),
      );
    }
  }
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
