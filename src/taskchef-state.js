import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dispatcherFiles = ["tasks.jsonl", "taskchef.json", ".taskchef-usage.json"];
const nativeEntries = ["settings.json", "done.json", "github-auth", "cache", "notifications.json", "notifications.json.errors.json", "delegation-memory.md", "usage-cache", "pricing.json"];

export function isNativeStateDir(directory) {
  const entries = readdirSync(directory);
  return !hasDispatcherState(directory) && (!entries.length || entries.some(name => nativeEntries.includes(name)));
}

export function taskChefStatePaths(home = homedir()) {
  const agents = join(home, ".agents");
  return { agents, current: join(agents, "taskchef"), previous: join(agents, "taskchef-next"), archive: join(agents, "taskchef-old"), registry: join(home, ".codex", "taskchef"), lock: join(agents, ".taskchef-storage-migration") };
}

export function hasDispatcherState(directory) {
  return dispatcherFiles.some(name => existsSync(join(directory, name)));
}

// Resolve paths only. Moving user data requires the explicit offline migration.
export function taskChefStateDir(home = homedir()) {
  const paths = taskChefStatePaths(home);
  const fail = () => { throw new Error("TaskChef storage needs migration. Quit Codex and other TaskChef clients, then run node scripts/migrate-taskchef-state.js from the installed TaskChef package. See docs/taskchef-next-storage.md. No state was moved."); };
  if (existsSync(paths.lock)) fail();
  const retired = hasDispatcherState(paths.current);
  let previousDirectory = false;
  for (const directory of [paths.current, paths.previous]) {
    let info;
    try { info = lstatSync(directory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (directory === paths.previous && info.isSymbolicLink()) {
      try { if (realpathSync(directory) === realpathSync(paths.current)) continue; } catch { /* Fail closed for dangling links. */ }
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    if (directory === paths.previous) previousDirectory = true;
  }
  if (previousDirectory) {
    // Upgraded packages remain usable before the offline move. Never read the
    // retired dispatcher directory as native state, and never choose between
    // two independent native stores.
    if ((!retired && existsSync(paths.current)) || !isNativeStateDir(paths.previous)) fail();
    return paths.previous;
  }
  if (retired) fail();
  return paths.current;
}
