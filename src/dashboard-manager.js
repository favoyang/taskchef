import http from "node:http";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DASHBOARD_HEALTH_MAX_BYTES,
  DASHBOARD_HEALTH_PATH,
  dashboardAuthority,
} from "./dashboard.js";
import {
  DASHBOARD_CONTROL_CHALLENGE_PATH,
  DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH,
  DASHBOARD_CONTROL_HANDOFF_PATH,
  DASHBOARD_CONTROL_SESSION_PATH,
  DASHBOARD_CONTROL_SHUTDOWN_PATH,
  createDashboardControlNonce,
  createDashboardControlSecret,
  dashboardControlProof,
  readDashboardHandoff,
  readDashboardOwner,
  validDashboardControlNonce,
  verifyDashboardControlProof,
} from "./dashboard-ownership.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "./version.js";
import {
  MAX_DASHBOARD_SESSION_PIDS,
  MAX_TRANSFERRED_DASHBOARD_SESSION_PIDS,
  validSessionPid,
} from "./dashboard-session.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const HEALTH_TIMEOUT_MS = 750;
const SESSION_START_ATTEMPTS = 80;
const SESSION_START_INTERVAL_MS = 25;
const HANDOFF_CONVERGENCE_ATTEMPTS = SESSION_START_ATTEMPTS * 3;
const SESSION_READY_TIMEOUT_MS = 15_000;
const OWNER_AUTH_DEFAULT_TIMEOUT_MS = 1_000;
const MAX_VERSION_REPLACEMENT_ATTEMPTS = 8;
const SESSION_PROCESS_PATH = fileURLToPath(new URL("../mcp/dashboard-session.js", import.meta.url));

export function launchDashboardSession({
  workspace,
  host,
  port,
  secret,
  sessionPid,
  sessionPids = [],
  processPath = process.execPath,
  spawnProcess = spawn,
  readyTimeoutMs = SESSION_READY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(processPath, [SESSION_PROCESS_PATH], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        TASKCHEF_DASHBOARD_WORKSPACE: workspace,
        TASKCHEF_DASHBOARD_HOST: host,
        TASKCHEF_DASHBOARD_PORT: String(port),
        TASKCHEF_DASHBOARD_SECRET: secret,
        TASKCHEF_DASHBOARD_SESSION_PID: String(sessionPid),
        TASKCHEF_DASHBOARD_SESSION_PIDS: JSON.stringify(sessionPids),
      },
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
        error.code = typeof message.code === "string"
          ? message.code
          : "TASKCHEF_DASHBOARD_START_FAILED";
        finish(reject, error);
      }
    };
    const timer = setTimeout(() => {
      const error = new Error("TaskChef dashboard session readiness timed out");
      error.code = "TASKCHEF_DASHBOARD_START_TIMEOUT";
      finish(reject, error, { disconnect: false });
      if (child.connected) {
        try {
          child.send({ type: "cancel" }, () => {
            if (child.connected) child.disconnect();
          });
        } catch {
          if (child.connected) child.disconnect();
        }
      }
    }, readyTimeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

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

export function requestDashboardJson({ host, port, path: requestPath, method = "GET", body, timeoutMs }) {
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
  launcher = "session",
  sessionPid = process.ppid,
  launchSession = launchDashboardSession,
  readIdentity = readDashboardIdentity,
  readOwner = readDashboardOwner,
  readHandoff = readDashboardHandoff,
  requestJson = requestDashboardJson,
  ownerAuthTimeoutMs = SESSION_READY_TIMEOUT_MS,
  handoffConvergenceAttempts = HANDOFF_CONVERGENCE_ATTEMPTS,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("dashboard manager port must be an integer from 1 to 65535");
  }
  if (!Number.isFinite(ownerAuthTimeoutMs) || ownerAuthTimeoutMs <= 0) {
    throw new Error("dashboard owner authentication timeout must be positive");
  }
  let canonicalWorkspace;
  let ensurePromise = null;
  let closePromise = null;
  let handoffSessionPids = [];

  const settleBeforeDeadline = (promise, deadline) => {
    const operation = Promise.resolve(promise);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      operation.catch(() => {});
      return Promise.reject(Object.assign(new Error("dashboard ownership deadline expired"), {
        code: "TASKCHEF_DASHBOARD_OWNER_TIMEOUT",
      }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(
        new Error("dashboard ownership operation timed out"),
        { code: "TASKCHEF_DASHBOARD_OWNER_TIMEOUT" },
      )), remaining);
      operation.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  };

  const publicResult = (action) => ({
    action,
    launcher,
    url: `http://${dashboardAuthority(host, port)}/`,
    workspace: canonicalWorkspace,
    taskchefVersion,
    serverVersion,
  });

  const authenticateOwner = async (identity) => {
    let observedOwner = null;
    let matchingOwner = null;
    let lastChallenge = null;
    let ownershipDeadlineExpired = false;
    let challengeUnavailable = false;
    const ownerMatches = (candidate) => candidate?.host === host && candidate?.port === port
      && isExactIdentity(identity, publicOwnerIdentity(candidate));
    const currentIdentity = expectedIdentity(
      canonicalWorkspace, taskchefVersion, serverVersion, launcher,
    );
    const recognizedStartingSession = identity?.schemaVersion === 1
      && identity?.service === "taskchef-dashboard"
      && identity?.workspace === canonicalWorkspace
      && identity?.launcher === "session"
      && (isExactIdentity(identity, currentIdentity)
        || priorCompatibleVersion(identity?.taskchefVersion, taskchefVersion));
    const deadline = Date.now() + (recognizedStartingSession
      ? ownerAuthTimeoutMs
      : Math.min(ownerAuthTimeoutMs, OWNER_AUTH_DEFAULT_TIMEOUT_MS));
    do {
      try {
        const owner = await settleBeforeDeadline(readOwner(canonicalWorkspace), deadline);
        observedOwner = owner;
        if (ownerMatches(owner)) {
          matchingOwner = owner;
          const challengeNonce = createDashboardControlNonce();
          lastChallenge = await requestJson({
            host,
            port,
            path: `${DASHBOARD_CONTROL_CHALLENGE_PATH}?nonce=${challengeNonce}`,
            timeoutMs: Math.max(1, Math.min(HEALTH_TIMEOUT_MS, deadline - Date.now())),
          }).catch((error) => {
            if (Date.now() >= deadline || /timed out/i.test(error?.message ?? "")) {
              ownershipDeadlineExpired = true;
            } else {
              challengeUnavailable = true;
            }
            return null;
          });
          if (lastChallenge?.statusCode === 200
              && lastChallenge.value?.schemaVersion === 1
              && lastChallenge.value?.nonce === challengeNonce
              && verifyDashboardControlProof(
                owner.secret,
                "challenge",
                challengeNonce,
                lastChallenge.value?.proof,
              )) {
            return owner;
          }
          if (challengeUnavailable) break;
        } else if (owner.host === host && owner.port === port
            && priorCompatibleVersion(taskchefVersion, owner.taskchefVersion)) {
          break;
        }
      } catch (error) {
        if (error?.code === "TASKCHEF_DASHBOARD_OWNER_TIMEOUT") {
          ownershipDeadlineExpired = true;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(SESSION_START_INTERVAL_MS, remaining),
      ));
    } while (Date.now() < deadline);
    if (!matchingOwner) {
      const priorVersion = identity.taskchefVersion !== taskchefVersion;
      if (observedOwner) {
        throw listenerConflict(
          `http://${dashboardAuthority(host, port)}/`,
          "has ownership metadata that does not exactly match the listener identity.",
          { staleTaskchefVersion: priorVersion ? identity.taskchefVersion : undefined },
        );
      }
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        priorVersion
          ? `is a verified older TaskChef ${identity.taskchefVersion} listener without usable authenticated handoff metadata.`
          : `is a verified TaskChef ${identity.taskchefVersion} session listener without usable authenticated ownership metadata.`,
        {
          staleTaskchefVersion: priorVersion ? identity.taskchefVersion : undefined,
        },
      );
    }
    throw listenerConflict(
      `http://${dashboardAuthority(host, port)}/`,
      "did not prove control of its private TaskChef ownership credential.",
      {
        staleTaskchefVersion: identity.taskchefVersion !== taskchefVersion
          ? identity.taskchefVersion
          : undefined,
        handoffRaceEligible: !ownershipDeadlineExpired && lastChallenge === null,
      },
    );
  };

  const recoverFinalHandoff = async (
    owner,
    expectedId,
    deadline = Date.now() + ownerAuthTimeoutMs,
  ) => {
    let handoff;
    try {
      handoff = await settleBeforeDeadline(readHandoff(canonicalWorkspace), deadline);
    } catch {
      return null;
    }
    const pids = handoff?.pids;
    if (handoff?.workspace !== canonicalWorkspace || handoff?.host !== host
        || handoff?.port !== port || handoff?.launcher !== "session"
        || handoff?.taskchefVersion !== owner.taskchefVersion
        || handoff?.serverVersion !== owner.serverVersion
        || (expectedId !== undefined && handoff?.id !== expectedId)
        || !Array.isArray(pids) || pids.length > MAX_TRANSFERRED_DASHBOARD_SESSION_PIDS
        || pids.some((pid) => !validSessionPid(pid))
        || new Set(pids).size !== pids.length
        || !verifyDashboardControlProof(
          owner.secret,
          `handoff-final:${JSON.stringify(pids)}`,
          handoff?.id,
          handoff?.proof,
        )) return null;
    return pids;
  };

  const registerSession = async (identity) => {
    const owner = await authenticateOwner(identity);
    const nonce = createDashboardControlNonce();
    const registration = await requestJson({
      host,
      port,
      path: DASHBOARD_CONTROL_SESSION_PATH,
      method: "POST",
      body: {
        pid: sessionPid,
        nonce,
        proof: dashboardControlProof(owner.secret, `session:${sessionPid}`, nonce),
      },
      timeoutMs: HEALTH_TIMEOUT_MS,
    }).catch(() => null);
    if (registration?.statusCode !== 200 || registration.value?.accepted !== true
        || registration.value?.nonce !== nonce
        || !verifyDashboardControlProof(
          owner.secret,
          `session-accepted:${sessionPid}`,
          nonce,
          registration.value?.proof,
        )) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        "refused authenticated Codex-session registration.",
        {
          handoffRaceEligible: registration === null
            || registration?.value?.reason === "retiring",
        },
      );
    }
    return owner;
  };

  const retirePriorOwner = async (identity) => {
    const owner = await authenticateOwner(identity);
    let sessionPids = [];
    if (identity.launcher === "session") {
      let handoff = null;
      let handoffNonce;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        handoffNonce = createDashboardControlNonce();
        handoff = await requestJson({
          host,
          port,
          path: DASHBOARD_CONTROL_HANDOFF_PATH,
          method: "POST",
          body: {
            pid: sessionPid,
            nonce: handoffNonce,
            proof: dashboardControlProof(owner.secret, `handoff:${sessionPid}`, handoffNonce),
          },
          timeoutMs: HEALTH_TIMEOUT_MS,
        }).catch(() => null);
        if (handoff !== null) break;
      }
      const pids = handoff?.value?.pids;
      const handoffId = handoff?.value?.id;
      if (handoff?.statusCode !== 200 || handoff.value?.accepted !== true
          || !validDashboardControlNonce(handoffId)
          || !Array.isArray(pids)
          || pids.length > MAX_DASHBOARD_SESSION_PIDS
          || pids.some((pid) => !validSessionPid(pid))
          || new Set(pids).size !== pids.length
          || !pids.includes(sessionPid)
          || handoff.value?.nonce !== handoffNonce
          || !verifyDashboardControlProof(
            owner.secret,
            `handoff-prepared:${sessionPid}:${handoffId}:${JSON.stringify(pids)}`,
            handoffNonce,
            handoff.value?.proof,
          )) {
        throw listenerConflict(
          `http://${dashboardAuthority(host, port)}/`,
          "refused authenticated TaskChef session handoff.",
          {
            staleTaskchefVersion: identity.taskchefVersion,
            handoffRaceEligible: handoff === null || handoff?.value?.reason === "retiring",
          },
        );
      }
      sessionPids = pids;
      let committed = false;
      let commitResponseLost = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const commitNonce = createDashboardControlNonce();
        const commit = await requestJson({
          host,
          port,
          path: DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH,
          method: "POST",
          body: {
            id: handoffId,
            nonce: commitNonce,
            proof: dashboardControlProof(owner.secret, `handoff-commit:${handoffId}`, commitNonce),
          },
          timeoutMs: HEALTH_TIMEOUT_MS,
        }).catch(() => null);
        const committedPids = commit?.value?.pids;
        if (commit?.statusCode === 202 && commit.value?.accepted === true
            && commit.value?.id === handoffId && commit.value?.nonce === commitNonce
            && Array.isArray(committedPids)
            && committedPids.length <= MAX_TRANSFERRED_DASHBOARD_SESSION_PIDS
            && committedPids.every((pid) => validSessionPid(pid))
            && new Set(committedPids).size === committedPids.length
            && committedPids.includes(sessionPid)
            && verifyDashboardControlProof(
              owner.secret,
              `handoff-committed:${handoffId}:${JSON.stringify(committedPids)}`,
              commitNonce,
              commit.value?.proof,
            )) {
          sessionPids = committedPids;
          committed = true;
          break;
        }
        if (commit === null) {
          commitResponseLost = true;
          try {
            await readIdentity({ host, port, timeoutMs: 100 });
          } catch (error) {
            if (listenerAbsent(error) || error?.code === "ECONNRESET") {
              const recovered = await recoverFinalHandoff(owner, handoffId);
              if (recovered) return recovered;
              throw listenerConflict(
                `http://${dashboardAuthority(host, port)}/`,
                "closed before its authenticated final lease snapshot could be recovered.",
                { staleTaskchefVersion: identity.taskchefVersion },
              );
            }
            throw error;
          }
          continue;
        }
        break;
      }
      if (!committed && commitResponseLost) {
        const recoveryDeadline = Date.now() + ownerAuthTimeoutMs;
        let recovered = null;
        do {
          recovered ??= await recoverFinalHandoff(owner, handoffId, recoveryDeadline);
          try {
            await readIdentity({ host, port, timeoutMs: 100 });
          } catch (error) {
            if (listenerAbsent(error) || error?.code === "ECONNRESET") {
              recovered ??= await recoverFinalHandoff(owner, handoffId, recoveryDeadline);
              if (recovered) return recovered;
              break;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, SESSION_START_INTERVAL_MS));
        } while (Date.now() < recoveryDeadline);
      }
      if (!committed) {
        throw listenerConflict(
          `http://${dashboardAuthority(host, port)}/`,
          "refused authenticated TaskChef session handoff commit.",
          { staleTaskchefVersion: identity.taskchefVersion },
        );
      }
    } else {
      const shutdownNonce = createDashboardControlNonce();
      const shutdown = await requestJson({
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
    }
    for (let attempt = 0; attempt < SESSION_START_ATTEMPTS; attempt += 1) {
      try {
        await readIdentity({ host, port, timeoutMs: 100 });
      } catch (error) {
        if (listenerAbsent(error) || error?.code === "ECONNRESET") return sessionPids;
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

  const waitForPriorSessionReplacement = async () => {
    const deadline = Date.now() + ownerAuthTimeoutMs;
    let owner;
    try {
      owner = await settleBeforeDeadline(readOwner(canonicalWorkspace), deadline);
    } catch {
      return false;
    }
    const priorIdentity = publicOwnerIdentity(owner);
    const expected = expectedIdentity(canonicalWorkspace, taskchefVersion, serverVersion, launcher);
    const ownerIsCurrent = isExactIdentity(priorIdentity, expected);
    const ownerIsPrior = priorCompatibleVersion(owner.taskchefVersion, taskchefVersion);
    const ownerIsNewer = priorCompatibleVersion(taskchefVersion, owner.taskchefVersion);
    if (owner.host === host && owner.port === port && owner.launcher === "session"
        && ownerIsNewer) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        `has retained ownership from newer TaskChef ${owner.taskchefVersion}; refusing to downgrade it.`,
      );
    }
    if (owner.host !== host || owner.port !== port || owner.launcher !== "session"
        || (!ownerIsCurrent && !ownerIsPrior)) return false;
    let finalizedCurrentOwner = false;
    let recoveredPriorOwner = false;
    const recoveredAtStart = await recoverFinalHandoff(owner, undefined, deadline);
    if (recoveredAtStart) {
      if (ownerIsPrior) {
        handoffSessionPids = recoveredAtStart;
        recoveredPriorOwner = true;
      }
      if (ownerIsCurrent) finalizedCurrentOwner = true;
    }
    if (ownerIsCurrent && !finalizedCurrentOwner) return false;
    do {
      await new Promise((resolve) => setTimeout(resolve, SESSION_START_INTERVAL_MS));
      let replacement;
      try {
        replacement = await readIdentity({ host, port, timeoutMs: 100 });
      } catch (error) {
        if (listenerAbsent(error) || error?.code === "ECONNRESET") {
          if (ownerIsPrior) {
            const recovered = await recoverFinalHandoff(owner, undefined, deadline);
            if (recovered) {
              handoffSessionPids = recovered;
              recoveredPriorOwner = true;
              return false;
            }
          } else if (ownerIsCurrent) {
            finalizedCurrentOwner ||= Boolean(
              await recoverFinalHandoff(owner, undefined, deadline),
            );
          }
          continue;
        }
        throw error;
      }
      if (isExactIdentity(replacement, expected)) {
        await registerSession(replacement);
        return true;
      }
      if (isExactIdentity(replacement, priorIdentity)) {
        if (ownerIsCurrent) {
          await registerSession(replacement);
          return true;
        }
        if (recoveredPriorOwner) continue;
        handoffSessionPids = await retirePriorOwner(replacement);
        return false;
      }
      const replacementIsNewer = replacement?.schemaVersion === 1
        && replacement?.service === "taskchef-dashboard"
        && replacement?.workspace === canonicalWorkspace
        && replacement?.launcher === "session"
        && priorCompatibleVersion(taskchefVersion, replacement?.taskchefVersion);
      if (replacementIsNewer) {
        throw listenerConflict(
          `http://${dashboardAuthority(host, port)}/`,
          `belongs to newer TaskChef ${replacement.taskchefVersion}; refusing to downgrade it.`,
        );
      }
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        "changed to an unexpected listener during authenticated version handoff.",
      );
    } while (Date.now() < deadline);
    if (finalizedCurrentOwner) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        `TaskChef ${taskchefVersion} has already finalized retirement; refusing to relaunch it.`,
      );
    }
    if (recoveredPriorOwner) {
      throw listenerConflict(
        `http://${dashboardAuthority(host, port)}/`,
        "has a verified final handoff snapshot but did not release the listener.",
        { staleTaskchefVersion: owner.taskchefVersion },
      );
    }
    return false;
  };

  const probe = async () => {
    const url = `http://${dashboardAuthority(host, port)}/`;
    let identity;
    try {
      identity = await readIdentity({ host, port });
    } catch (error) {
      if (listenerAbsent(error) || error?.code === "ECONNRESET") {
        return waitForPriorSessionReplacement();
      }
      throw listenerConflict(url, `is occupied but did not return a compatible identity (${error.message}).`);
    }
    const expected = expectedIdentity(canonicalWorkspace, taskchefVersion, serverVersion, launcher);
    if (isExactIdentity(identity, expected)) {
      try {
        await registerSession(identity);
        return true;
      } catch (registrationError) {
        if (!registrationError?.handoffRaceEligible) throw registrationError;
        let lastError = registrationError;
        for (let attempt = 0; attempt < SESSION_START_ATTEMPTS; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, SESSION_START_INTERVAL_MS));
          let replacement;
          try {
            replacement = await readIdentity({ host, port, timeoutMs: 100 });
          } catch (error) {
            if (listenerAbsent(error) || error?.code === "ECONNRESET") return false;
            throw error;
          }
          if (!isExactIdentity(replacement, expected)) throw registrationError;
          try {
            await registerSession(replacement);
            return true;
          } catch (error) {
            if (!error?.handoffRaceEligible) throw error;
            lastError = error;
          }
        }
        throw lastError;
      }
    }
    const compatiblePrior = identity?.schemaVersion === 1
      && identity?.service === "taskchef-dashboard"
      && identity?.workspace === canonicalWorkspace
      && new Set(["mcp", "session"]).has(identity?.launcher)
      && priorCompatibleVersion(identity?.taskchefVersion, taskchefVersion);
    if (compatiblePrior) {
      try {
        handoffSessionPids = await retirePriorOwner(identity);
        return false;
      } catch (handoffError) {
        if (!handoffError?.handoffRaceEligible) throw handoffError;
        let raceError = handoffError;
        try {
          const reused = await waitForPriorSessionReplacement();
          if (reused || handoffSessionPids.length > 0) return reused;
        } catch (error) {
          if (!error?.handoffRaceEligible) throw error;
          raceError = error;
        }
        let sawAbsent = false;
        for (let attempt = 0; attempt < handoffConvergenceAttempts; attempt += 1) {
          try {
            const replacement = await readIdentity({ host, port, timeoutMs: 100 });
            if (isExactIdentity(replacement, expected)) {
              await registerSession(replacement);
              return true;
            }
            if (!isExactIdentity(replacement, identity)) throw raceError;
            try {
              handoffSessionPids = await retirePriorOwner(identity);
              return false;
            } catch (error) {
              if (!error?.handoffRaceEligible) throw error;
              raceError = error;
            }
          } catch (error) {
            if (listenerAbsent(error) || error?.code === "ECONNRESET") {
              sawAbsent = true;
              await new Promise((resolve) => setTimeout(resolve, 25));
              continue;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (sawAbsent) return false;
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
    if (await probe()) return publicResult("reused");
    for (let replacementAttempt = 0;
      replacementAttempt < MAX_VERSION_REPLACEMENT_ATTEMPTS;
      replacementAttempt += 1) {
      const secret = createDashboardControlSecret();
      try {
        await launchSession({
          workspace: canonicalWorkspace,
          host,
          port,
          secret,
          sessionPid,
          sessionPids: handoffSessionPids,
          taskchefVersion,
          serverVersion,
        });
      } catch (error) {
        // Concurrent activations can both observe a free port before one binds it.
        // The loser must authenticate and reuse or upgrade the winner.
        if (error?.code !== "EADDRINUSE") throw error;
      }
      let lastError = null;
      let retryAfterLowerVersion = false;
      for (let attempt = 0; attempt < SESSION_START_ATTEMPTS; attempt += 1) {
        try {
          const identity = await readIdentity({ host, port, timeoutMs: 100 });
          const expected = expectedIdentity(
            canonicalWorkspace, taskchefVersion, serverVersion, launcher,
          );
          if (!isExactIdentity(identity, expected)) {
            const compatibleLower = identity?.schemaVersion === 1
              && identity?.service === "taskchef-dashboard"
              && identity?.workspace === canonicalWorkspace
              && new Set(["mcp", "session"]).has(identity?.launcher)
              && priorCompatibleVersion(identity?.taskchefVersion, taskchefVersion);
            if (compatibleLower) {
              if (await probe()) return publicResult("reused");
              retryAfterLowerVersion = true;
              break;
            }
            throw listenerConflict(
              `http://${dashboardAuthority(host, port)}/`,
              "changed to an unexpected listener while the dashboard session was starting.",
            );
          }
          const owner = await registerSession(identity);
          return publicResult(owner.secret === secret ? "started" : "reused");
        } catch (error) {
          if (!listenerAbsent(error) && error?.code !== "ECONNRESET"
              && error?.code !== "ENOENT" && !error?.handoffRaceEligible) throw error;
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, SESSION_START_INTERVAL_MS));
      }
      if (retryAfterLowerVersion) continue;
      const error = new Error(
        `TaskChef dashboard session did not become available at http://${dashboardAuthority(host, port)}/`,
        { cause: lastError },
      );
      error.code = "TASKCHEF_DASHBOARD_START_TIMEOUT";
      throw error;
    }
    throw listenerConflict(
      `http://${dashboardAuthority(host, port)}/`,
      "changed versions too many times during concurrent authenticated startup.",
    );
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
      })();
      return closePromise;
    },
    get owned() { return false; },
  };
}
