import { execFile as execFileCallback } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
} from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const taskchefPackage = require("../package.json");
const PINNED_CCUSAGE_VERSION = taskchefPackage.optionalDependencies?.ccusage;
const CCUSAGE_RESOLVER = fileURLToPath(new URL("./resolve-ccusage.js", import.meta.url));
let npxResolvedCcusageInvocation = null;
const USAGE_FILE_NAME = ".taskchef-usage.json";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];
const USAGE_STATUSES = new Set(["calculating", "available", "unavailable"]);
const MAX_USAGE_FILE_BYTES = 16 * 1024 * 1024;
const USAGE_WRITE_BUDGET_BYTES = 8 * 1024 * 1024;
const MAX_PERSISTED_TASKS = 1_000;
const MAX_PERSISTED_TURNS = 250;

function nonNegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function matchingSession(session, threadId) {
  const identity = `${session.sessionId ?? ""} ${session.sessionFile ?? ""}`;
  const [primaryThreadId] = identity.match(UUID_PATTERN) ?? [];
  return primaryThreadId?.toLowerCase() === threadId;
}

function normalizeModelUsage(models, name) {
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new Error(`${name}.models must be an object`);
  }
  return Object.fromEntries(Object.entries(models).map(([model, usage]) => {
    if (model.length === 0 || model.length > 256) throw new Error(`${name}.models has an invalid model name`);
    return [model, {
    inputTokens: nonNegativeNumber(usage.inputTokens, `${name}.models.${model}.inputTokens`),
    cachedInputTokens: nonNegativeNumber(usage.cacheReadTokens, `${name}.models.${model}.cacheReadTokens`),
    outputTokens: nonNegativeNumber(usage.outputTokens, `${name}.models.${model}.outputTokens`),
    reasoningOutputTokens: nonNegativeNumber(
      usage.reasoningOutputTokens,
      `${name}.models.${model}.reasoningOutputTokens`,
    ),
    totalTokens: nonNegativeNumber(usage.totalTokens, `${name}.models.${model}.totalTokens`),
    }];
  }));
}

function addModelUsage(target, source) {
  for (const [model, usage] of Object.entries(source)) {
    if (!Object.hasOwn(target, model)) {
      target[model] = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
    }
    for (const field of TOKEN_FIELDS) target[model][field] += usage[field];
  }
}

function timestampOrNull(value, name) {
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp or null`);
  }
  return value;
}

function normalizeProvenance(value, name, { includeSessionCount = false } = {}) {
  if (!value || value.provider !== "ccusage") {
    throw new Error(`${name}.provenance is invalid`);
  }
  return {
    provider: "ccusage",
    version: typeof value.version === "string" ? value.version.slice(0, 64) : null,
    pricingMode: value.pricingMode === "online" || value.pricingMode === "offline"
      ? value.pricingMode
      : null,
    costCoverage: value.costCoverage === "cache_writes_unverified"
      || value.costCoverage === "ccusage_reported"
      ? value.costCoverage
      : null,
    ...(includeSessionCount ? {
      sessionCount: nonNegativeNumber(value.sessionCount, `${name}.provenance.sessionCount`),
    } : {}),
  };
}

function normalizeStoredSnapshot(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const snapshot = Object.fromEntries(TOKEN_FIELDS.map((field) => [
    field,
    nonNegativeNumber(value[field], `${name}.${field}`),
  ]));
  if (value.estimatedCostUsd !== null) {
    snapshot.estimatedCostUsd = nonNegativeNumber(value.estimatedCostUsd, `${name}.estimatedCostUsd`);
  } else {
    snapshot.estimatedCostUsd = null;
  }
  snapshot.costStatus = value.costStatus === "estimated" ? "estimated" : "unavailable";
  const models = normalizeModelUsage(Object.fromEntries(Object.entries(value.models ?? {}).map(
    ([model, usage]) => [model, {
      ...usage,
      cacheReadTokens: usage.cachedInputTokens,
    }],
  )), name);
  if (Object.keys(models).length > 64 || Object.keys(models).some((model) => model.length > 256)) {
    throw new Error(`${name}.models exceeds the usage cache limit`);
  }
  snapshot.models = models;
  snapshot.provenance = normalizeProvenance(value.provenance, name, { includeSessionCount: true });
  if (snapshot.provenance.pricingMode === null || snapshot.provenance.costCoverage === null) {
    snapshot.estimatedCostUsd = null;
    snapshot.costStatus = "unavailable";
  }
  snapshot.sampledAt = timestampOrNull(value.sampledAt, `${name}.sampledAt`);
  snapshot.sourceUpdatedAt = timestampOrNull(value.sourceUpdatedAt, `${name}.sourceUpdatedAt`);
  return snapshot;
}

function normalizeStoredTurn(value, name) {
  if (!value || typeof value !== "object" || !USAGE_STATUSES.has(value.status)) {
    throw new Error(`${name} has an invalid status`);
  }
  const updatedAt = timestampOrNull(value.updatedAt, `${name}.updatedAt`);
  if (value.status === "available") {
    const normalized = Object.fromEntries(TOKEN_FIELDS.map((field) => [
      field,
      nonNegativeNumber(value[field], `${name}.${field}`),
    ]));
    normalized.estimatedCostUsd = value.estimatedCostUsd === null
      ? null
      : nonNegativeNumber(value.estimatedCostUsd, `${name}.estimatedCostUsd`);
    const provenance = normalizeProvenance(value.provenance, name);
    if (provenance.pricingMode === null || provenance.costCoverage === null) {
      normalized.estimatedCostUsd = null;
    }
    return {
      status: "available",
      ...normalized,
      costStatus: normalized.estimatedCostUsd === null ? "unavailable" : "estimated",
      provenance,
      sampledAt: timestampOrNull(value.sampledAt, `${name}.sampledAt`),
      sourceUpdatedAt: timestampOrNull(value.sourceUpdatedAt, `${name}.sourceUpdatedAt`),
      updatedAt,
    };
  }
  return {
    status: value.status,
    ...(value.status === "unavailable" ? {
      reason: typeof value.reason === "string" ? value.reason.slice(0, 256) : "Usage is unavailable.",
    } : {}),
    updatedAt,
  };
}

function normalizeStoredRecord(value, name) {
  if (!value || typeof value !== "object" || !USAGE_STATUSES.has(value.status)) {
    throw new Error(`${name} is invalid`);
  }
  const threadId = String(value.threadId ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(threadId)) {
    throw new Error(`${name}.threadId is invalid`);
  }
  const generationTurnRef = value.generationTurnRef ?? null;
  if (generationTurnRef !== null
    && (typeof generationTurnRef !== "string" || generationTurnRef.length === 0 || generationTurnRef.length > 256)) {
    throw new Error(`${name}.generationTurnRef is invalid`);
  }
  const zeroBaselineTurnRef = value.zeroBaselineTurnRef ?? null;
  if (zeroBaselineTurnRef !== null
    && (typeof zeroBaselineTurnRef !== "string" || zeroBaselineTurnRef.length === 0 || zeroBaselineTurnRef.length > 256)) {
    throw new Error(`${name}.zeroBaselineTurnRef is invalid`);
  }
  const generationTurnCount = nonNegativeNumber(
    value.generationTurnCount ?? 0,
    `${name}.generationTurnCount`,
  );
  const generationTerminal = value.generationTerminal === true;
  const normalizeMap = (entries, normalizer, mapName) => {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(`${mapName} must be an object`);
    }
    const pairs = Object.entries(entries);
    if (pairs.length > 10_000) throw new Error(`${mapName} exceeds the usage cache limit`);
    return Object.fromEntries(pairs.map(([key, item]) => [key, normalizer(item, `${mapName}.${key}`)]));
  };
  return {
    threadId,
    generationTurnRef,
    generationTurnCount,
    generationTerminal,
    zeroBaselineTurnRef,
    status: value.status,
    updatedAt: timestampOrNull(value.updatedAt, `${name}.updatedAt`),
    retryAfter: timestampOrNull(value.retryAfter ?? null, `${name}.retryAfter`),
    task: value.task === null ? null : normalizeStoredSnapshot(value.task, `${name}.task`),
    turns: normalizeMap(value.turns, normalizeStoredTurn, `${name}.turns`),
    boundaries: normalizeMap(value.boundaries, normalizeStoredSnapshot, `${name}.boundaries`),
    ...(value.status === "unavailable" ? {
      reason: typeof value.reason === "string" ? value.reason.slice(0, 256) : "Usage is unavailable.",
    } : {}),
  };
}

export function aggregateCcusageSessions(payload, threadId, {
  sampledAt = new Date().toISOString(),
  version = null,
  pricingMode = null,
} = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.sessions)) {
    throw new Error("ccusage output must contain a sessions array");
  }
  const normalizedThreadId = String(threadId).toLowerCase();
  const sessions = payload.sessions.filter((session) => matchingSession(session, normalizedThreadId));
  if (sessions.length === 0) throw new Error("ccusage could not resolve this Codex thread");

  const usage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  const models = Object.create(null);
  let estimatedCostUsd = 0;
  let hasUnpricedUsage = false;
  let sourceUpdatedAt = null;
  for (const [index, session] of sessions.entries()) {
    const name = `ccusage.sessions[${index}]`;
    usage.inputTokens += nonNegativeNumber(session.inputTokens, `${name}.inputTokens`);
    usage.cachedInputTokens += nonNegativeNumber(session.cacheReadTokens, `${name}.cacheReadTokens`);
    usage.outputTokens += nonNegativeNumber(session.outputTokens, `${name}.outputTokens`);
    usage.reasoningOutputTokens += nonNegativeNumber(
      session.reasoningOutputTokens,
      `${name}.reasoningOutputTokens`,
    );
    const sessionTotalTokens = nonNegativeNumber(session.totalTokens, `${name}.totalTokens`);
    usage.totalTokens += sessionTotalTokens;
    const sessionCost = session.costUSD === undefined || session.costUSD === null
      ? null
      : nonNegativeNumber(session.costUSD, `${name}.costUSD`);
    if (sessionCost !== null) estimatedCostUsd += sessionCost;
    if (sessionTotalTokens > 0 && (sessionCost === null || sessionCost === 0)) hasUnpricedUsage = true;
    addModelUsage(models, normalizeModelUsage(session.models, name));
    if (typeof session.lastActivity === "string" && !Number.isNaN(Date.parse(session.lastActivity))) {
      if (sourceUpdatedAt === null || Date.parse(session.lastActivity) > Date.parse(sourceUpdatedAt)) {
        sourceUpdatedAt = session.lastActivity;
      }
    }
  }

  return {
    ...usage,
    estimatedCostUsd: hasUnpricedUsage ? null : estimatedCostUsd,
    costStatus: hasUnpricedUsage ? "unavailable" : "estimated",
    models,
    provenance: {
      provider: "ccusage",
      version,
      pricingMode,
      costCoverage: Object.keys(models).some((model) => /^gpt-5\.6(?:-|$)/i.test(model))
        ? "cache_writes_unverified"
        : "ccusage_reported",
      sessionCount: sessions.length,
    },
    sampledAt,
    sourceUpdatedAt,
  };
}

export function managedCcusageInvocation({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  resolvePath = (id) => require.resolve(id),
  exists = existsSync,
  npxCliPath = null,
} = {}) {
  if (typeof PINNED_CCUSAGE_VERSION !== "string" || PINNED_CCUSAGE_VERSION.length === 0) {
    throw new Error("TaskChef has no pinned ccusage version");
  }
  const packageName = {
    "darwin-arm64": "@ccusage/ccusage-darwin-arm64",
    "darwin-x64": "@ccusage/ccusage-darwin-x64",
    "linux-arm64": "@ccusage/ccusage-linux-arm64",
    "linux-x64": "@ccusage/ccusage-linux-x64",
    "win32-arm64": "@ccusage/ccusage-win32-arm64",
    "win32-x64": "@ccusage/ccusage-win32-x64",
  }[`${platform}-${arch}`];
  let nativeBinary = null;
  if (packageName !== undefined) {
    try {
      nativeBinary = resolvePath(
        `${packageName}/bin/${platform === "win32" ? "ccusage.exe" : "ccusage"}`,
      );
    } catch {
      // Plugin-only installations can resolve the same pinned release through npx.
    }
  }
  if (nativeBinary !== null) {
    return {
      command: nativeBinary,
      args: [],
      version: PINNED_CCUSAGE_VERSION,
    };
  }
  if (packageName === undefined) {
    throw new Error(`ccusage does not support ${platform}-${arch}`);
  }
  const binaryName = platform === "win32" ? "ccusage.exe" : "ccusage";
  const npxArgs = [
    "--yes",
    "--prefer-offline",
    `--package=ccusage@${PINNED_CCUSAGE_VERSION}`,
    "node",
    CCUSAGE_RESOLVER,
    packageName,
    binaryName,
  ];
  if (platform === "win32") {
    const platformPath = path.win32;
    const nodeDirectory = platformPath.dirname(process.execPath);
    const candidates = [
      npxCliPath,
      typeof env.npm_execpath === "string"
        ? platformPath.join(platformPath.dirname(env.npm_execpath), "npx-cli.js")
        : null,
      platformPath.join(nodeDirectory, "node_modules", "npm", "bin", "npx-cli.js"),
      platformPath.resolve(
        nodeDirectory,
        "..", "lib", "node_modules", "npm", "bin", "npx-cli.js",
      ),
    ];
    const npxCli = candidates.find((candidate) => typeof candidate === "string"
      && platformPath.isAbsolute(candidate)
      && exists(candidate));
    if (npxCli === undefined) throw new Error("TaskChef could not resolve npm's npx CLI safely");
    return {
      command: process.execPath,
      args: [npxCli, ...npxArgs],
      version: PINNED_CCUSAGE_VERSION,
      resolvesNative: true,
    };
  }
  return {
    command: "npx",
    args: npxArgs,
    version: PINNED_CCUSAGE_VERSION,
    resolvesNative: true,
  };
}

export function ensureCcusageExecutable(command, {
  platform = process.platform,
} = {}) {
  if (platform === "win32") return;
  const descriptor = openSync(command, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile()) throw new Error("ccusage native binary is not a regular file");
    if ((file.mode & 0o100) === 0) fchmodSync(descriptor, file.mode | 0o100);
  } finally {
    closeSync(descriptor);
  }
}

async function resolveManagedCcusageInvocation(invocation, run, timeoutMs) {
  if (invocation.resolvesNative !== true) {
    ensureCcusageExecutable(invocation.command);
    return invocation;
  }
  if (npxResolvedCcusageInvocation !== null
    && existsSync(npxResolvedCcusageInvocation.command)) {
    ensureCcusageExecutable(npxResolvedCcusageInvocation.command);
    return npxResolvedCcusageInvocation;
  }
  npxResolvedCcusageInvocation = null;
  const result = await run(invocation.command, invocation.args, {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const command = String(result.stdout).trim();
  if (!path.isAbsolute(command)
    || !/^ccusage(?:\.exe)?$/iu.test(path.basename(command))
    || !existsSync(command)) {
    throw new Error("npx returned an invalid ccusage executable");
  }
  ensureCcusageExecutable(command);
  npxResolvedCcusageInvocation = {
    command,
    args: [],
    version: invocation.version,
  };
  return npxResolvedCcusageInvocation;
}

function processTable() {
  return new Promise((resolve) => {
    execFileCallback("ps", ["-axo", "pid=,ppid="], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 250,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(String(stdout).trim().split("\n").flatMap((line) => {
        const [pid, parentPid] = line.trim().split(/\s+/u).map(Number);
        return Number.isInteger(pid) && Number.isInteger(parentPid)
          ? [{ pid, parentPid }]
          : [];
      }));
    });
  });
}

async function descendantProcessIds(parentPid) {
  const table = await processTable();
  const visit = (pid) => table
    .filter((entry) => entry.parentPid === pid)
    .flatMap((entry) => [...visit(entry.pid), entry.pid]);
  return visit(parentPid);
}

async function terminateProcessTree(child, platform = process.platform) {
  if (!Number.isInteger(child.pid)) return;
  if (platform === "win32") {
    await new Promise((resolve) => {
      execFileCallback(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        { timeout: 500, windowsHide: true },
        () => {
          child.kill("SIGKILL");
          resolve();
        },
      );
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    return;
  } catch {
    // Resolve descendants only when process-group termination is unavailable.
  }
  let descendants = [];
  try {
    descendants = await descendantProcessIds(child.pid);
  } catch {
    // The detached process-group kill remains the fallback when ps is unavailable.
  }
  for (const pid of descendants) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The group kill or normal process exit may have won the race.
    }
  }
  child.kill("SIGKILL");
}

export function runBoundedProcess(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const timeout = options.timeout ?? 0;
  const { platform: _platform, ...childOptions } = options;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer = null;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const child = execFileCallback(command, args, {
      ...childOptions,
      timeout: undefined,
      detached: platform !== "win32",
      windowsHide: true,
    }, async (error, stdout, stderr) => {
      if (timer !== null) clearTimeout(timer);
      if (timedOut || settled) return;
      if (error) {
        await terminateProcessTree(child, platform);
        rejectOnce(error);
        return;
      }
      settled = true;
      resolve({ stdout, stderr });
    });
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const timeoutError = new Error(`${command} timed out`);
        timeoutError.code = "ETIMEDOUT";
        timeoutError.killed = true;
        Promise.race([
          terminateProcessTree(child, platform),
          new Promise((resolveTermination) => setTimeout(resolveTermination, 750)),
        ]).catch(() => {}).then(() => rejectOnce(timeoutError));
      }, timeout);
      timer.unref();
    }
  });
}

export async function readCcusageThreadUsage(threadId, {
  command = null,
  commandArgs = [],
  run = runBoundedProcess,
  sampledAt = new Date().toISOString(),
  timeoutMs = 8_000,
} = {}) {
  const invocation = command === null
    ? managedCcusageInvocation()
    : { command, args: commandArgs, version: null };
  const resolvedInvocation = command === null
    ? await resolveManagedCcusageInvocation(invocation, run, timeoutMs)
    : invocation;
  const invoke = (args, options) => run(
    resolvedInvocation.command,
    [...resolvedInvocation.args, ...args],
    options,
  );
  let version = resolvedInvocation.version;
  if (version === null) {
    try {
      const result = await invoke(["--version"], {
        timeout: Math.min(timeoutMs, 2_000),
        maxBuffer: 64 * 1024,
      });
      version = String(result.stdout).trim().replace(/^ccusage\s+/i, "") || null;
    } catch {
      // Usage remains useful if a custom compatible ccusage cannot print its version.
    }
  }
  const report = async (pricingMode) => {
    let result;
    try {
      result = await invoke([
        "codex", "session", "--json",
        pricingMode === "online" ? "--no-offline" : "--offline",
      ], {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("ccusage is not installed");
      if (error?.killed || error?.code === "ETIMEDOUT") throw new Error("ccusage timed out");
      throw new Error("ccusage could not read Codex usage");
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("ccusage returned malformed JSON");
    }
    return aggregateCcusageSessions(payload, threadId, {
      sampledAt,
      version,
      pricingMode,
    });
  };
  try {
    return await report("online");
  } catch (onlineError) {
    try {
      return await report("offline");
    } catch {
      throw onlineError;
    }
  }
}

function usageFile(workspace) {
  return path.join(workspace, USAGE_FILE_NAME);
}

export async function readUsageStore(workspace) {
  const filePath = usageFile(workspace);
  const details = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (details === null) return { schemaVersion: 1, tasks: {} };
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("TaskChef usage cache must be a regular file");
  }
  if (details.size > MAX_USAGE_FILE_BYTES) {
    return { schemaVersion: 1, tasks: {} };
  }
  const value = JSON.parse(await readFile(filePath, "utf8"));
  if (value?.schemaVersion !== 1 || !value.tasks || typeof value.tasks !== "object") {
    throw new Error("TaskChef usage cache has an unsupported schema");
  }
  const tasks = Object.entries(value.tasks);
  if (tasks.length > 2_000) return { schemaVersion: 1, tasks: {} };
  return {
    schemaVersion: 1,
    tasks: Object.fromEntries(tasks.map(([taskId, record]) => [
      taskId,
      normalizeStoredRecord(record, `usage task ${taskId}`),
    ])),
  };
}

function compactUsageRecord(record) {
  const turnEntries = Object.entries(record.turns ?? {}).slice(-MAX_PERSISTED_TURNS);
  const boundaryEntries = Object.entries(record.boundaries ?? {}).slice(-1);
  return {
    ...record,
    turns: Object.fromEntries(turnEntries),
    boundaries: Object.fromEntries(boundaryEntries),
  };
}

export function compactUsageStore(store) {
  const entries = Object.entries(store.tasks ?? {})
    .sort(([, left], [, right]) => Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0))
    .slice(0, MAX_PERSISTED_TASKS);
  const tasks = {};
  let approximateBytes = 64;
  for (const [taskId, record] of entries) {
    const compacted = compactUsageRecord(record);
    const entryBytes = Buffer.byteLength(JSON.stringify([taskId, compacted]), "utf8");
    if (Object.keys(tasks).length > 0 && approximateBytes + entryBytes > USAGE_WRITE_BUDGET_BYTES) break;
    tasks[taskId] = compacted;
    approximateBytes += entryBytes;
  }
  return { schemaVersion: 1, tasks };
}

export async function writeUsageStore(workspace, store) {
  await mkdir(workspace, { recursive: true });
  const filePath = usageFile(workspace);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(compactUsageStore(store), null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_USAGE_FILE_BYTES) {
    throw new Error("TaskChef usage cache cannot be compacted below the size limit");
  }
  await writeFile(temporaryPath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export function usageDelta(current, previous = null) {
  const baseline = previous ?? Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  const delta = {};
  for (const field of TOKEN_FIELDS) {
    const value = current[field] - baseline[field];
    if (!Number.isFinite(value) || value < 0) return null;
    delta[field] = value;
  }
  const samePricingSource = previous === null || ["version", "pricingMode", "costCoverage"]
    .every((field) => current.provenance?.[field] === previous.provenance?.[field]);
  let estimatedCostUsd = !samePricingSource
    || current.estimatedCostUsd === null
    || (previous !== null && previous.estimatedCostUsd === null)
    ? null
    : current.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
  if (estimatedCostUsd !== null && (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0)) {
    estimatedCostUsd = null;
  }
  if (estimatedCostUsd === 0 && delta.totalTokens > 0) estimatedCostUsd = null;
  return {
    ...delta,
    estimatedCostUsd,
    costStatus: estimatedCostUsd === null ? "unavailable" : "estimated",
  };
}
