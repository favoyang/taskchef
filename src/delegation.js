import { randomUUID } from "node:crypto";

export const THREAD_RESOLUTION_ATTEMPTS = 11;
export const THREAD_RESOLUTION_DELAY_MS = 1_000;
export const THREAD_RESOLUTION_RECENT_LIMIT = 50;
export const THREAD_RESOLUTION_CLOCK_SKEW_MS = 5_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function taskChefMarker(taskId) {
  return `# taskchef_id=${requireUuid(taskId)}`;
}

export function parseTaskChefMarker(instruction) {
  if (typeof instruction !== "string") return null;
  const firstLine = instruction.split(/\r?\n/, 1)[0];
  const match = firstLine.match(/^# taskchef_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  return match?.[1] ?? null;
}

export function prepareDelegation(instruction, { taskId = randomUUID() } = {}) {
  requireString(instruction, "instruction");
  if (parseTaskChefMarker(instruction) !== null) {
    throw new Error("instruction already contains a TaskChef marker");
  }
  const id = requireUuid(taskId);
  return {
    id,
    instruction: `${taskChefMarker(id)}\n\n${instruction}`,
  };
}

export function listThreadEntries(result) {
  const parsed = parseToolResult(result, "list_threads result");
  const entries = [...(parsed.pinnedThreads ?? []), ...(parsed.threads ?? [])];
  const unique = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.id === "string" && !unique.has(entry.id)) {
      unique.set(entry.id, entry);
    }
  }
  return [...unique.values()];
}

export function structuredDelegatedInputs(result) {
  const parsed = parseToolResult(result, "read_thread result");
  const inputs = [];
  for (const turn of parsed.turns ?? []) {
    for (const item of turn?.items ?? []) {
      if (item?.type !== "userMessage") continue;
      if (typeof item.codexDelegation?.input === "string") {
        inputs.push(item.codexDelegation.input);
      }
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
  const marker = taskChefMarker(taskId);
  return structuredDelegatedInputs(result).some(
    (input) => input.split(/\r?\n/, 1)[0] === marker,
  );
}

export function filterThreadCandidates(result, {
  baselineThreadIds = new Set(),
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
    if (baselineThreadIds.has(thread.id) || thread.kind !== "codex") return false;
    if (hostId !== null && thread.hostId !== undefined && thread.hostId !== hostId) return false;
    if (projectId !== null && thread.projectId !== undefined && thread.projectId !== projectId) {
      return false;
    }
    const candidateEnvironmentType = thread.environment?.type
      ?? thread.environmentType
      ?? thread.backing?.environment?.type;
    if (
      environmentType !== null &&
      candidateEnvironmentType !== undefined &&
      candidateEnvironmentType !== environmentType
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

export async function createAndRecordDelegation({
  project,
  title,
  instruction,
  target,
  expected = {},
  createThread,
  listThreads,
  readThread,
  recordTask,
  taskId = randomUUID(),
  attempts = THREAD_RESOLUTION_ATTEMPTS,
  delayMs = THREAD_RESOLUTION_DELAY_MS,
  recentLimit = THREAD_RESOLUTION_RECENT_LIMIT,
  now = Date.now,
  waitImpl = wait,
}) {
  requireString(project, "project");
  requireString(title, "title");
  requireObject(target, "target");
  for (const [value, name] of [
    [createThread, "createThread"],
    [listThreads, "listThreads"],
    [readThread, "readThread"],
    [recordTask, "recordTask"],
  ]) {
    if (typeof value !== "function") throw new Error(`${name} must be a function`);
  }
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("attempts must be positive");
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("delayMs must be non-negative");

  const prepared = prepareDelegation(instruction, { taskId });
  const discoveryErrors = [];
  const baseline = await listThreads({ limit: recentLimit })
    .then((result) => listThreadEntries(result))
    .catch((error) => {
      discoveryErrors.push({
        attempt: 0,
        operation: "baseline",
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
  const baselineThreadIds = new Set(baseline.map((thread) => thread.id));
  const createdAfter = now();
  const createResult = parseToolResult(await createThread({
    prompt: prepared.instruction,
    title,
    target,
  }), "create_thread result");
  const provisional = createResult.clientThreadId ?? createResult.pendingWorktreeId ?? null;

  if (typeof createResult.threadId === "string" && createResult.threadId.length > 0) {
    await recordTask({
      id: prepared.id,
      project,
      title,
      instruction: prepared.instruction,
      threadId: createResult.threadId,
    });
    return {
      status: "recorded",
      resolution: "immediate",
      ...prepared,
      threadId: createResult.threadId,
      hostId: createResult.hostId ?? expected.hostId ?? null,
      provisional,
      attempts: 0,
      discoveryErrors,
    };
  }

  if (provisional === null) {
    await recordTask({
      id: prepared.id,
      project,
      title,
      instruction: prepared.instruction,
      threadId: null,
    });
    return {
      status: "recorded-unresolved",
      reason: "create-returned-no-thread-identifier",
      ...prepared,
      threadId: null,
      provisional: null,
      attempts: 0,
      matchingThreadIds: [],
      discoveryErrors,
    };
  }

  let exactMatches = [];
  let ambiguousMatches = [];
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attemptsMade = attempt;
    let candidates = [];
    let attemptFailed = false;
    try {
      const snapshot = await listThreads({ limit: recentLimit });
      candidates = filterThreadCandidates(snapshot, {
        baselineThreadIds,
        hostId: expected.hostId ?? null,
        projectId: expected.projectId ?? target.projectId ?? null,
        title,
        createdAfter,
        environmentType: expected.environmentType ?? target.environment?.type ?? null,
      });
    } catch (error) {
      attemptFailed = true;
      discoveryErrors.push({
        attempt,
        operation: "listThreads",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    exactMatches = [];
    for (const candidate of candidates) {
      try {
        const readResult = await readThread({
          threadId: candidate.id,
          ...(candidate.hostId ? { hostId: candidate.hostId } : {}),
          turnLimit: 1,
          includeOutputs: false,
        });
        if (hasExactTaskChefMarker(readResult, prepared.id)) exactMatches.push(candidate);
      } catch (error) {
        attemptFailed = true;
        discoveryErrors.push({
          attempt,
          operation: "readThread",
          threadId: candidate.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (exactMatches.length > 1) ambiguousMatches = exactMatches;
    if (exactMatches.length === 1 && ambiguousMatches.length === 0 && !attemptFailed) {
      const thread = exactMatches[0];
      await recordTask({
        id: prepared.id,
        project,
        title,
        instruction: prepared.instruction,
        threadId: thread.id,
      });
      return {
        status: "recorded",
        resolution: "discovered",
        ...prepared,
        threadId: thread.id,
        hostId: thread.hostId ?? expected.hostId ?? null,
        provisional,
        attempts: attempt,
        discoveryErrors,
      };
    }
    if (attempt < attempts) {
      try {
        await waitImpl(delayMs);
      } catch (error) {
        discoveryErrors.push({
          attempt,
          operation: "wait",
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }

  const reason = ambiguousMatches.length > 1
    ? "multiple-exact-marker-matches"
    : discoveryErrors.length > 0
      ? "thread-discovery-error"
      : "no-exact-marker-match";
  await recordTask({
    id: prepared.id,
    project,
    title,
    instruction: prepared.instruction,
    threadId: null,
  });
  return {
    status: "recorded-unresolved",
    reason,
    ...prepared,
    threadId: null,
    provisional,
    attempts: attemptsMade,
    discoveryErrors,
    matchingThreadIds: (ambiguousMatches.length > 1 ? ambiguousMatches : exactMatches)
      .map((thread) => thread.id),
  };
}
