import http from "node:http";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  DASHBOARD_HEALTH_MAX_BYTES,
  DASHBOARD_HEALTH_PATH,
  createDashboardServer,
  dashboardAuthority,
} from "./dashboard.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const HEALTH_TIMEOUT_MS = 750;

function expectedIdentity(workspace, taskchefVersion, serverVersion, launcher) {
  return {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion,
    serverVersion,
    workspace,
    launcher,
  };
}

function isExactIdentity(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => value[key] === expected[key]);
}

function listenerConflict(url, detail) {
  return new Error(
    `TaskChef dashboard port conflict at ${url} ${detail} `
    + "Stop that listener or choose another port for the foreground dashboard CLI; TaskChef will not terminate it.",
  );
}

export function readDashboardIdentity({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  maximumBytes = DASHBOARD_HEALTH_MAX_BYTES,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.get({
      host,
      port,
      path: DASHBOARD_HEALTH_PATH,
      headers: {
        Accept: "application/json",
        Host: dashboardAuthority(host, port),
      },
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maximumBytes) {
          const error = new Error("dashboard health response exceeds the identity limit");
          finish(error);
          request.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          finish(new Error(`dashboard health returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          finish(null, JSON.parse(Buffer.concat(chunks, total).toString("utf8")));
        } catch {
          finish(new Error("dashboard health returned invalid JSON"));
        }
      });
    });
    const deadline = setTimeout(() => {
      const error = new Error("dashboard health request timed out");
      finish(error);
      request.destroy(error);
    }, timeoutMs);
    request.on("error", (error) => finish(error));
  });
}

function listenerAbsent(error) {
  return error?.code === "ECONNREFUSED" || error?.code === "EHOSTUNREACH";
}

export function createDashboardManager({
  workspace,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  taskchefVersion = TASKCHEF_VERSION,
  serverVersion = DASHBOARD_SERVER_VERSION,
  launcher = "mcp",
  createServer = createDashboardServer,
  readIdentity = readDashboardIdentity,
} = {}) {
  let canonicalWorkspace;
  let ownedServer = null;
  let ensurePromise = null;
  let closePromise = null;

  const publicResult = (action) => ({
    action,
    launcher,
    url: `http://${dashboardAuthority(host, ownedServer?.port ?? port)}/`,
    workspace: canonicalWorkspace,
    taskchefVersion,
    serverVersion,
  });

  const probe = async () => {
    const url = `http://${dashboardAuthority(host, port)}/`;
    let identity;
    try {
      identity = await readIdentity({ host, port });
    } catch (error) {
      if (listenerAbsent(error)) return false;
      throw listenerConflict(url, `is occupied but did not return a compatible identity (${error.message}).`);
    }
    const expected = expectedIdentity(canonicalWorkspace, taskchefVersion, serverVersion, launcher);
    if (!isExactIdentity(identity, expected)) {
      throw listenerConflict(
        url,
        "belongs to an unknown, stale, different-workspace, or differently launched service.",
      );
    }
    return true;
  };

  const ensureOnce = async () => {
    canonicalWorkspace ??= await realpath(path.resolve(workspace));
    if (ownedServer) return publicResult("reused");
    if (await probe()) return publicResult("reused");
    try {
      ownedServer = await createServer({
        workspace: canonicalWorkspace,
        host,
        port,
        taskchefVersion,
        serverVersion,
        launcher,
      });
      return publicResult("started");
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (await probe()) return publicResult("reused");
      throw error;
    }
  };

  return {
    async ensure() {
      if (closePromise) throw new Error("TaskChef dashboard manager is shutting down");
      if (ensurePromise) {
        await ensurePromise;
        return publicResult("reused");
      }
      ensurePromise = ensureOnce().finally(() => { ensurePromise = null; });
      return ensurePromise;
    },
    async close() {
      closePromise ??= (async () => {
        await ensurePromise?.catch(() => {});
        const server = ownedServer;
        ownedServer = null;
        await server?.close();
      })();
      return closePromise;
    },
    get owned() { return ownedServer !== null; },
  };
}
