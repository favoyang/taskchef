import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { openWorkspaceInCodex } from "./codex-app.js";
import { createDashboardServer } from "./dashboard.js";
import { resolveWorkspacePath } from "./workspace-path.js";

import {
  addProject,
  createWorkspaceBackup,
  buildCopilotBrief,
  buildTaskSummary,
  doctorWorkspace,
  filterTasks,
  importProjects,
  initializeWorkspace,
  listProjects,
  listWorkspaceBackups,
  pruneWorkspaceBackups,
  readProjectIndex,
  readWorkspaceMaintenance,
  listTasks,
  migrateTaskLog,
  prepareDispatch,
  recordTask,
  removeProject,
  restoreWorkspaceBackup,
  requireSafeId,
  updateProject,
  verifyWorkspaceBackup,
} from "./workspace.js";

const BLANK_TABLE_CELL = Symbol("blank table cell");

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export function assertTaskRecordStdin(stdin = process.stdin) {
  if (stdin.isTTY) {
    throw new Error(
      "task record requires non-interactive JSON on standard input; pipe one JSON value and close stdin",
    );
  }
}

async function readJsonStdin() {
  assertTaskRecordStdin();
  const input = await readStdin();
  if (input.trim().length === 0) throw new Error("expected JSON on standard input");
  return JSON.parse(input);
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function validateCommandArgs(
  args,
  startIndex,
  { values = [], switches = [], repeatable = [] } = {},
) {
  const valueOptions = new Set(values);
  const booleanOptions = new Set(switches);
  const repeatableOptions = new Set(repeatable);
  const seen = new Set();
  for (let index = startIndex; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--") || token.includes("=")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    if (!valueOptions.has(token) && !booleanOptions.has(token)) {
      throw new Error(`unsupported option: ${token}`);
    }
    if (seen.has(token) && !repeatableOptions.has(token)) {
      throw new Error(`duplicate option: ${token}`);
    }
    seen.add(token);
    if (valueOptions.has(token)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      index += 1;
    }
  }
}

function workspaceSelection(args) {
  return resolveWorkspacePath({
    explicit: args.includes("--workspace") ? option(args, "--workspace") : null,
  });
}

function workspaceRoot(args) {
  return workspaceSelection(args).workspace;
}

function print(value, args, human) {
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  process.stdout.write(`${human ? human(value) : JSON.stringify(value, null, 2)}\n`);
}

async function mutationOptions(args) {
  const confirmedPath = option(args, "--confirm-removed", null);
  let confirmRemoved;
  if (confirmedPath !== null) {
    confirmRemoved = JSON.parse(await readFile(path.resolve(confirmedPath), "utf8"));
  }
  const numberOption = (name) => {
    const value = option(args, name, null);
    if (value === null) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
    return parsed;
  };
  return {
    dryRun: args.includes("--dry-run"),
    expectedConfigHash: option(args, "--expect-config-hash", undefined),
    expectedProjectCount: numberOption("--expect-project-count"),
    expectedAfterCount: numberOption("--expect-after-count"),
    confirmPlan: option(args, "--confirm-plan", undefined),
    confirmRemoved,
    confirmCountCollapse: option(args, "--confirm-count-collapse", undefined),
  };
}

function table(headers, rows) {
  const display = (value) => {
    if (value === BLANK_TABLE_CELL) return "";
    if (value === null || value === undefined || value === "") return "-";
    return String(value);
  };
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => display(row[index]).length)));
  const format = (row) => row.map((value, index) => index === row.length - 1
    ? display(value)
    : display(value).padEnd(widths[index])).join("  ").trimEnd();
  return [format(headers), ...rows.map(format)].join("\n");
}

function projectRows(projects) {
  return projects.flatMap((project) => {
    const [primaryRepository = null, ...additionalRepositories] = project.githubRepos;
    return [[
      project.name,
      project.isGitRepository ? "git" : "folder",
      primaryRepository,
      project.path,
    ], ...additionalRepositories.map((repository) => [
      BLANK_TABLE_CELL,
      BLANK_TABLE_CELL,
      repository,
      BLANK_TABLE_CELL,
    ])];
  });
}

function sortTasksByCreatedAt(tasks, ascending) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftCreatedAt = left.task.createdAt;
      const rightCreatedAt = right.task.createdAt;
      if (!leftCreatedAt && !rightCreatedAt) return left.index - right.index;
      if (!leftCreatedAt) return 1;
      if (!rightCreatedAt) return -1;
      const chronological = Date.parse(leftCreatedAt) - Date.parse(rightCreatedAt);
      return (ascending ? chronological : -chronological) || left.index - right.index;
    })
    .map(({ task }) => task);
}

function displayId(value, fullId) {
  if (fullId || value === null || value === undefined) return value;
  const uuidSection = String(value).match(/^[0-9a-fA-F]{8}(?=-)/);
  return uuidSection ? uuidSection[0] : value;
}

function singleLineDetail(value) {
  return String(value).replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function taskDetails(task) {
  const lastResult = task.lastResult;
  return [
    `Title: ${singleLineDetail(task.title)}`,
    `Project: ${singleLineDetail(task.project.name)}`,
    `Current status: ${singleLineDetail(task.status ?? "unknown")}`,
    `Current turn ref: ${singleLineDetail(task.turnRef ?? "-")}`,
    `Current Codex turn ID: ${singleLineDetail(task.turnId ?? "-")}`,
    `Last result status: ${singleLineDetail(lastResult?.status ?? "-")}`,
    `Last result summary: ${singleLineDetail(lastResult?.summary ?? "-")}`,
    `Last result turn ref: ${singleLineDetail(lastResult?.turnRef ?? "-")}`,
    `Last result Codex turn ID: ${singleLineDetail(lastResult?.turnId ?? "-")}`,
    `Last result updated: ${singleLineDetail(lastResult?.updatedAt ?? "-")}`,
    `Project path: ${singleLineDetail(task.project.path)}`,
    `Created: ${singleLineDetail(task.createdAt)}`,
    `Updated: ${singleLineDetail(task.updatedAt ?? "-")}`,
    `Updated by: ${singleLineDetail(task.updatedBy ?? "-")}`,
    `Task ID: ${singleLineDetail(task.id)}`,
    `Thread ID: ${singleLineDetail(task.threadId ?? "-")}`,
    `Turn count: ${task.turns.length}`,
    "Activity timeline (newest first):",
    ...[...task.turns].reverse().map((turn) => (
      `- ${singleLineDetail(turn.startedAt)} | ${singleLineDetail(turn.result?.status ?? "working")} | ref ${singleLineDetail(turn.turnRef ?? "-")} | Codex turn ${singleLineDetail(turn.turnId ?? "-")} | request: ${singleLineDetail(turn.requestSummary ?? "not recorded")} | result: ${singleLineDetail(turn.result?.summary ?? "in progress")}`
    )),
    "Instruction:",
    task.instruction,
  ].join("\n");
}

async function migrate(args) {
  validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
  const result = await migrateTaskLog(workspaceRoot(args));
  print(result, args, (value) => [
    `Task log: ${value.action}`,
    `Tasks: ${value.taskCount}`,
    `Turns: ${value.turnCount}`,
    `Migrated: ${value.migratedCount}`,
    `Native turn refs: ${value.nativeTurnRefCount}`,
    `Fallback turn refs: ${value.fallbackTurnRefCount}`,
    `Backup: ${value.backupPath ?? "not needed"}`,
  ].join("\n"));
  return 0;
}

async function readTaskForShow(workspace, taskId) {
  const id = requireSafeId(taskId, "taskId");
  const tasks = await listTasks(workspace);
  if (!/^[0-9a-fA-F]{8}$/.test(id)) {
    const exact = tasks.find((task) => task.id === id);
    if (exact) return exact;
    if (id.length < 8) {
      throw new Error(
        `task ID prefix is too short: ${id}; use all 8 characters shown by taskchef task list`,
      );
    }
    if (id.length === 8) {
      throw new Error(
        `malformed task ID prefix: ${id}; use the 8 hexadecimal characters shown by taskchef task list`,
      );
    }
    throw new Error(`task not found: ${id}`);
  }

  const matches = tasks.filter((task) => displayId(task.id, false) === id);
  if (matches.length === 0) {
    throw new Error(
      `task not found for ID prefix: ${id}; run taskchef task list --full-id to verify the task ID`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `task ID prefix is ambiguous: ${id}; run taskchef task list --full-id and pass the full task ID`,
    );
  }
  return matches[0];
}

async function initialize(args) {
  validateCommandArgs(args, 2, {
    values: ["--workspace", "--codex-cli"],
    switches: ["--json", "--register-codex"],
  });
  const resolution = workspaceSelection(args);
  const result = await initializeWorkspace(resolution.workspace);
  result.resolutionSource = resolution.source;
  let registrationFailed = false;
  if (args.includes("--register-codex")) {
    try {
      result.registration = await openWorkspaceInCodex(result.workspace, {
        explicit: args.includes("--codex-cli") ? option(args, "--codex-cli") : null,
      });
    } catch (error) {
      registrationFailed = true;
      result.registration = { status: "failed", reason: error.message };
    }
  }
  print(result, args, (value) => [
    `Workspace: ${value.workspace}`,
    `Configuration: ${value.config.action}`,
    `Task log: ${value.tasks.action}`,
    `Instructions: ${value.instructions.action}`,
    ...(value.registration ? [`Codex opening: ${value.registration.status}`] : []),
  ].join("\n"));
  return registrationFailed ? 5 : 0;
}

async function workspacePath(args) {
  validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
  const resolution = workspaceSelection(args);
  const exists = await access(resolution.workspace).then(() => true).catch(() => false);
  const workspace = exists ? await realpath(resolution.workspace) : resolution.workspace;
  print({
    schemaVersion: 1,
    workspace,
    source: resolution.source,
    exists,
  }, args, (value) => value.workspace);
  return 0;
}

async function doctor(args) {
  validateCommandArgs(args, 1, { values: ["--workspace"], switches: ["--json"] });
  const result = await doctorWorkspace(workspaceRoot(args));
  print(result, args, (value) => value.checks
    .map((check) => `${check.status === "pass" ? "✓" : "✗"} ${check.name}: ${check.message}`)
    .join("\n"));
  return result.ok ? 0 : 1;
}

async function projectAdd(args) {
  if (!args[2] || args[2].startsWith("--")) throw new Error("project add requires a path");
  validateCommandArgs(args, 3, {
    values: ["--workspace", "--name", "--description", "--github-repo"],
    switches: ["--json", "--no-github", "--dry-run"],
    repeatable: ["--github-repo"],
  });
  if (args.includes("--no-github") && args.includes("--github-repo")) {
    throw new Error("--no-github and --github-repo cannot be used together");
  }
  const input = { path: args[2] };
  const name = option(args, "--name", null);
  const description = option(args, "--description", null);
  if (name !== null) input.name = name;
  if (description !== null) input.description = description;
  if (args.includes("--no-github")) input.githubRepos = [];
  else if (args.includes("--github-repo")) input.githubRepos = options(args, "--github-repo");
  const result = await addProject(workspaceRoot(args), input, {
    dryRun: args.includes("--dry-run"),
  });
  print(result, args, (value) => {
    const project = value.project ?? value;
    return `${args.includes("--dry-run") ? "Would add" : "Added"} ${project.name}: ${project.path}`;
  });
  return 0;
}

async function projectImport(args) {
  const hasSource = Boolean(args[2] && !args[2].startsWith("--"));
  const source = hasSource ? args[2] : "-";
  validateCommandArgs(args, hasSource ? 3 : 2, {
    values: [
      "--workspace", "--expect-config-hash", "--expect-project-count", "--expect-after-count",
      "--confirm-plan", "--confirm-removed", "--confirm-count-collapse",
    ],
    switches: ["--json", "--replace", "--dry-run"],
  });
  const content = source === "-"
    ? await readStdin()
    : await readFile(path.resolve(source), "utf8");
  if (content.trim().length === 0) throw new Error("project import input is empty");
  const result = await importProjects(workspaceRoot(args), JSON.parse(content), {
    replace: args.includes("--replace"),
    ...(await mutationOptions(args)),
  });
  print(result, args, (value) =>
    `Imported ${value.importedCount} project(s); ${value.projectCount} configured (${value.mode}).`);
  return 0;
}

async function projectList(args) {
  validateCommandArgs(args, 2, {
    values: ["--workspace"],
    switches: ["--json", "--allow-missing-paths"],
  });
  const result = await readProjectIndex(workspaceRoot(args), {
    checkPaths: !args.includes("--allow-missing-paths"),
  });
  print(result, args, (value) => table(
    ["NAME", "KIND", "GITHUB REPOSITORY", "PATH"],
    projectRows(value.projects),
  ));
  return 0;
}

async function dispatchPrepare(args) {
  validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
  const resolution = workspaceSelection(args);
  const prepared = await prepareDispatch(resolution.workspace);
  prepared.workspaceSource = resolution.source;
  print(prepared, args, (value) => [
    `Workspace: ${value.workspace}`,
    `Task ID: ${value.taskId}`,
    `Prepared: ${value.preparedAt}`,
    `Projects: ${value.projectCount}`,
  ].join("\n"));
  return 0;
}

async function projectRemove(args) {
  if (!args[2] || args[2].startsWith("--")) throw new Error("project remove requires a name");
  validateCommandArgs(args, 3, {
    values: [
      "--workspace", "--expect-config-hash", "--expect-project-count", "--expect-after-count",
      "--confirm-plan", "--confirm-removed", "--confirm-count-collapse",
    ],
    switches: ["--json", "--dry-run"],
  });
  const result = await removeProject(workspaceRoot(args), args[2], await mutationOptions(args));
  print(result, args, (value) =>
    `${args.includes("--dry-run") ? "Would remove" : "Removed"} ${value.project.name}: ${value.project.path}`);
  return 0;
}

async function projectUpdate(args) {
  const hasName = Boolean(args[2] && !args[2].startsWith("--"));
  validateCommandArgs(args, hasName ? 3 : 2, {
    values: [
      "--workspace", "--path", "--name", "--description", "--github-repo",
      "--expect-config-hash",
    ],
    switches: ["--json", "--clear-description", "--no-github", "--refresh-git", "--dry-run"],
    repeatable: ["--github-repo"],
  });
  const selectedPath = option(args, "--path", null);
  if (hasName === Boolean(selectedPath)) throw new Error("project update requires exactly one name or --path selector");
  if (args.includes("--description") && args.includes("--clear-description")) {
    throw new Error("--description and --clear-description cannot be combined");
  }
  if (args.includes("--no-github") && args.includes("--github-repo")) {
    throw new Error("--no-github and --github-repo cannot be combined");
  }
  const input = {};
  if (args.includes("--name")) input.name = option(args, "--name", null);
  if (args.includes("--description")) input.description = option(args, "--description", null);
  if (args.includes("--clear-description")) input.clearDescription = true;
  if (args.includes("--no-github")) input.githubRepos = [];
  else if (args.includes("--github-repo")) input.githubRepos = options(args, "--github-repo");
  if (args.includes("--refresh-git")) input.refreshGit = true;
  const result = await updateProject(
    workspaceRoot(args),
    selectedPath ? { path: selectedPath } : { name: args[2] },
    input,
    await mutationOptions(args),
  );
  print(result, args, (value) => value.changed
    ? `Updated ${value.project.name}: ${value.project.path}`
    : `Unchanged ${value.project.name}: ${value.project.path}`);
  return 0;
}

async function backupCommand(args) {
  const action = args[1];
  if (action === "list") {
    validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
    const result = await listWorkspaceBackups(workspaceRoot(args));
    print(result, args, (value) => value.backups.map((item) =>
      `${item.id}  ${item.usable ? "usable" : item.integrityValid ? "forensic" : "corrupt"}`)
      .join("\n") || "No backups.");
    return 0;
  }
  if (action === "create") {
    validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
    const result = await createWorkspaceBackup(workspaceRoot(args), { reason: "manual" });
    print(result, args, (value) => `Created backup ${value.id}.`);
    return 0;
  }
  if (action === "verify" && args[2]) {
    validateCommandArgs(args, 3, { values: ["--workspace"], switches: ["--json"] });
    const result = await verifyWorkspaceBackup(workspaceRoot(args), args[2]);
    print(result, args, (value) => `${value.id}: ${value.usable ? "usable" : value.error}`);
    return result.usable ? 0 : 1;
  }
  if (action === "prune") {
    validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json", "--apply", "--dry-run"] });
    if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("--apply and --dry-run conflict");
    const result = await pruneWorkspaceBackups(workspaceRoot(args), { apply: args.includes("--apply") });
    print(result, args, (value) => `${value.apply ? "Pruned" : "Would prune"} ${value.removed.length} backup(s).`);
    return 0;
  }
  if (action === "restore") {
    const hasBackupId = Boolean(args[2] && !args[2].startsWith("--"));
    validateCommandArgs(args, hasBackupId ? 3 : 2, {
      values: [
        "--workspace", "--scope", "--expect-config-hash", "--expect-project-count",
        "--expect-after-count", "--confirm-plan", "--confirm-removed", "--confirm-count-collapse",
        "--resume", "--rollback",
      ],
      switches: [
        "--json", "--dry-run", "--approve-restore", "--confirm-offline",
        "--confirm-unreadable-current",
      ],
    });
    const resume = option(args, "--resume", null);
    const rollback = option(args, "--rollback", null);
    if ([hasBackupId, resume !== null, rollback !== null].filter(Boolean).length !== 1) {
      throw new Error("backup restore requires exactly one backup ID, --resume ID, or --rollback ID");
    }
    let backupId = hasBackupId ? args[2] : null;
    let maintenanceTransaction = null;
    if (resume !== null || rollback !== null) {
      const maintenance = await readWorkspaceMaintenance(workspaceRoot(args));
      maintenanceTransaction = resume ?? rollback;
      if (!maintenance.active || maintenance.transactionId !== maintenanceTransaction) {
        throw new Error("maintenance transaction not found");
      }
      backupId = resume !== null ? maintenance.backupId : maintenance.safetyBackupId;
    }
    const result = await restoreWorkspaceBackup(workspaceRoot(args), backupId, {
      ...(await mutationOptions(args)),
      scope: resume !== null || rollback !== null ? "state" : option(args, "--scope", "projects"),
      approveRestore: args.includes("--approve-restore"),
      confirmOffline: args.includes("--confirm-offline"),
      confirmUnreadableCurrent: args.includes("--confirm-unreadable-current"),
      maintenanceTransaction,
    });
    print(result, args, (value) => value.dryRun
      ? `Restore preview ${value.beforeCount} -> ${value.afterCount}.`
      : `Restored backup ${value.backupId} (${value.scope}).`);
    return 0;
  }
  throw new Error("backup command requires list, create, verify, prune, or restore");
}

async function taskRecord(args) {
  validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
  const dispatch = await recordTask(workspaceRoot(args), await readJsonStdin());
  print(dispatch, args, (value) => `Recorded ${value.id}: ${value.title}`);
  return 0;
}

async function taskShow(args) {
  validateCommandArgs(args, 3, { values: ["--workspace"], switches: ["--json"] });
  print(await readTaskForShow(workspaceRoot(args), args[2]), args, taskDetails);
  return 0;
}

async function taskList(args) {
  validateCommandArgs(args, 2, {
    values: ["--workspace", "--project"],
    switches: ["--ascending", "--full-id", "--json"],
  });
  const filtered = await filterTasks(workspaceRoot(args), {
    project: option(args, "--project", null),
  });
  const dispatches = sortTasksByCreatedAt(filtered, args.includes("--ascending"));
  const result = { taskCount: dispatches.length, tasks: dispatches };
  const fullId = args.includes("--full-id");
  print(result, args, (value) => table(
    ["TITLE", "PROJECT", "STATUS", "UPDATED", "ID", "THREAD ID"],
    value.tasks.map((dispatch) => [
      dispatch.title,
      dispatch.project?.name,
      dispatch.status ?? "unknown",
      dispatch.updatedAt ?? dispatch.createdAt,
      displayId(dispatch.id, fullId),
      displayId(dispatch.threadId, fullId),
    ]),
  ));
  return 0;
}

async function taskSummary(args) {
  validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
  const summary = await buildTaskSummary(workspaceRoot(args));
  print(summary, args, (value) => [
    `Tasks: ${value.taskCount}`,
    ...Object.entries(value.projectCounts).map(([project, count]) => `${project}: ${count}`),
  ].join("\n"));
  return 0;
}

async function taskBrief(args) {
  const hasTaskId = Boolean(args[2] && !args[2].startsWith("--"));
  validateCommandArgs(args, hasTaskId ? 3 : 2, {
    values: ["--workspace", "--project"],
    switches: ["--all", "--json"],
  });
  if (hasTaskId && args.includes("--project")) {
    throw new Error("task brief accepts either a task ID or --project, not both");
  }
  const taskId = hasTaskId
    ? (await readTaskForShow(workspaceRoot(args), args[2])).id
    : null;
  const brief = await buildCopilotBrief(workspaceRoot(args), {
    taskId,
    project: option(args, "--project", null),
    includeOldTerminal: args.includes("--all"),
  });
  print(brief, args, (value) => {
    const rows = value.tasks.map((task) => [
      task.title,
      task.project.name,
      task.state,
      task.attention?.kind ?? "-",
      task.nextAction.kind,
      displayId(task.id, false),
    ]);
    return [
      `Cached TaskChef brief (${value.scope})`,
      table(["TITLE", "PROJECT", "STATE", "ATTENTION", "NEXT ACTION", "ID"], rows),
      value.omittedTerminalCount > 0
        ? `Omitted old terminal tasks: ${value.omittedTerminalCount}`
        : null,
    ].filter(Boolean).join("\n");
  });
  return 0;
}

function dashboardPort(args) {
  const value = option(args, "--port", "3210");
  if (!/^\d+$/.test(value)) throw new Error("--port must be an integer from 0 to 65535");
  const port = Number(value);
  if (port > 65_535) throw new Error("--port must be an integer from 0 to 65535");
  return port;
}

async function dashboard(args) {
  validateCommandArgs(args, 1, {
    values: ["--port", "--workspace"],
    switches: ["--json"],
  });
  const port = dashboardPort(args);
  let server;
  try {
    server = await createDashboardServer({
      workspace: workspaceRoot(args),
      port,
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new Error(
        `dashboard port 127.0.0.1:${port} is already in use; `
        + "stop the existing listener or choose another --port (TaskChef will not terminate it)",
      );
    }
    throw error;
  }
  print({
    schemaVersion: 1,
    url: server.url,
    workspace: server.monitor.workspace,
  }, args, (value) => [
    `TaskChef dashboard: ${value.url}`,
    `Workspace: ${value.workspace}`,
    "Press Ctrl+C to stop.",
  ].join("\n"));

  let stop;
  await new Promise((resolve) => {
    stop = resolve;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await server.close();
  return 0;
}

function usage() {
  process.stdout.write(`TaskChef workspace utility

Usage:
  taskchef help
  taskchef dashboard [--port <number>] [--json] [--workspace <path>]
  taskchef doctor [--json] [--workspace <path>]
  taskchef workspace path [--json] [--workspace <path>]
  taskchef workspace init [--register-codex] [--codex-cli <path>] [--json] [--workspace <path>]
  taskchef workspace migrate [--json] [--workspace <path>]
  taskchef project add <path> [--name <name>] [--description <text>] [--github-repo <url> ... | --no-github] [--json] [--workspace <path>]
  taskchef project import [<file> | -] [--replace] [--json] [--workspace <path>]
  taskchef project list [--allow-missing-paths] [--json] [--workspace <path>]
  taskchef project update <name> [fields] [--dry-run] [--expect-config-hash <sha256>] [--json]
  taskchef project remove <name> --dry-run [--json] [--workspace <path>]
  taskchef backup list|create|verify|restore|prune [options]
  taskchef dispatch prepare [--json] [--workspace <path>]
  taskchef task record [--json] [--workspace <path>]
  taskchef task brief [<task-id-or-8-character-prefix> | --project <name-or-path>] [--all] [--json] [--workspace <path>]
  taskchef task show <task-id-or-8-character-prefix> [--json] [--workspace <path>]
  taskchef task list [--project <name-or-path>] [--ascending] [--full-id] [--json] [--workspace <path>]
  taskchef task summary [--json] [--workspace <path>]

Task record reads one JSON value from closed, non-interactive standard input.
Task show accepts a full task ID or the exact 8-character ID printed by task list.
Task show prints human-readable details by default; --json prints the complete task object.
Project import reads a JSON
array from a file, or from standard input when the source is '-' or omitted.
Workspace resolution precedence is --workspace, TASKCHEF_WORKSPACE, then
~/.agents/taskchef.
The foreground dashboard binds to 127.0.0.1 and creates one verified startup
snapshot before reading the canonical task log. The dispatcher MCP may reuse a
compatible foreground server on port 3210; neither mode terminates a listener
that already occupies its requested port.
`);
}

export async function runCli(args) {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    usage();
    return 0;
  }
  if (args[0] === "dashboard") return dashboard(args);
  if (args[0] === "doctor") return doctor(args);
  if (args[0] === "workspace" && args[1] === "path") return workspacePath(args);
  if (args[0] === "workspace" && args[1] === "init") return initialize(args);
  if (args[0] === "workspace" && args[1] === "migrate") return migrate(args);
  if (args[0] === "project" && args[1] === "add") return projectAdd(args);
  if (args[0] === "project" && args[1] === "import") return projectImport(args);
  if (args[0] === "project" && args[1] === "list") return projectList(args);
  if (args[0] === "project" && args[1] === "update") return projectUpdate(args);
  if (args[0] === "project" && args[1] === "remove") return projectRemove(args);
  if (args[0] === "backup") return backupCommand(args);
  if (args[0] === "dispatch" && args[1] === "prepare") return dispatchPrepare(args);
  if (args[0] === "task" && args[1] === "record") return taskRecord(args);
  if (args[0] === "task" && args[1] === "brief") return taskBrief(args);
  if (args[0] === "task" && args[1] === "show" && args[2]) return taskShow(args);
  if (args[0] === "task" && args[1] === "list") return taskList(args);
  if (args[0] === "task" && args[1] === "summary") return taskSummary(args);
  process.stderr.write(`Unknown command: ${args.join(" ")}\n`);
  usage();
  return 2;
}
