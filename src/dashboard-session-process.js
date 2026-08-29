import { realpath } from "node:fs/promises";

import { createDashboardServer } from "./dashboard.js";
import {
  dashboardHandoffMetadata,
  dashboardOwnerMetadata,
  validDashboardControlSecret,
  writeDashboardHandoff,
  writeDashboardOwner,
} from "./dashboard-ownership.js";
import {
  MAX_DASHBOARD_SESSION_PIDS,
  createDashboardSessionLease,
  validSessionPid,
} from "./dashboard-session.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";

export async function runDashboardSessionProcess({
  workspace = process.env.TASKCHEF_DASHBOARD_WORKSPACE,
  host = process.env.TASKCHEF_DASHBOARD_HOST ?? "127.0.0.1",
  port = Number(process.env.TASKCHEF_DASHBOARD_PORT ?? 3210),
  secret = process.env.TASKCHEF_DASHBOARD_SECRET,
  sessionPid = Number(process.env.TASKCHEF_DASHBOARD_SESSION_PID),
  sessionPids,
  taskchefVersion = TASKCHEF_VERSION,
  serverVersion = DASHBOARD_SERVER_VERSION,
  createServer = createDashboardServer,
  writeOwner = writeDashboardOwner,
  writeHandoff = writeDashboardHandoff,
  createLease = createDashboardSessionLease,
  processObject = process,
  signal,
  checkIntervalMs = Number(process.env.TASKCHEF_DASHBOARD_CHECK_INTERVAL_MS ?? 1_000),
  exitGraceMs = Number(process.env.TASKCHEF_DASHBOARD_EXIT_GRACE_MS ?? 15_000),
} = {}) {
  if (processObject.env) delete processObject.env.TASKCHEF_DASHBOARD_SECRET;
  sessionPids ??= JSON.parse(process.env.TASKCHEF_DASHBOARD_SESSION_PIDS ?? "[]");
  if (!workspace) throw new Error("dashboard session workspace is required");
  if (!validDashboardControlSecret(secret)) {
    throw new Error("dashboard session control credential is invalid");
  }
  if (!validSessionPid(sessionPid)) throw new Error("dashboard session PID is invalid");
  if (!Array.isArray(sessionPids) || sessionPids.length > MAX_DASHBOARD_SESSION_PIDS
      || sessionPids.some((pid) => !validSessionPid(pid))
      || new Set([sessionPid, ...sessionPids]).size > MAX_DASHBOARD_SESSION_PIDS) {
    throw new Error("dashboard transferred session PIDs are invalid");
  }

  const canonicalWorkspace = await realpath(workspace);
  let server = null;
  let lease = null;
  let closePromise = null;
  let closing = false;
  let publishingOwner = false;
  let deferredClose = null;
  const abortError = () => Object.assign(new Error("dashboard session startup was cancelled"), {
    code: "TASKCHEF_DASHBOARD_START_TIMEOUT",
  });
  const startupClosedError = () => Object.assign(
    new Error("dashboard session closed during startup"),
    { code: "TASKCHEF_DASHBOARD_START_EXIT" },
  );
  const removeListeners = () => {
    processObject.off("SIGINT", close);
    processObject.off("SIGTERM", close);
  };
  const performClose = async () => {
    let cleanupError = null;
    try {
      lease?.close();
    } catch (error) {
      cleanupError = error;
    }
    await server?.close();
    if (cleanupError) throw cleanupError;
  };
  const close = () => {
    closing = true;
    if (!closePromise && publishingOwner) {
      closePromise = new Promise((resolve, reject) => {
        deferredClose = { resolve, reject };
      }).finally(removeListeners);
    } else if (!closePromise) {
      closePromise = performClose().finally(removeListeners);
    }
    return closePromise;
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", onAbort, { once: true });
  processObject.once("SIGINT", close);
  processObject.once("SIGTERM", close);
  const control = {
    secret,
    onShutdown: close,
    onSession: (pid) => {
      if (closing) {
        throw Object.assign(new Error("dashboard session is retiring"), {
          code: "TASKCHEF_DASHBOARD_SESSION_RETIRING",
        });
      }
      lease.register(pid);
    },
    onHandoff: (pid) => {
      if (closing) {
        throw Object.assign(new Error("dashboard session is retiring"), {
          code: "TASKCHEF_DASHBOARD_SESSION_RETIRING",
        });
      }
      lease.register(pid);
      return lease.snapshot();
    },
    onHandoffFinalized: ({ id, pids }) => writeHandoff(
      canonicalWorkspace,
      dashboardHandoffMetadata({
        workspace: canonicalWorkspace,
        host,
        port: server.port,
        taskchefVersion,
        serverVersion,
        id,
        pids,
        secret,
      }),
    ),
  };

  try {
    server = await createServer({
      workspace: canonicalWorkspace,
      host,
      port,
      taskchefVersion,
      serverVersion,
      launcher: "session",
      control,
    });
    if (closing) {
      closePromise = null;
      if (signal?.aborted) throw abortError();
      throw startupClosedError();
    }
    lease = createLease({ initialPid: sessionPid, checkIntervalMs, exitGraceMs, onExpire: close });
    for (const pid of sessionPids) lease.register(pid);
    publishingOwner = true;
    try {
      await writeOwner(canonicalWorkspace, dashboardOwnerMetadata({
        workspace: canonicalWorkspace,
        host,
        port: server.port,
        taskchefVersion,
        serverVersion,
        launcher: "session",
        secret,
      }), { signal });
    } finally {
      publishingOwner = false;
      if (deferredClose) {
        const pending = deferredClose;
        deferredClose = null;
        void performClose().then(pending.resolve, pending.reject);
      }
    }
    if (closing) {
      await closePromise;
      if (signal?.aborted) throw abortError();
      throw startupClosedError();
    }
    if (signal?.aborted) throw abortError();
    signal?.removeEventListener("abort", onAbort);
    return { server, lease, close };
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    await close().catch(() => {});
    throw error;
  }
}
