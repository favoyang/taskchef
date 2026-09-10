import http from "node:http";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DASHBOARD_HEALTH_MAX_BYTES, DASHBOARD_HEALTH_PATH, dashboardAuthority } from "./dashboard.js";
import { DASHBOARD_CONTROL_HEADER, DASHBOARD_CONTROL_SESSION_PATH,
  DASHBOARD_CONTROL_SHUTDOWN_PATH, exactDashboardIdentity } from "./dashboard-control.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const HEALTH_TIMEOUT_MS = 750;
const SESSION_START_ATTEMPTS = 80;
const SESSION_START_INTERVAL_MS = 25;
const SESSION_READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_VERSION_REPLACEMENT_ATTEMPTS = 8;
const SESSION_PROCESS_PATH = fileURLToPath(new URL("../mcp/dashboard-session.js", import.meta.url));

export function launchDashboardSession({ workspace, host, port, sessionPid,
  processPath = process.execPath, spawnProcess = spawn,
  readyTimeoutMs = SESSION_READY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const childEnvironment = {
      ...process.env,
      TASKCHEF_DASHBOARD_WORKSPACE: workspace,
      TASKCHEF_DASHBOARD_HOST: host,
      TASKCHEF_DASHBOARD_PORT: String(port),
      TASKCHEF_DASHBOARD_SESSION_PID: String(sessionPid),
    };
    delete childEnvironment.TASKCHEF_DASHBOARD_SECRET;
    delete childEnvironment.TASKCHEF_DASHBOARD_SESSION_PIDS;
    const child = spawnProcess(processPath, [SESSION_PROCESS_PATH], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: childEnvironment,
    });
    let settled = false;
    const finish = (callback, value, { disconnect = true } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      child.on("error", () => {});
      if (disconnect && child.connected) child.disconnect();
      child.unref();
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code) => {
      const error = new Error("TaskChef dashboard session exited before becoming ready");
      error.code = code === 0 ? "TASKCHEF_DASHBOARD_START_EXIT" : "TASKCHEF_DASHBOARD_START_FAILED";
      finish(reject, error);
    };
    const onMessage = (message) => {
      if (message?.type === "ready" && message.port === port) {
        finish(resolve, { pid: child.pid, port: message.port });
      } else if (message?.type === "error") {
        const error = new Error("TaskChef dashboard session failed before becoming ready");
        error.code = typeof message.code === "string" ? message.code : "TASKCHEF_DASHBOARD_START_FAILED";
        finish(reject, error);
      }
    };
    const timer = setTimeout(() => {
      const error = new Error("TaskChef dashboard session readiness timed out");
      error.code = "TASKCHEF_DASHBOARD_START_TIMEOUT";
      finish(reject, error, { disconnect: false });
      if (child.connected) {
        try { child.send({ type: "cancel" }, () => { if (child.connected) child.disconnect(); }); }
        catch { if (child.connected) child.disconnect(); }
      }
    }, readyTimeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

function expectedIdentity(workspace, taskchefVersion, serverVersion, launcher) {
  return { schemaVersion: 1, service: "taskchef-dashboard", taskchefVersion,
    serverVersion, workspace, launcher };
}

function isRecognizedDashboardIdentity(value, workspace) {
  return value?.schemaVersion === 1 && value?.service === "taskchef-dashboard"
    && typeof value?.taskchefVersion === "string" && typeof value?.serverVersion === "string"
    && value?.workspace === workspace && new Set(["mcp", "session", "standalone"]).has(value?.launcher)
    && exactDashboardIdentity(value, expectedIdentity(workspace, value.taskchefVersion,
      value.serverVersion, value.launcher));
}

function listenerConflict(url, detail, { staleTaskchefVersion } = {}) {
  const error = new Error(`TaskChef dashboard port conflict at ${url} ${detail} `
    + "Stop that listener or choose another port for the foreground dashboard CLI; TaskChef will not terminate it.");
  error.code = "TASKCHEF_DASHBOARD_CONFLICT";
  if (staleTaskchefVersion) error.staleTaskchefVersion = staleTaskchefVersion;
  return error;
}

export function priorCompatibleVersion(candidate, current) {
  const parse = (value) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split(".") ?? null;
    if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
    return { core: match.slice(1, 4).map(BigInt), prerelease };
  };
  const left = parse(candidate); const right = parse(current);
  if (!left || !right) return false;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index];
  }
  if (left.prerelease === null || right.prerelease === null) return left.prerelease !== null && right.prerelease === null;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const l = left.prerelease[index]; const r = right.prerelease[index];
    if (l === undefined || r === undefined) return l === undefined;
    if (l === r) continue;
    const ln = /^\d+$/.test(l); const rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) < BigInt(r);
    if (ln !== rn) return ln;
    return l < r;
  }
  return false;
}

export function requestDashboardJson({ host, port, path: requestPath, action, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const encoded = Buffer.from(`${JSON.stringify(body ?? {})}\n`);
    const authority = dashboardAuthority(host, port);
    const request = http.request({ host, port, path: requestPath, method: "POST", headers: {
      Accept: "application/json", Host: authority, Origin: `http://${authority}`,
      "Content-Type": "application/json", "Content-Length": encoded.length,
      [DASHBOARD_CONTROL_HEADER]: action,
    } }, (response) => {
      const chunks = []; let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > DASHBOARD_HEALTH_MAX_BYTES) {
          const error = new Error("dashboard control response exceeds the identity limit");
          finish(error); request.destroy(error);
        }
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { finish(null, { statusCode: response.statusCode,
          value: JSON.parse(Buffer.concat(chunks, total).toString("utf8")) }); }
        catch { finish(new Error("dashboard control returned invalid JSON")); }
      });
      const interrupted = () => finish(new Error("dashboard control response was interrupted"));
      response.on("aborted", interrupted);
      response.on("error", interrupted);
      response.on("close", () => { if (!response.complete) interrupted(); });
    });
    deadline = setTimeout(() => {
      const error = new Error("dashboard control request timed out");
      finish(error); request.destroy(error);
    }, timeoutMs);
    request.on("error", (error) => finish(error));
    request.end(encoded);
  });
}

export function readDashboardIdentity({ host = DEFAULT_HOST, port = DEFAULT_PORT,
  maximumBytes = DASHBOARD_HEALTH_MAX_BYTES, timeoutMs = HEALTH_TIMEOUT_MS,
  deadlineAt = Date.now() + timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value); };
    const request = http.get({ host, port, path: DASHBOARD_HEALTH_PATH,
      headers: { Accept: "application/json", Host: dashboardAuthority(host, port) } }, (response) => {
      const chunks = []; let total = 0;
      response.on("data", (chunk) => { total += chunk.length;
        if (total > maximumBytes) { const error = new Error("dashboard health response exceeds the identity limit");
          finish(error); request.destroy(error); } else chunks.push(chunk); });
      response.on("end", () => {
        if (response.statusCode === 503 && deadlineAt - Date.now() > 10) {
          settled = true; clearTimeout(deadline); const remaining = deadlineAt - Date.now();
          setTimeout(() => readDashboardIdentity({ host, port, maximumBytes,
            timeoutMs: Math.max(1, remaining), deadlineAt }).then(resolve, reject), 10); return;
        }
        if (response.statusCode !== 200) { finish(new Error(`dashboard health returned HTTP ${response.statusCode}`)); return; }
        try { finish(null, JSON.parse(Buffer.concat(chunks, total).toString("utf8"))); }
        catch { finish(new Error("dashboard health returned invalid JSON")); }
      });
    });
    const deadline = setTimeout(() => { const error = new Error("dashboard health request timed out");
      finish(error); request.destroy(error); }, timeoutMs);
    request.on("error", (error) => finish(error));
  });
}

function listenerAbsent(error) { return error?.code === "ECONNREFUSED" || error?.code === "EHOSTUNREACH"; }

export function createDashboardManager({ workspace, host = DEFAULT_HOST, port = DEFAULT_PORT,
  taskchefVersion = TASKCHEF_VERSION, serverVersion = DASHBOARD_SERVER_VERSION,
  launcher = "session", sessionPid = process.ppid, launchSession = launchDashboardSession,
  readIdentity = readDashboardIdentity, requestJson = requestDashboardJson,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("dashboard manager port must be an integer from 1 to 65535");
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) throw new Error("dashboard shutdown timeout must be positive");
  let canonicalWorkspace; let ensurePromise = null; let closePromise = null;
  const url = `http://${dashboardAuthority(host, port)}/`;
  const expected = () => expectedIdentity(canonicalWorkspace, taskchefVersion, serverVersion, launcher);
  const publicResult = (action, observedLauncher = launcher) => ({
    action,
    launcher: observedLauncher,
    url,
    workspace: canonicalWorkspace,
    taskchefVersion,
    serverVersion,
  });

  const registerAndVerify = async (identity) => {
    const registration = await requestJson({ host, port, path: DASHBOARD_CONTROL_SESSION_PATH,
      action: "session", body: { pid: sessionPid, expectedIdentity: identity },
      timeoutMs: HEALTH_TIMEOUT_MS }).catch(() => null);
    if (registration?.statusCode !== 200 || registration.value?.accepted !== true) return false;
    const verified = await readIdentity({ host, port, timeoutMs: HEALTH_TIMEOUT_MS }).catch(() => null);
    return exactDashboardIdentity(verified, identity);
  };
  const stopOlder = async (identity) => {
    const shutdown = await requestJson({ host, port, path: DASHBOARD_CONTROL_SHUTDOWN_PATH,
      action: "shutdown", body: { reason: "version-replacement", expectedIdentity: identity },
      timeoutMs: HEALTH_TIMEOUT_MS }).catch(() => null);
    if (shutdown?.statusCode !== 202 || shutdown.value?.accepted !== true) {
      const live = await readIdentity({ host, port, timeoutMs: HEALTH_TIMEOUT_MS }).catch((error) => {
        if (listenerAbsent(error) || error?.code === "ECONNRESET") return null;
        throw listenerConflict(url, "changed to an unexpected listener before graceful restart.");
      });
      if (live === null) return;
      if (!exactDashboardIdentity(live, identity)) {
        return probe();
      }
      throw listenerConflict(url, `is a recognized older TaskChef ${identity.taskchefVersion} listener that refused graceful shutdown.`,
        { staleTaskchefVersion: identity.taskchefVersion });
    }
    const deadline = Date.now() + shutdownTimeoutMs;
    do {
      try {
        const live = await readIdentity({ host, port, timeoutMs: Math.min(100, shutdownTimeoutMs) });
        if (!exactDashboardIdentity(live, identity)) {
          return probe();
        }
      } catch (error) {
        if (listenerAbsent(error) || error?.code === "ECONNRESET") return;
        if (error?.code === "TASKCHEF_DASHBOARD_CONFLICT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_START_INTERVAL_MS));
    } while (Date.now() < deadline);
    throw listenerConflict(url, `accepted graceful shutdown but did not release the port within ${shutdownTimeoutMs}ms.`,
      { staleTaskchefVersion: identity.taskchefVersion });
  };
  const probe = async () => {
    let identity;
    try { identity = await readIdentity({ host, port }); }
    catch (error) {
      if (listenerAbsent(error) || error?.code === "ECONNRESET") return false;
      throw listenerConflict(url, `is occupied but did not return a compatible identity (${error.message}).`);
    }
    const exactCurrent = isRecognizedDashboardIdentity(identity, canonicalWorkspace)
      && identity.taskchefVersion === taskchefVersion
      && identity.serverVersion === serverVersion;
    if (exactCurrent) {
      if (identity.launcher === "session") {
        if (await registerAndVerify(identity)) return identity;
        return null;
      }
      const verified = await readIdentity({ host, port, timeoutMs: HEALTH_TIMEOUT_MS }).catch(() => null);
      return exactDashboardIdentity(verified, identity) ? identity : null;
    }
    if (isRecognizedDashboardIdentity(identity, canonicalWorkspace)) {
      if (priorCompatibleVersion(taskchefVersion, identity.taskchefVersion))
        throw listenerConflict(url, `belongs to newer TaskChef ${identity.taskchefVersion}; refusing to downgrade it.`);
      if (priorCompatibleVersion(identity.taskchefVersion, taskchefVersion)) return stopOlder(identity);
    }
    throw listenerConflict(url, "belongs to an unknown, malformed, different-workspace, standalone, or incompatible service.");
  };
  const ensureOnce = async () => {
    canonicalWorkspace ??= await realpath(path.resolve(workspace));
    const existing = await probe();
    if (existing) return publicResult("reused", existing.launcher);
    for (let replacementAttempt = 0; replacementAttempt < MAX_VERSION_REPLACEMENT_ATTEMPTS; replacementAttempt += 1) {
      try { await launchSession({ workspace: canonicalWorkspace, host, port, sessionPid,
        taskchefVersion, serverVersion }); }
      catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
        const winner = await probe();
        if (winner) return publicResult("reused", winner.launcher);
        continue;
      }
      for (let attempt = 0; attempt < SESSION_START_ATTEMPTS; attempt += 1) {
        try {
          const identity = await readIdentity({ host, port, timeoutMs: 100 });
          if (exactDashboardIdentity(identity, expected())) {
            if (await registerAndVerify(identity)) return publicResult("started");
          } else if (isRecognizedDashboardIdentity(identity, canonicalWorkspace)
              && priorCompatibleVersion(identity.taskchefVersion, taskchefVersion)) {
            const replacement = await stopOlder(identity);
            if (replacement) return publicResult("reused", replacement.launcher);
            break;
          } else if (isRecognizedDashboardIdentity(identity, canonicalWorkspace)
              && priorCompatibleVersion(taskchefVersion, identity.taskchefVersion)) {
            throw listenerConflict(url, `belongs to newer TaskChef ${identity.taskchefVersion}; refusing to downgrade it.`);
          } else throw listenerConflict(url, "changed to an unexpected listener while the dashboard session was starting.");
        } catch (error) { if (!listenerAbsent(error) && error?.code !== "ECONNRESET") throw error; }
        await new Promise((resolve) => setTimeout(resolve, SESSION_START_INTERVAL_MS));
      }
    }
    const error = new Error(`TaskChef dashboard session did not become available at ${url}`);
    error.code = "TASKCHEF_DASHBOARD_START_TIMEOUT"; throw error;
  };
  return {
    async ensure() {
      if (closePromise) throw new Error("TaskChef dashboard manager is shutting down");
      if (ensurePromise) {
        await ensurePromise;
        const existing = await probe();
        if (existing) return publicResult("reused", existing.launcher);
      }
      ensurePromise = ensureOnce().finally(() => { ensurePromise = null; });
      return ensurePromise;
    },
    async close() { closePromise ??= (async () => { await ensurePromise?.catch(() => {}); })(); return closePromise; },
    get owned() { return false; },
  };
}
