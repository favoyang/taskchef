const DEFAULT_CHECK_INTERVAL_MS = 1_000;
const DEFAULT_EXIT_GRACE_MS = 15_000;
export const MAX_DASHBOARD_SESSION_PIDS = 64;
export const MAX_TRANSFERRED_DASHBOARD_SESSION_PIDS = MAX_DASHBOARD_SESSION_PIDS - 1;

export function processIsAlive(pid, processObject = process) {
  try {
    processObject.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function validSessionPid(pid) {
  return Number.isSafeInteger(pid) && pid > 1;
}

export function createDashboardSessionLease({
  initialPid,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  exitGraceMs = DEFAULT_EXIT_GRACE_MS,
  isAlive = processIsAlive,
  now = Date.now,
  onExpire,
} = {}) {
  if (!validSessionPid(initialPid)) throw new Error("dashboard session PID is invalid");
  if (!Number.isFinite(checkIntervalMs) || checkIntervalMs <= 0) {
    throw new Error("dashboard session check interval must be positive");
  }
  if (!Number.isFinite(exitGraceMs) || exitGraceMs < 0) {
    throw new Error("dashboard session exit grace must be non-negative");
  }
  if (typeof onExpire !== "function") throw new Error("dashboard session expiry callback is required");

  const pids = new Set([initialPid]);
  let absentSince = null;
  let expiryPromise = null;
  let timer = null;

  const activePids = () => {
    let active = false;
    for (const pid of pids) {
      if (isAlive(pid)) active = true;
      else pids.delete(pid);
    }
    return active;
  };

  const tick = () => {
    if (expiryPromise) return;
    const active = activePids();
    if (active) {
      absentSince = null;
      return;
    }
    absentSince ??= now();
    if (now() - absentSince < exitGraceMs) return;
    expiryPromise = Promise.resolve().then(onExpire).catch(() => {});
  };

  timer = setInterval(tick, checkIntervalMs);
  timer.unref?.();

  return {
    register(pid) {
      if (!validSessionPid(pid)) throw new Error("dashboard session PID is invalid");
      if (expiryPromise) {
        throw Object.assign(new Error("dashboard session is expiring"), {
          code: "TASKCHEF_DASHBOARD_SESSION_RETIRING",
        });
      }
      activePids();
      if (!pids.has(pid) && pids.size >= MAX_DASHBOARD_SESSION_PIDS) {
        throw new Error("dashboard session PID limit reached");
      }
      pids.add(pid);
      absentSince = null;
    },
    snapshot() {
      activePids();
      return [...pids];
    },
    tick,
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get sessionCount() { return pids.size; },
  };
}
