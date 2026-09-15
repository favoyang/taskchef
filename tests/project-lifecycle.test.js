import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  addProject,
  createWorkspaceBackup,
  includeProject,
  importProjects,
  initializeWorkspace,
  linkTask,
  listWorkspaceBackups,
  matchProjectForGithubUrl,
  prepareDispatch,
  prepareDelegation,
  readConfig,
  readTask,
  reconcileProjects,
  recordTask,
  removeProject,
  reportTaskState,
  restoreWorkspaceBackup,
  updateProjectHint,
  validateConfig,
} from "../index.js";

const execFile = promisify(execFileCallback);
const TASK_ID = "c0f010ff-84f2-4838-a69d-0ff1f5d721d7";
const THREAD_ID = "019ffb69-57a6-7801-8b7a-8ff4c32a398c";
const TURN_ID = "01a03275-d530-7043-ab4a-513a1ad6ae1e";

async function gitProject(parent, name, remote = null) {
  const project = path.join(parent, name);
  await mkdir(project, { recursive: true });
  await execFile("git", ["init", "-q"], { cwd: project });
  if (remote) await execFile("git", ["remote", "add", "origin", remote], { cwd: project });
  return realpath(project);
}

function nativeProject(projectId, label, projectPath, isGitRepository, extra = {}) {
  return {
    projectId,
    projectKind: "local",
    label,
    path: projectPath,
    hostId: "local",
    hostDisplayName: null,
    isGitRepository,
    ...extra,
  };
}

function explicit(evidence = "User selected this routing fact.") {
  return {
    kind: "explicit_user",
    evidence,
    taskId: null,
    threadId: null,
    turnRef: null,
    repositoryPath: null,
  };
}

test("reconciliation accepts realistic mixed native snapshots and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-reconcile-"));
  const workspace = path.join(root, "dispatcher");
  const repository = await gitProject(root, "service", "git@github.com:Example/service.git");
  const notes = path.join(root, "notes");
  await mkdir(notes);
  await initializeWorkspace(workspace);
  const empty = await reconcileProjects(workspace, { schemaVersion: 2, projects: [] });
  assert.equal(empty.changed, false);
  assert.equal((await listWorkspaceBackups(workspace)).backups.length, 0);
  const snapshot = {
    schemaVersion: 2,
    projects: [
      nativeProject("service-id", "service", repository, true),
      nativeProject("notes-id", "service", notes, false),
      { projectId: "chat-id", projectKind: "chatgpt", label: "Cloud", hostId: null },
      nativeProject("remote-id", "remote", repository, true, { hostId: "remote-host" }),
      nativeProject("workspace-id", "dispatcher", workspace, false),
      nativeProject("ancestor-id", "ancestor", root, false),
    ],
  };

  const first = await reconcileProjects(workspace, snapshot);
  assert.equal(first.changed, true);
  assert.deepEqual(first.added.map((project) => project.name), ["service", "service (2)"]);
  assert.deepEqual(first.diagnostics.map((item) => item.code).sort(), [
    "ineligible-host", "ineligible-host", "workspace-excluded", "workspace-excluded",
  ]);
  const backupCount = (await listWorkspaceBackups(workspace)).backups.length;
  const second = await reconcileProjects(workspace, snapshot);
  assert.equal(second.changed, false);
  assert.equal((await listWorkspaceBackups(workspace)).backups.length, backupCount);
  assert.equal((await readConfig(workspace)).projectIndex.bindings.length, 2);
});

test("reconciliation preserves curation and rejects duplicate canonical identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-reconcile-duplicates-"));
  const workspace = path.join(root, "dispatcher");
  const repository = await gitProject(root, "service", "git@github.com:Example/service.git");
  const alias = path.join(root, "service-link");
  await symlink(repository, alias);
  await initializeWorkspace(workspace);
  await addProject(workspace, {
    path: repository,
    name: "curated-service",
    description: "Curated responsibility.",
    githubRepos: ["https://github.com/Example/owned-one", "https://github.com/Example/owned-two"],
  });
  const result = await reconcileProjects(workspace, {
    schemaVersion: 2,
    projects: [
      nativeProject("one", "native-name", repository, true),
      nativeProject("two", "other-name", alias, true),
    ],
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.diagnostics.map((item) => item.code), [
    "duplicate-canonical-path", "duplicate-canonical-path",
  ]);
  const [project] = (await readConfig(workspace)).projects;
  assert.equal(project.name, "curated-service");
  assert.equal(project.description, "Curated responsibility.");
  assert.equal(project.githubRepos.length, 2);

  const folder = path.join(root, "folder");
  await mkdir(folder);
  const duplicateId = await reconcileProjects(workspace, {
    schemaVersion: 2,
    projects: [
      nativeProject("same-id", "repository", repository, true),
      nativeProject("same-id", "folder", folder, false),
    ],
  });
  assert.deepEqual(duplicateId.diagnostics.map((item) => item.code), [
    "duplicate-native-id", "duplicate-native-id",
  ]);
});

test("reconciliation withholds a path whose native identity changed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-reconcile-changed-identity-"));
  const workspace = path.join(root, "dispatcher");
  const repository = await gitProject(root, "service");
  await initializeWorkspace(workspace);

  const first = await reconcileProjects(workspace, {
    schemaVersion: 2,
    projects: [nativeProject("old-id", "service", repository, true)],
  });
  assert.deepEqual(first.available, [{ hostId: "local", projectId: "old-id", path: repository }]);

  const conflict = await reconcileProjects(workspace, {
    schemaVersion: 2,
    projects: [nativeProject("new-id", "service", repository, true)],
  });
  assert.deepEqual(conflict.available, []);
  assert.deepEqual(conflict.diagnostics.map((item) => item.code), ["path-identity-conflict"]);
  assert.equal((await prepareDispatch(workspace, { taskId: TASK_ID })).projects[0].path, repository);
});

test("reconciliation canonicalizes configured aliases and their project index metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-reconcile-configured-alias-"));
  const workspace = path.join(root, "dispatcher");
  const repository = await gitProject(root, "service", "git@github.com:Example/service.git");
  const alias = path.join(root, "service-link");
  const notes = path.join(root, "notes");
  const notesAlias = path.join(root, "notes-link");
  await symlink(repository, alias);
  await mkdir(notes);
  await symlink(notes, notesAlias);
  const canonicalNotes = await realpath(notes);
  await initializeWorkspace(workspace);
  await writeFile(path.join(workspace, "taskchef.json"), `${JSON.stringify({
    schemaVersion: 2,
    projects: [{
      name: "curated-service",
      path: alias,
      isGitRepository: true,
      githubRepos: ["https://github.com/example/service"],
      description: "Keep this curation.",
    }, {
      name: "notes",
      path: notesAlias,
      isGitRepository: false,
      githubRepos: [],
    }],
    projectIndex: {
      bindings: [{ hostId: "local", projectId: "service-id", path: alias }],
      exclusions: [{ hostId: "local", projectId: "notes-id", path: notesAlias }],
      routingHints: [{
        path: alias,
        aliases: [{ value: "backend", provenance: explicit() }],
        githubRepos: [], responsibilities: [], forgotten: [],
      }],
    },
  }, null, 2)}\n`);

  const result = await reconcileProjects(workspace, {
    schemaVersion: 2,
    projects: [
      nativeProject("service-id", "service", repository, true),
      nativeProject("notes-id", "notes", notes, false),
    ],
  });
  assert.equal(result.changed, true);
  assert.equal(result.added.length, 0);
  const config = await readConfig(workspace);
  assert.deepEqual(config.projects.map((project) => project.path), [repository, canonicalNotes]);
  assert.equal(config.projects[0].name, "curated-service");
  assert.equal(config.projects[0].description, "Keep this curation.");
  assert.deepEqual(result.diagnostics.map((item) => item.code), ["explicitly-excluded"]);
  assert.deepEqual(config.projectIndex.bindings.map((entry) => entry.path), [repository]);
  assert.deepEqual(config.projectIndex.exclusions.map((entry) => entry.path), [canonicalNotes]);
  assert.deepEqual(config.projectIndex.routingHints.map((entry) => entry.path), [repository]);
  assert.equal((await reconcileProjects(workspace, {
    schemaVersion: 2,
    projects: [
      nativeProject("service-id", "service", repository, true),
      nativeProject("notes-id", "notes", notes, false),
    ],
  })).changed, false);
});

test("reconciliation leaves unavailable unrelated configured paths intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-reconcile-unavailable-configured-"));
  const workspace = path.join(root, "dispatcher");
  const repository = await gitProject(root, "service");
  const unavailable = path.join(root, "missing");
  await initializeWorkspace(workspace);
  await writeFile(path.join(workspace, "taskchef.json"), `${JSON.stringify({
    schemaVersion: 2,
    projects: [
      { name: "service", path: repository, isGitRepository: true, githubRepos: [] },
      { name: "missing", path: unavailable, isGitRepository: false, githubRepos: [] },
    ],
  }, null, 2)}\n`);
  const result = await reconcileProjects(workspace, {
    schemaVersion: 2,
    projects: [nativeProject("service-id", "service", repository, true)],
  });
  assert.equal(result.added.length, 0);
  assert.equal((await readConfig(workspace, { checkPaths: false })).projects[1].path, unavailable);
});

test("explicit removal excludes reconciliation until inclusion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-reconcile-exclusion-"));
  const workspace = path.join(root, "dispatcher");
  const project = await gitProject(root, "service");
  await initializeWorkspace(workspace);
  const snapshot = { schemaVersion: 2, projects: [nativeProject("service-id", "service", project, true)] };
  await reconcileProjects(workspace, snapshot);
  const preview = await removeProject(workspace, "service", { dryRun: true });
  assert.ok(preview.projectIndexDiff);
  await removeProject(workspace, "service", {
    expectedConfigHash: preview.beforeConfigHash,
    expectedProjectCount: preview.beforeCount,
    expectedAfterCount: preview.afterCount,
    confirmPlan: preview.planHash,
    confirmRemoved: ["service"],
    confirmCountCollapse: "1:0",
  });
  const excluded = await reconcileProjects(workspace, snapshot);
  assert.equal(excluded.changed, false);
  assert.equal(excluded.diagnostics[0].code, "explicitly-excluded");
  await includeProject(workspace, { projectId: "service-id", hostId: "local" });
  assert.equal((await reconcileProjects(workspace, snapshot)).added.length, 1);
});

test("explicit replacement exclusions survive reconciliation and remain includable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-replace-exclusion-"));
  const workspace = path.join(root, "dispatcher");
  const project = await gitProject(root, "service");
  const unrelated = path.join(root, "unrelated");
  await initializeWorkspace(workspace);
  const snapshot = { schemaVersion: 2, projects: [nativeProject("service-id", "service", project, true)] };
  await reconcileProjects(workspace, snapshot);
  const indexed = await readConfig(workspace, { checkPaths: false });
  await writeFile(path.join(workspace, "taskchef.json"), `${JSON.stringify({
    ...indexed,
    projectIndex: {
      ...indexed.projectIndex,
      exclusions: [{ hostId: "local", projectId: "unrelated-id", path: unrelated }],
    },
  }, null, 2)}\n`);

  const preview = await importProjects(workspace, [], { replace: true, dryRun: true });
  assert.deepEqual(preview.projectIndexDiff.after.exclusions.map((entry) => entry.projectId), [
    "unrelated-id", "service-id",
  ]);
  await importProjects(workspace, [], {
    replace: true,
    expectedConfigHash: preview.beforeConfigHash,
    expectedProjectCount: preview.beforeCount,
    expectedAfterCount: preview.afterCount,
    confirmPlan: preview.planHash,
    confirmRemoved: ["service"],
    confirmCountCollapse: "1:0",
  });
  const excluded = await reconcileProjects(workspace, snapshot);
  assert.equal(excluded.changed, false);
  assert.equal(excluded.diagnostics[0].code, "explicitly-excluded");
  assert.equal((await readConfig(workspace, { checkPaths: false }))
    .projectIndex.exclusions.some((entry) => entry.projectId === "unrelated-id"), true);
  await includeProject(workspace, { projectId: "service-id", hostId: "local" });
  assert.equal((await reconcileProjects(workspace, snapshot)).added.length, 1);

  const legacyWorkspace = path.join(root, "legacy-dispatcher");
  const legacyProject = await gitProject(root, "legacy-service");
  await initializeWorkspace(legacyWorkspace);
  await addProject(legacyWorkspace, { path: legacyProject });
  assert.equal((await readConfig(legacyWorkspace, { checkPaths: false })).projectIndex, undefined);
  const legacyPreview = await importProjects(legacyWorkspace, [], { replace: true, dryRun: true });
  assert.equal(legacyPreview.projectIndexDiff.after.exclusions[0].path, legacyProject);
  await importProjects(legacyWorkspace, [], {
    replace: true,
    expectedConfigHash: legacyPreview.beforeConfigHash,
    expectedProjectCount: 1,
    expectedAfterCount: 0,
    confirmPlan: legacyPreview.planHash,
    confirmRemoved: ["legacy-service"],
    confirmCountCollapse: "1:0",
  });
  const legacyExcluded = await reconcileProjects(legacyWorkspace, {
    schemaVersion: 2,
    projects: [nativeProject("legacy-id", "legacy-service", legacyProject, true)],
  });
  assert.equal(legacyExcluded.diagnostics[0].code, "explicitly-excluded");
});

test("dispatch validates only the selected project and keeps task snapshots unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-selected-project-"));
  const workspace = path.join(root, "dispatcher");
  const available = await gitProject(root, "available");
  const unavailable = await gitProject(root, "unavailable");
  await initializeWorkspace(workspace);
  await addProject(workspace, { path: available });
  await addProject(workspace, { path: unavailable });
  await rename(unavailable, `${unavailable}-moved`);
  assert.equal((await prepareDispatch(workspace, { taskId: TASK_ID })).projectCount, 2);
  await recordTask(workspace, {
    id: TASK_ID,
    project: available,
    title: "Selected project",
    instruction: prepareDelegation("Complete the selected project task.", { taskId: TASK_ID }).instruction,
    threadId: null,
  });
  await assert.rejects(recordTask(workspace, {
    id: "ea896202-04fc-4a46-a6a1-4c9f5d63edfe",
    project: unavailable,
    title: "Unavailable project",
    instruction: prepareDelegation("This must fail.", {
      taskId: "ea896202-04fc-4a46-a6a1-4c9f5d63edfe",
    }).instruction,
    threadId: null,
  }), /project does not exist/);
  const snapshot = (await readTask(workspace, TASK_ID)).project;
  await updateProjectHint(workspace, {
    action: "remember",
    project: available,
    kind: "alias",
    value: "primary service",
    provenance: explicit(),
  });
  assert.deepEqual((await readTask(workspace, TASK_ID)).project, snapshot);
});

test("routing hints validate provenance, corrections, forgetting, and terminal reports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-routing-hints-"));
  const workspace = path.join(root, "dispatcher");
  const first = await gitProject(root, "first", "git@github.com:Example/first.git");
  const second = await gitProject(root, "second", "git@github.com:Example/second.git");
  await initializeWorkspace(workspace);
  await addProject(workspace, { path: first });
  await addProject(workspace, { path: second });
  await updateProjectHint(workspace, {
    action: "remember", project: first, kind: "alias", value: "backend", provenance: explicit(),
  });
  await updateProjectHint(workspace, {
    action: "remember", project: second, kind: "alias", value: "backend", provenance: explicit(),
  });
  let prepared = await prepareDispatch(workspace, { taskId: TASK_ID });
  assert.equal(prepared.routingHints.filter((hint) => hint.aliases.includes("backend")).length, 2);
  await updateProjectHint(workspace, {
    action: "correct", project: second, kind: "alias", value: "backend",
    provenance: explicit("User corrected backend to the second project."),
  });
  prepared = await prepareDispatch(workspace, { taskId: TASK_ID });
  assert.equal(prepared.routingHints.filter((hint) => hint.aliases.includes("backend")).length, 1);
  await updateProjectHint(workspace, {
    action: "forget", project: second, kind: "alias", value: "backend", provenance: explicit(),
  });
  assert.equal((await prepareDispatch(workspace, { taskId: TASK_ID })).routingHints
    .some((hint) => hint.aliases.includes("backend")), false);
  await updateProjectHint(workspace, {
    action: "remember",
    project: first,
    kind: "githubRepo",
    value: "https://github.com/example/first",
    provenance: {
      kind: "verified_repository", evidence: "Inspected the exact Git origin.",
      taskId: null, threadId: null, turnRef: null, repositoryPath: first,
    },
  });
  const configAfterRepository = await readConfig(workspace, { checkPaths: false });
  const routingAfterRepository = (await prepareDispatch(workspace, { taskId: TASK_ID })).routingHints;
  assert.equal(matchProjectForGithubUrl(
    "https://github.com/example/first/issues/9",
    configAfterRepository.projects,
    routingAfterRepository,
  ).project.path, first);
  await recordTask(workspace, {
    id: TASK_ID, project: first, title: "Learn responsibility",
    instruction: prepareDelegation("Complete and report the responsibility.", {
      taskId: TASK_ID,
    }).instruction, threadId: null,
  });
  await linkTask(workspace, TASK_ID, THREAD_ID);
  await reportTaskState(workspace, {
    taskId: TASK_ID, threadId: THREAD_ID, turnRef: TURN_ID, turnId: TURN_ID,
    status: "working", requestSummary: "Complete responsibility work.",
  });
  await assert.rejects(updateProjectHint(workspace, {
    action: "remember", project: first, kind: "responsibility", value: "Release automation",
    provenance: {
      kind: "accepted_terminal_report", evidence: "Current task report.",
      taskId: TASK_ID, threadId: THREAD_ID, turnRef: TURN_ID, repositoryPath: null,
    },
  }), /accepted current terminal report/);
  await reportTaskState(workspace, {
    taskId: TASK_ID, threadId: THREAD_ID, turnRef: TURN_ID, turnId: TURN_ID,
    status: "completed", summary: "Implemented release automation.",
  });
  const learned = await updateProjectHint(workspace, {
    action: "remember", project: first, kind: "responsibility", value: "Release automation",
    provenance: {
      kind: "accepted_terminal_report", evidence: "Accepted current terminal task report.",
      taskId: TASK_ID, threadId: THREAD_ID, turnRef: TURN_ID, repositoryPath: null,
    },
  });
  assert.equal(learned.changed, true);
  assert.equal((await updateProjectHint(workspace, {
    action: "forget", project: first, kind: "responsibility", value: "Release automation",
    provenance: explicit(),
  })).changed, true);
  const replay = await updateProjectHint(workspace, {
    action: "remember", project: first, kind: "responsibility", value: "Release automation",
    provenance: {
      kind: "accepted_terminal_report", evidence: "Accepted current terminal task report.",
      taskId: TASK_ID, threadId: THREAD_ID, turnRef: TURN_ID, repositoryPath: null,
    },
  });
  assert.equal(replay.changed, false);
  assert.equal(replay.suppressed, true);

  await updateProjectHint(workspace, {
    action: "forget", project: first, kind: "githubRepo",
    value: "https://github.com/example/first", provenance: explicit(),
  });
  const repositoryReplay = await updateProjectHint(workspace, {
    action: "remember", project: first, kind: "githubRepo",
    value: "https://github.com/example/first",
    provenance: {
      kind: "verified_repository", evidence: "Inspected the exact Git origin.",
      taskId: null, threadId: null, turnRef: null, repositoryPath: first,
    },
  });
  assert.equal(repositoryReplay.suppressed, true);
});

test("recording accepts a configured symlink spelling but snapshots the canonical selected path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-selected-alias-"));
  const workspace = path.join(root, "dispatcher");
  const project = await gitProject(root, "service");
  const alias = path.join(root, "service-alias");
  await symlink(project, alias);
  await initializeWorkspace(workspace);
  await writeFile(path.join(workspace, "taskchef.json"), `${JSON.stringify({
    schemaVersion: 2,
    projects: [{
      name: "service",
      path: alias,
      isGitRepository: true,
      githubRepos: [],
    }],
  }, null, 2)}\n`);
  const task = await recordTask(workspace, {
    id: TASK_ID,
    project,
    title: "Canonical selected project",
    instruction: prepareDelegation("Use the canonical selected project.", { taskId: TASK_ID }).instruction,
    threadId: null,
  });
  assert.equal(task.project.path, project);
});

test("routing hint bounds and project restore cover optional projectIndex state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-routing-restore-"));
  const workspace = path.join(root, "dispatcher");
  const project = await gitProject(root, "service");
  await initializeWorkspace(workspace);
  await addProject(workspace, { path: project });
  await updateProjectHint(workspace, {
    action: "remember", project, kind: "alias", value: "before restore", provenance: explicit(),
  });
  const backup = await createWorkspaceBackup(workspace, { reason: "routing-test" });
  await updateProjectHint(workspace, {
    action: "forget", project, kind: "alias", value: "before restore", provenance: explicit(),
  });
  const preview = await restoreWorkspaceBackup(workspace, backup.id, { dryRun: true });
  assert.ok(preview.projectIndexDiff);
  await restoreWorkspaceBackup(workspace, backup.id, {
    approveRestore: true,
    expectedConfigHash: preview.beforeConfigHash,
    expectedProjectCount: preview.beforeCount,
    expectedAfterCount: preview.afterCount,
    confirmPlan: preview.planHash,
    confirmRemoved: [],
  });
  assert.deepEqual((await prepareDispatch(workspace, { taskId: TASK_ID })).routingHints[0].aliases,
    ["before restore"]);

  const provenance = explicit();
  await assert.rejects(validateConfig({
    schemaVersion: 2,
    projects: [{ name: "service", path: project, isGitRepository: true, githubRepos: [] }],
    projectIndex: {
      bindings: [], exclusions: [],
      routingHints: [{
        path: project,
        aliases: Array.from({ length: 17 }, (_, index) => ({
          value: `alias-${index}`,
          provenance,
        })),
        githubRepos: [], responsibilities: [], forgotten: [],
      }],
    },
  }), /at most 16 entries/);
});
