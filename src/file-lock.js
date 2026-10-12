import path from "node:path";
import lockfile from "proper-lockfile";

// Keep the existing lock filename and timing for shared native state.
export async function acquireFileLock(workspaceRoot, {
  lock = lockfile.lock,
  waitImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  const lockPath = path.join(workspaceRoot, ".taskchef-workspace.lock");
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
