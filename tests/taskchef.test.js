import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
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

import {
  addProject,
  buildReconciliationCandidates,
  buildTaskSummary,
  canonicalDirectory,
  createTask,
  doctorWorkspace,
  ensureWorkspaceInstructions,
  filterTasks,
  importProjects,
  initializeWorkspace,
  listProjects,
  listTasks,
  readConfig,
  readTask,
  removeProject,
  requireSafeId,
  updateTask,
  validateConfig,
  validateResult,
} from "../index.js";

const execFile = promisify(execFileCallback);
const FIXED_TIME = "2026-08-08T10:00:00.000Z";
const LATER_TIME = "2026-08-08T10:05:00.000Z";

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

function taskInput(project, id = "task-1") {
  return {
    id,
    project,
    title: "Echo input",
    instruction: "Create echo_input.py, test it, and report the result.",
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

test("lightweight init creates and idempotently repairs the workspace scaffold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-init-"));
  const workspace = path.join(root, "workspace");
  const initialized = await initializeWorkspace(workspace);

  assert.deepEqual(initialized.config.value, { schemaVersion: 1, projects: [] });
  assert.equal(initialized.config.action, "created");
  assert.deepEqual((await readdir(workspace)).sort(), [".agents", "AGENTS.md", "taskchef.json", "tasks"]);
  assert.deepEqual(
    initialized.skills.skills.map(({ name, action }) => ({ name, action })),
    [
      { name: "taskchef-bootstrap", action: "created" },
      { name: "taskchef-delegate", action: "created" },
      { name: "taskchef-reconcile", action: "created" },
    ],
  );
  for (const skillName of ["taskchef-bootstrap", "taskchef-delegate", "taskchef-reconcile"]) {
    const skillPath = path.join(workspace, ".agents", "skills", skillName);
    assert.equal((await lstat(skillPath)).isSymbolicLink(), true);
    assert.equal(await readlink(skillPath), path.resolve("skills", skillName));
    const resolvedSkillPath = await realpath(skillPath);
    const documentedCliPath = path.resolve(resolvedSkillPath, "..", "..", "bin", "taskchef.js");
    assert.equal((await lstat(documentedCliPath)).isFile(), true);
  }

  const repeated = await initializeWorkspace(workspace);
  assert.equal(repeated.config.action, "unchanged");
  assert.equal(repeated.instructions.action, "unchanged");
  assert.deepEqual(repeated.skills.skills.map((skill) => skill.action), ["unchanged", "unchanged", "unchanged"]);

  const delegateLink = path.join(workspace, ".agents", "skills", "taskchef-delegate");
  await unlink(delegateLink);
  await symlink(root, delegateLink, "dir");
  const repaired = await initializeWorkspace(workspace);
  assert.equal(
    repaired.skills.skills.find((skill) => skill.name === "taskchef-delegate").action,
    "updated",
  );
  assert.equal(await readlink(delegateLink), path.resolve("skills", "taskchef-delegate"));
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
  assert.match(content, /taskchef-bootstrap/);

  const project = await gitProject(root, "project");
  await addProject(workspace, { name: "project", path: project });
  await initializeWorkspace(workspace);
  assert.equal((await readConfig(workspace)).projects.length, 1);
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

test("init rejects symlinked managed workspace directories", async () => {
  for (const segments of [[".agents"], [".agents", "skills"], ["tasks"]]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-symlinked-managed-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    let parent = workspace;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      await mkdir(parent);
    }
    await symlink(outside, path.join(parent, segments.at(-1)), "dir");

    await assert.rejects(
      initializeWorkspace(workspace),
      /managed workspace path is not a real directory/,
    );
    assert.deepEqual(await readdir(outside), []);
  }
});

test("init rejects symlinked managed workspace files without reading them", async () => {
  for (const fileName of ["AGENTS.md", "taskchef.json"]) {
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

test("project removal protects referenced task records unless forced", async () => {
  const { workspace, projects } = await fixture(1);
  await createTask(workspace, taskInput(projects[0]));
  await assert.rejects(removeProject(workspace, "project-1"), /referenced by 1 task/);
  const removed = await removeProject(workspace, "project-1", { force: true });
  assert.equal(removed.referencedTaskCount, 1);
  assert.deepEqual(await listProjects(workspace), []);
});

test("project replacement refuses to orphan task records", async () => {
  const { root, workspace, projects } = await fixture(1);
  await createTask(workspace, taskInput(projects[0]));
  const replacement = await gitProject(root, "replacement");

  await assert.rejects(
    importProjects(workspace, [{ name: "replacement", path: replacement }], { replace: true }),
    /replacement would orphan 1 task record/,
  );
  assert.deepEqual((await listProjects(workspace)).map((project) => project.path), projects);
});

test("project replacement permits tasks deliberately orphaned by force removal", async () => {
  const { root, workspace, projects } = await fixture(1);
  await createTask(workspace, taskInput(projects[0]));
  await removeProject(workspace, "project-1", { force: true });
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

test("configuration and result schemas remain strict", async () => {
  await assert.rejects(
    validateConfig({ schemaVersion: 1, projects: [], hostId: "forbidden" }),
    /unsupported field: hostId/,
  );
  assert.deepEqual(
    validateResult({
      message: "Opened related work.",
      githubPRs: ["https://github.com/example/repo/pull/12"],
      githubIssues: ["https://github.com/example/repo/issues/8"],
    }),
    {
      message: "Opened related work.",
      githubPRs: ["https://github.com/example/repo/pull/12"],
      githubIssues: ["https://github.com/example/repo/issues/8"],
    },
  );
  assert.throws(() => requireSafeId("../escape"), /unsupported characters/);
});

test("tasks preserve exact creation and lifecycle behavior", async () => {
  const { workspace, projects } = await fixture(1);
  const created = await createTask(workspace, taskInput(projects[0]), { now: FIXED_TIME });
  assert.equal(created.status, "pending");
  assert.equal(created.threadId, null);
  const running = await updateTask(
    workspace,
    "task-1",
    { status: "running", threadId: "thread-1" },
    { now: LATER_TIME },
  );
  assert.equal(running.threadId, "thread-1");
  await assert.rejects(updateTask(workspace, "task-1", { threadId: "thread-2" }), /cannot be replaced/);
  await updateTask(workspace, "task-1", {
    status: "finished",
    result: { message: "Done.", githubPRs: [], githubIssues: [] },
  });
  const resumed = await updateTask(workspace, "task-1", { status: "running" });
  assert.equal(resumed.result.message, "Done.");
  assert.deepEqual(await readdir(path.join(workspace, "tasks", "task-1")), ["task.json"]);
});

test("task reads and updates reject records whose IDs do not match their directories", async () => {
  const { workspace, projects } = await fixture(1);
  await createTask(workspace, taskInput(projects[0], "task-a"), { now: FIXED_TIME });
  await createTask(workspace, taskInput(projects[0], "task-b"), { now: FIXED_TIME });
  const firstPath = path.join(workspace, "tasks", "task-a", "task.json");
  const secondPath = path.join(workspace, "tasks", "task-b", "task.json");
  const first = JSON.parse(await readFile(firstPath, "utf8"));
  await writeFile(firstPath, `${JSON.stringify({ ...first, id: "task-b" }, null, 2)}\n`);
  const secondBefore = await readFile(secondPath, "utf8");

  await assert.rejects(readTask(workspace, "task-a"), /task ID does not match directory/);
  await assert.rejects(
    updateTask(workspace, "task-a", { status: "running", threadId: "thread-a" }),
    /task ID does not match directory/,
  );
  assert.equal(await readFile(secondPath, "utf8"), secondBefore);
});

test("task list filters and summary replace the old snapshot command", async () => {
  const { workspace, projects } = await fixture(2);
  await createTask(workspace, taskInput(projects[0], "pending"));
  await createTask(workspace, taskInput(projects[0], "running"));
  await updateTask(workspace, "running", { status: "running", threadId: "thread-running" });
  await createTask(workspace, taskInput(projects[1], "finished"));
  await updateTask(workspace, "finished", { status: "running", threadId: "thread-finished" });
  await updateTask(workspace, "finished", { status: "finished" });

  assert.deepEqual((await filterTasks(workspace, { statuses: ["running"] })).map((task) => task.id), ["running"]);
  assert.deepEqual((await filterTasks(workspace, { project: "project-1" })).map((task) => task.id), ["pending", "running"]);
  assert.deepEqual(await buildTaskSummary(workspace), {
    schemaVersion: 1,
    taskCount: 3,
    statusCounts: { pending: 1, running: 1, blocked: 0, finished: 1 },
  });
});

test("reconciliation candidates exclude pending and finished by default", async () => {
  const { workspace, projects } = await fixture(1);
  await createTask(workspace, taskInput(projects[0], "pending"));
  await createTask(workspace, taskInput(projects[0], "running"));
  await updateTask(workspace, "running", { status: "running", threadId: "thread-running" });
  await createTask(workspace, taskInput(projects[0], "finished"));
  await updateTask(workspace, "finished", { status: "running", threadId: "thread-finished" });
  await updateTask(workspace, "finished", { status: "finished" });
  assert.deepEqual((await buildReconciliationCandidates(workspace)).tasks.map((task) => task.id), ["running"]);
  assert.deepEqual(
    (await buildReconciliationCandidates(workspace, { includeFinished: true })).tasks.map((task) => task.id),
    ["finished", "running"],
  );
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

test("task listing and doctor reject unexpected task entries", async () => {
  for (const kind of ["file", "symlink"]) {
    const { root, workspace } = await fixture(1);
    const entry = path.join(workspace, "tasks", `unexpected-${kind}`);
    if (kind === "file") await writeFile(entry, "not a task directory\n");
    else await symlink(root, entry, "dir");

    await assert.rejects(listTasks(workspace), /unexpected task entry/);
    const diagnosis = await doctorWorkspace(workspace);
    assert.equal(diagnosis.ok, false);
    assert.match(
      diagnosis.checks.find((check) => check.name === "task-records").message,
      /unexpected task entry/,
    );
  }
});

test("CLI implements the v2 bootstrap, project, doctor, and task surface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-cli-v2-"));
  const workspace = path.join(root, "workspace");
  const first = await gitProject(root, "first", "https://github.com/example/first.git");
  const second = await gitProject(root, "second");

  const initialized = await runCli(["workspace", "init", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(initialized.stdout).config.action, "created");
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

  await runCli(["task", "create", "--json", "--workspace", workspace], {
    input: JSON.stringify(taskInput(first)),
  });
  await runCli(["task", "update", "task-1", "--json", "--workspace", workspace], {
    input: JSON.stringify({ status: "running", threadId: "thread-1" }),
  });
  const listed = await runCli([
    "task", "list", "--status", "running", "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(listed.stdout).tasks.map((task) => task.id), ["task-1"]);
  const summary = await runCli(["task", "summary", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(summary.stdout).statusCounts.running, 1);
  const doctor = await runCli(["doctor", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
});

test("CLI rejects removed legacy commands", async () => {
  for (const args of [
    ["workspace", "ensure-instructions", "--json"],
    ["workspace", "ensure-skills", "--json"],
    ["config", "validate", "--json"],
    ["task", "snapshot", "--json"],
  ]) {
    await assert.rejects(
      runCli(args),
      (error) => error.code === 2 && /Unknown command/.test(error.stderr),
    );
  }
});
