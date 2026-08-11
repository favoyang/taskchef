import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  link,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";

const execFile = promisify(execFileCallback);
const DISPATCHER_INSTRUCTIONS_URL = new URL(
  "../assets/taskchef-dispatcher-instructions.md",
  import.meta.url,
);
const DISPATCHER_INSTRUCTIONS_START = "<!-- taskchef:dispatcher-instructions:start -->";
const DISPATCHER_INSTRUCTIONS_END = "<!-- taskchef:dispatcher-instructions:end -->";
const TASKCHEF_SKILL_NAMES = [
  "taskchef-bootstrap",
  "taskchef-delegate",
  "taskchef-report",
];
const LEGACY_TASKCHEF_SKILL_NAMES = [...TASKCHEF_SKILL_NAMES, "taskchef-reconcile"];
const SKILLS_SOURCE_ROOT = fileURLToPath(new URL("../skills/", import.meta.url));
const DISPATCH_FILE_NAME = "tasks.jsonl";
const DISPATCH_LOCK_NAME = ".taskchef-dispatch.lock";
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
const DISPATCH_FIELDS = new Set([
  "schemaVersion",
  "id",
  "project",
  "title",
  "instruction",
  "threadId",
  "createdAt",
]);
const RECORD_DISPATCH_FIELDS = new Set([
  "id",
  "project",
  "title",
  "instruction",
  "threadId",
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

async function withDispatchLock(workspaceRoot, operation) {
  const dispatchPath = path.join(workspaceRoot, DISPATCH_FILE_NAME);
  const lockPath = path.join(workspaceRoot, DISPATCH_LOCK_NAME);
  const release = await lockfile.lock(dispatchPath, {
    realpath: false,
    lockfilePath: lockPath,
    stale: 5_000,
    update: 1_000,
    retries: { retries: 70, factor: 1, minTimeout: 100, maxTimeout: 100 },
  });
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
  const appended = dispatches.map((dispatch) => `${JSON.stringify(dispatch)}\n`).join("");
  await writeTextAtomic(dispatchPath, `${content}${appended}`);
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

async function findLegacySkillLinks(workspaceRoot) {
  const agentsDirectory = path.join(workspaceRoot, ".agents");
  const agentsDetails = await lstat(agentsDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (agentsDetails === null) return { agentsDirectory: null, skillsDirectory: null, links: [] };
  if (agentsDetails.isSymbolicLink() || !agentsDetails.isDirectory()) {
    return { agentsDirectory: null, skillsDirectory: null, links: [] };
  }

  const skillsDirectory = path.join(agentsDirectory, "skills");
  const skillsDetails = await lstat(skillsDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (skillsDetails === null) return { agentsDirectory, skillsDirectory, links: [] };
  if (skillsDetails.isSymbolicLink() || !skillsDetails.isDirectory()) {
    return { agentsDirectory, skillsDirectory: null, links: [] };
  }

  const links = [];
  for (const skillName of LEGACY_TASKCHEF_SKILL_NAMES) {
    const skillPath = path.join(skillsDirectory, skillName);
    const details = await lstat(skillPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (details === null) continue;
    if (!details.isSymbolicLink()) {
      throw new Error(`legacy TaskChef skill path is not a symlink: ${skillPath}`);
    }
    links.push({ name: skillName, path: skillPath });
  }
  return { agentsDirectory, skillsDirectory, links };
}

async function removeLegacySkillLinks(workspaceRoot) {
  const legacy = await findLegacySkillLinks(workspaceRoot);
  for (const link of legacy.links) await unlink(link.path);
  const removedDirectories = [];
  if (legacy.skillsDirectory && (await readdir(legacy.skillsDirectory)).length === 0) {
    await rmdir(legacy.skillsDirectory);
    removedDirectories.push(legacy.skillsDirectory);
  }
  if (legacy.agentsDirectory && (await readdir(legacy.agentsDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }))?.length === 0) {
    await rmdir(legacy.agentsDirectory);
    removedDirectories.push(legacy.agentsDirectory);
  }
  return { removed: legacy.links, removedDirectories };
}

export async function ensureWorkspaceSkills(workspaceRoot) {
  const root = await realpath(path.resolve(workspaceRoot));
  const legacySkills = await removeLegacySkillLinks(root);
  return {
    directory: null,
    skills: TASKCHEF_SKILL_NAMES.map((name) => ({
      name,
      path: path.join(SKILLS_SOURCE_ROOT, name),
      action: "provided-by-plugin",
    })),
    legacySkills,
  };
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
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const configPath = path.join(root, "taskchef.json");
  const configExists = await managedRegularFileExists(configPath);
  const config = configExists
    ? await readConfig(root, { checkPaths: false })
    : { schemaVersion: 1, projects: [] };
  const dispatchPath = path.join(root, DISPATCH_FILE_NAME);
  if (configExists && (await managedRegularFileExists(dispatchPath))) {
    await readDispatchesUnlocked(root);
  }
  const { legacySkills } = await ensureWorkspaceSkills(root);
  if (!configExists) await writeJsonAtomic(configPath, config, { exclusive: true });
  const tasks = await ensureDispatchFile(root);
  const instructions = await ensureWorkspaceInstructions(root).catch(async (error) => {
    if (!configExists) await unlink(configPath).catch(() => {});
    throw error;
  });
  return {
    workspace: root,
    config: { path: configPath, action: configExists ? "unchanged" : "created", value: config },
    tasks,
    instructions,
    legacySkills,
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
  await writeJsonAtomic(path.join(root, "taskchef.json"), config);
  return {
    mode: replace ? "replace" : "merge",
    importedCount: imported.length,
    projectCount: config.projects.length,
    projects: imported,
  };
}

export async function removeProject(workspaceRoot, name) {
  const root = path.resolve(workspaceRoot);
  const config = await readConfig(root, { checkPaths: false });
  const index = config.projects.findIndex(
    (project) => project.name.toLowerCase() === requireString(name, "project name").toLowerCase(),
  );
  if (index === -1) throw new Error(`configured project not found: ${name}`);
  const [project] = config.projects.slice(index, index + 1);
  const projects = config.projects.filter((_, projectIndex) => projectIndex !== index);
  await writeJsonAtomic(path.join(root, "taskchef.json"), { schemaVersion: 1, projects });
  return { project };
}

async function validateDispatchShape(dispatch, name = "task") {
  requireExactFields(dispatch, DISPATCH_FIELDS, name);
  if (dispatch.schemaVersion !== 1) throw new Error(`unsupported ${name} schemaVersion`);
  const id = requireSafeId(dispatch.id, `${name}.id`);
  const project = await normalizeProject(dispatch.project, 0, { checkPath: false });
  return {
    schemaVersion: 1,
    id,
    project,
    title: requireString(dispatch.title, `${name}.title`).trim(),
    instruction: requireString(dispatch.instruction, `${name}.instruction`).trim(),
    threadId: requireString(dispatch.threadId, `${name}.threadId`).trim(),
    createdAt: requireTimestamp(dispatch.createdAt, `${name}.createdAt`),
  };
}

async function readDispatchesUnlocked(root) {
  await readConfig(root, { checkPaths: false });
  const filePath = path.join(root, DISPATCH_FILE_NAME);
  if (!(await managedRegularFileExists(filePath))) {
    throw new Error(`task log does not exist: ${filePath}`);
  }
  const content = await readFile(filePath, "utf8");
  if (content.length > 0 && !content.endsWith("\n")) {
    throw new Error(`${DISPATCH_FILE_NAME} must end with a newline`);
  }
  const lines = content.length === 0 ? [] : content.slice(0, -1).split("\n");
  const dispatches = [];
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
    dispatches.push(await validateDispatchShape(value, `task line ${index + 1}`));
  }
  const ids = new Set();
  const threadIds = new Set();
  for (const dispatch of dispatches) {
    if (ids.has(dispatch.id)) throw new Error(`duplicate task ID: ${dispatch.id}`);
    if (threadIds.has(dispatch.threadId)) {
      throw new Error(`duplicate task threadId: ${dispatch.threadId}`);
    }
    ids.add(dispatch.id);
    threadIds.add(dispatch.threadId);
  }
  return dispatches;
}

export async function listTasks(workspaceRoot) {
  const root = await realpath(path.resolve(workspaceRoot));
  return readDispatchesUnlocked(root);
}

export async function recordTask(workspaceRoot, input, { now } = {}) {
  requireExactFields(input, RECORD_DISPATCH_FIELDS, "task input");
  const root = await realpath(path.resolve(workspaceRoot));
  const config = await readConfig(root);
  const projectPath = await canonicalDirectory(input.project);
  const project = config.projects.find((candidate) => candidate.path === projectPath);
  if (!project) throw new Error(`project is not configured in taskchef.json: ${projectPath}`);
  const dispatch = await validateDispatchShape({
    schemaVersion: 1,
    id: input.id,
    project,
    title: input.title,
    instruction: input.instruction,
    threadId: input.threadId,
    createdAt: now ?? new Date().toISOString(),
  });
  await withDispatchLock(root, async () => {
    const existing = await readDispatchesUnlocked(root);
    if (existing.some((item) => item.id === dispatch.id)) {
      throw new Error(`task already exists: ${dispatch.id}`);
    }
    if (existing.some((item) => item.threadId === dispatch.threadId)) {
      throw new Error(`threadId is already recorded: ${dispatch.threadId}`);
    }
    await appendDispatchesAtomic(root, [dispatch]);
  });
  return dispatch;
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
  await check("legacy-skill-links", async () => {
    const legacy = await findLegacySkillLinks(root);
    if (legacy.links.length > 0) {
      throw new Error("legacy TaskChef skill links remain; run workspace init to remove them");
    }
    return "no legacy TaskChef skill links";
  });
  return { workspace: root, ok: checks.every((item) => item.status === "pass"), checks };
}
