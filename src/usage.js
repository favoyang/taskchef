import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFile = promisify(execFileCallback);
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
    return {
      status: "available",
      ...normalized,
      costStatus: normalized.estimatedCostUsd === null ? "unavailable" : "estimated",
      provenance: normalizeProvenance(value.provenance, name),
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
      sessionCount: sessions.length,
    },
    sampledAt,
    sourceUpdatedAt,
  };
}

export async function readCcusageThreadUsage(threadId, {
  command = "ccusage",
  run = execFile,
  sampledAt = new Date().toISOString(),
  timeoutMs = 8_000,
} = {}) {
  let version = null;
  try {
    const result = await run(command, ["--version"], {
      timeout: Math.min(timeoutMs, 2_000),
      maxBuffer: 64 * 1024,
    });
    version = String(result.stdout).trim().replace(/^ccusage\s+/i, "") || null;
  } catch {
    // Usage remains useful if an older compatible ccusage cannot print its version.
  }
  let result;
  try {
    result = await run(command, ["codex", "session", "--json", "--offline"], {
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
  return aggregateCcusageSessions(payload, threadId, { sampledAt, version });
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
  let estimatedCostUsd = current.estimatedCostUsd === null
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
