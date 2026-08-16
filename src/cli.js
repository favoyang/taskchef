import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { openWorkspaceInCodex } from "./codex-app.js";
import { resolveWorkspacePath } from "./workspace-path.js";

import {
  addProject,
  buildTaskSummary,
  doctorWorkspace,
  filterTasks,
  importProjects,
  initializeWorkspace,
  listProjects,
  listTasks,
  prepareDispatch,
  recordTask,
  removeProject,
  requireSafeId,
  resolveTask,
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
  return [
    `Title: ${singleLineDetail(task.title)}`,
    `Project: ${singleLineDetail(task.project.name)}`,
    `Project path: ${singleLineDetail(task.project.path)}`,
    `Created: ${singleLineDetail(task.createdAt)}`,
    `Task ID: ${singleLineDetail(task.id)}`,
    `Thread ID: ${singleLineDetail(task.threadId ?? "-")}`,
    "Instruction:",
    task.instruction,
  ].join("\n");
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
    `Legacy skill links removed: ${value.legacySkills.removed.length}`,
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
    switches: ["--json", "--no-github"],
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
  const project = await addProject(workspaceRoot(args), input);
  print(project, args, (value) => `Added ${value.name}: ${value.path}`);
  return 0;
}

async function projectImport(args) {
  const hasSource = Boolean(args[2] && !args[2].startsWith("--"));
  const source = hasSource ? args[2] : "-";
  validateCommandArgs(args, hasSource ? 3 : 2, {
    values: ["--workspace"],
    switches: ["--json", "--replace"],
  });
  const content = source === "-"
    ? await readStdin()
    : await readFile(path.resolve(source), "utf8");
  if (content.trim().length === 0) throw new Error("project import input is empty");
  const result = await importProjects(workspaceRoot(args), JSON.parse(content), {
    replace: args.includes("--replace"),
  });
  print(result, args, (value) =>
    `Imported ${value.importedCount} project(s); ${value.projectCount} configured (${value.mode}).`);
  return 0;
}

async function projectList(args) {
  validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
  const projects = await listProjects(workspaceRoot(args));
  print({ projectCount: projects.length, projects }, args, (value) => table(
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
    values: ["--workspace"],
    switches: ["--json"],
  });
  const result = await removeProject(workspaceRoot(args), args[2]);
  print(result, args, (value) => `Removed ${value.project.name}: ${value.project.path}`);
  return 0;
}

async function taskRecord(args) {
  validateCommandArgs(args, 2, { values: ["--workspace"], switches: ["--json"] });
  const dispatch = await recordTask(workspaceRoot(args), await readJsonStdin());
  print(dispatch, args, (value) => `Recorded ${value.id}: ${value.title}`);
  return 0;
}

async function taskResolve(args) {
  if (!args[2] || args[2].startsWith("--")) throw new Error("task resolve requires a task ID");
  validateCommandArgs(args, 3, {
    values: ["--thread-id", "--workspace"],
    switches: ["--json"],
  });
  if (!args.includes("--thread-id")) throw new Error("task resolve requires --thread-id");
  const task = await resolveTask(
    workspaceRoot(args),
    args[2],
    option(args, "--thread-id"),
  );
  print(task, args, (value) => `Resolved ${value.id}: ${value.threadId}`);
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
    ["TITLE", "PROJECT", "CREATED", "ID", "THREAD ID"],
    value.tasks.map((dispatch) => [
      dispatch.title,
      dispatch.project?.name,
      dispatch.createdAt,
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

function usage() {
  process.stdout.write(`TaskChef workspace utility

Usage:
  taskchef help
  taskchef doctor [--json] [--workspace <path>]
  taskchef workspace path [--json] [--workspace <path>]
  taskchef workspace init [--register-codex] [--codex-cli <path>] [--json] [--workspace <path>]
  taskchef project add <path> [--name <name>] [--description <text>] [--github-repo <url> ... | --no-github] [--json] [--workspace <path>]
  taskchef project import [<file> | -] [--replace] [--json] [--workspace <path>]
  taskchef project list [--json] [--workspace <path>]
  taskchef project remove <name> [--json] [--workspace <path>]
  taskchef dispatch prepare [--json] [--workspace <path>]
  taskchef task record [--json] [--workspace <path>]
  taskchef task resolve <task-id> --thread-id <thread-id> [--json] [--workspace <path>]
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
`);
}

export async function runCli(args) {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    usage();
    return 0;
  }
  if (args[0] === "doctor") return doctor(args);
  if (args[0] === "workspace" && args[1] === "path") return workspacePath(args);
  if (args[0] === "workspace" && args[1] === "init") return initialize(args);
  if (args[0] === "project" && args[1] === "add") return projectAdd(args);
  if (args[0] === "project" && args[1] === "import") return projectImport(args);
  if (args[0] === "project" && args[1] === "list") return projectList(args);
  if (args[0] === "project" && args[1] === "remove") return projectRemove(args);
  if (args[0] === "dispatch" && args[1] === "prepare") return dispatchPrepare(args);
  if (args[0] === "task" && args[1] === "record") return taskRecord(args);
  if (args[0] === "task" && args[1] === "resolve") return taskResolve(args);
  if (args[0] === "task" && args[1] === "show" && args[2]) return taskShow(args);
  if (args[0] === "task" && args[1] === "list") return taskList(args);
  if (args[0] === "task" && args[1] === "summary") return taskSummary(args);
  process.stderr.write(`Unknown command: ${args.join(" ")}\n`);
  usage();
  return 2;
}
