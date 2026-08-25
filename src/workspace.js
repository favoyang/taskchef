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
const CURRENT_TASK_SCHEMA_VERSION = 7;
const PREVIOUS_TASK_SCHEMA_VERSION = 6;
const FIRST_SELF_LINKING_TASK_SCHEMA_VERSION = 4;
const CONFIG_FIELDS = new Set(["schemaVersion", "projects"]);
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
const DISPATCH_FIELDS = new Set([...STATEFUL_DISPATCH_FIELDS, "turns"]);
const RECORD_DISPATCH_FIELDS = new Set([
  "id",
  "project",
  "title",
  "instruction",
  "threadId",
]);
const RESULT_STATUSES = new Set(["needs_input", "completed", "failed"]);
const TASK_STATUSES = new Set(["working", ...RESULT_STATUSES]);
const TASK_UPDATE_SOURCES = new Set(["dispatcher", "mcp"]);
const MAX_RESULT_SUMMARY_LENGTH = 2_000;
const MAX_REQUEST_SUMMARY_LENGTH = 1_000;
const RESULT_FIELDS = new Set(["status", "summary", "turnId", "updatedAt"]);
const TURN_RESULT_FIELDS = new Set(["status", "summary", "updatedAt"]);
const TURN_FIELDS = new Set(["turnId", "requestSummary", "startedAt", "result"]);

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
    .map((dispatch) => `${JSON.stringify(schema7Task(dispatch))}\n`)
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
  requireExactFields(config, CONFIG_FIELDS, "taskchef.json");
  if (config.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error("unsupported configuration schemaVersion");
  }
  return {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    projects: await normalizeProjects(config.projects, { checkPaths }),
  };
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
      : { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, projects: [] };
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
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
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
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
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
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      projects,
    });
    return { project };
  });
}

async function validateDispatchShape(dispatch, name = "task") {
  const supportedVersions = [
    FIRST_SELF_LINKING_TASK_SCHEMA_VERSION,
    5,
    PREVIOUS_TASK_SCHEMA_VERSION,
    CURRENT_TASK_SCHEMA_VERSION,
  ];
  if (!supportedVersions.includes(dispatch?.schemaVersion)) {
    throw new Error(`unsupported ${name} schemaVersion`);
  }
  requireExactFields(
    dispatch,
    dispatch.schemaVersion === CURRENT_TASK_SCHEMA_VERSION
      ? DISPATCH_FIELDS
      : dispatch.schemaVersion === PREVIOUS_TASK_SCHEMA_VERSION
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
  const turnId = optionalString(dispatch.turnId, `${name}.turnId`, { maxLength: 256 });
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
        turnId: optionalString(
          result.turnId,
          `${resultName}.turnId`,
          { maxLength: 256 },
        ),
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
      status: requireEnum(result.status, RESULT_STATUSES, `${resultName}.status`),
      summary: optionalString(result.summary, `${resultName}.summary`, {
        maxLength: MAX_RESULT_SUMMARY_LENGTH,
      }),
      updatedAt: requireTimestamp(result.updatedAt, `${resultName}.updatedAt`),
    };
    if (normalizedResult.summary === null) {
      throw new Error(`${resultName}.summary must be a non-empty string`);
    }
    return normalizedResult;
  };
  const normalizeTurn = (turn, turnName) => {
    requireExactFields(turn, TURN_FIELDS, turnName);
    return {
      turnId: optionalString(turn.turnId, `${turnName}.turnId`, { maxLength: 256 }),
      requestSummary: optionalString(turn.requestSummary, `${turnName}.requestSummary`, {
        maxLength: MAX_REQUEST_SUMMARY_LENGTH,
      }),
      startedAt: requireTimestamp(turn.startedAt, `${turnName}.startedAt`),
      result: normalizeTurnResult(turn.result, `${turnName}.result`),
    };
  };
  let legacyResults = [];
  let turns = [];
  if (dispatch.schemaVersion === CURRENT_TASK_SCHEMA_VERSION) {
    if (!Array.isArray(dispatch.turns)) throw new Error(`${name}.turns must be an array`);
    turns = dispatch.turns.map((turn, index) => normalizeTurn(turn, `${name}.turns[${index}]`));
  } else if (dispatch.schemaVersion === PREVIOUS_TASK_SCHEMA_VERSION) {
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
  if (dispatch.schemaVersion !== CURRENT_TASK_SCHEMA_VERSION) {
    turns = legacyResults.map((result) => ({
      turnId: result.turnId,
      requestSummary: null,
      startedAt: result.updatedAt,
      result: {
        status: result.status,
        summary: result.summary,
        updatedAt: result.updatedAt,
      },
    }));
    if (
      status === "working"
      && turnId !== null
      && (
        turns.at(-1)?.turnId !== turnId
        || turns.at(-1)?.result !== null
      )
    ) {
      turns.push({ turnId, requestSummary: null, startedAt: updatedAt, result: null });
    }
  }
  const results = turns.flatMap((turn) => turn.result === null ? [] : [{
    ...turn.result,
    turnId: turn.turnId,
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
    turnId,
    updatedAt,
    updatedBy: requireEnum(dispatch.updatedBy, TASK_UPDATE_SOURCES, `${name}.updatedBy`),
    turns,
    latestTurn,
    results,
    lastResult,
  };
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
    }
    normalized.results = normalized.turns.flatMap((turn) => turn.result === null ? [] : [{
      ...turn.result,
      turnId: turn.turnId,
    }]);
    normalized.lastResult = normalized.results.at(-1) ?? null;
    normalized.latestTurn = normalized.turns.at(-1) ?? null;
  }
  if (normalized.schemaVersion >= FIRST_SELF_LINKING_TASK_SCHEMA_VERSION) {
    if (normalized.threadId === null) {
      const isLinkPending = normalized.status === "working"
        && normalized.summary === null
        && normalized.turnId === null
        && normalized.lastResult === null
        && normalized.updatedBy === "dispatcher";
      const isCreationFailure = normalized.status === "failed"
        && normalized.summary !== null
        && normalized.turnId === null
        && normalized.lastResult?.status === "failed"
        && normalized.lastResult.turnId === null
        && normalized.updatedBy === "mcp";
      if (!isLinkPending && !isCreationFailure) {
        throw new Error(`${name} has an invalid unlinked lifecycle state`);
      }
    } else {
      if (RESULT_STATUSES.has(normalized.status) && normalized.turnId === null) {
        throw new Error(`${name}.turnId is required for a linked semantic state`);
      }
      const resultWithoutTurn = normalized.results.findIndex((result) => result.turnId === null);
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
      && normalized.lastResult?.turnId != null
      && (
        normalized.turnId === null
        || normalized.turnId <= normalized.lastResult.turnId
      )
    ) {
      throw new Error(`${name}.turnId must be newer than lastResult.turnId while working`);
    }
  }
  if (normalized.status === "working") {
    if (normalized.turnId === null) {
      if (normalized.turns.length !== 0) {
        throw new Error(`${name}.turns must be empty before the first working turn`);
      }
    } else if (
      normalized.latestTurn === null
      || normalized.latestTurn.turnId !== normalized.turnId
      || normalized.latestTurn.result !== null
    ) {
      throw new Error(`${name}.latestTurn must match the current working turn`);
    }
  }
  if (RESULT_STATUSES.has(normalized.status)) {
    if (
      normalized.latestTurn === null
      || normalized.latestTurn.turnId !== normalized.turnId
      || normalized.latestTurn.result === null
      || normalized.latestTurn.result.status !== normalized.status
      || normalized.latestTurn.result.summary !== normalized.summary
      || normalized.latestTurn.result.updatedAt !== normalized.updatedAt
    ) {
      throw new Error(`${name}.latestTurn must match the current semantic state`);
    }
  }
  const seenTurnIds = new Set();
  const nullTurnKey = Symbol("null turn");
  for (const [index, turn] of normalized.turns.entries()) {
    const turnKey = turn.turnId ?? nullTurnKey;
    const isLegacyOpaqueWorkingReuse = (
      !isSelfLinkingRecord
      && normalized.status === "working"
      && index === normalized.turns.length - 1
      && turn.result === null
      && index > 0
      && normalized.turns[index - 1].turnId === turn.turnId
      && normalized.turns[index - 1].result !== null
    );
    if (seenTurnIds.has(turnKey) && !isLegacyOpaqueWorkingReuse) {
      throw new Error(`${name}.turns contains duplicate turnId: ${turn.turnId ?? "null"}`);
    }
    seenTurnIds.add(turnKey);
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
      isSelfLinkingRecord
      && index > 0
      && turn.turnId <= normalized.turns[index - 1].turnId
    ) {
      throw new Error(`${name}.turns must be ordered by turnId`);
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
  for (const { normalized: dispatch } of records) {
    if (ids.has(dispatch.id)) throw new Error(`duplicate task ID: ${dispatch.id}`);
    const threadKey = dispatch.threadId === null ? null : threadIdentityKey(dispatch.threadId);
    if (threadKey !== null && threadIds.has(threadKey)) {
      throw new Error(`duplicate task threadId: ${dispatch.threadId}`);
    }
    ids.add(dispatch.id);
    if (threadKey !== null) threadIds.add(threadKey);
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

function schema7Task(dispatch, patch = {}) {
  const {
    latestTurn: _latestTurn,
    results: _results,
    lastResult: _lastResult,
    ...persisted
  } = dispatch;
  return {
    ...persisted,
    schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
    turns: dispatch.turns ?? [],
    ...patch,
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
      return {
        schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
        action: "unchanged",
        taskCount: records.length,
        migratedCount: 0,
        backupPath: null,
      };
    }
    const lines = records.map((record) => JSON.stringify(schema7Task(record.normalized)));
    const migrated = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    await parseDispatchRecordsUnlocked(root, migrated);
    const timestamp = requireTimestamp(now(), "migration timestamp")
      .replaceAll(":", "-")
      .replaceAll(".", "-");
    const backupPath = `${dispatchPath}.pre-v7-${timestamp}-${randomUUID()}.bak`;
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
      migratedCount,
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
      const canonical = await validateDispatchShape(schema7Task(dispatch, {
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
    const linked = await validateDispatchShape(schema7Task(dispatch, {
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
  return JSON.stringify(schema7Task(dispatch, patch));
}

function normalizeTaskStateInput(input, { allowWorking }) {
  const fields = new Set([
    "taskId", "threadId", "turnId", "status", "summary", "requestSummary",
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
  const turnId = optionalString(input.turnId, "turnId", { maxLength: 256 });
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
  return { id, threadId, turnId, status, summary, requestSummary };
}

function sameLastResult(lastResult, { status, summary, turnId }) {
  return lastResult !== null
    && lastResult.status === status
    && lastResult.summary === summary
    && lastResult.turnId === turnId;
}

async function reportTaskStateInternal(
  workspaceRoot,
  input,
  { now, compatibilityAlias = false } = {},
) {
  const { id, threadId, turnId, status, summary, requestSummary } = normalizeTaskStateInput(input, {
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
    let stateTurnId = turnId;
    if (isSelfLinkingJourney) {
      if (dispatch.updatedBy === "dispatcher") {
        throw new Error(`self-linking task must link before reporting a result: ${id}`);
      }
      stateTurnId = normalizeCodexThreadId(turnId, "turnId");
    }
    if (dispatch.threadId === null) {
      if (threadId !== null || stateTurnId !== null || status !== "failed") {
        throw new Error(`task without a durable threadId accepts only failed with null thread/turn IDs: ${id}`);
      }
      if (!compatibilityAlias) {
        const rawSchemaVersion = records[index].raw.schemaVersion;
        const hasCurrentMarker = rawSchemaVersion
          >= FIRST_SELF_LINKING_TASK_SCHEMA_VERSION
          && parseTaskChefMarker(dispatch.instruction) === dispatch.id;
        const isFreshCreationFailure = hasCurrentMarker
          && dispatch.status === "working"
          && dispatch.turnId === null
          && dispatch.lastResult === null
          && dispatch.updatedBy === "dispatcher";
        const isIdenticalCreationFailureRetry = hasCurrentMarker
          && dispatch.status === "failed"
          && dispatch.turnId === null
          && dispatch.updatedBy === "mcp"
          && sameLastResult(dispatch.lastResult, {
            status,
            summary,
            turnId: stateTurnId,
          });
        if (!isFreshCreationFailure && !isIdenticalCreationFailureRetry) {
          throw new Error(`report_state unlinked failure requires a fresh link-pending task: ${id}`);
        }
      }
    } else {
      if (threadIdentityKey(threadId) !== threadIdentityKey(dispatch.threadId)) {
        throw new Error(`task result threadId does not match recorded threadId: ${id}`);
      }
      if (stateTurnId === null) {
        throw new Error(`task state turnId is required for a linked task: ${id}`);
      }
    }
    if (status === "working") {
      const sameWorkingTurn = dispatch.status === "working" && stateTurnId === dispatch.turnId;
      if (sameWorkingTurn) {
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
      if (isSelfLinkingJourney) {
        if (!sameWorkingTurn && dispatch.turnId !== null && stateTurnId <= dispatch.turnId) {
          throw new Error(`working turnId must be newer than the current task turnId: ${id}`);
        }
        if (!sameWorkingTurn && dispatch.lastResult?.turnId != null && stateTurnId <= dispatch.lastResult.turnId) {
          throw new Error(`working turnId must be newer than the last result turnId: ${id}`);
        }
      }
      const updatedAt = sameWorkingTurn
        ? dispatch.updatedAt
        : transitionTimestamp(now, dispatch.updatedAt);
      const turns = sameWorkingTurn
        ? dispatch.turns.map((turn, turnIndex) => turnIndex === dispatch.turns.length - 1
          ? { ...turn, requestSummary: turn.requestSummary ?? requestSummary }
          : turn)
        : [...dispatch.turns, {
          turnId: stateTurnId,
          requestSummary,
          startedAt: updatedAt,
          result: null,
        }];
      const updated = await validateDispatchShape(schema7Task(dispatch, {
        status,
        summary: null,
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
    const priorTurn = dispatch.turns.find((turn) => turn.turnId === stateTurnId);
    const priorTurnResult = priorTurn?.result === null || priorTurn === undefined
      ? null
      : { ...priorTurn.result, turnId: priorTurn.turnId };
    if (priorTurnResult && sameLastResult(priorTurnResult, { status, summary, turnId: stateTurnId })) {
      return dispatch;
    }
    if (priorTurnResult || (dispatch.turnId === stateTurnId && dispatch.status !== "working")) {
      throw new Error(`task turn already has a different semantic result: ${id}`);
    }
    if (compatibilityAlias) {
      const matchesWorkingTurn = dispatch.status === "working"
        && dispatch.turnId === stateTurnId;
      if (!matchesWorkingTurn && isSelfLinkingJourney) {
        if (dispatch.turnId !== null && stateTurnId <= dispatch.turnId) {
          throw new Error(`task result turnId must be newer than the stored turnId: ${id}`);
        }
        if (dispatch.lastResult?.turnId != null && stateTurnId <= dispatch.lastResult.turnId) {
          throw new Error(`task result turnId must be newer than the last result turnId: ${id}`);
        }
      }
    } else if (dispatch.status !== "working" || dispatch.turnId !== stateTurnId) {
      throw new Error(`task result must match the current working turnId: ${id}`);
    }
    const updatedAt = transitionTimestamp(now, dispatch.updatedAt);
    const turnResult = { status, summary, updatedAt };
    const currentTurnIndex = dispatch.turns.findIndex((turn) => turn.turnId === stateTurnId);
    let turns;
    if (currentTurnIndex === -1) {
      turns = [...dispatch.turns, {
        turnId: stateTurnId,
        requestSummary: null,
        startedAt: updatedAt,
        result: turnResult,
      }];
    } else {
      turns = dispatch.turns.map((turn, turnIndex) => turnIndex === currentTurnIndex
        ? { ...turn, result: turnResult }
        : turn);
    }
    const candidate = schema7Task(dispatch, {
      status,
      summary,
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
