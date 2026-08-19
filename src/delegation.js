import { randomUUID } from "node:crypto";

// Deprecated v5 compatibility exports. TaskChef no longer uses bounded thread
// discovery, but keeping these pure helpers avoids breaking existing imports
// before the next major release.
export const THREAD_RESOLUTION_CHECKPOINTS_MS = Object.freeze([10_000, 30_000]);
export const THREAD_RESOLUTION_TIMEOUT_MS = 30_000;
export const THREAD_RESOLUTION_RECENT_LIMIT = 50;
export const THREAD_RESOLUTION_CLOCK_SKEW_MS = 5_000;
export const EXECUTOR_OWNERSHIP_PARAGRAPH = "This task owns the delegated assignment. Execute it in this task; do not re-dispatch it merely because it concerns TaskChef or a configured project. Explicit requests to delegate separate work remain valid.";
export const EXECUTOR_RESULT_PARAGRAPH = "Before ending, call the TaskChef report_result MCP tool with completed, needs_input, or failed and a concise summary. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const TASKCHEF_MARKER_PATTERN = new RegExp(`^<!-- taskchef_id=(${UUID_SOURCE}) -->$`);
const LEGACY_TASKCHEF_MARKER_PATTERN = new RegExp(`^# taskchef_id=(${UUID_SOURCE})$`);

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireUuid(value, name = "taskId") {
  requireString(value, name);
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a lowercase full UUID`);
  return value;
}

function parseToolResult(value, name) {
  if (typeof value !== "string") return requireObject(value, name);
  try {
    return requireObject(JSON.parse(value), name);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${name} must contain valid JSON`);
    throw error;
  }
}

function timestampMilliseconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function toolIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function attachCreationRecovery(error, taskId, resultReporting) {
  const creationError = error instanceof Error ? error : new Error(String(error));
  try {
    Object.defineProperties(creationError, {
      taskChefTaskId: { value: taskId, enumerable: true },
      taskChefResultReporting: { value: resultReporting, enumerable: true },
    });
    return creationError;
  } catch {
    const wrapped = new Error(
      `Executor creation failed for recorded TaskChef task ${taskId}.`,
      { cause: creationError },
    );
    wrapped.taskChefTaskId = taskId;
    wrapped.taskChefResultReporting = resultReporting;
    return wrapped;
  }
}

export function isProvisionalThreadId(value) {
  const id = toolIdentifier(value);
  return id !== null && id.startsWith("local:");
}

export function normalizeDurableThreadId(value, name = "threadId") {
  const id = toolIdentifier(value);
  if (id === null) throw new Error(`${name} must be a non-empty string`);
  if (isProvisionalThreadId(id)) {
    throw new Error(`${name} must be a durable thread ID, not a provisional local ID`);
  }
  return id;
}


export function taskChefMarker(taskId) {
  return `<!-- taskchef_id=${requireUuid(taskId)} -->`;
}

export function parseTaskChefMarker(instruction, { allowLegacyHeading = false } = {}) {
  if (typeof instruction !== "string") return null;
  const firstLine = instruction.split(/\r?\n/, 1)[0];
  const currentMatch = firstLine.match(TASKCHEF_MARKER_PATTERN);
  if (currentMatch !== null) {
    const prefix = instruction.match(/^([^\r\n]*)(\r?\n)\2/);
    return prefix === null ? null : currentMatch[1];
  }
  if (!allowLegacyHeading) return null;
  return firstLine.match(LEGACY_TASKCHEF_MARKER_PATTERN)?.[1] ?? null;
}

export function prepareDelegation(instruction, { taskId = randomUUID() } = {}) {
  requireString(instruction, "instruction");
  if (parseTaskChefMarker(instruction) !== null) {
    throw new Error("instruction already contains a TaskChef marker");
  }
  const id = requireUuid(taskId);
  return {
    id,
    instruction: `${taskChefMarker(id)}\n\n${EXECUTOR_OWNERSHIP_PARAGRAPH}\n\n${EXECUTOR_RESULT_PARAGRAPH}\n\n${instruction}`,
  };
}

export function listThreadEntries(result) {
  const parsed = parseToolResult(result, "list_threads result");
  const entries = [...(parsed.pinnedThreads ?? []), ...(parsed.threads ?? [])];
  const unique = new Map();
  for (const entry of entries) {
    const id = toolIdentifier(entry?.id);
    if (id !== null && !unique.has(id)) unique.set(id, { ...entry, id });
  }
  return [...unique.values()];
}

export function structuredDelegatedInputs(result) {
  const parsed = parseToolResult(result, "read_thread result");
  const inputs = [];
  for (const turn of parsed.turns ?? []) {
    for (const item of turn?.items ?? []) {
      if (item?.type !== "userMessage") continue;
      for (const part of item.content ?? []) {
        if (typeof part?.codexDelegation?.input === "string") {
          inputs.push(part.codexDelegation.input);
        }
      }
    }
  }
  return inputs;
}

export function hasExactTaskChefMarker(result, taskId) {
  const id = requireUuid(taskId);
  return structuredDelegatedInputs(result).some(
    (input) => parseTaskChefMarker(input) === id,
  );
}

export function filterThreadCandidates(result, {
  baselineThreadIds = new Set(),
  excludedThreadIds = new Set(),
  hostId = null,
  projectId = null,
  title = null,
  createdAfter = null,
  environmentType = null,
} = {}) {
  const minimumCreatedAt = createdAfter === null
    ? null
    : timestampMilliseconds(createdAfter) - THREAD_RESOLUTION_CLOCK_SKEW_MS;
  const candidates = listThreadEntries(result).filter((thread) => {
    if (
      baselineThreadIds.has(thread.id)
      || excludedThreadIds.has(thread.id)
      || isProvisionalThreadId(thread.id)
      || thread.kind !== "codex"
    ) return false;
    if (hostId !== null && thread.hostId !== undefined && thread.hostId !== hostId) return false;
    if (projectId !== null && thread.projectId !== undefined && thread.projectId !== projectId) {
      return false;
    }
    const candidateEnvironmentType = thread.environment?.type
      ?? thread.environmentType
      ?? thread.backing?.environment?.type;
    if (
      environmentType !== null
      && candidateEnvironmentType !== undefined
      && candidateEnvironmentType !== environmentType
    ) return false;
    const candidateTime = timestampMilliseconds(thread.createdAt ?? thread.updatedAt);
    if (minimumCreatedAt !== null && candidateTime !== null && candidateTime < minimumCreatedAt) {
      return false;
    }
    return true;
  });
  if (title === null) return candidates;
  return candidates.sort((left, right) =>
    Number(right.title === title) - Number(left.title === title));
}

export async function createAndRecordDelegation(input) {
  const {
    project,
    title,
    instruction,
    target,
    createThread,
    recordTask,
    resolveRecordedTask = null,
    reportRecordedResult = null,
    taskId = randomUUID(),
  } = input ?? {};
  requireString(project, "project");
  requireString(title, "title");
  requireObject(target, "target");
  for (const [value, name] of [
    [createThread, "createThread"],
    [recordTask, "recordTask"],
  ]) {
    if (typeof value !== "function") throw new Error(`${name} must be a function`);
  }
  for (const [value, name] of [
    [resolveRecordedTask, "resolveRecordedTask"],
    [reportRecordedResult, "reportRecordedResult"],
  ]) {
    if (value !== null && typeof value !== "function") {
      throw new Error(`${name} must be a function or null`);
    }
  }

  const prepared = prepareDelegation(instruction, { taskId });
  await recordTask({
    id: prepared.id,
    project,
    title,
    instruction: prepared.instruction,
    threadId: null,
  });

  let createResult;
  try {
    createResult = parseToolResult(await createThread({
      prompt: prepared.instruction,
      title,
      target,
    }), "create_thread result");
  } catch (error) {
    let resultReporting = "unavailable";
    if (reportRecordedResult !== null) {
      try {
        await reportRecordedResult({
          taskId: prepared.id,
          threadId: null,
          turnId: null,
          status: "failed",
          summary: "Executor creation failed before the executor started.",
        });
        resultReporting = "recorded";
      } catch {
        resultReporting = "failed";
      }
    }
    throw attachCreationRecovery(error, prepared.id, resultReporting);
  }

  const returnedThreadId = toolIdentifier(createResult.threadId);
  const clientThreadId = toolIdentifier(createResult.clientThreadId);
  const pendingWorktreeId = toolIdentifier(createResult.pendingWorktreeId);
  const provisional = clientThreadId
    ?? pendingWorktreeId
    ?? (isProvisionalThreadId(returnedThreadId) ? returnedThreadId : null);
  const durableThreadId = returnedThreadId !== null
    && !isProvisionalThreadId(returnedThreadId)
    && returnedThreadId !== clientThreadId
    && returnedThreadId !== pendingWorktreeId
      ? returnedThreadId
      : null;

  if (durableThreadId !== null) {
    if (resolveRecordedTask !== null) {
      try {
        await resolveRecordedTask({ id: prepared.id, threadId: durableThreadId });
        return {
          status: "recorded",
          resolution: "immediate",
          ...prepared,
          threadId: durableThreadId,
          provisional,
          hostId: createResult.hostId ?? null,
        };
      } catch (error) {
        return {
          status: "recorded-unresolved",
          reason: "task-resolution-failed",
          resolutionError: error instanceof Error ? error.message : String(error),
          ...prepared,
          threadId: null,
          createdThreadId: durableThreadId,
          provisional,
          hostId: createResult.hostId ?? null,
        };
      }
    }
    return {
      status: "recorded-unresolved",
      reason: "task-resolution-unavailable",
      ...prepared,
      threadId: null,
      createdThreadId: durableThreadId,
      provisional,
      hostId: createResult.hostId ?? null,
    };
  }

  return {
    status: "recorded-unresolved",
    reason: "awaiting-initial-hook",
    ...prepared,
    threadId: null,
    provisional,
    hostId: createResult.hostId ?? null,
  };
}
