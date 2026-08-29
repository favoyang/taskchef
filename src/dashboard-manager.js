import http from "node:http";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  DASHBOARD_HEALTH_MAX_BYTES,
  DASHBOARD_HEALTH_PATH,
  createDashboardServer,
  dashboardAuthority,
} from "./dashboard.js";
import {
  DASHBOARD_CONTROL_CHALLENGE_PATH,
  DASHBOARD_CONTROL_SHUTDOWN_PATH,
  createDashboardControlNonce,
  createDashboardControlSecret,
  dashboardControlProof,
  dashboardOwnerMetadata,
  readDashboardOwner,
  verifyDashboardControlProof,
  writeDashboardOwner,
} from "./dashboard-ownership.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const HEALTH_TIMEOUT_MS = 750;
const REUSE_MONITOR_INTERVAL_MS = 250;

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

function listenerConflict(url, detail, {
  staleTaskchefVersion,
  handoffRaceEligible = false,
  retryAuthentication = false,
} = {}) {
  const error = new Error(
    `TaskChef dashboard port conflict at ${url} ${detail} `
    + "Stop that listener or choose another port for the foreground dashboard CLI; TaskChef will not terminate it.",
  );
  error.code = "TASKCHEF_DASHBOARD_CONFLICT";
  if (staleTaskchefVersion) error.staleTaskchefVersion = staleTaskchefVersion;
  if (handoffRaceEligible) error.handoffRaceEligible = true;
  if (retryAuthentication) error.retryAuthentication = true;
  return error;
}

export function priorCompatibleVersion(candidate, current) {
  const parse = (value) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split(".") ?? null;
    if (prerelease?.some((identifier) => /^\d+$/.test(identifier)
        && identifier.length > 1 && identifier.startsWith("0"))) return null;
    return { core: match.slice(1, 4).map(BigInt), prerelease };
  };
  const left = parse(candidate);
  const right = parse(current);
  if (!left || !right) return false;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index];
  }
  if (left.prerelease === null || right.prerelease === null) {
    return left.prerelease !== null && right.prerelease === null;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric;
    return leftPart < rightPart;
  }
  return false;
}

function publicOwnerIdentity(owner) {
  return {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion: owner.taskchefVersion,
    serverVersion: owner.serverVersion,
    workspace: owner.workspace,
    launcher: owner.launcher,
  };
}

function requestDashboardJson({ host, port, path: requestPath, method = "GET", body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host,
      port,
      path: requestPath,
      method,
      headers: {
        Accept: "application/json",
        Host: dashboardAuthority(host, port),
        ...(encoded ? {
          "Content-Type": "application/json",
          "Content-Length": encoded.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > DASHBOARD_HEALTH_MAX_BYTES) request.destroy(
          new Error("dashboard control response exceeds the identity limit"),
        );
        else chunks.push(chunk);
      });
      response.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); } catch {
          reject(new Error("dashboard control returned invalid JSON"));
          return;
        }
        resolve({ statusCode: response.statusCode, value });
      });
    });
    const deadline = setTimeout(() => request.destroy(
      new Error("dashboard control request timed out"),
    ), timeoutMs);
    request.on("close", () => clearTimeout(deadline));
    request.on("error", reject);
    if (encoded) request.write(encoded);
    request.end();
  });
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
  readOwner = readDashboardOwner,
  writeOwner = writeDashboardOwner,
  reuseMonitorIntervalMs = REUSE_MONITOR_INTERVAL_MS,
} = {}) {
  let canonicalWorkspace;
  let ownedServer = null;
  let ownedSecret = null;
  let ensurePromise = null;
  let closePromise = null;
  let reuseMonitor = null;
  let reuseRecovery = null;
  let retired = false;

  const stopReuseMonitor = () => {
    if (reuseMonitor) clearInterval(reuseMonitor);
    reuseMonitor = null;
  };

  const closeOwned = async () => {
    const server = ownedServer;
    ownedServer = null;
    ownedSecret = null;
    await server?.close();
  };

  const publicResult = (action) => ({
    action,
    launcher,
    url: `http://${dashboardAuthority(host, ownedServer?.port ?? port)}/`,
    workspace: canonicalWorkspace,
    taskchefVersion,
    serverVersion,
  });

  const authenticatePriorOwner = async (identity) => {
    let owner;
    try {
      owner = await readOwner(canonicalWorkspace);
    } catch (error) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        `is a verified older TaskChef ${identity.taskchefVersion} listener without usable authenticated handoff metadata.`,
        {
          staleTaskchefVersion: identity.taskchefVersion,
          handoffRaceEligible: error?.code === "ENOENT",
          retryAuthentication: error?.code === "ENOENT",
        },
      );
    }
    if (owner.host !== host || owner.port !== port
        || !isExactIdentity(identity, publicOwnerIdentity(owner))) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        "has ownership metadata that does not exactly match the listener identity.",
        { staleTaskchefVersion: identity.taskchefVersion },
      );
    }
    const challengeNonce = createDashboardControlNonce();
    const challenge = await requestDashboardJson({
      host,
      port,
      path: `${DASHBOARD_CONTROL_CHALLENGE_PATH}?nonce=${challengeNonce}`,
      timeoutMs: HEALTH_TIMEOUT_MS,
    }).catch(() => null);
    if (challenge?.statusCode !== 200
        || challenge.value?.schemaVersion !== 1
        || challenge.value?.nonce !== challengeNonce
        || !verifyDashboardControlProof(
          owner.secret, "challenge", challengeNonce, challenge.value?.proof,
        )) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        "did not prove control of its private TaskChef ownership credential.",
        {
          staleTaskchefVersion: identity.taskchefVersion,
          handoffRaceEligible: challenge === null,
        },
      );
    }
    return owner;
  };

  const retirePriorOwner = async (identity) => {
    const owner = await authenticatePriorOwner(identity);
    const shutdownNonce = createDashboardControlNonce();
    const shutdown = await requestDashboardJson({
      host,
      port,
      path: DASHBOARD_CONTROL_SHUTDOWN_PATH,
      method: "POST",
      body: {
        nonce: shutdownNonce,
        proof: dashboardControlProof(owner.secret, "shutdown", shutdownNonce),
      },
      timeoutMs: HEALTH_TIMEOUT_MS,
    }).catch(() => null);
    if (shutdown?.statusCode !== 202 || shutdown.value?.accepted !== true) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        "refused authenticated TaskChef version handoff.",
        {
          staleTaskchefVersion: identity.taskchefVersion,
          handoffRaceEligible: shutdown === null || shutdown?.statusCode === 409,
        },
      );
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await readIdentity({ host, port, timeoutMs: 100 });
      } catch (error) {
        if (listenerAbsent(error) || error?.code === "ECONNRESET") return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw listenerConflict(
      `http://${dashboardAuthority(host, port)}/`,
      "accepted authenticated handoff but did not release the listener.",
      {
        staleTaskchefVersion: identity.taskchefVersion,
        handoffRaceEligible: true,
        retryAuthentication: true,
      },
    );
  };

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
    if (isExactIdentity(identity, expected)) return true;
    const compatiblePrior = identity?.schemaVersion === 1
      && identity?.service === "taskchef-dashboard"
      && identity?.workspace === canonicalWorkspace
      && identity?.launcher === "mcp"
      && identity?.serverVersion === serverVersion
      && priorCompatibleVersion(identity?.taskchefVersion, taskchefVersion);
    if (compatiblePrior) {
      try {
        await retirePriorOwner(identity);
        return false;
      } catch (handoffError) {
        if (!handoffError?.handoffRaceEligible) throw handoffError;
        let raceError = handoffError;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            const replacement = await readIdentity({ host, port, timeoutMs: 100 });
            if (isExactIdentity(replacement, expected)) return true;
            if (!isExactIdentity(replacement, identity)) throw raceError;
            if (raceError.retryAuthentication) {
              try {
                await retirePriorOwner(identity);
                return false;
              } catch (error) {
                if (!error?.handoffRaceEligible) throw error;
                raceError = error;
              }
            }
          } catch (error) {
            if (listenerAbsent(error) || error?.code === "ECONNRESET") return false;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw raceError;
      }
    }
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
      const secret = createDashboardControlSecret();
      const control = {
        secret,
        onShutdown: () => {
          retired = true;
          return closeOwned();
        },
      };
      ownedServer = await createServer({
        workspace: canonicalWorkspace,
        host,
        port,
        taskchefVersion,
        serverVersion,
        launcher,
        control,
      });
      ownedSecret = secret;
      try {
        await writeOwner(canonicalWorkspace, dashboardOwnerMetadata({
          workspace: canonicalWorkspace,
          host,
          port: ownedServer.port,
          taskchefVersion,
          serverVersion,
          launcher,
          secret,
        }));
      } catch (error) {
        await closeOwned().catch(() => {});
        throw error;
      }
      return publicResult("started");
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (await probe()) return publicResult("reused");
      throw error;
    }
  };

  const monitorExactReuse = () => {
    if (reuseMonitor || ownedServer || closePromise || retired) return;
    reuseMonitor = setInterval(() => {
      if (ownedServer || closePromise || retired || reuseRecovery) return;
      reuseRecovery = (async () => {
        try {
          const identity = await readIdentity({ host, port, timeoutMs: HEALTH_TIMEOUT_MS });
          const expected = expectedIdentity(
            canonicalWorkspace, taskchefVersion, serverVersion, launcher,
          );
          if (isExactIdentity(identity, expected)) return;
          // A replacement listener with any other identity is never touched. Keep
          // watching so this process can recover normally if that occupant exits.
        } catch (error) {
          if (!listenerAbsent(error) && error?.code !== "ECONNRESET") return;
          const result = await ensureOnce();
          if (result.action === "started" || ownedServer) stopReuseMonitor();
        }
      })().catch(() => {
        // Startup diagnostics remain available through an explicit ensure call.
      }).finally(() => {
        reuseRecovery = null;
      });
    }, reuseMonitorIntervalMs);
    reuseMonitor.unref?.();
  };

  return {
    async ensure() {
      if (closePromise || retired) throw new Error("TaskChef dashboard manager is shutting down");
      if (ensurePromise) {
        await ensurePromise;
        return publicResult("reused");
      }
      ensurePromise = ensureOnce().finally(() => { ensurePromise = null; });
      const result = await ensurePromise;
      if (result.action === "reused" && !ownedServer) monitorExactReuse();
      return result;
    },
    async close() {
      closePromise ??= (async () => {
        stopReuseMonitor();
        await ensurePromise?.catch(() => {});
        await reuseRecovery?.catch(() => {});
        const secret = ownedSecret;
        if (secret) await closeOwned();
        else {
          const server = ownedServer;
          ownedServer = null;
          await server?.close();
        }
      })();
      return closePromise;
    },
    get owned() { return ownedServer !== null; },
  };
}
