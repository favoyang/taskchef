import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  link,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DISPATCHER_INSTRUCTIONS_URL = new URL("../assets/AGENTS.md", import.meta.url);
const DISPATCHER_INSTRUCTIONS_START = "<!-- taskchef:dispatcher-instructions:start -->";
const DISPATCHER_INSTRUCTIONS_END = "<!-- taskchef:dispatcher-instructions:end -->";
const TASKCHEF_SKILL_NAMES = [
  "taskchef-bootstrap",
  "taskchef-delegate",
  "taskchef-reconcile",
];
const SKILLS_SOURCE_ROOT = fileURLToPath(new URL("../.agents/skills/", import.meta.url));
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const CONFIG_FIELDS = new Set(["schemaVersion", "projects"]);
const PROJECT_FIELDS = new Set([
  "name",
  "path",
  "isGitRepository",
  "githubRepo",
  "description",
]);
const PROJECT_INPUT_FIELDS = new Set(["name", "path", "githubRepo", "description"]);
const TASK_FIELDS = new Set([
  "schemaVersion",
  "id",
  "project",
  "title",
  "instruction",
  "status",
  "threadId",
  "result",
  "createdAt",
  "updatedAt",
]);
const RESULT_FIELDS = new Set(["message", "githubPRs", "githubIssues"]);
const CREATE_TASK_FIELDS = new Set(["id", "project", "title", "instruction"]);
const TASK_STATUSES = new Set(["pending", "running", "blocked", "finished"]);
const STATUS_TRANSITIONS = {
  pending: new Set(["pending", "running"]),
  running: new Set(["running", "blocked", "finished"]),
  blocked: new Set(["blocked", "running", "finished"]),
  finished: new Set(["finished", "running", "blocked"]),
};

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
      if (error.code === "ENOENT") return 0o644;
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

async function ensureSkillLink(skillsDirectory, skillName) {
  const source = path.join(SKILLS_SOURCE_ROOT, skillName);
  const destination = path.join(skillsDirectory, skillName);
  await canonicalDirectory(source);
  const details = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (details === null) {
    await symlink(source, destination, "dir");
    return { name: skillName, path: destination, action: "created" };
  }
  if (!details.isSymbolicLink()) {
    throw new Error(`TaskChef skill path exists and is not a symlink: ${destination}`);
  }
  const linked = path.resolve(path.dirname(destination), await readlink(destination));
  if (linked !== source) {
    await unlink(destination);
    await symlink(source, destination, "dir");
    return { name: skillName, path: destination, action: "updated" };
  }
  return { name: skillName, path: destination, action: "unchanged" };
}

export async function ensureWorkspaceSkills(workspaceRoot) {
  const root = await realpath(path.resolve(workspaceRoot));
  const skillsDirectory = await ensureManagedDirectory(root, ".agents", "skills");
  const skills = [];
  for (const skillName of TASKCHEF_SKILL_NAMES) {
    skills.push(await ensureSkillLink(skillsDirectory, skillName));
  }
  return { directory: skillsDirectory, skills };
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

function validateGithubRepository(value, name) {
  if (value === null) return null;
  requireString(value, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a canonical GitHub repository URL or null`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/[^/]+\/[^/]+$/.test(url.pathname) ||
    url.pathname.endsWith(".git")
  ) {
    throw new Error(`${name} must be a canonical GitHub repository URL or null`);
  }
  return value;
}

async function normalizeProject(project, index, { checkPath = true } = {}) {
  const field = `projects[${index}]`;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error(`${field} must be an object`);
  }
  const unexpected = Object.keys(project).find((key) => !PROJECT_FIELDS.has(key));
  if (unexpected) throw new Error(`${field} has unsupported field: ${unexpected}`);
  for (const required of ["name", "path", "isGitRepository", "githubRepo"]) {
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
  const githubRepo = validateGithubRepository(project.githubRepo, `${field}.githubRepo`);
  if (!project.isGitRepository && githubRepo !== null) {
    throw new Error(`${field}.githubRepo must be null for a non-Git project`);
  }
  const normalized = {
    name,
    path: projectPath,
    isGitRepository: project.isGitRepository,
    githubRepo,
  };
  if ("description" in project) {
    normalized.description = requireString(
      project.description,
      `${field}.description`,
    ).trim();
  }
  return normalized;
}

async function normalizeProjects(projects, { checkPaths = true } = {}) {
  if (!Array.isArray(projects)) throw new Error("projects must be an array");
  const normalized = [];
  for (const [index, project] of projects.entries()) {
    normalized.push(await normalizeProject(project, index, { checkPath: checkPaths }));
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
  const value = remote.trim();
  const scpMatch = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (scpMatch) return `https://github.com/${scpMatch[1]}/${scpMatch[2]}`;
  const sshMatch = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    return match ? `https://github.com/${match[1]}/${match[2]}` : null;
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
  let githubRepo = null;
  if (isGitRepository) {
    if ("githubRepo" in input) {
      githubRepo = validateGithubRepository(input.githubRepo, `${field}.githubRepo`);
    } else {
      const remote = await execFile("git", ["remote", "get-url", "origin"], {
        cwd: projectPath,
      }).then(({ stdout }) => stdout.trim()).catch((error) => {
        if (error.code === 2 && /No such remote/i.test(error.stderr ?? "")) return null;
        throw gitInspectionError("failed to inspect GitHub origin", error);
      });
      githubRepo = normalizeGithubRemote(remote);
    }
  } else if ("githubRepo" in input && input.githubRepo !== null) {
    throw new Error(`${field}.githubRepo must be null for a non-Git project`);
  }
  const project = {
    name: "name" in input
      ? requireString(input.name, `${field}.name`).trim()
      : path.basename(projectPath),
    path: projectPath,
    isGitRepository,
    githubRepo,
  };
  if ("description" in input) {
    project.description = requireString(input.description, `${field}.description`).trim();
  }
  return project;
}

export async function validateConfig(config, { checkPaths = true } = {}) {
  requireExactFields(config, CONFIG_FIELDS, "taskchef.json");
  if (config.schemaVersion !== 1) throw new Error("unsupported configuration schemaVersion");
  return {
    schemaVersion: 1,
    projects: await normalizeProjects(config.projects, { checkPaths }),
  };
}

export async function initializeWorkspace(workspaceRoot) {
  const requestedRoot = path.resolve(workspaceRoot);
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  await ensureManagedDirectory(root, "tasks");
  const configPath = path.join(root, "taskchef.json");
  const configExists = await managedRegularFileExists(configPath);
  const config = configExists
    ? await readConfig(root, { checkPaths: false })
    : { schemaVersion: 1, projects: [] };
  if (!configExists) await writeJsonAtomic(configPath, config, { exclusive: true });
  const instructions = await ensureWorkspaceInstructions(root).catch(async (error) => {
    if (!configExists) await unlink(configPath).catch(() => {});
    throw error;
  });
  const skills = await ensureWorkspaceSkills(root).catch(async (error) => {
    if (!configExists) await unlink(configPath).catch(() => {});
    throw error;
  });
  return {
    workspace: root,
    config: { path: configPath, action: configExists ? "unchanged" : "created", value: config },
    tasks: { path: path.join(root, "tasks"), action: "ready" },
    instructions,
    skills,
  };
}

export async function readConfig(workspaceRoot, { checkPaths = true } = {}) {
  const root = path.resolve(workspaceRoot);
  const configPath = path.join(root, "taskchef.json");
  if (!(await managedRegularFileExists(configPath))) {
    throw new Error(`configuration does not exist: ${configPath}`);
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  return validateConfig(config, { checkPaths });
}

export async function listProjects(workspaceRoot) {
  const config = await readConfig(workspaceRoot);
  return [...config.projects].sort((left, right) => left.name.localeCompare(right.name));
}

export async function addProject(workspaceRoot, input) {
  const root = path.resolve(workspaceRoot);
  const config = await readConfig(root);
  const project = await inspectProject(input);
  const updated = await validateConfig({
    schemaVersion: 1,
    projects: [...config.projects, project],
  });
  await writeJsonAtomic(path.join(root, "taskchef.json"), updated);
  return project;
}

export async function importProjects(workspaceRoot, inputs, { replace = false } = {}) {
  if (!Array.isArray(inputs)) throw new Error("project import must be a JSON array");
  const root = path.resolve(workspaceRoot);
  const current = await readConfig(root, { checkPaths: !replace });
  const imported = [];
  for (const [index, input] of inputs.entries()) {
    const canonicalPath = await canonicalDirectory(input?.path);
    const existing = current.projects.find((project) => project.path === canonicalPath);
    const mergedInput = { ...input, path: canonicalPath };
    if (!("name" in mergedInput) && existing) mergedInput.name = existing.name;
    if (!("description" in mergedInput) && existing?.description) {
      mergedInput.description = existing.description;
    }
    imported.push(await inspectProject(mergedInput, index));
  }
  const projects = replace ? [] : [...current.projects];
  for (const project of imported) {
    const index = projects.findIndex((existing) => existing.path === project.path);
    if (index === -1) projects.push(project);
    else projects[index] = project;
  }
  const config = await validateConfig({ schemaVersion: 1, projects });
  if (replace) {
    const currentPaths = new Set(current.projects.map((project) => project.path));
    const configuredPaths = new Set(config.projects.map((project) => project.path));
    const removedPaths = new Set(
      [...currentPaths].filter((projectPath) => !configuredPaths.has(projectPath)),
    );
    const newlyOrphaned = (await listTasks(root, { checkProjects: false })).filter(
      (task) => removedPaths.has(task.project),
    );
    if (newlyOrphaned.length > 0) {
      throw new Error(
        `replacement would orphan ${newlyOrphaned.length} task record(s); remove referenced projects with --force first`,
      );
    }
  }
  await writeJsonAtomic(path.join(root, "taskchef.json"), config);
  return {
    mode: replace ? "replace" : "merge",
    importedCount: imported.length,
    projectCount: config.projects.length,
    projects: imported,
  };
}

export async function removeProject(workspaceRoot, name, { force = false } = {}) {
  const root = path.resolve(workspaceRoot);
  const config = await readConfig(root, { checkPaths: false });
  const index = config.projects.findIndex(
    (project) => project.name.toLowerCase() === requireString(name, "project name").toLowerCase(),
  );
  if (index === -1) throw new Error(`configured project not found: ${name}`);
  const [project] = config.projects.slice(index, index + 1);
  const referenced = (await listTasks(root, { checkProjects: false })).filter(
    (task) => task.project === project.path,
  );
  if (referenced.length > 0 && !force) {
    throw new Error(
      `project is referenced by ${referenced.length} task record(s); pass --force to remove it`,
    );
  }
  const projects = config.projects.filter((_, projectIndex) => projectIndex !== index);
  await writeJsonAtomic(path.join(root, "taskchef.json"), { schemaVersion: 1, projects });
  return { project, referencedTaskCount: referenced.length };
}

function validateGithubUrl(value, kind, name) {
  requireString(value, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a canonical GitHub URL`);
  }
  const segment = kind === "pull" ? "pull" : "issues";
  const pattern = new RegExp(`^/[^/]+/[^/]+/${segment}/[1-9]\\d*$`);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !pattern.test(url.pathname)
  ) {
    throw new Error(`${name} must be a canonical GitHub ${kind} URL`);
  }
  return value;
}

export function validateResult(result) {
  if (result === null) return null;
  requireExactFields(result, RESULT_FIELDS, "result");
  requireString(result.message, "result.message");
  for (const field of ["githubPRs", "githubIssues"]) {
    if (!Array.isArray(result[field])) throw new Error(`result.${field} must be an array`);
  }
  result.githubPRs.forEach((value, index) =>
    validateGithubUrl(value, "pull", `result.githubPRs[${index}]`));
  result.githubIssues.forEach((value, index) =>
    validateGithubUrl(value, "issue", `result.githubIssues[${index}]`));
  return {
    message: result.message,
    githubPRs: [...result.githubPRs],
    githubIssues: [...result.githubIssues],
  };
}

function validateTaskShape(task) {
  requireExactFields(task, TASK_FIELDS, "task");
  if (task.schemaVersion !== 1) throw new Error("unsupported task schemaVersion");
  requireSafeId(task.id);
  requireString(task.project, "project");
  requireString(task.title, "title");
  requireString(task.instruction, "instruction");
  if (!TASK_STATUSES.has(task.status)) throw new Error(`unsupported task status: ${task.status}`);
  if (task.threadId !== null) requireString(task.threadId, "threadId");
  if (task.status === "pending" && task.threadId !== null) {
    throw new Error("a pending task must not have a threadId");
  }
  if (task.status !== "pending" && task.threadId === null) {
    throw new Error(`a ${task.status} task requires a threadId`);
  }
  validateResult(task.result);
  requireTimestamp(task.createdAt, "createdAt");
  requireTimestamp(task.updatedAt, "updatedAt");
  if (Date.parse(task.updatedAt) < Date.parse(task.createdAt)) {
    throw new Error("updatedAt must not be earlier than createdAt");
  }
  return task;
}

export async function createTask(workspaceRoot, input, { now } = {}) {
  const root = await realpath(path.resolve(workspaceRoot));
  requireExactFields(input, CREATE_TASK_FIELDS, "task creation input");
  const config = await readConfig(root);
  const id = requireSafeId(input.id);
  const project = await canonicalDirectory(input.project);
  if (!config.projects.some((configuredProject) => configuredProject.path === project)) {
    throw new Error(`project is not configured in taskchef.json: ${project}`);
  }
  const createdAt = now ?? new Date().toISOString();
  requireTimestamp(createdAt, "createdAt");
  const task = {
    schemaVersion: 1,
    id,
    project,
    title: requireString(input.title, "title"),
    instruction: requireString(input.instruction, "instruction"),
    status: "pending",
    threadId: null,
    result: null,
    createdAt,
    updatedAt: createdAt,
  };
  const tasksDirectory = await ensureManagedDirectory(root, "tasks");
  const taskDirectory = path.join(tasksDirectory, id);
  if (await lstat(taskDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  })) throw new Error(`task already exists: ${id}`);
  await mkdir(taskDirectory, { recursive: false });
  await writeJsonAtomic(path.join(taskDirectory, "task.json"), task, { exclusive: true });
  return task;
}

export async function readTask(workspaceRoot, taskId) {
  const id = requireSafeId(taskId, "taskId");
  const root = await realpath(path.resolve(workspaceRoot));
  const tasksDirectory = await ensureManagedDirectory(root, "tasks");
  const taskDirectory = path.join(tasksDirectory, id);
  const taskDirectoryDetails = await lstat(taskDirectory);
  if (taskDirectoryDetails.isSymbolicLink() || !taskDirectoryDetails.isDirectory()) {
    throw new Error(`task path is not a real directory: ${taskDirectory}`);
  }
  const filePath = path.join(taskDirectory, "task.json");
  const fileDetails = await lstat(filePath);
  if (fileDetails.isSymbolicLink() || !fileDetails.isFile()) {
    throw new Error(`task record is not a regular file: ${filePath}`);
  }
  const task = validateTaskShape(JSON.parse(await readFile(filePath, "utf8")));
  if (task.id !== id) throw new Error(`task ID does not match directory: ${id}`);
  return task;
}

export async function updateTask(workspaceRoot, taskId, patch, { now } = {}) {
  const allowed = new Set(["status", "threadId", "result"]);
  const unexpected = Object.keys(patch).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`unsupported task update field: ${unexpected}`);
  if (Object.keys(patch).length === 0) throw new Error("task update must not be empty");
  const current = await readTask(workspaceRoot, taskId);
  const status = patch.status ?? current.status;
  if (!TASK_STATUSES.has(status)) throw new Error(`unsupported task status: ${status}`);
  if (!STATUS_TRANSITIONS[current.status].has(status)) {
    throw new Error(`unsupported task transition: ${current.status} -> ${status}`);
  }
  const threadId = patch.threadId === undefined ? current.threadId : patch.threadId;
  if (threadId !== null) requireString(threadId, "threadId");
  if (current.threadId && threadId !== current.threadId) {
    throw new Error("threadId cannot be replaced once recorded");
  }
  const updated = {
    ...current,
    status,
    threadId,
    result: patch.result === undefined ? current.result : validateResult(patch.result),
    updatedAt: now ?? new Date().toISOString(),
  };
  requireTimestamp(updated.updatedAt, "updatedAt");
  if (Date.parse(updated.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("updatedAt must not move backwards");
  }
  validateTaskShape(updated);
  const filePath = path.join(path.resolve(workspaceRoot), "tasks", current.id, "task.json");
  await writeJsonAtomic(filePath, updated);
  return updated;
}

export async function listTasks(workspaceRoot, { checkProjects = true } = {}) {
  const root = await realpath(path.resolve(workspaceRoot));
  await readConfig(root, { checkPaths: checkProjects });
  const tasksDirectory = await ensureManagedDirectory(root, "tasks");
  const entries = await readdir(tasksDirectory, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error(`unexpected task entry: ${entry.name}`);
    if (!SAFE_ID.test(entry.name)) throw new Error(`invalid task directory name: ${entry.name}`);
    tasks.push(await readTask(root, entry.name));
  }
  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

export async function filterTasks(workspaceRoot, { statuses = [], project = null } = {}) {
  const config = await readConfig(workspaceRoot);
  const statusSet = new Set(statuses);
  for (const status of statusSet) {
    if (!TASK_STATUSES.has(status)) throw new Error(`unsupported task status: ${status}`);
  }
  let projectPath = null;
  if (project !== null) {
    const configured = config.projects.find(
      (candidate) => candidate.name.toLowerCase() === project.toLowerCase() || candidate.path === project,
    );
    if (!configured) throw new Error(`configured project not found: ${project}`);
    projectPath = configured.path;
  }
  return (await listTasks(workspaceRoot)).filter(
    (task) =>
      (statusSet.size === 0 || statusSet.has(task.status)) &&
      (projectPath === null || task.project === projectPath),
  );
}

export async function buildTaskSummary(workspaceRoot) {
  const tasks = await listTasks(workspaceRoot);
  return {
    schemaVersion: 1,
    taskCount: tasks.length,
    statusCounts: Object.fromEntries(
      [...TASK_STATUSES].map((status) => [status, tasks.filter((task) => task.status === status).length]),
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
  let config = null;
  await check("configuration", async () => {
    config = await readConfig(root);
    return `${config.projects.length} configured project(s) valid`;
  });
  await check("tasks-directory", async () => {
    const details = await lstat(path.join(root, "tasks"));
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error("tasks path is not a real directory");
    }
    return "tasks directory ready";
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
  for (const skillName of TASKCHEF_SKILL_NAMES) {
    await check(`skill:${skillName}`, async () => {
      const destination = path.join(root, ".agents", "skills", skillName);
      const details = await lstat(destination);
      if (!details.isSymbolicLink()) throw new Error("skill path is not a symlink");
      const linked = path.resolve(path.dirname(destination), await readlink(destination));
      const expected = path.join(SKILLS_SOURCE_ROOT, skillName);
      if (linked !== expected) throw new Error(`unexpected target: ${linked}`);
      await canonicalDirectory(expected);
      return "skill link valid";
    });
  }
  await check("task-records", async () => {
    const taskRoot = path.join(root, "tasks");
    const entries = await readdir(taskRoot, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) throw new Error(`unexpected task entry: ${entry.name}`);
      if (!SAFE_ID.test(entry.name)) throw new Error(`invalid task directory name: ${entry.name}`);
      const task = await readTask(root, entry.name);
      if (task.id !== entry.name) throw new Error(`task ID does not match directory: ${entry.name}`);
      if (config && !config.projects.some((project) => project.path === task.project)) {
        throw new Error(`task ${task.id} references an unconfigured project`);
      }
      count += 1;
    }
    return `${count} task record(s) valid`;
  });
  return { workspace: root, ok: checks.every((item) => item.status === "pass"), checks };
}

export async function buildReconciliationCandidates(
  workspaceRoot,
  { includeFinished = false } = {},
) {
  const includedStatuses = includeFinished
    ? ["running", "blocked", "finished"]
    : ["running", "blocked"];
  const includedStatusSet = new Set(includedStatuses);
  const tasks = (await listTasks(workspaceRoot)).filter(
    (task) => task.threadId !== null && includedStatusSet.has(task.status),
  );
  return {
    schemaVersion: 1,
    candidateCount: tasks.length,
    includedStatuses,
    tasks,
  };
}
