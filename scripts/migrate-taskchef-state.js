#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, readFile, rename, rmdir, symlink, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { hasDispatcherState, isNativeStateDir, taskChefStatePaths, taskChefStateDir } from "../src/taskchef-state.js";

const run = promisify(execFile);
const info = path => lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const inside = (root, path) => { const child = relative(root, path); return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)); };

// lsof supplies cwd even when the MCP command uses ./mcp/server.js. Inspect
// command arguments too, so a test or build in a TaskChef checkout is harmless.
export async function assertNoStateWriters(paths, runCommand = run) {
  let output, commands;
  try {
    ({ stdout: output } = await runCommand("lsof", ["-n", "-a", "-u", String(process.getuid()), "-d", "cwd", "-Fpn"], { maxBuffer: 8 * 1024 * 1024 }));
    const { stdout } = await runCommand("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
    commands = new Map(stdout.split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match ? [[Number(match[1]), match[2]]] : [];
    }));
  } catch (error) { throw new Error(`Cannot establish that TaskChef writers are stopped (lsof/ps): ${error.message}`); }
  const identities = new Map();
  async function isTaskChef(root) {
    if (!identities.has(root)) {
      let name;
      try { name = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8")).name; } catch { /* Unrelated process. */ }
      identities.set(root, ["taskchef", "taskchef-next"].includes(name));
    }
    return identities.get(root);
  }
  let pid;
  const blocked = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n") || !pid || pid === process.pid) continue;
    const cwd = line.slice(1);
    if ([paths.current, paths.previous, paths.archive, paths.registry].some(root => inside(root, cwd))) { blocked.push(pid); continue; }
    const command = commands.get(pid) ?? "";
    if (/(?:^|[\s"'])(?:\.\/)?mcp\/server\.js(?:[\s"']|$)/.test(command) && await isTaskChef(cwd)) { blocked.push(pid); continue; }
    // ps does not escape spaces consistently. Try each absolute suffix ending
    // at the server filename and confirm the package's manifest on disk.
    for (const match of command.matchAll(/\/mcp\/server\.js(?=[\s"']|$)/g)) {
      const end = match.index + match[0].length;
      for (let start = command.indexOf("/"); start >= 0 && start <= match.index; start = command.indexOf("/", start + 1)) {
        if (await isTaskChef(dirname(dirname(command.slice(start, end))))) { blocked.push(pid); break; }
      }
    }
  }
  if (blocked.length) throw new Error(`Stop TaskChef clients and processes using its storage before migrating (PIDs: ${[...new Set(blocked)].join(", ")}). Quit Codex; stop any listed legacy dashboard through its normal controls. Nothing was moved.`);
}

async function assertNative(directory) {
  if (!isNativeStateDir(directory)) {
    throw new Error(`Unrecognized native state at ${directory}; inspect it before migrating.`);
  }
}

export async function migrateTaskChefState(home = homedir(), { assertStopped = assertNoStateWriters } = {}) {
  const paths = taskChefStatePaths(home);
  await mkdir(paths.agents, { recursive: true, mode: 0o700 });
  // A leftover lock requires inspection, never automatic deletion or a blind retry.
  await mkdir(paths.lock, { mode: 0o700 });
  try {
    await assertStopped(paths);
    const current = await info(paths.current), previous = await info(paths.previous), archive = await info(paths.archive);
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error(`Refusing unexpected destination ${paths.current}.`);
    if (archive && (!archive.isDirectory() || archive.isSymbolicLink())) throw new Error(`Refusing unexpected archive ${paths.archive}.`);
    const retired = current && hasDispatcherState(paths.current);
    if (retired && archive) throw new Error(`Archive ${paths.archive} already exists; nothing will be overwritten or merged.`);
    if (previous?.isSymbolicLink()) {
      if (!current || retired || await realpath(paths.previous) !== await realpath(paths.current)) throw new Error("Unexpected taskchef-next link; inspect it before migrating.");
    } else if (previous) {
      if (!previous.isDirectory()) throw new Error("taskchef-next must be a directory.");
      await assertNative(paths.previous);
      if (current && !retired) throw new Error("Both native state directories exist. Inspect and reconcile them before migrating; no files were merged.");
    } else if (!current || retired) throw new Error("No current native state was found; nothing was moved.");
    if (current && !retired) await assertNative(paths.current);

    // The obsolete registry is independent of Codex's active SQLite databases.
    const registry = paths.registry, registryInfo = await info(registry);
    const registryArchive = join(paths.archive, "codex-registry");
    if (registryInfo) {
      const futureArchive = join(retired ? paths.current : paths.archive, "codex-registry");
      if (!registryInfo.isDirectory() || registryInfo.isSymbolicLink() || await info(futureArchive)) throw new Error("Unexpected or colliding legacy Codex registry; nothing was moved.");
      const names = await readdir(registry);
      if (names.some(name => !["workspaces.json", "projects"].includes(name))) throw new Error("Legacy Codex registry contains unknown entries; inspect it first.");
    }
    // Complete all collision checks before the first rename. Each rename is
    // recoverable: a repeated run recognizes the resulting directory layout.
    if (retired) await rename(paths.current, paths.archive);
    if (registryInfo) {
      await mkdir(paths.archive, { recursive: true, mode: 0o700 });
      await rename(registry, registryArchive);
    }
    if (previous && !previous.isSymbolicLink()) await rename(paths.previous, paths.current);
    if (!await info(paths.previous)) await symlink("taskchef", paths.previous, "dir");
    return { state: paths.current, archive: await info(paths.archive) ? paths.archive : null, compatibilityLink: paths.previous };
  } finally { await rmdir(paths.lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await migrateTaskChefState();
    // Resolve only after releasing the migration lock.
    taskChefStateDir();
    console.log(JSON.stringify(result, null, 2));
    console.log("Start Codex with the updated TaskChef packages. taskchef-next is a compatibility link, not a second state store.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
