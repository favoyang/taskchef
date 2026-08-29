import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  link,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import {
  normalizeCodexThreadId,
  normalizeDurableThreadId,
  parseTaskChefMarker,
  taskChefMarker,
} from "./delegation.js";
import {
  canonicalGithubRepository,
  normalizeGithubRepositories,
} from "./github.js";

const execFile = promisify(execFileCallback);
const DISPATCHER_INSTRUCTIONS_URL = new URL(
  "../assets/taskchef-dispatcher-instructions.md",
  import.meta.url,
);
const DISPATCHER_INSTRUCTIONS_START = "<!-- taskchef:dispatcher-instructions:start -->";
const DISPATCHER_INSTRUCTIONS_END = "<!-- taskchef:dispatcher-instructions:end -->";
const DISPATCH_FILE_NAME = "tasks.jsonl";
const WORKSPACE_LOCK_NAME = ".taskchef-workspace.lock";
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const CURRENT_CONFIG_SCHEMA_VERSION = 2;
const CURRENT_TASK_SCHEMA_VERSION = 10;
const PREVIOUS_TASK_SCHEMA_VERSION = 9;
const TURN_REF_TASK_SCHEMA_VERSION = 9;
const FIRST_TURN_HISTORY_TASK_SCHEMA_VERSION = 7;
const INTERRUPTED_TURN_TASK_SCHEMA_VERSION = 8;
const LEGACY_RESULTS_TASK_SCHEMA_VERSION = 6;
const FIRST_SELF_LINKING_TASK_SCHEMA_VERSION = 4;
const CONFIG_FIELDS = new Set(["schemaVersion", "projects", "dashboard"]);
const DASHBOARD_CONFIG_FIELDS = new Set(["autostart"]);
const PROJECT_FIELDS = new Set([
  "name",
  "path",
  "isGitRepository",
  "githubRepos",
  "description",
]);
const PROJECT_INPUT_FIELDS = new Set(["name", "path", "githubRepos", "description"]);
const STATEFUL_DISPATCH_FIELDS = new Set([
  "schemaVersion",
  "id",
  "project",
  "title",
  "instruction",
  "threadId",
  "createdAt",
  "status",
  "summary",
  "turnId",
  "updatedAt",
  "updatedBy",
]);
const SCHEMA_5_DISPATCH_FIELDS = new Set([...STATEFUL_DISPATCH_FIELDS, "lastResult"]);
const SCHEMA_6_DISPATCH_FIELDS = new Set([...STATEFUL_DISPATCH_FIELDS, "results"]);
const LEGACY_TURN_DISPATCH_FIELDS = new Set([...STATEFUL_DISPATCH_FIELDS, "turns"]);
const DISPATCH_FIELDS = new Set([...STATEFUL_DISPATCH_FIELDS, "turnRef", "turns"]);
const RECORD_DISPATCH_FIELDS = new Set([
  "id",
  "project",
  "title",
  "instruction",
  "threadId",
]);
const RESULT_STATUSES = new Set(["needs_input", "completed", "failed"]);
const TURN_RESULT_STATUSES = new Set([...RESULT_STATUSES, "interrupted"]);
const TASK_STATUSES = new Set(["working", ...RESULT_STATUSES]);
const TASK_UPDATE_SOURCES = new Set(["dispatcher", "mcp", "dashboard"]);
const MAX_RESULT_SUMMARY_LENGTH = 2_000;
const MAX_REQUEST_SUMMARY_LENGTH = 1_000;
const RESULT_FIELDS = new Set(["status", "summary", "turnId", "updatedAt"]);
const TURN_RESULT_FIELDS = new Set(["status", "summary", "updatedAt"]);
const LEGACY_TURN_FIELDS = new Set(["turnId", "requestSummary", "startedAt", "result"]);
const SCHEMA_9_TURN_FIELDS = new Set([
  "turnRef", "turnId", "requestSummary", "startedAt", "result",
]);
const TURN_FIELDS = new Set([...SCHEMA_9_TURN_FIELDS, "provenance"]);
const TURN_PROVENANCE_KINDS = new Set(["legacy", "mcp", "dashboard_manual"]);
const SIMPLE_TURN_PROVENANCE_FIELDS = new Set(["kind"]);
const MANUAL_TURN_PROVENANCE_FIELDS = new Set([
  "kind",
  "actionId",
  "fromStatus",
  "toStatus",
  "expectedTurnRef",
  "expectedThreadId",
  "expectedUpdatedAt",
]);
const INTERRUPTED_TURN_SUMMARY = "Turn interrupted before a terminal report.";
const MANUAL_TRANSITION_STATUSES = new Set([
  "working", "needs_input", "completed", "failed",
]);
const MANUAL_TARGET_STATUSES = new Set(["completed", "failed"]);
const MANUAL_TRANSITION_FIELDS = new Set([
  "actionId", "expected", "targetStatus",
]);
const MANUAL_EXPECTED_FIELDS = new Set([
  "status", "turnRef", "threadId", "updatedAt",
]);

function requireExactFields(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const unexpected = Object.keys(value).find((key) => !fields.has(key));
  if (unexpected) throw new Error(`${name} has unsupported field: ${unexpected}`);
  const missing = [...fields].find((key) => !(key in value));
  if (missing) throw new Error(`${name} is missing field: ${missing}`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value, name) {
  requireString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO 8601 timestamp`);
  }
  return value;
}

function transitionTimestamp(now, currentUpdatedAt) {
  const candidate = requireTimestamp(now ?? new Date().toISOString(), "transition timestamp");
  return Date.parse(candidate) < Date.parse(currentUpdatedAt)
    ? currentUpdatedAt
    : candidate;
}

function optionalString(value, name, { maxLength = null } = {}) {
  if (value === null) return null;
  const normalized = requireString(value, name).trim();
  if (maxLength !== null && normalized.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeTurnRef(value, name = "turnRef") {
  const normalized = requireString(value, name).trim();
  if (normalized.length > 256) throw new Error(`${name} must be at most 256 characters`);
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function normalizeExecutorTurnRef(value, name = "turnRef") {
  const normalized = normalizeTurnRef(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`${name} must be a UUID for a self-linked task`);
  }
  return normalized;
}

function normalizeTurnProvenance(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const kind = requireEnum(value.kind, TURN_PROVENANCE_KINDS, `${name}.kind`);
  if (kind !== "dashboard_manual") {
    requireExactFields(value, SIMPLE_TURN_PROVENANCE_FIELDS, name);
    return { kind };
  }
  requireExactFields(value, MANUAL_TURN_PROVENANCE_FIELDS, name);
  return {
    kind,
    actionId: normalizeExecutorTurnRef(value.actionId, `${name}.actionId`),
    fromStatus: requireEnum(value.fromStatus, MANUAL_TRANSITION_STATUSES, `${name}.fromStatus`),
    toStatus: requireEnum(value.toStatus, MANUAL_TARGET_STATUSES, `${name}.toStatus`),
    expectedTurnRef: value.expectedTurnRef === null
      ? null
      : normalizeTurnRef(value.expectedTurnRef, `${name}.expectedTurnRef`),
    expectedThreadId: value.expectedThreadId === null
      ? null
      : normalizeDurableThreadId(value.expectedThreadId, `${name}.expectedThreadId`),
    expectedUpdatedAt: requireTimestamp(value.expectedUpdatedAt, `${name}.expectedUpdatedAt`),
  };
}

function requireEnum(value, allowed, name) {
  if (!allowed.has(value)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

export function requireSafeId(value, name = "id") {
  requireString(value, name);
  if (!SAFE_ID.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return value;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureManagedDirectory(root, ...segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let details = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (details === null) {
      await mkdir(current);
      details = await lstat(current);
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`managed workspace path is not a real directory: ${current}`);
    }
    if (await realpath(current) !== current) {
      throw new Error(`managed workspace path escapes the workspace: ${current}`);
    }
  }
  return current;
}

async function managedRegularFileExists(filePath) {
  const details = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (details === null) return false;
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`managed workspace path is not a regular file: ${filePath}`);
  }
  return true;
}

function assertWorkspaceOutsideProject(workspaceRoot, projectPath) {
  const relative = path.relative(projectPath, workspaceRoot);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(
      "TaskChef workspace cannot be configured as its own delegation project or inside a delegation project",
    );
  }
}

export async function acquireWorkspaceLock(workspaceRoot, {
  lock = lockfile.lock,
  waitImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  const lockPath = path.join(workspaceRoot, WORKSPACE_LOCK_NAME);
  for (let attempt = 0; attempt <= 70; attempt += 1) {
    try {
      return await lock(workspaceRoot, {
        realpath: false,
        lockfilePath: lockPath,
        stale: 600_000,
        update: 10_000,
        retries: 0,
      });
    } catch (error) {
      if (error.code !== "ELOCKED" || attempt === 70) throw error;
      await waitImpl(100);
    }
  }
  throw new Error("workspace lock retry loop ended unexpectedly");
}

async function withWorkspaceLock(workspaceRoot, operation) {
  const release = await acquireWorkspaceLock(workspaceRoot);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function appendDispatchesAtomic(workspaceRoot, dispatches) {
  if (dispatches.length === 0) return;
  const dispatchPath = path.join(workspaceRoot, DISPATCH_FILE_NAME);
  const content = await readFile(dispatchPath, "utf8");
  const appended = dispatches
    .map((dispatch) => `${JSON.stringify(currentSchemaTask(dispatch))}\n`)
    .join("");
  await writeTextAtomic(dispatchPath, `${content}${appended}`);
}

async function writeDispatchLinesAtomic(workspaceRoot, lines) {
  const dispatchPath = path.join(workspaceRoot, DISPATCH_FILE_NAME);
  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  await writeTextAtomic(dispatchPath, content);
}

async function writeJsonAtomic(filePath, value, { exclusive = false } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (exclusive && (await pathExists(filePath))) {
    throw new Error(`file already exists: ${filePath}`);
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    if (exclusive) {
      await link(temporaryPath, filePath).catch((error) => {
        if (error.code === "EEXIST") throw new Error(`file already exists: ${filePath}`);
        throw error;
      });
      await unlink(temporaryPath);
      return;
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function writeTextAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const mode = await stat(filePath)
    .then((details) => details.mode & 0o777)
    .catch((error) => {
      if (error.code === "ENOENT") return 0o600;
      throw error;
    });
  await writeFile(temporaryPath, value, {
    encoding: "utf8",
    mode,
    flag: "wx",
  });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function readDispatcherInstructions() {
  const instructions = await readFile(DISPATCHER_INSTRUCTIONS_URL, "utf8");
  const startCount = instructions.split(DISPATCHER_INSTRUCTIONS_START).length - 1;
  const endCount = instructions.split(DISPATCHER_INSTRUCTIONS_END).length - 1;
  if (
    startCount !== 1 ||
    endCount !== 1 ||
    instructions.indexOf(DISPATCHER_INSTRUCTIONS_START) >
      instructions.indexOf(DISPATCHER_INSTRUCTIONS_END)
  ) {
    throw new Error("TaskChef dispatcher instructions must contain exactly one managed block");
  }
  return instructions.endsWith("\n") ? instructions : `${instructions}\n`;
}

function mergeDispatcherInstructions(existing, managed) {
  const startCount = existing.split(DISPATCHER_INSTRUCTIONS_START).length - 1;
  const endCount = existing.split(DISPATCHER_INSTRUCTIONS_END).length - 1;
  if (startCount !== endCount || startCount > 1) {
    throw new Error("AGENTS.md contains malformed TaskChef managed-block markers");
  }
  if (startCount === 1) {
    const start = existing.indexOf(DISPATCHER_INSTRUCTIONS_START);
    const end = existing.indexOf(DISPATCHER_INSTRUCTIONS_END, start);
    if (end === -1) {
      throw new Error("AGENTS.md contains malformed TaskChef managed-block markers");
    }
    return `${existing.slice(0, start)}${managed.trimEnd()}${existing.slice(end + DISPATCHER_INSTRUCTIONS_END.length)}`;
  }
  if (existing.trim().length === 0) return managed;
  return `${existing.trimEnd()}\n\n${managed}`;
}

export async function ensureWorkspaceInstructions(workspaceRoot) {
  const requestedRoot = path.resolve(workspaceRoot);
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const filePath = path.join(root, "AGENTS.md");
  const managed = await readDispatcherInstructions();
  const existing = await managedRegularFileExists(filePath)
    ? await readFile(filePath, "utf8")
    : null;
  const merged = mergeDispatcherInstructions(existing ?? "", managed);
  const action = existing === null
    ? "created"
    : existing === merged
      ? "unchanged"
      : existing.includes(DISPATCHER_INSTRUCTIONS_START)
        ? "updated"
        : "merged";
  if (action !== "unchanged") await writeTextAtomic(filePath, merged);
  return { path: filePath, action };
}

export async function canonicalGitRoot(projectPath) {
  const requested = await canonicalDirectory(projectPath);
  const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
  }).catch(() => {
    throw new Error(`project is not a Git repository: ${requested}`);
  });
  const gitRoot = await realpath(stdout.trim());
  if (gitRoot !== requested) {
    throw new Error(`project must be the Git repository root: ${requested}`);
  }
  return requested;
}

export async function canonicalDirectory(projectPath) {
  const requested = await realpath(path.resolve(requireString(projectPath, "project")))
    .catch((error) => {
      if (error.code === "ENOENT") throw new Error(`project does not exist: ${projectPath}`);
      throw error;
    });
  if (!(await stat(requested)).isDirectory()) {
    throw new Error(`project must be a directory: ${requested}`);
  }
  return requested;
}

async function normalizeProject(
  project,
  index,
  { checkPath = true } = {},
) {
  const field = `projects[${index}]`;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error(`${field} must be an object`);
  }
  const unexpected = Object.keys(project).find((key) => !PROJECT_FIELDS.has(key));
  if (unexpected) throw new Error(`${field} has unsupported field: ${unexpected}`);
  for (const required of ["name", "path", "isGitRepository", "githubRepos"]) {
    if (!(required in project)) throw new Error(`${field} is missing field: ${required}`);
  }
  const name = requireString(project.name, `${field}.name`).trim();
  if (typeof project.isGitRepository !== "boolean") {
    throw new Error(`${field}.isGitRepository must be a boolean`);
  }
  let projectPath;
  if (checkPath) {
    projectPath = project.isGitRepository
      ? await canonicalGitRoot(project.path)
      : await canonicalDirectory(project.path);
  } else {
    projectPath = requireString(project.path, `${field}.path`).trim();
    if (!path.isAbsolute(projectPath) || path.normalize(projectPath) !== projectPath) {
      throw new Error(`${field}.path must be a normalized absolute path`);
    }
  }
  const githubRepos = normalizeGithubRepositories(project.githubRepos, `${field}.githubRepos`);
  const normalized = {
    name,
    path: projectPath,
    isGitRepository: project.isGitRepository,
    githubRepos,
  };
  if ("description" in project) {
    normalized.description = requireString(
      project.description,
      `${field}.description`,
    ).trim();
  }
  return normalized;
}

async function normalizeProjects(
  projects,
  { checkPaths = true } = {},
) {
  if (!Array.isArray(projects)) throw new Error("projects must be an array");
  const normalized = [];
  for (const [index, project] of projects.entries()) {
    normalized.push(await normalizeProject(project, index, {
      checkPath: checkPaths,
    }));
  }
  if (new Set(normalized.map((project) => project.path)).size !== normalized.length) {
    throw new Error("project paths must not contain duplicates");
  }
  if (
    new Set(normalized.map((project) => project.name.toLowerCase())).size !==
    normalized.length
  ) {
    throw new Error("project names must not contain duplicates");
  }
  return normalized;
}

function normalizeGithubRemote(remote) {
  if (typeof remote !== "string" || remote.trim().length === 0) return null;
  try {
    return canonicalGithubRepository(remote, "GitHub origin");
  } catch {
    return null;
  }
}

function gitInspectionError(action, error) {
  const detail = typeof error.stderr === "string" && error.stderr.trim()
    ? error.stderr.trim()
    : error.message;
  return new Error(`${action}: ${detail}`);
}

async function inspectProject(input, index = 0) {
  const field = `projects[${index}]`;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${field} must be an object`);
  }
  const unexpected = Object.keys(input).find((key) => !PROJECT_INPUT_FIELDS.has(key));
  if (unexpected) throw new Error(`${field} has unsupported field: ${unexpected}`);
  if (!("path" in input)) throw new Error(`${field} is missing field: path`);
  const projectPath = await canonicalDirectory(input.path);
  let isGitRepository = false;
  let gitRoot = null;
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectPath,
    });
    gitRoot = await realpath(stdout.trim());
    isGitRepository = true;
  } catch (error) {
    if (error.code === 128 && /not a git repository/i.test(error.stderr ?? "")) {
      isGitRepository = false;
    } else {
      throw gitInspectionError("failed to inspect Git repository", error);
    }
  }
  if (isGitRepository && gitRoot !== projectPath) {
    throw new Error(`project must be the Git repository root: ${projectPath}`);
  }
  let githubRepos = [];
  if (isGitRepository) {
    if ("githubRepos" in input) {
      githubRepos = normalizeGithubRepositories(input.githubRepos, `${field}.githubRepos`);
    } else {
      const remote = await execFile("git", ["remote", "get-url", "origin"], {
        cwd: projectPath,
      }).then(({ stdout }) => stdout.trim()).catch((error) => {
        if (error.code === 2 && /No such remote/i.test(error.stderr ?? "")) return null;
        throw gitInspectionError("failed to inspect GitHub origin", error);
      });
      const detected = normalizeGithubRemote(remote);
      githubRepos = detected === null ? [] : [detected];
    }
  } else if ("githubRepos" in input) {
    githubRepos = normalizeGithubRepositories(input.githubRepos, `${field}.githubRepos`);
  }
  const project = {
    name: "name" in input
      ? requireString(input.name, `${field}.name`).trim()
      : path.basename(projectPath),
    path: projectPath,
    isGitRepository,
    githubRepos,
  };
  if ("description" in input) {
    project.description = requireString(input.description, `${field}.description`).trim();
  }
  return project;
}

export async function validateConfig(config, { checkPaths = true } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("taskchef.json must be an object");
  }
  const unexpected = Object.keys(config).find((key) => !CONFIG_FIELDS.has(key));
  if (unexpected) throw new Error(`taskchef.json has unsupported field: ${unexpected}`);
  for (const required of ["schemaVersion", "projects"]) {
    if (!(required in config)) throw new Error(`taskchef.json is missing field: ${required}`);
  }
  if (config.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error("unsupported configuration schemaVersion");
  }
  let dashboard;
  if ("dashboard" in config) {
    requireExactFields(config.dashboard, DASHBOARD_CONFIG_FIELDS, "taskchef.json.dashboard");
    if (typeof config.dashboard.autostart !== "boolean") {
      throw new Error("taskchef.json.dashboard.autostart must be a boolean");
    }
    dashboard = { autostart: config.dashboard.autostart };
  }
  return {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    projects: await normalizeProjects(config.projects, { checkPaths }),
    ...(dashboard ? { dashboard } : {}),
  };
}

export function dashboardAutostartEnabled(config) {
  return config?.dashboard?.autostart !== false;
}

async function ensureDispatchFile(workspaceRoot) {
  const filePath = path.join(workspaceRoot, DISPATCH_FILE_NAME);
  const exists = await managedRegularFileExists(filePath);
  if (!exists) {
    await writeFile(filePath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  return { path: filePath, action: exists ? "unchanged" : "created" };
}

export async function initializeWorkspace(workspaceRoot) {
  const requestedRoot = path.resolve(workspaceRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const requestedDetails = await lstat(requestedRoot);
  if (requestedDetails.isSymbolicLink() || !requestedDetails.isDirectory()) {
    throw new Error(`workspace path is not a real directory: ${requestedRoot}`);
  }
  if (typeof process.getuid === "function" && requestedDetails.uid !== process.getuid()) {
    throw new Error(`workspace is not owned by the current user: ${requestedRoot}`);
  }
  const root = await realpath(requestedRoot);
  await chmod(root, 0o700);
  return withWorkspaceLock(root, async () => {
    const configPath = path.join(root, "taskchef.json");
    const configExists = await managedRegularFileExists(configPath);
    const config = configExists
      ? await readConfig(root, { checkPaths: false })
      : {
        schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
        projects: [],
        dashboard: { autostart: true },
      };
    const dispatchPath = path.join(root, DISPATCH_FILE_NAME);
    if (configExists && (await managedRegularFileExists(dispatchPath))) {
      await readDispatchesUnlocked(root);
    }
    if (!configExists) await writeJsonAtomic(configPath, config, { exclusive: true });
    const tasks = await ensureDispatchFile(root);
    const instructions = await ensureWorkspaceInstructions(root).catch(async (error) => {
      if (!configExists) await unlink(configPath).catch(() => {});
      throw error;
    });
    await Promise.all([configPath, tasks.path, instructions.path]
      .map((filePath) => chmod(filePath, 0o600)));
    return {
      workspace: root,
      config: {
        path: configPath,
        action: configExists ? "unchanged" : "created",
        value: config,
      },
      tasks,
      instructions,
    };
  });
}

export async function readConfig(workspaceRoot, { checkPaths = true } = {}) {
  const root = path.resolve(workspaceRoot);
  const configPath = path.join(root, "taskchef.json");
  if (!(await managedRegularFileExists(configPath))) {
    throw new Error(`configuration does not exist: ${configPath}`);
  }
  const config = await validateConfig(JSON.parse(await readFile(configPath, "utf8")), { checkPaths });
  const canonicalRoot = await realpath(root);
  for (const project of config.projects) assertWorkspaceOutsideProject(canonicalRoot, project.path);
  return config;
}

export async function listProjects(workspaceRoot) {
  const config = await readConfig(workspaceRoot);
  return [...config.projects].sort((left, right) => left.name.localeCompare(right.name));
}

export async function prepareDispatch(workspaceRoot, {
  taskId = randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  const workspace = await realpath(path.resolve(workspaceRoot));
  const projects = await listProjects(workspace);
  const marker = taskChefMarker(taskId);
  const preparedAt = requireTimestamp(now(), "preparedAt");
  return {
    schemaVersion: 1,
    workspace,
    taskId,
    preparedAt,
    marker,
    projectCount: projects.length,
    projects,
  };
}

export async function addProject(workspaceRoot, input) {
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const config = await readConfig(root);
    const project = await inspectProject(input);
    assertWorkspaceOutsideProject(root, project.path);
    const updated = await validateConfig({
      ...config,
      projects: [...config.projects, project],
    });
    await writeJsonAtomic(path.join(root, "taskchef.json"), updated);
    return project;
  });
}

export async function importProjects(workspaceRoot, inputs, { replace = false } = {}) {
  if (!Array.isArray(inputs)) throw new Error("project import must be a JSON array");
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const current = await readConfig(root, { checkPaths: !replace });
    const imported = [];
    for (const [index, input] of inputs.entries()) {
      const canonicalPath = await canonicalDirectory(input?.path);
      assertWorkspaceOutsideProject(root, canonicalPath);
      const existing = current.projects.find((project) => project.path === canonicalPath);
      const mergedInput = { ...input, path: canonicalPath };
      if (!("name" in mergedInput) && existing) mergedInput.name = existing.name;
      if (!("description" in mergedInput) && existing?.description) {
        mergedInput.description = existing.description;
      }
      if (existing && !replace) {
        const importedRepositories = "githubRepos" in mergedInput
          ? normalizeGithubRepositories(mergedInput.githubRepos, `projects[${index}].githubRepos`)
          : [];
        mergedInput.githubRepos = [...existing.githubRepos, ...importedRepositories];
      }
      imported.push(await inspectProject(mergedInput, index));
    }
    const projects = replace ? [] : [...current.projects];
    for (const project of imported) {
      const index = projects.findIndex((existing) => existing.path === project.path);
      if (index === -1) projects.push(project);
      else projects[index] = project;
    }
    const config = await validateConfig({
      ...current,
      projects,
    });
    await writeJsonAtomic(path.join(root, "taskchef.json"), config);
    return {
      mode: replace ? "replace" : "merge",
      importedCount: imported.length,
      projectCount: config.projects.length,
      projects: imported,
    };
  });
}

export async function removeProject(workspaceRoot, name) {
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const config = await readConfig(root, { checkPaths: false });
    const index = config.projects.findIndex(
      (project) => project.name.toLowerCase() === requireString(name, "project name").toLowerCase(),
    );
    if (index === -1) throw new Error(`configured project not found: ${name}`);
    const [project] = config.projects.slice(index, index + 1);
    const projects = config.projects.filter((_, projectIndex) => projectIndex !== index);
    await writeJsonAtomic(path.join(root, "taskchef.json"), {
      ...config,
      projects,
    });
    return { project };
  });
}

async function validateDispatchShape(dispatch, name = "task") {
  const supportedVersions = [
    FIRST_SELF_LINKING_TASK_SCHEMA_VERSION,
    5,
    LEGACY_RESULTS_TASK_SCHEMA_VERSION,
    FIRST_TURN_HISTORY_TASK_SCHEMA_VERSION,
    INTERRUPTED_TURN_TASK_SCHEMA_VERSION,
    PREVIOUS_TASK_SCHEMA_VERSION,
    CURRENT_TASK_SCHEMA_VERSION,
  ];
  if (!supportedVersions.includes(dispatch?.schemaVersion)) {
    throw new Error(`unsupported ${name} schemaVersion`);
  }
  requireExactFields(
    dispatch,
    dispatch.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION
      ? DISPATCH_FIELDS
      : dispatch.schemaVersion >= FIRST_TURN_HISTORY_TASK_SCHEMA_VERSION
        ? LEGACY_TURN_DISPATCH_FIELDS
        : dispatch.schemaVersion === LEGACY_RESULTS_TASK_SCHEMA_VERSION
        ? SCHEMA_6_DISPATCH_FIELDS
        : dispatch.schemaVersion === 5
        ? SCHEMA_5_DISPATCH_FIELDS
        : STATEFUL_DISPATCH_FIELDS,
    name,
  );
  const id = requireSafeId(dispatch.id, `${name}.id`);
  const project = await normalizeProject(dispatch.project, 0, { checkPath: false });
  const status = requireEnum(dispatch.status, TASK_STATUSES, `${name}.status`);
  const summary = optionalString(dispatch.summary, `${name}.summary`, {
    maxLength: MAX_RESULT_SUMMARY_LENGTH,
  });
  const rawTurnId = optionalString(dispatch.turnId, `${name}.turnId`, { maxLength: 256 });
  const turnId = rawTurnId === null ? null : normalizeTurnRef(rawTurnId, `${name}.turnId`);
  const storedTurnRef = dispatch.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION
    ? (dispatch.turnRef === null ? null : normalizeTurnRef(dispatch.turnRef, `${name}.turnRef`))
    : null;
  const updatedAt = requireTimestamp(dispatch.updatedAt, `${name}.updatedAt`);
  const normalizeResult = (result, resultName) => {
    requireExactFields(result, RESULT_FIELDS, resultName);
    const normalizedResult = {
        status: requireEnum(
          result.status,
          RESULT_STATUSES,
          `${resultName}.status`,
        ),
        summary: optionalString(
          result.summary,
          `${resultName}.summary`,
          { maxLength: MAX_RESULT_SUMMARY_LENGTH },
        ),
        turnId: result.turnId === null
          ? null
          : normalizeTurnRef(optionalString(
            result.turnId,
            `${resultName}.turnId`,
            { maxLength: 256 },
          ), `${resultName}.turnId`),
        updatedAt: requireTimestamp(
          result.updatedAt,
          `${resultName}.updatedAt`,
        ),
    };
    if (normalizedResult.summary === null) {
      throw new Error(`${resultName}.summary must be a non-empty string`);
    }
    return normalizedResult;
  };
  const normalizeTurnResult = (result, resultName) => {
    if (result === null) return null;
    requireExactFields(result, TURN_RESULT_FIELDS, resultName);
    const normalizedResult = {
      status: requireEnum(
        result.status,
        dispatch.schemaVersion >= INTERRUPTED_TURN_TASK_SCHEMA_VERSION
          ? TURN_RESULT_STATUSES
          : RESULT_STATUSES,
        `${resultName}.status`,
      ),
      summary: optionalString(result.summary, `${resultName}.summary`, {
        maxLength: MAX_RESULT_SUMMARY_LENGTH,
      }),
      updatedAt: requireTimestamp(result.updatedAt, `${resultName}.updatedAt`),
    };
    if (normalizedResult.summary === null) {
      throw new Error(`${resultName}.summary must be a non-empty string`);
    }
    if (
      normalizedResult.status === "interrupted"
      && normalizedResult.summary !== INTERRUPTED_TURN_SUMMARY
    ) {
      throw new Error(`${resultName}.summary must use the TaskChef interrupted-turn summary`);
    }
    return normalizedResult;
  };
  const normalizeTurn = (turn, turnName) => {
    requireExactFields(
      turn,
      dispatch.schemaVersion === CURRENT_TASK_SCHEMA_VERSION
        ? TURN_FIELDS
        : dispatch.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION
          ? SCHEMA_9_TURN_FIELDS
          : LEGACY_TURN_FIELDS,
      turnName,
    );
    const rawTurnId = optionalString(turn.turnId, `${turnName}.turnId`, { maxLength: 256 });
    const normalizedTurnId = rawTurnId === null
      ? null
      : normalizeTurnRef(rawTurnId, `${turnName}.turnId`);
    return {
      turnRef: dispatch.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION
        ? normalizeTurnRef(turn.turnRef, `${turnName}.turnRef`)
        : normalizedTurnId,
      turnId: normalizedTurnId,
      requestSummary: optionalString(turn.requestSummary, `${turnName}.requestSummary`, {
        maxLength: MAX_REQUEST_SUMMARY_LENGTH,
      }),
      startedAt: requireTimestamp(turn.startedAt, `${turnName}.startedAt`),
      result: normalizeTurnResult(turn.result, `${turnName}.result`),
      provenance: dispatch.schemaVersion === CURRENT_TASK_SCHEMA_VERSION
        ? normalizeTurnProvenance(turn.provenance, `${turnName}.provenance`)
        : null,
    };
  };
  let legacyResults = [];
  let turns = [];
  if (dispatch.schemaVersion >= FIRST_TURN_HISTORY_TASK_SCHEMA_VERSION) {
    if (!Array.isArray(dispatch.turns)) throw new Error(`${name}.turns must be an array`);
    turns = dispatch.turns.map((turn, index) => normalizeTurn(turn, `${name}.turns[${index}]`));
  } else if (dispatch.schemaVersion === LEGACY_RESULTS_TASK_SCHEMA_VERSION) {
    if (!Array.isArray(dispatch.results)) throw new Error(`${name}.results must be an array`);
    legacyResults = dispatch.results.map((result, index) => (
      normalizeResult(result, `${name}.results[${index}]`)
    ));
  } else if (dispatch.schemaVersion === 5) {
    if (dispatch.lastResult !== null) {
      legacyResults = [normalizeResult(dispatch.lastResult, `${name}.lastResult`)];
    }
  } else if (RESULT_STATUSES.has(status)) {
    legacyResults = [{ status, summary, turnId, updatedAt }];
  }
  if (dispatch.schemaVersion < FIRST_TURN_HISTORY_TASK_SCHEMA_VERSION) {
    turns = legacyResults.map((result) => ({
      turnRef: result.turnId,
      turnId: result.turnId,
      requestSummary: null,
      startedAt: result.updatedAt,
      result: {
        status: result.status,
        summary: result.summary,
        updatedAt: result.updatedAt,
      },
      provenance: null,
    }));
    if (
      status === "working"
      && turnId !== null
      && (
        turns.at(-1)?.turnId !== turnId
        || turns.at(-1)?.result !== null
      )
    ) {
      turns.push({
        turnRef: turnId,
        turnId,
        requestSummary: null,
        startedAt: updatedAt,
        result: null,
        provenance: null,
      });
    }
  }
  const results = turns.flatMap((turn) => (
    turn.result === null || !RESULT_STATUSES.has(turn.result.status)
  ) ? [] : [{
    ...turn.result,
    turnRef: turn.turnRef,
    turnId: turn.turnId,
    ...(turn.provenance?.kind === "dashboard_manual"
      ? { provenance: turn.provenance }
      : {}),
  }]);
  const lastResult = results.at(-1) ?? null;
  const latestTurn = turns.at(-1) ?? null;
  const normalized = {
    schemaVersion: dispatch.schemaVersion,
    id,
    project,
    title: requireString(dispatch.title, `${name}.title`).trim(),
    instruction: requireString(dispatch.instruction, `${name}.instruction`),
    threadId: dispatch.threadId === null
      ? null
      : normalizeDurableThreadId(dispatch.threadId, `${name}.threadId`),
    createdAt: requireTimestamp(dispatch.createdAt, `${name}.createdAt`),
    status,
    summary,
    turnRef: dispatch.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION
      ? storedTurnRef
      : turns.at(-1)?.turnRef ?? null,
    turnId,
    updatedAt,
    updatedBy: requireEnum(dispatch.updatedBy, TASK_UPDATE_SOURCES, `${name}.updatedBy`),
    turns,
    latestTurn,
    results,
    lastResult,
  };
  if (normalized.updatedBy === "dashboard" && normalized.schemaVersion < CURRENT_TASK_SCHEMA_VERSION) {
    throw new Error(`${name}.updatedBy dashboard requires schema ${CURRENT_TASK_SCHEMA_VERSION}`);
  }
  if (normalized.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION) {
    if (normalized.turnId !== null && normalized.turnRef !== normalizeTurnRef(normalized.turnId)) {
      throw new Error(`${name}.turnRef must equal turnId when turnId is present`);
    }
    if (normalized.latestTurn === null) {
      if (normalized.turnRef !== null) {
        throw new Error(`${name}.turnRef must be null before the first lifecycle turn`);
      }
    } else if (normalized.turnRef !== normalized.latestTurn.turnRef) {
      throw new Error(`${name}.turnRef must match latestTurn.turnRef`);
    }
    for (const [index, turn] of normalized.turns.entries()) {
      if (turn.turnId === null) {
        turn.turnRef = normalizeExecutorTurnRef(
          turn.turnRef,
          `${name}.turns[${index}].turnRef`,
        );
      } else if (turn.turnRef !== normalizeTurnRef(turn.turnId)) {
        throw new Error(
          `${name}.turns[${index}].turnRef must equal turnId when turnId is present`,
        );
      }
    }
  }
  if (normalized.schemaVersion === CURRENT_TASK_SCHEMA_VERSION) {
    const actionIds = new Set();
    for (const [index, turn] of normalized.turns.entries()) {
      const provenance = turn.provenance;
      if (provenance.kind !== "dashboard_manual") continue;
      const turnName = `${name}.turns[${index}]`;
      const predecessor = normalized.turns[index - 1] ?? null;
      if (actionIds.has(provenance.actionId)) {
        throw new Error(`${name} has duplicate manual transition actionId: ${provenance.actionId}`);
      }
      actionIds.add(provenance.actionId);
      if (turn.turnId !== null) {
        throw new Error(`${turnName}.turnId must be null for a manual dashboard turn`);
      }
      if (provenance.expectedThreadId !== normalized.threadId) {
        throw new Error(`${turnName}.provenance.expectedThreadId must match the task threadId`);
      }
      if (provenance.expectedTurnRef !== (predecessor?.turnRef ?? null)) {
        throw new Error(`${turnName}.provenance.expectedTurnRef must match the prior turn`);
      }
      if (!canManuallyTransition(provenance.fromStatus, provenance.toStatus)) {
        throw new Error(`${turnName}.provenance describes an invalid manual transition`);
      }
      const validPriorState = provenance.fromStatus === "needs_input"
        ? predecessor?.result?.status === "needs_input"
        : provenance.fromStatus === "working"
          ? predecessor === null || predecessor.result?.status === "interrupted"
          : predecessor?.result?.status === provenance.fromStatus;
      if (!validPriorState) {
        throw new Error(`${turnName}.provenance.fromStatus does not match the prior turn`);
      }
      if (
        provenance.fromStatus === "working"
        && predecessor !== null
        && predecessor.result.updatedAt !== turn.startedAt
      ) {
        throw new Error(`${turnName} must share its timestamp with the interrupted prior turn`);
      }
      const expectedPriorTimestamp = provenance.fromStatus === "working"
        ? predecessor?.startedAt ?? null
        : predecessor.result.updatedAt;
      if (
        Date.parse(provenance.expectedUpdatedAt) < Date.parse(normalized.createdAt)
        || (
          expectedPriorTimestamp !== null
          && provenance.expectedUpdatedAt !== expectedPriorTimestamp
        )
      ) {
        throw new Error(`${turnName}.provenance.expectedUpdatedAt does not match prior state`);
      }
      if (turn.requestSummary !== manualTransitionRequestSummary(
        provenance.fromStatus,
        provenance.toStatus,
      )) {
        throw new Error(`${turnName}.requestSummary must use the manual transition summary`);
      }
      if (
        turn.result?.status !== provenance.toStatus
        || turn.result?.summary !== manualTransitionSummary(provenance.toStatus)
      ) {
        throw new Error(`${turnName}.result must match its manual transition provenance`);
      }
      if (
        turn.startedAt !== turn.result.updatedAt
        || Date.parse(turn.startedAt) < Date.parse(provenance.expectedUpdatedAt)
      ) {
        throw new Error(`${turnName} has invalid manual transition timestamps`);
      }
    }
    if (normalized.updatedBy === "dashboard") {
      if (normalized.latestTurn?.provenance?.kind !== "dashboard_manual") {
        throw new Error(`${name}.updatedBy dashboard requires a latest manual dashboard turn`);
      }
    }
    if (
      normalized.latestTurn?.provenance?.kind === "dashboard_manual"
      && normalized.updatedBy !== "dashboard"
    ) {
      throw new Error(`${name} latest manual dashboard turn requires updatedBy dashboard`);
    }
  }
  const isSelfLinkingRecord = normalized.threadId !== null
    && parseTaskChefMarker(normalized.instruction) === normalized.id;
  if (isSelfLinkingRecord) {
    if (normalized.turnId !== null) {
      normalized.turnId = normalizeCodexThreadId(normalized.turnId, `${name}.turnId`);
    }
    for (const [index, turn] of normalized.turns.entries()) {
      if (turn.turnId != null) {
        turn.turnId = normalizeCodexThreadId(
          turn.turnId,
          `${name}.turns[${index}].turnId`,
        );
      }
      if (turn.turnRef !== null) {
        turn.turnRef = normalized.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION
          ? normalizeExecutorTurnRef(turn.turnRef, `${name}.turns[${index}].turnRef`)
          : normalizeTurnRef(turn.turnRef, `${name}.turns[${index}].turnRef`);
      }
    }
    normalized.results = normalized.turns.flatMap((turn) => (
      turn.result === null || !RESULT_STATUSES.has(turn.result.status)
    ) ? [] : [{
      ...turn.result,
      turnRef: turn.turnRef,
      turnId: turn.turnId,
      ...(turn.provenance?.kind === "dashboard_manual"
        ? { provenance: turn.provenance }
        : {}),
    }]);
    normalized.lastResult = normalized.results.at(-1) ?? null;
    normalized.latestTurn = normalized.turns.at(-1) ?? null;
  }
  if (normalized.schemaVersion >= FIRST_SELF_LINKING_TASK_SCHEMA_VERSION) {
    if (normalized.threadId === null) {
      const isLinkPending = normalized.status === "working"
        && normalized.summary === null
        && normalized.turnRef === null
        && normalized.turnId === null
        && normalized.lastResult === null
        && normalized.updatedBy === "dispatcher";
      const isCreationFailure = normalized.status === "failed"
        && normalized.summary !== null
        && (
          normalized.schemaVersion < TURN_REF_TASK_SCHEMA_VERSION
          || normalized.turnRef !== null
        )
        && normalized.turnId === null
        && normalized.lastResult?.status === "failed"
        && normalized.lastResult.turnId === null
        && normalized.updatedBy === "mcp";
      const isManualTerminal = normalized.schemaVersion === CURRENT_TASK_SCHEMA_VERSION
        && RESULT_STATUSES.has(normalized.status)
        && normalized.summary !== null
        && normalized.turnId === null
        && normalized.lastResult?.status === normalized.status
        && normalized.lastResult.turnId === null
        && normalized.updatedBy === "dashboard"
        && normalized.latestTurn?.provenance?.kind === "dashboard_manual";
      if (!isLinkPending && !isCreationFailure && !isManualTerminal) {
        throw new Error(`${name} has an invalid unlinked lifecycle state`);
      }
      if ((isCreationFailure || isManualTerminal) && normalized.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION) {
        normalized.turnRef = normalizeExecutorTurnRef(normalized.turnRef, `${name}.turnRef`);
        for (const [index, turn] of normalized.turns.entries()) {
          turn.turnRef = normalizeExecutorTurnRef(
            turn.turnRef,
            `${name}.turns[${index}].turnRef`,
          );
        }
      }
    } else {
      if (RESULT_STATUSES.has(normalized.status) && normalized.turnId === null) {
        if (normalized.schemaVersion < TURN_REF_TASK_SCHEMA_VERSION) {
          throw new Error(`${name}.turnId is required for a linked semantic state`);
        }
      }
      const resultWithoutTurn = normalized.results.findIndex((result) => (
        normalized.schemaVersion < TURN_REF_TASK_SCHEMA_VERSION && result.turnId === null
      ));
      if (resultWithoutTurn !== -1) {
        throw new Error(`${name}.results[${resultWithoutTurn}].turnId is required for a linked result`);
      }
    }
  }
  if (normalized.status === "working" && normalized.summary !== null) {
    throw new Error(`${name}.summary must be null while status is working`);
  }
  if (RESULT_STATUSES.has(normalized.status) && normalized.summary === null) {
    throw new Error(`${name}.summary is required for status ${normalized.status}`);
  }
  if (normalized.schemaVersion >= 5) {
    if (RESULT_STATUSES.has(normalized.status)) {
      if (
        normalized.lastResult === null
        || normalized.lastResult.status !== normalized.status
        || normalized.lastResult.summary !== normalized.summary
        || normalized.lastResult.turnRef !== normalized.turnRef
        || normalized.lastResult.turnId !== normalized.turnId
        || normalized.lastResult.updatedAt !== normalized.updatedAt
      ) {
        throw new Error(`${name}.lastResult must match the current semantic state`);
      }
    }
    if (
      normalized.lastResult !== null
      && Date.parse(normalized.lastResult.updatedAt) < Date.parse(normalized.createdAt)
    ) {
      throw new Error(`${name}.lastResult.updatedAt must not be earlier than createdAt`);
    }
    if (
      normalized.lastResult !== null
      && Date.parse(normalized.lastResult.updatedAt) > Date.parse(normalized.updatedAt)
    ) {
      throw new Error(`${name}.lastResult.updatedAt must not be later than updatedAt`);
    }
    if (
      normalized.status === "working"
      && isSelfLinkingRecord
      && normalized.schemaVersion < TURN_REF_TASK_SCHEMA_VERSION
      && normalized.lastResult?.turnId != null
      && (normalized.turnId === null || normalized.turnId <= normalized.lastResult.turnId)
    ) {
      throw new Error(`${name}.turnId must be newer than lastResult.turnId while working`);
    }
  }
  if (
    normalized.schemaVersion >= FIRST_TURN_HISTORY_TASK_SCHEMA_VERSION
    && normalized.schemaVersion < TURN_REF_TASK_SCHEMA_VERSION
    && normalized.turnId !== normalized.turnRef
  ) {
    throw new Error(`${name}.turnId must match the latest legacy turn identity`);
  }
  if (normalized.status === "working") {
    if (normalized.turnRef === null) {
      if (normalized.turns.length !== 0) {
        throw new Error(`${name}.turns must be empty before the first working turn`);
      }
    } else if (
      normalized.latestTurn === null
      || normalized.latestTurn.turnRef !== normalized.turnRef
      || normalized.latestTurn.turnId !== normalized.turnId
      || normalized.latestTurn.result !== null
    ) {
      throw new Error(`${name}.latestTurn must match the current working turn`);
    }
  }
  if (RESULT_STATUSES.has(normalized.status)) {
    if (
      normalized.latestTurn === null
      || normalized.latestTurn.turnRef !== normalized.turnRef
      || normalized.latestTurn.turnId !== normalized.turnId
      || normalized.latestTurn.result === null
      || normalized.latestTurn.result.status !== normalized.status
      || normalized.latestTurn.result.summary !== normalized.summary
      || normalized.latestTurn.result.updatedAt !== normalized.updatedAt
    ) {
      throw new Error(`${name}.latestTurn must match the current semantic state`);
    }
  }
  const seenTurnRefs = new Set();
  let lastNativeTurnRef = null;
  for (const [index, turn] of normalized.turns.entries()) {
    const turnKey = turn.turnRef;
    const isLegacyOpaqueTurnReuse = (
      !isSelfLinkingRecord
      && index === normalized.turns.length - 1
      && index > 0
      && normalized.turns[index - 1].turnId === turn.turnId
      && normalized.turns[index - 1].turnRef === turn.turnRef
      && normalized.turns[index - 1].result !== null
    );
    if (seenTurnRefs.has(turnKey) && !isLegacyOpaqueTurnReuse) {
      throw new Error(`${name}.turns contains duplicate turnRef: ${turn.turnRef ?? "null"}`);
    }
    seenTurnRefs.add(turnKey);
    if (Date.parse(turn.startedAt) < Date.parse(normalized.createdAt)) {
      throw new Error(`${name}.turns[${index}].startedAt must not be earlier than createdAt`);
    }
    if (Date.parse(turn.startedAt) > Date.parse(normalized.updatedAt)) {
      throw new Error(`${name}.turns[${index}].startedAt must not be later than updatedAt`);
    }
    if (
      index > 0
      && Date.parse(turn.startedAt) < Date.parse(normalized.turns[index - 1].startedAt)
    ) {
      throw new Error(`${name}.turns must be ordered by startedAt`);
    }
    if (
      normalized.schemaVersion < TURN_REF_TASK_SCHEMA_VERSION
      && isSelfLinkingRecord
      && index > 0
      && turn.turnId <= normalized.turns[index - 1].turnId
    ) {
      throw new Error(`${name}.turns must be ordered by turnId`);
    }
    if (
      normalized.schemaVersion >= TURN_REF_TASK_SCHEMA_VERSION
      && isSelfLinkingRecord
      && turn.turnId !== null
    ) {
      if (lastNativeTurnRef !== null && turn.turnRef <= lastNativeTurnRef) {
        throw new Error(`${name}.native-backed turnRefs must be strictly increasing`);
      }
      lastNativeTurnRef = turn.turnRef;
    }
    if (turn.result !== null) {
      if (Date.parse(turn.result.updatedAt) < Date.parse(turn.startedAt)) {
        throw new Error(`${name}.turns[${index}].result.updatedAt must not be earlier than startedAt`);
      }
      if (Date.parse(turn.result.updatedAt) > Date.parse(normalized.updatedAt)) {
        throw new Error(`${name}.turns[${index}].result.updatedAt must not be later than updatedAt`);
      }
    } else if (index !== normalized.turns.length - 1) {
      throw new Error(`${name}.turns may contain an unfinished turn only at the end`);
    }
  }
  if (
    Date.parse(normalized.updatedAt) < Date.parse(normalized.createdAt)
  ) {
    throw new Error(`${name}.updatedAt must not be earlier than createdAt`);
  }
  if (
    normalized.threadId === null &&
    parseTaskChefMarker(normalized.instruction) !== normalized.id
  ) {
    throw new Error(`${name} with a null threadId must contain its exact TaskChef marker`);
  }
  return normalized;
}

async function parseDispatchRecordsUnlocked(root, content) {
  await readConfig(root, { checkPaths: false });
  if (content.length > 0 && !content.endsWith("\n")) {
    throw new Error(`${DISPATCH_FILE_NAME} must end with a newline`);
  }
  const lines = content.length === 0 ? [] : content.slice(0, -1).split("\n");
  const records = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      throw new Error(`${DISPATCH_FILE_NAME} line ${index + 1} is empty`);
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${DISPATCH_FILE_NAME} line ${index + 1} is invalid JSON: ${error.message}`);
    }
    records.push({
      line,
      raw: value,
      normalized: await validateDispatchShape(value, `task line ${index + 1}`),
    });
  }
  const ids = new Set();
  const threadIds = new Set();
  const manualActionIds = new Set();
  for (const { normalized: dispatch } of records) {
    if (ids.has(dispatch.id)) throw new Error(`duplicate task ID: ${dispatch.id}`);
    const threadKey = dispatch.threadId === null ? null : threadIdentityKey(dispatch.threadId);
    if (threadKey !== null && threadIds.has(threadKey)) {
      throw new Error(`duplicate task threadId: ${dispatch.threadId}`);
    }
    ids.add(dispatch.id);
    if (threadKey !== null) threadIds.add(threadKey);
    for (const turn of dispatch.turns) {
      if (turn.provenance?.kind !== "dashboard_manual") continue;
      if (manualActionIds.has(turn.provenance.actionId)) {
        throw new Error(`duplicate manual transition actionId: ${turn.provenance.actionId}`);
      }
      manualActionIds.add(turn.provenance.actionId);
    }
  }
  return records;
}

function threadIdentityKey(threadId) {
  try {
    return `codex:${normalizeCodexThreadId(threadId)}`;
  } catch {
    return `opaque:${threadId}`;
  }
}

async function readDispatchRecordsUnlocked(root) {
  const filePath = path.join(root, DISPATCH_FILE_NAME);
  if (!(await managedRegularFileExists(filePath))) {
    throw new Error(`task log does not exist: ${filePath}`);
  }
  return parseDispatchRecordsUnlocked(root, await readFile(filePath, "utf8"));
}

async function readDispatchesUnlocked(root) {
  return (await readDispatchRecordsUnlocked(root)).map((record) => record.normalized);
}

export async function listTasks(workspaceRoot) {
  const root = await realpath(path.resolve(workspaceRoot));
  return readDispatchesUnlocked(root);
}

export async function parseTaskLogContent(workspaceRoot, content) {
  const root = await realpath(path.resolve(workspaceRoot));
  if (typeof content !== "string") throw new Error("task log content must be a string");
  return (await parseDispatchRecordsUnlocked(root, content)).map((record) => record.normalized);
}

function currentSchemaTask(dispatch, patch = {}) {
  const {
    latestTurn: _latestTurn,
    results: _results,
    lastResult: _lastResult,
    ...persisted
  } = dispatch;
  const sourceTurns = patch.turns ?? dispatch.turns ?? [];
  const turns = sourceTurns.map((turn) => ({
    ...turn,
    provenance: turn.provenance ?? { kind: "legacy" },
    turnRef: turn.turnRef === null || turn.turnRef === undefined
      ? (turn.turnId === null || turn.turnId === undefined ? randomUUID() : turn.turnId)
      : turn.turnRef,
  }));
  const latestTurn = turns.at(-1) ?? null;
  return {
    ...persisted,
    schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
    ...patch,
    turnRef: "turnRef" in patch ? patch.turnRef : latestTurn?.turnRef ?? null,
    turns,
  };
}

export async function migrateTaskLog(workspaceRoot, {
  now = () => new Date().toISOString(),
  writeTaskLog = writeTextAtomic,
} = {}) {
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const dispatchPath = path.join(root, DISPATCH_FILE_NAME);
    if (!(await managedRegularFileExists(dispatchPath))) {
      throw new Error(`task log does not exist: ${dispatchPath}`);
    }
    const original = await readFile(dispatchPath, "utf8");
    const records = await parseDispatchRecordsUnlocked(root, original);
    const migratedCount = records.filter(
      (record) => record.raw.schemaVersion !== CURRENT_TASK_SCHEMA_VERSION,
    ).length;
    if (migratedCount === 0) {
      const turnCount = records.reduce((count, record) => count + record.normalized.turns.length, 0);
      return {
        schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
        action: "unchanged",
        taskCount: records.length,
        turnCount,
        migratedCount: 0,
        nativeTurnRefCount: records.reduce((count, record) => count + record.normalized.turns.filter(
          (turn) => turn.turnId !== null && turn.turnRef === turn.turnId,
        ).length, 0),
        fallbackTurnRefCount: records.reduce((count, record) => count + record.normalized.turns.filter(
          (turn) => turn.turnId === null,
        ).length, 0),
        backupPath: null,
      };
    }
    const beforeTurnCount = records.reduce((count, record) => count + record.normalized.turns.length, 0);
    const migratedTasks = records.map((record) => currentSchemaTask(record.normalized));
    const lines = migratedTasks.map((task) => JSON.stringify(task));
    const migrated = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    const validated = await parseDispatchRecordsUnlocked(root, migrated);
    const afterTurnCount = validated.reduce((count, record) => count + record.normalized.turns.length, 0);
    if (validated.length !== records.length || afterTurnCount !== beforeTurnCount) {
      throw new Error("task log migration changed task or turn counts before replacement");
    }
    const nativeTurnRefCount = migratedTasks.reduce((count, task) => count + task.turns.filter(
      (turn) => turn.turnId !== null && turn.turnRef === turn.turnId,
    ).length, 0);
    const fallbackTurnRefCount = migratedTasks.reduce((count, task) => count + task.turns.filter(
      (turn) => turn.turnId === null,
    ).length, 0);
    const timestamp = requireTimestamp(now(), "migration timestamp")
      .replaceAll(":", "-")
      .replaceAll(".", "-");
    const backupPath = `${dispatchPath}.pre-v10-${timestamp}-${randomUUID()}.bak`;
    await writeFile(backupPath, original, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (await readFile(backupPath, "utf8") !== original) {
      throw new Error(`task log backup validation failed: ${backupPath}`);
    }
    try {
      await writeTaskLog(dispatchPath, migrated);
      await parseDispatchRecordsUnlocked(root, await readFile(dispatchPath, "utf8"));
    } catch (error) {
      throw new Error(
        `task log migration failed after recovery backup ${backupPath}: ${error.message}`,
        { cause: error },
      );
    }
    return {
      schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
      action: "migrated",
      taskCount: records.length,
      turnCount: afterTurnCount,
      migratedCount,
      nativeTurnRefCount,
      fallbackTurnRefCount,
      backupPath,
    };
  });
}

export async function recordTask(workspaceRoot, input, { now } = {}) {
  requireExactFields(input, RECORD_DISPATCH_FIELDS, "task input");
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const config = await readConfig(root);
    const projectPath = await canonicalDirectory(input.project);
    const project = config.projects.find((candidate) => candidate.path === projectPath);
    if (!project) throw new Error(`project is not configured in taskchef.json: ${projectPath}`);
    const createdAt = now ?? new Date().toISOString();
    const dispatch = await validateDispatchShape({
      schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
      id: input.id,
      project,
      title: input.title,
      instruction: input.instruction,
      threadId: input.threadId,
      createdAt,
      status: "working",
      summary: null,
      turnRef: null,
      turnId: null,
      updatedAt: createdAt,
      updatedBy: "dispatcher",
      turns: [],
    });
    const existing = await readDispatchesUnlocked(root);
    if (existing.some((item) => item.id === dispatch.id)) {
      throw new Error(`task already exists: ${dispatch.id}`);
    }
    if (
      dispatch.threadId !== null &&
      existing.some((item) => (
        item.threadId !== null
        && threadIdentityKey(item.threadId) === threadIdentityKey(dispatch.threadId)
      ))
    ) {
      throw new Error(`threadId is already recorded: ${dispatch.threadId}`);
    }
    if (
      dispatch.threadId !== null
      && parseTaskChefMarker(dispatch.instruction) === dispatch.id
    ) {
      throw new Error("a marked self-linking task must be recorded with threadId: null");
    }
    await appendDispatchesAtomic(root, [dispatch]);
    return dispatch;
  });
}

export async function linkTask(workspaceRoot, taskId, threadId, { now } = {}) {
  const id = requireSafeId(taskId, "taskId");
  const durableThreadId = normalizeCodexThreadId(threadId);
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const records = await readDispatchRecordsUnlocked(root);
    const dispatches = records.map((record) => record.normalized);
    const index = dispatches.findIndex((dispatch) => dispatch.id === id);
    if (index === -1) throw new Error(`task not found: ${id}`);
    const dispatch = dispatches[index];
    const sameIdentity = dispatch.threadId?.toLowerCase() === durableThreadId;
    if (sameIdentity && dispatch.updatedBy === "mcp") {
      if (parseTaskChefMarker(dispatch.instruction) !== dispatch.id) {
        throw new Error(`task instruction does not contain its exact TaskChef marker: ${id}`);
      }
      if (dispatch.threadId === durableThreadId) return dispatch;
      const canonical = await validateDispatchShape(currentSchemaTask(dispatch, {
        threadId: durableThreadId,
        updatedAt: transitionTimestamp(now, dispatch.updatedAt),
        updatedBy: "mcp",
      }));
      const lines = records.map((record, recordIndex) => recordIndex === index
        ? dispatchLineWithState(canonical, {})
        : record.line);
      await writeDispatchLinesAtomic(root, lines);
      return canonical;
    }
    if (dispatch.threadId !== null && dispatch.updatedBy === "mcp") {
      throw new Error(`task already has a different threadId: ${id}`);
    }
    if (
      dispatch.threadId !== null
      || dispatch.status !== "working"
      || dispatch.updatedBy !== "dispatcher"
    ) {
      throw new Error(`task is not an eligible link-pending dispatcher record: ${id}`);
    }
    if (parseTaskChefMarker(dispatch.instruction) !== dispatch.id) {
      throw new Error(`task instruction does not contain its exact TaskChef marker: ${id}`);
    }
    if (dispatches.some((item) => (
      item.id !== id && item.threadId?.toLowerCase() === durableThreadId
    ))) {
      throw new Error(`threadId is already recorded: ${durableThreadId}`);
    }
    const linked = await validateDispatchShape(currentSchemaTask(dispatch, {
      threadId: durableThreadId,
      updatedAt: transitionTimestamp(now, dispatch.updatedAt),
      updatedBy: "mcp",
    }));
    const lines = records.map((record, recordIndex) => recordIndex === index
      ? dispatchLineWithState(linked, {})
      : record.line);
    await writeDispatchLinesAtomic(root, lines);
    return linked;
  });
}

function dispatchLineWithState(dispatch, patch) {
  return JSON.stringify(currentSchemaTask(dispatch, patch));
}

function normalizeTaskStateInput(input, { allowWorking }) {
  const fields = new Set([
    "taskId", "threadId", "turnRef", "turnId", "status", "summary", "requestSummary",
  ]);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("task state must be an object");
  }
  const unexpected = Object.keys(input).find((key) => !fields.has(key));
  if (unexpected) throw new Error(`task state has unsupported field: ${unexpected}`);
  for (const field of ["taskId", "threadId", "turnId", "status"]) {
    if (!(field in input)) throw new Error(`task state is missing field: ${field}`);
  }
  const id = requireSafeId(input.taskId, "taskId");
  const threadId = input.threadId === null
    ? null
    : normalizeDurableThreadId(input.threadId, "threadId");
  const rawTurnId = optionalString(input.turnId, "turnId", { maxLength: 256 });
  const turnId = rawTurnId === null ? null : normalizeTurnRef(rawTurnId, "turnId");
  const turnRefInput = "turnRef" in input ? input.turnRef : turnId;
  const turnRef = turnRefInput === null ? null : normalizeTurnRef(turnRefInput);
  if (turnId !== null && turnRef !== normalizeTurnRef(turnId, "turnId as turnRef")) {
    throw new Error("turnRef must equal turnId when turnId is present");
  }
  const status = requireEnum(
    input.status,
    allowWorking ? TASK_STATUSES : RESULT_STATUSES,
    "status",
  );
  const summary = optionalString("summary" in input ? input.summary : null, "summary", {
    maxLength: MAX_RESULT_SUMMARY_LENGTH,
  });
  const requestSummary = optionalString(
    "requestSummary" in input ? input.requestSummary : null,
    "requestSummary",
    { maxLength: MAX_REQUEST_SUMMARY_LENGTH },
  );
  if (status === "working" && summary !== null) {
    throw new Error("summary must be null while status is working");
  }
  if (status !== "working" && summary === null) {
    throw new Error(`summary is required for status ${status}`);
  }
  if (status !== "working" && requestSummary !== null) {
    throw new Error(`requestSummary is accepted only for status working`);
  }
  return { id, threadId, turnRef, turnId, status, summary, requestSummary };
}

function manualTransitionSummary(status) {
  return `Manually marked ${status} from the TaskChef dashboard.`;
}

function manualTransitionRequestSummary(fromStatus, toStatus) {
  return `Manual dashboard transition from ${fromStatus} to ${toStatus}.`;
}

function canManuallyTransition(fromStatus, toStatus) {
  if (!MANUAL_TRANSITION_STATUSES.has(fromStatus) || !MANUAL_TARGET_STATUSES.has(toStatus)) {
    return false;
  }
  return ["working", "needs_input"].includes(fromStatus) || fromStatus !== toStatus;
}

function taskOperationError(code, message, task = null) {
  const error = new Error(message);
  error.code = code;
  error.task = task;
  return error;
}

function normalizeManualTransitionInput(input) {
  requireExactFields(input, MANUAL_TRANSITION_FIELDS, "manual transition");
  requireExactFields(input.expected, MANUAL_EXPECTED_FIELDS, "manual transition.expected");
  const expectedTurnRef = input.expected.turnRef === null
    ? null
    : normalizeTurnRef(input.expected.turnRef, "manual transition.expected.turnRef");
  const expectedThreadId = input.expected.threadId === null
    ? null
    : normalizeDurableThreadId(
      input.expected.threadId,
      "manual transition.expected.threadId",
    );
  return {
    actionId: normalizeExecutorTurnRef(input.actionId, "manual transition.actionId"),
    expected: {
      status: requireEnum(
        input.expected.status,
        TASK_STATUSES,
        "manual transition.expected.status",
      ),
      turnRef: expectedTurnRef,
      threadId: expectedThreadId,
      updatedAt: requireTimestamp(
        input.expected.updatedAt,
        "manual transition.expected.updatedAt",
      ),
    },
    targetStatus: requireEnum(
      input.targetStatus,
      MANUAL_TARGET_STATUSES,
      "manual transition.targetStatus",
    ),
  };
}

function sameManualAction(provenance, input) {
  return provenance.fromStatus === input.expected.status
    && provenance.toStatus === input.targetStatus
    && provenance.expectedTurnRef === input.expected.turnRef
    && provenance.expectedThreadId === input.expected.threadId
    && provenance.expectedUpdatedAt === input.expected.updatedAt;
}

function sameLastResult(lastResult, { status, summary, turnRef, turnId }) {
  return lastResult !== null
    && lastResult.status === status
    && lastResult.summary === summary
    && lastResult.turnRef === turnRef
    && lastResult.turnId === turnId;
}

async function reportTaskStateInternal(
  workspaceRoot,
  input,
  { now, compatibilityAlias = false } = {},
) {
  const turnRefWasProvided = input !== null
    && typeof input === "object"
    && Object.prototype.hasOwnProperty.call(input, "turnRef");
  const { id, threadId, turnRef, turnId, status, summary, requestSummary } = normalizeTaskStateInput(input, {
    allowWorking: !compatibilityAlias,
  });
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const records = await readDispatchRecordsUnlocked(root);
    const dispatches = records.map((record) => record.normalized);
    const index = dispatches.findIndex((dispatch) => dispatch.id === id);
    if (index === -1) throw new Error(`task not found: ${id}`);
    const dispatch = dispatches[index];
    const isSelfLinkingJourney = (
      dispatch.threadId !== null
      && parseTaskChefMarker(dispatch.instruction) === dispatch.id
    );
    if (
      !compatibilityAlias
      && dispatch.threadId !== null
      && !isSelfLinkingJourney
    ) {
      throw new Error(`report_state accepts only self-linked task records: ${id}`);
    }
    let stateTurnRef = turnRef;
    let stateTurnId = turnId;
    if (isSelfLinkingJourney) {
      if (dispatch.updatedBy === "dispatcher") {
        throw new Error(`self-linking task must link before reporting a result: ${id}`);
      }
      stateTurnId = turnId === null ? null : normalizeCodexThreadId(turnId, "turnId");
      stateTurnRef = normalizeExecutorTurnRef(turnRef, "turnRef");
    }
    if (dispatch.threadId === null) {
      const rawSchemaVersion = records[index].raw.schemaVersion;
      const hasCurrentMarker = rawSchemaVersion
        >= FIRST_SELF_LINKING_TASK_SCHEMA_VERSION
        && parseTaskChefMarker(dispatch.instruction) === dispatch.id;
      const isIdenticalOmittedRefCreationFailureRetry = !turnRefWasProvided
        && hasCurrentMarker
        && threadId === null
        && dispatch.status === "failed"
        && dispatch.turnId === null
        && dispatch.updatedBy === "mcp"
        && dispatch.lastResult?.status === status
        && dispatch.lastResult?.summary === summary
        && dispatch.lastResult?.turnId === null;
      if (isIdenticalOmittedRefCreationFailureRetry) return dispatch;
      if (stateTurnRef !== null) {
        stateTurnRef = normalizeExecutorTurnRef(stateTurnRef, "turnRef");
      }
      if (threadId !== null || stateTurnId !== null || stateTurnRef === null || status !== "failed") {
        throw new Error(`task without a durable threadId accepts only failed with a turnRef and null thread/turn IDs: ${id}`);
      }
      const isFreshCreationFailure = hasCurrentMarker
        && dispatch.status === "working"
        && dispatch.turnRef === null
        && dispatch.lastResult === null
        && dispatch.updatedBy === "dispatcher";
      const isIdenticalCreationFailureRetry = hasCurrentMarker
        && dispatch.status === "failed"
        && dispatch.turnRef === stateTurnRef
        && dispatch.updatedBy === "mcp"
        && sameLastResult(dispatch.lastResult, {
          status,
          summary,
          turnRef: stateTurnRef,
          turnId: stateTurnId,
        });
      if (!isFreshCreationFailure && !isIdenticalCreationFailureRetry) {
        throw new Error(`report_state unlinked failure requires a fresh link-pending task: ${id}`);
      }
    } else {
      if (threadIdentityKey(threadId) !== threadIdentityKey(dispatch.threadId)) {
        throw new Error(`task result threadId does not match recorded threadId: ${id}`);
      }
      if (stateTurnRef === null) {
        throw new Error(`task state turnRef is required for a linked task: ${id}`);
      }
    }
    if (status === "working") {
      const sameWorkingTurn = dispatch.status === "working" && stateTurnRef === dispatch.turnRef;
      const recordedTurn = dispatch.turns.findLast((turn) => turn.turnRef === stateTurnRef);
      if (!sameWorkingTurn && recordedTurn) {
        throw new Error(`working turnRef is stale: ${id}`);
      }
      const latestNativeTurnRef = isSelfLinkingJourney && stateTurnId !== null
        ? dispatch.turns.reduce((latest, turn) => (
          turn.turnId !== null && (latest === null || turn.turnRef > latest)
            ? turn.turnRef
            : latest
        ), null)
        : null;
      if (
        !sameWorkingTurn
        && latestNativeTurnRef !== null
        && stateTurnRef <= latestNativeTurnRef
      ) {
        throw new Error(`working native turnRef is stale: ${id}`);
      }
      if (sameWorkingTurn) {
        if (dispatch.turnId !== stateTurnId) {
          throw new Error(`working turnRef already has different Codex turn metadata: ${id}`);
        }
        const storedRequest = dispatch.latestTurn?.requestSummary ?? null;
        if (
          requestSummary !== null
          && storedRequest !== null
          && requestSummary !== storedRequest
        ) {
          throw new Error(`working turn already has a different requestSummary: ${id}`);
        }
        if (
          records[index].raw.schemaVersion === CURRENT_TASK_SCHEMA_VERSION
          && (requestSummary === null || storedRequest === requestSummary)
        ) {
          return dispatch;
        }
      }
      const updatedAt = sameWorkingTurn
        ? dispatch.updatedAt
        : transitionTimestamp(now, dispatch.updatedAt);
      const recoveredTurns = (
        !sameWorkingTurn
        && dispatch.status === "working"
        && dispatch.latestTurn?.result === null
      )
        ? dispatch.turns.map((turn, turnIndex) => turnIndex === dispatch.turns.length - 1
          ? {
            ...turn,
            result: {
              status: "interrupted",
              summary: INTERRUPTED_TURN_SUMMARY,
              updatedAt,
            },
          }
          : turn)
        : dispatch.turns;
      const turns = sameWorkingTurn
        ? dispatch.turns.map((turn, turnIndex) => turnIndex === dispatch.turns.length - 1
          ? { ...turn, requestSummary: turn.requestSummary ?? requestSummary }
          : turn)
        : [...recoveredTurns, {
          turnRef: stateTurnRef,
          turnId: stateTurnId,
          requestSummary,
          startedAt: updatedAt,
          result: null,
          provenance: { kind: "mcp" },
        }];
      const updated = await validateDispatchShape(currentSchemaTask(dispatch, {
        status,
        summary: null,
        turnRef: stateTurnRef,
        turnId: stateTurnId,
        updatedAt,
        updatedBy: "mcp",
        turns,
      }));
      const lines = records.map((record, recordIndex) => recordIndex === index
        ? dispatchLineWithState(updated, {})
        : record.line);
      await writeDispatchLinesAtomic(root, lines);
      return updated;
    }
    const priorTurn = dispatch.turns.findLast((turn) => turn.turnRef === stateTurnRef);
    const priorTurnResult = priorTurn?.result === null || priorTurn === undefined
      ? null
      : { ...priorTurn.result, turnRef: priorTurn.turnRef, turnId: priorTurn.turnId };
    if (priorTurnResult && sameLastResult(priorTurnResult, {
      status, summary, turnRef: stateTurnRef, turnId: stateTurnId,
    })) {
      if (dispatch.turnRef === stateTurnRef) return dispatch;
      throw new Error(`task result turnRef is stale: ${id}`);
    }
    if (priorTurnResult || (dispatch.turnRef === stateTurnRef && dispatch.status !== "working")) {
      throw new Error(`task turn already has a different semantic result: ${id}`);
    }
    if (compatibilityAlias) {
      const matchesWorkingTurn = dispatch.status === "working"
        && dispatch.turnRef === stateTurnRef;
      if (!matchesWorkingTurn && dispatch.turns.some((turn) => turn.turnRef === stateTurnRef)) {
        throw new Error(`task result turnRef is stale: ${id}`);
      }
    } else if (
      dispatch.threadId !== null
      && (dispatch.status !== "working" || dispatch.turnRef !== stateTurnRef)
    ) {
      throw new Error(`task result must match the current working turnRef: ${id}`);
    }
    const updatedAt = transitionTimestamp(now, dispatch.updatedAt);
    const turnResult = { status, summary, updatedAt };
    const currentTurnIndex = dispatch.turns.findLastIndex(
      (turn) => turn.turnRef === stateTurnRef,
    );
    let turns;
    if (currentTurnIndex === -1) {
      turns = [...dispatch.turns, {
        turnRef: stateTurnRef,
        turnId: stateTurnId,
        requestSummary: null,
        startedAt: updatedAt,
        result: turnResult,
        provenance: { kind: "mcp" },
      }];
    } else {
      turns = dispatch.turns.map((turn, turnIndex) => turnIndex === currentTurnIndex
        ? { ...turn, result: turnResult }
        : turn);
    }
    const candidate = currentSchemaTask(dispatch, {
      status,
      summary,
      turnRef: stateTurnRef,
      turnId: stateTurnId,
      updatedAt,
      updatedBy: "mcp",
      turns,
    });
    const updated = await validateDispatchShape(candidate);
    const lines = records.map((record, recordIndex) => recordIndex === index
      ? dispatchLineWithState(updated, {})
      : record.line);
    await writeDispatchLinesAtomic(root, lines);
    return updated;
  });
}

export async function reportTaskState(workspaceRoot, input, { now } = {}) {
  return reportTaskStateInternal(workspaceRoot, input, { now });
}

export async function reportTaskResult(workspaceRoot, input, options = {}) {
  return reportTaskStateInternal(workspaceRoot, input, {
    ...options,
    compatibilityAlias: true,
  });
}

export async function manuallyTransitionTask(
  workspaceRoot,
  taskId,
  input,
  { now, writeTaskLines = writeDispatchLinesAtomic } = {},
) {
  const id = requireSafeId(taskId, "taskId");
  let normalizedInput;
  try {
    normalizedInput = normalizeManualTransitionInput(input);
  } catch {
    throw taskOperationError("invalid_request", "manual transition request is invalid");
  }
  const root = await realpath(path.resolve(workspaceRoot));
  return withWorkspaceLock(root, async () => {
    const records = await readDispatchRecordsUnlocked(root);
    const dispatches = records.map((record) => record.normalized);
    const index = dispatches.findIndex((dispatch) => dispatch.id === id);
    if (index === -1) {
      throw taskOperationError("task_not_found", `task not found: ${id}`);
    }
    const actionOwner = dispatches.find((dispatch) => dispatch.turns.some((turn) => (
      turn.provenance?.kind === "dashboard_manual"
      && turn.provenance.actionId === normalizedInput.actionId
    )));
    if (actionOwner) {
      const manualTurn = actionOwner.turns.find((turn) => (
        turn.provenance?.kind === "dashboard_manual"
        && turn.provenance.actionId === normalizedInput.actionId
      ));
      if (actionOwner.id !== id || !sameManualAction(manualTurn.provenance, normalizedInput)) {
        throw taskOperationError(
          "idempotency_conflict",
          `manual transition actionId is already used: ${normalizedInput.actionId}`,
          dispatches[index],
        );
      }
      return { task: dispatches[index], idempotent: true };
    }

    const dispatch = dispatches[index];
    if (!canManuallyTransition(dispatch.status, normalizedInput.targetStatus)) {
      throw taskOperationError(
        "invalid_transition",
        `task status cannot be changed manually from ${dispatch.status}: ${id}`,
        dispatch,
      );
    }
    const expected = normalizedInput.expected;
    if (
      dispatch.status !== expected.status
      || dispatch.turnRef !== expected.turnRef
      || dispatch.threadId !== expected.threadId
      || dispatch.updatedAt !== expected.updatedAt
    ) {
      throw taskOperationError(
        "stale_task",
        `task changed after the dashboard loaded it: ${id}`,
        dispatch,
      );
    }

    const updatedAt = transitionTimestamp(now, dispatch.updatedAt);
    const interruptedTurns = (
      dispatch.status === "working"
      && dispatch.latestTurn?.result === null
    )
      ? dispatch.turns.map((turn, turnIndex) => turnIndex === dispatch.turns.length - 1
        ? {
          ...turn,
          result: {
            status: "interrupted",
            summary: INTERRUPTED_TURN_SUMMARY,
            updatedAt,
          },
        }
        : turn)
      : dispatch.turns;
    const turnRef = randomUUID();
    const provenance = {
      kind: "dashboard_manual",
      actionId: normalizedInput.actionId,
      fromStatus: dispatch.status,
      toStatus: normalizedInput.targetStatus,
      expectedTurnRef: expected.turnRef,
      expectedThreadId: expected.threadId,
      expectedUpdatedAt: expected.updatedAt,
    };
    const summary = manualTransitionSummary(normalizedInput.targetStatus);
    const turns = [...interruptedTurns, {
      turnRef,
      turnId: null,
      requestSummary: manualTransitionRequestSummary(
        dispatch.status,
        normalizedInput.targetStatus,
      ),
      startedAt: updatedAt,
      result: {
        status: normalizedInput.targetStatus,
        summary,
        updatedAt,
      },
      provenance,
    }];
    const updated = await validateDispatchShape(currentSchemaTask(dispatch, {
      status: normalizedInput.targetStatus,
      summary,
      turnRef,
      turnId: null,
      updatedAt,
      updatedBy: "dashboard",
      turns,
    }));
    const lines = records.map((record, recordIndex) => recordIndex === index
      ? dispatchLineWithState(updated, {})
      : record.line);
    await writeTaskLines(root, lines);
    return { task: updated, idempotent: false };
  });
}

export async function readTask(workspaceRoot, taskId) {
  const id = requireSafeId(taskId, "taskId");
  const dispatch = (await listTasks(workspaceRoot)).find((item) => item.id === id);
  if (!dispatch) throw new Error(`task not found: ${id}`);
  return dispatch;
}

export async function filterTasks(workspaceRoot, { project = null } = {}) {
  const dispatches = await listTasks(workspaceRoot);
  if (project === null) return dispatches;
  const value = requireString(project, "project");
  const filtered = dispatches.filter(
    (dispatch) =>
      dispatch.project.name.toLowerCase() === value.toLowerCase() ||
      dispatch.project.path === value,
  );
  return filtered;
}

export async function buildTaskSummary(workspaceRoot) {
  const dispatches = await listTasks(workspaceRoot);
  const projectCounts = new Map();
  for (const dispatch of dispatches) {
    projectCounts.set(
      dispatch.project.name,
      (projectCounts.get(dispatch.project.name) ?? 0) + 1,
    );
  }
  return {
    schemaVersion: 1,
    taskCount: dispatches.length,
    projectCounts: Object.fromEntries(
      [...projectCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

const COPILOT_RECENT_TERMINAL_DAYS = 7;

function sortTasksByNewestUpdate(tasks) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => (
      Date.parse(right.task.updatedAt) - Date.parse(left.task.updatedAt)
      || left.index - right.index
    ))
    .map(({ task }) => task);
}

function taskBriefEntry(task) {
  const linkPending = task.threadId === null && task.status === "working";
  const creationFailure = task.threadId === null && task.status === "failed";
  const interruptedTurnCount = task.turns.filter(
    (turn) => turn.result?.status === "interrupted",
  ).length;
  let attention = null;
  let nextAction;
  if (linkPending) {
    attention = {
      kind: "link_pending",
      reason: "The executor has not linked its durable Codex task identity yet.",
    };
    nextAction = {
      kind: "wait",
      instruction: "Wait for the existing executor to self-link; recover its exact identity before proposing any continuation.",
      requiresExplicitAuthorization: false,
    };
  } else if (task.status === "needs_input") {
    attention = {
      kind: "needs_input",
      reason: task.summary,
    };
    nextAction = {
      kind: "continue_existing_task",
      instruction: "Provide the missing decision or fact in the existing executor task.",
      requiresExplicitAuthorization: true,
    };
  } else if (task.status === "failed") {
    attention = {
      kind: creationFailure ? "creation_failed" : "failed",
      reason: task.summary,
    };
    nextAction = creationFailure ? {
      kind: "inspect_creation_failure",
      instruction: "Review the creation failure before deciding whether to dispatch new work.",
      requiresExplicitAuthorization: true,
    } : {
      kind: "continue_existing_task",
      instruction: "Review the failure and authorize a focused follow-up in the existing executor task if appropriate.",
      requiresExplicitAuthorization: true,
    };
  } else if (task.status === "working") {
    nextAction = {
      kind: "wait",
      instruction: "No action is recommended while the existing executor is working.",
      requiresExplicitAuthorization: false,
    };
  } else {
    nextAction = {
      kind: "none",
      instruction: "No follow-up is required unless the user has a new request.",
      requiresExplicitAuthorization: false,
    };
  }
  return {
    id: task.id,
    title: task.title,
    project: {
      name: task.project.name,
      path: task.project.path,
    },
    threadId: task.threadId,
    state: task.status,
    summary: task.summary,
    lastOutcome: task.lastResult === null ? null : {
      status: task.lastResult.status,
      summary: task.lastResult.summary,
      turnRef: task.lastResult.turnRef,
      turnId: task.lastResult.turnId,
      updatedAt: task.lastResult.updatedAt,
    },
    requestSummary: task.latestTurn?.requestSummary ?? null,
    updatedAt: task.updatedAt,
    attention,
    nextAction: {
      ...nextAction,
      taskId: task.id,
      threadId: task.threadId,
    },
    liveCheck: {
      recommended: false,
      reason: null,
    },
    interruptedTurnCount,
  };
}

export async function buildCopilotBrief(workspaceRoot, {
  project = null,
  taskId = null,
  includeOldTerminal = false,
  now = () => new Date().toISOString(),
} = {}) {
  if (project !== null && taskId !== null) {
    throw new Error("copilot brief accepts either project or taskId, not both");
  }
  let tasks = project === null
    ? await listTasks(workspaceRoot)
    : await filterTasks(workspaceRoot, { project });
  if (taskId !== null) {
    const id = requireSafeId(taskId, "taskId");
    tasks = tasks.filter((task) => task.id === id);
    if (tasks.length === 0) throw new Error(`task not found: ${id}`);
  }
  const generatedAt = requireTimestamp(now(), "copilot brief timestamp");
  const recentCutoff = Date.parse(generatedAt)
    - COPILOT_RECENT_TERMINAL_DAYS * 24 * 60 * 60 * 1_000;
  const focused = taskId !== null || project !== null;
  const selected = [];
  let omittedTerminalCount = 0;
  for (const task of sortTasksByNewestUpdate(tasks)) {
    const terminal = task.status === "completed" || task.status === "failed";
    const oldTerminal = terminal && Date.parse(task.updatedAt) < recentCutoff;
    if (!focused && !includeOldTerminal && oldTerminal) {
      omittedTerminalCount += 1;
      continue;
    }
    selected.push(taskBriefEntry(task));
  }
  return {
    schemaVersion: 1,
    mode: "cached",
    scope: taskId !== null ? "task" : project !== null ? "project" : "overview",
    generatedAt,
    taskCount: selected.length,
    omittedTerminalCount,
    tasks: selected,
  };
}

export async function doctorWorkspace(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const checks = [];
  const check = async (name, operation) => {
    try {
      const message = await operation();
      checks.push({ name, status: "pass", message });
    } catch (error) {
      checks.push({ name, status: "fail", message: error.message });
    }
  };
  await check("configuration", async () => {
    const config = await readConfig(root);
    return `${config.projects.length} configured project(s) valid`;
  });
  await check("task-log", async () => {
    const dispatches = await listTasks(root);
    return `${dispatches.length} task record(s) valid`;
  });
  await check("instructions", async () => {
    const filePath = path.join(root, "AGENTS.md");
    const existing = await readFile(filePath, "utf8");
    const managed = await readDispatcherInstructions();
    if (mergeDispatcherInstructions(existing, managed) !== existing) {
      throw new Error("managed AGENTS.md instructions are missing or stale");
    }
    return "managed AGENTS.md instructions current";
  });
  return { workspace: root, ok: checks.every((item) => item.status === "pass"), checks };
}
