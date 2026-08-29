import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const DASHBOARD_CONTROL_VERSION = 1;
export const DASHBOARD_OWNER_FILE = ".taskchef-dashboard-owner.json";
export const DASHBOARD_HANDOFF_FILE = ".taskchef-dashboard-handoff.json";
export const DASHBOARD_CONTROL_CHALLENGE_PATH = "/api/control/challenge";
export const DASHBOARD_CONTROL_SHUTDOWN_PATH = "/api/control/shutdown";
export const DASHBOARD_CONTROL_SESSION_PATH = "/api/control/session";
export const DASHBOARD_CONTROL_HANDOFF_PATH = "/api/control/handoff";
export const DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH = "/api/control/handoff/commit";

const OWNER_MAX_BYTES = 4_096;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{32,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

function ownerPath(workspace) {
  return path.join(workspace, DASHBOARD_OWNER_FILE);
}

function handoffPath(workspace) {
  return path.join(workspace, DASHBOARD_HANDOFF_FILE);
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function createDashboardControlSecret() {
  return randomBytes(32).toString("hex");
}

export function createDashboardControlNonce() {
  return randomBytes(24).toString("hex");
}

export function validDashboardControlSecret(secret) {
  return typeof secret === "string" && SECRET_PATTERN.test(secret);
}

export function dashboardControlProof(secret, action, nonce) {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`taskchef-dashboard-control-v${DASHBOARD_CONTROL_VERSION}:${action}:${nonce}`)
    .digest("hex");
}

export function validDashboardControlNonce(nonce) {
  return typeof nonce === "string" && NONCE_PATTERN.test(nonce);
}

export function verifyDashboardControlProof(secret, action, nonce, proof) {
  if (!validDashboardControlSecret(secret) || !validDashboardControlNonce(nonce)
      || typeof proof !== "string" || !SECRET_PATTERN.test(proof)) return false;
  const expected = Buffer.from(dashboardControlProof(secret, action, nonce), "hex");
  const supplied = Buffer.from(proof, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function dashboardOwnerMetadata({
  workspace,
  host,
  port,
  taskchefVersion,
  serverVersion,
  launcher,
  secret,
}) {
  return {
    schemaVersion: 1,
    service: "taskchef-dashboard-owner",
    controlVersion: DASHBOARD_CONTROL_VERSION,
    workspace,
    host,
    port,
    taskchefVersion,
    serverVersion,
    launcher,
    secret,
  };
}

export function dashboardHandoffMetadata({
  workspace,
  host,
  port,
  taskchefVersion,
  serverVersion,
  id,
  pids,
  secret,
}) {
  return {
    schemaVersion: 1,
    service: "taskchef-dashboard-handoff",
    controlVersion: DASHBOARD_CONTROL_VERSION,
    workspace,
    host,
    port,
    taskchefVersion,
    serverVersion,
    launcher: "session",
    id,
    pids,
    proof: dashboardControlProof(secret, `handoff-final:${JSON.stringify(pids)}`, id),
  };
}

function validOwner(value) {
  const keys = [
    "schemaVersion", "service", "controlVersion", "workspace", "host", "port",
    "taskchefVersion", "serverVersion", "launcher", "secret",
  ];
  return exactKeys(value, keys)
    && value.schemaVersion === 1
    && value.service === "taskchef-dashboard-owner"
    && value.controlVersion === DASHBOARD_CONTROL_VERSION
    && typeof value.workspace === "string"
    && LOOPBACK_HOSTS.has(value.host)
    && Number.isInteger(value.port) && value.port >= 0 && value.port <= 65_535
    && typeof value.taskchefVersion === "string"
    && typeof value.serverVersion === "string"
    && new Set(["mcp", "session"]).has(value.launcher)
    && typeof value.secret === "string" && SECRET_PATTERN.test(value.secret);
}

function validHandoff(value) {
  const keys = [
    "schemaVersion", "service", "controlVersion", "workspace", "host", "port",
    "taskchefVersion", "serverVersion", "launcher", "id", "pids", "proof",
  ];
  return exactKeys(value, keys)
    && value.schemaVersion === 1
    && value.service === "taskchef-dashboard-handoff"
    && value.controlVersion === DASHBOARD_CONTROL_VERSION
    && typeof value.workspace === "string"
    && LOOPBACK_HOSTS.has(value.host)
    && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65_535
    && typeof value.taskchefVersion === "string"
    && typeof value.serverVersion === "string"
    && value.launcher === "session"
    && validDashboardControlNonce(value.id)
    && Array.isArray(value.pids) && value.pids.length <= 64
    && value.pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)
    && new Set(value.pids).size === value.pids.length
    && typeof value.proof === "string" && SECRET_PATTERN.test(value.proof);
}

async function readPrivateJson(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw new Error("dashboard ownership record is not a private regular file");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("dashboard ownership record has a different owner");
    }
    if (info.size > OWNER_MAX_BYTES) throw new Error("dashboard ownership record is too large");
    const buffer = Buffer.alloc(OWNER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > OWNER_MAX_BYTES) throw new Error("dashboard ownership record is too large");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function readDashboardOwner(workspace) {
  const filePath = ownerPath(workspace);
  const value = await readPrivateJson(filePath);
  if (!validOwner(value) || value.workspace !== workspace) {
    throw new Error("dashboard owner record is invalid");
  }
  return value;
}

export async function readDashboardHandoff(workspace) {
  const value = await readPrivateJson(handoffPath(workspace));
  if (!validHandoff(value) || value.workspace !== workspace) {
    throw new Error("dashboard handoff record is invalid");
  }
  return value;
}

export async function writeDashboardOwner(workspace, value, { signal } = {}) {
  if (!validOwner(value) || value.workspace !== workspace) {
    throw new Error("dashboard owner record does not match its canonical workspace");
  }
  const filePath = ownerPath(workspace);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw Object.assign(new Error("dashboard owner publication was cancelled"), {
        code: "TASKCHEF_DASHBOARD_START_TIMEOUT",
      });
    }
  };
  try {
    throwIfAborted();
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
      throwIfAborted();
      await handle.sync();
      throwIfAborted();
    } finally {
      await handle.close();
    }
    throwIfAborted();
    await rename(temporary, filePath);
    await syncDirectory(workspace);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function writeDashboardHandoff(workspace, value) {
  if (!validHandoff(value) || value.workspace !== workspace) {
    throw new Error("dashboard handoff record does not match its canonical workspace");
  }
  const filePath = handoffPath(workspace);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    await syncDirectory(workspace);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
