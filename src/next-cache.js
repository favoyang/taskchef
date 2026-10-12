import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireWorkspaceLock } from "./workspace.js";

// Serialize migrations between plugin processes. Never replace a newer cache.
export async function migrateCache(previous, current) {
  if (!previous || previous === current) return;
  await mkdir(dirname(current), { recursive: true, mode: 0o700 });
  const release = await acquireWorkspaceLock(dirname(current));
  try {
    try { await stat(current); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await rename(previous, current); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } finally { await release(); }
}
