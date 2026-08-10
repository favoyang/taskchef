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
const DISPATCH_FILE_NAME = "dispatches.jsonl";
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
  const existingDispatches = configExists && (await managedRegularFileExists(dispatchPath))
    ? await readDispatchesUnlocked(root)
    : [];
  const legacyTaskRecords = await inspectLegacyTaskRecords(root, config, existingDispatches);
  const { legacySkills } = await ensureWorkspaceSkills(root);
  if (!configExists) await writeJsonAtomic(configPath, config, { exclusive: true });
  const dispatches = await ensureDispatchFile(root);
  const legacyTasks = await migrateLegacyTaskRecords(root, legacyTaskRecords);
  const instructions = await ensureWorkspaceInstructions(root).catch(async (error) => {
    if (!configExists) await unlink(configPath).catch(() => {});
    throw error;
  });
  return {
    workspace: root,
    config: { path: configPath, action: configExists ? "unchanged" : "created", value: config },
    dispatches,
    instructions,
    legacySkills,
    legacyTasks,
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

async function validateDispatchShape(dispatch, name = "dispatch") {
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
    throw new Error(`dispatch log does not exist: ${filePath}`);
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
    dispatches.push(await validateDispatchShape(value, `dispatch line ${index + 1}`));
  }
  const ids = new Set();
  const threadIds = new Set();
  for (const dispatch of dispatches) {
    if (ids.has(dispatch.id)) throw new Error(`duplicate dispatch ID: ${dispatch.id}`);
    if (threadIds.has(dispatch.threadId)) {
      throw new Error(`duplicate dispatch threadId: ${dispatch.threadId}`);
    }
    ids.add(dispatch.id);
    threadIds.add(dispatch.threadId);
  }
  return dispatches;
}

export async function readDispatches(workspaceRoot) {
  const root = await realpath(path.resolve(workspaceRoot));
  return readDispatchesUnlocked(root);
}

export async function recordDispatch(workspaceRoot, input, { now } = {}) {
  requireExactFields(input, RECORD_DISPATCH_FIELDS, "dispatch input");
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
      throw new Error(`dispatch already exists: ${dispatch.id}`);
    }
    if (existing.some((item) => item.threadId === dispatch.threadId)) {
      throw new Error(`threadId is already recorded: ${dispatch.threadId}`);
    }
    await appendDispatchesAtomic(root, [dispatch]);
  });
  return dispatch;
}

export async function readDispatch(workspaceRoot, dispatchId) {
  const id = requireSafeId(dispatchId, "dispatchId");
  const dispatch = (await readDispatches(workspaceRoot)).find((item) => item.id === id);
  if (!dispatch) throw new Error(`dispatch not found: ${id}`);
  return dispatch;
}

export async function filterDispatches(workspaceRoot, { project = null } = {}) {
  const dispatches = await readDispatches(workspaceRoot);
  if (project === null) return dispatches;
  const value = requireString(project, "project");
  const filtered = dispatches.filter(
    (dispatch) =>
      dispatch.project.name.toLowerCase() === value.toLowerCase() ||
      dispatch.project.path === value,
  );
  return filtered;
}

export async function buildDispatchSummary(workspaceRoot) {
  const dispatches = await readDispatches(workspaceRoot);
  const projectCounts = new Map();
  for (const dispatch of dispatches) {
    projectCounts.set(
      dispatch.project.name,
      (projectCounts.get(dispatch.project.name) ?? 0) + 1,
    );
  }
  return {
    schemaVersion: 1,
    dispatchCount: dispatches.length,
    projectCounts: Object.fromEntries(
      [...projectCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

const LEGACY_TASK_FIELDS = new Set([
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

function validateLegacyTask(task, taskId) {
  requireExactFields(task, LEGACY_TASK_FIELDS, `legacy task ${taskId}`);
  if (task.schemaVersion !== 1) throw new Error(`legacy task ${taskId} has unsupported schemaVersion`);
  if (requireSafeId(task.id) !== taskId) throw new Error(`legacy task ID does not match directory: ${taskId}`);
  requireString(task.project, `legacy task ${taskId}.project`);
  requireString(task.title, `legacy task ${taskId}.title`);
  requireString(task.instruction, `legacy task ${taskId}.instruction`);
  requireTimestamp(task.createdAt, `legacy task ${taskId}.createdAt`);
  if (task.threadId === null) {
    throw new Error(`legacy pending task ${taskId} has no executor thread and cannot be migrated`);
  }
  requireString(task.threadId, `legacy task ${taskId}.threadId`);
  return task;
}

async function inspectLegacyTaskRecords(workspaceRoot, config, existingDispatches = []) {
  const tasksPath = path.join(workspaceRoot, "tasks");
  const details = await lstat(tasksPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (details === null) return { tasksPath, entries: [], records: [], action: "not-found" };
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`legacy tasks path is not a real directory: ${tasksPath}`);
  }
  const entries = await readdir(tasksPath, { withFileTypes: true });
  const records = [];
  const ids = new Set();
  const threadIds = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) {
      throw new Error(`unexpected legacy task entry: ${entry.name}`);
    }
    const taskDirectory = path.join(tasksPath, entry.name);
    const taskEntries = await readdir(taskDirectory, { withFileTypes: true });
    if (taskEntries.length === 0) {
      records.push({ dispatch: null, taskPath: null, taskDirectory, taskId: entry.name });
      continue;
    }
    if (
      taskEntries.length !== 1 ||
      taskEntries[0].name !== "task.json" ||
      !taskEntries[0].isFile()
    ) {
      throw new Error(`legacy task directory must contain only task.json: ${entry.name}`);
    }
    const taskPath = path.join(taskDirectory, "task.json");
    const task = validateLegacyTask(JSON.parse(await readFile(taskPath, "utf8")), entry.name);
    const existing = existingDispatches.find((dispatch) => dispatch.id === task.id);
    let dispatch;
    if (existing) {
      const comparable = {
        title: task.title.trim(),
        instruction: task.instruction.trim(),
        threadId: task.threadId.trim(),
        createdAt: task.createdAt,
      };
      for (const [field, value] of Object.entries(comparable)) {
        if (existing[field] !== value) {
          throw new Error(`legacy task conflicts with dispatch: ${task.id}`);
        }
      }
      dispatch = existing;
    } else {
      const project = config.projects.find((candidate) => candidate.path === task.project) ??
        await inspectProject({ path: task.project });
      dispatch = await validateDispatchShape({
        schemaVersion: 1,
        id: task.id,
        project,
        title: task.title,
        instruction: task.instruction,
        threadId: task.threadId,
        createdAt: task.createdAt,
      });
    }
    if (ids.has(dispatch.id)) throw new Error(`duplicate legacy task ID: ${dispatch.id}`);
    if (threadIds.has(dispatch.threadId)) {
      throw new Error(`duplicate legacy task threadId: ${dispatch.threadId}`);
    }
    ids.add(dispatch.id);
    threadIds.add(dispatch.threadId);
    records.push({ dispatch, taskPath, taskDirectory, taskId: task.id });
  }
  return {
    tasksPath,
    entries,
    records,
    action: entries.length === 0 ? "removed-empty" : "migrated",
  };
}

async function migrateLegacyTaskRecords(workspaceRoot, inspection) {
  if (inspection.action === "not-found") return { action: "not-found", migratedCount: 0 };
  const migrations = await withDispatchLock(workspaceRoot, async () => {
    const existing = await readDispatchesUnlocked(workspaceRoot);
    const existingById = new Map(existing.map((dispatch) => [dispatch.id, dispatch]));
    const threadIds = new Set(existing.map((dispatch) => dispatch.threadId));
    const pending = [];
    for (const { dispatch, taskPath, taskDirectory, taskId } of inspection.records) {
      if (dispatch === null) {
        if (!existingById.has(taskId)) {
          throw new Error(`empty legacy task directory has no matching dispatch: ${taskId}`);
        }
        pending.push({ dispatch: null, taskPath, taskDirectory });
        continue;
      }
      const previous = existingById.get(dispatch.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(dispatch)) {
        throw new Error(`legacy task conflicts with dispatch: ${dispatch.id}`);
      }
      if (!previous && threadIds.has(dispatch.threadId)) {
        throw new Error(`legacy task threadId is already recorded: ${dispatch.threadId}`);
      }
      if (!previous) {
        pending.push({ dispatch, taskPath, taskDirectory });
        existingById.set(dispatch.id, dispatch);
        threadIds.add(dispatch.threadId);
      } else {
        pending.push({ dispatch: null, taskPath, taskDirectory });
      }
    }
    await appendDispatchesAtomic(
      workspaceRoot,
      pending.filter((item) => item.dispatch).map((item) => item.dispatch),
    );
    return pending;
  });
  for (const migration of migrations) {
    if (migration.taskPath !== null) await unlink(migration.taskPath);
    await rmdir(migration.taskDirectory);
  }
  await rmdir(inspection.tasksPath);
  return {
    action: inspection.action,
    migratedCount: migrations.filter((item) => item.dispatch).length,
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
  await check("dispatch-log", async () => {
    const dispatches = await readDispatches(root);
    return `${dispatches.length} dispatch record(s) valid`;
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
  await check("legacy-tasks", async () => {
    if (await pathExists(path.join(root, "tasks"))) {
      throw new Error("legacy tasks directory remains; run workspace init to migrate it");
    }
    return "no legacy task records";
  });
  return { workspace: root, ok: checks.every((item) => item.status === "pass"), checks };
}
