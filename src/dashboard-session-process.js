import { realpath } from "node:fs/promises";

import { createDashboardServer } from "./dashboard.js";
import { createDashboardSessionLease, validSessionPid } from "./dashboard-session.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";

export async function runDashboardSessionProcess({
  workspace = process.env.TASKCHEF_DASHBOARD_WORKSPACE,
  host = process.env.TASKCHEF_DASHBOARD_HOST ?? "127.0.0.1",
  port = Number(process.env.TASKCHEF_DASHBOARD_PORT ?? 3210),
  sessionPid = Number(process.env.TASKCHEF_DASHBOARD_SESSION_PID),
  taskchefVersion = TASKCHEF_VERSION,
  serverVersion = DASHBOARD_SERVER_VERSION,
  createServer = createDashboardServer,
  createLease = createDashboardSessionLease,
  processObject = process,
  signal,
  checkIntervalMs = Number(process.env.TASKCHEF_DASHBOARD_CHECK_INTERVAL_MS ?? 1_000),
  exitGraceMs = Number(process.env.TASKCHEF_DASHBOARD_EXIT_GRACE_MS ?? 15_000),
} = {}) {
  if (processObject.env) {
    delete processObject.env.TASKCHEF_DASHBOARD_SECRET;
    delete processObject.env.TASKCHEF_DASHBOARD_SESSION_PIDS;
  }
  if (!workspace) throw new Error("dashboard session workspace is required");
  if (!validSessionPid(sessionPid)) throw new Error("dashboard session PID is invalid");

  const canonicalWorkspace = await realpath(workspace);
  let server = null;
  let lease = null;
  let closePromise = null;
  let closeChain = Promise.resolve();
  let closedLease = null;
  let closedServer = null;
  let closing = false;
  const abortError = () => Object.assign(new Error("dashboard session startup was cancelled"), {
    code: "TASKCHEF_DASHBOARD_START_TIMEOUT",
  });
  const removeListeners = () => {
    processObject.off("SIGINT", close);
    processObject.off("SIGTERM", close);
  };
  const close = () => {
    closing = true;
    closePromise = closeChain.then(async () => {
      let failure = null;
      if (lease && lease !== closedLease) {
        closedLease = lease;
        try { lease.close(); } catch (error) { failure = error; }
      }
      if (server && server !== closedServer) {
        closedServer = server;
        try { await server.close(); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    }).finally(removeListeners);
    closeChain = closePromise.catch(() => {});
    return closePromise;
  };
  const onAbort = () => { void close().catch(() => {}); };
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", onAbort, { once: true });
  processObject.once("SIGINT", close);
  processObject.once("SIGTERM", close);

  try {
    const control = {
      onShutdown: close,
      onSession: (pid) => {
        if (closing) throw Object.assign(new Error("dashboard session is retiring"), {
          code: "TASKCHEF_DASHBOARD_SESSION_RETIRING",
        });
        lease.register(pid);
      },
    };
    server = await createServer({ workspace: canonicalWorkspace, host, port,
      taskchefVersion, serverVersion, launcher: "session", control });
    if (closing || signal?.aborted) throw abortError();
    lease = createLease({ initialPid: sessionPid, checkIntervalMs, exitGraceMs, onExpire: close });
    if (closing || signal?.aborted) throw abortError();
    signal?.removeEventListener("abort", onAbort);
    return { server, lease, close };
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    await close().catch(() => {});
    throw error;
  }
}
