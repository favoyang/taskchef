import { randomUUID } from "node:crypto";

export const THREAD_RESOLUTION_CHECKPOINTS_MS = Object.freeze([10_000, 29_000]);
export const THREAD_RESOLUTION_TIMEOUT_MS = 30_000;
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

function toolIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
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
    const id = toolIdentifier(entry?.id);
    if (id !== null && !unique.has(id)) {
      unique.set(id, { ...entry, id });
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

function validateResolutionSchedule(checkpointsMs, timeoutMs) {
  if (!Array.isArray(checkpointsMs) || checkpointsMs.length === 0) {
    throw new Error("checkpointsMs must contain at least one checkpoint");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be positive");
  }
  let previous = 0;
  for (const checkpoint of checkpointsMs) {
    if (!Number.isInteger(checkpoint) || checkpoint <= previous || checkpoint > timeoutMs) {
      throw new Error("checkpointsMs must be strictly increasing positive integers within timeoutMs");
    }
    previous = checkpoint;
  }
}

async function inspectCandidates(candidates, {
  readThread,
  taskId,
  attempt,
  canVerify = () => true,
}) {
  const inspected = await Promise.all(candidates.map(async (candidate) => {
    try {
      const readResult = await readThread({
        threadId: candidate.id,
        ...(candidate.hostId ? { hostId: candidate.hostId } : {}),
        turnLimit: 1,
        includeOutputs: false,
      });
      if (!canVerify()) {
        return { candidate, matches: false, error: null };
      }
      return {
        candidate,
        matches: hasExactTaskChefMarker(readResult, taskId),
        error: null,
      };
    } catch (error) {
      return {
        candidate,
        matches: false,
        error: {
          attempt,
          operation: "readThread",
          threadId: candidate.id,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }));
  return {
    exactMatches: inspected.filter((item) => item.matches).map((item) => item.candidate),
    errors: inspected.flatMap((item) => item.error === null ? [] : [item.error]),
  };
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
  resolveRecordedTask = null,
  resolveProvisionalThread = null,
  taskId = randomUUID(),
  checkpointsMs = THREAD_RESOLUTION_CHECKPOINTS_MS,
  timeoutMs = THREAD_RESOLUTION_TIMEOUT_MS,
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
  if (resolveProvisionalThread !== null && typeof resolveProvisionalThread !== "function") {
    throw new Error("resolveProvisionalThread must be a function or null");
  }
  if (resolveRecordedTask !== null && typeof resolveRecordedTask !== "function") {
    throw new Error("resolveRecordedTask must be a function or null");
  }
  validateResolutionSchedule(checkpointsMs, timeoutMs);

  const prepared = prepareDelegation(instruction, { taskId });
  const discoveryErrors = [];
  const createdAfter = now();
  const createResult = parseToolResult(await createThread({
    prompt: prepared.instruction,
    title,
    target,
  }), "create_thread result");
  const clientThreadId = toolIdentifier(createResult.clientThreadId);
  const pendingWorktreeId = toolIdentifier(createResult.pendingWorktreeId);
  const returnedThreadId = toolIdentifier(createResult.threadId);
  const returnedProvisionalId = isProvisionalThreadId(returnedThreadId)
    ? returnedThreadId
    : null;
  const provisional = clientThreadId ?? pendingWorktreeId ?? returnedProvisionalId;
  const resolutionStartedAt = provisional === null ? null : now();
  const provisionalIds = new Set([
    clientThreadId,
    pendingWorktreeId,
    returnedProvisionalId,
  ].filter(Boolean));
  const durableThreadId = !isProvisionalThreadId(returnedThreadId)
    && !provisionalIds.has(returnedThreadId)
    ? returnedThreadId
    : null;

  if (durableThreadId !== null) {
    await recordTask({
      id: prepared.id,
      project,
      title,
      instruction: prepared.instruction,
      threadId: durableThreadId,
    });
    return {
      status: "recorded",
      resolution: "immediate",
      ...prepared,
      threadId: durableThreadId,
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

  await recordTask({
    id: prepared.id,
    project,
    title,
    instruction: prepared.instruction,
    threadId: null,
  });

  if (resolveRecordedTask === null) {
    return {
      status: "recorded-unresolved",
      reason: "task-resolution-unavailable",
      ...prepared,
      threadId: null,
      provisional,
      attempts: 0,
      matchingThreadIds: [],
      discoveryErrors,
    };
  }

  const resolutionDeadline = resolutionStartedAt + timeoutMs;
  let deadlineExpired = false;
  const hasResolutionTime = () => {
    if (now() < resolutionDeadline) return true;
    deadlineExpired = true;
    return false;
  };

  const acceptResolvedThread = async (thread, resolution, attempt, { verified = false } = {}) => {
    const threadId = toolIdentifier(thread.id);
    if (
      threadId === null
      || provisionalIds.has(threadId)
      || isProvisionalThreadId(threadId)
    ) {
      discoveryErrors.push({
        attempt,
        operation: "validateThreadId",
        ...(threadId === null ? {} : { threadId }),
        message: "resolved threadId is not a durable identifier",
      });
      return null;
    }
    const durableThread = { ...thread, id: threadId };
    if (!hasResolutionTime()) return null;
    if (!verified) {
      const inspected = await inspectCandidates([durableThread], {
        readThread,
        taskId: prepared.id,
        attempt,
        canVerify: hasResolutionTime,
      });
      discoveryErrors.push(...inspected.errors);
      if (inspected.exactMatches.length !== 1 || inspected.errors.length > 0) return null;
    }
    if (!hasResolutionTime()) return null;
    try {
      await resolveRecordedTask({ id: prepared.id, threadId });
    } catch (error) {
      discoveryErrors.push({
        attempt,
        operation: "resolveRecordedTask",
        threadId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    return {
      status: "recorded",
      resolution,
      ...prepared,
      threadId,
      hostId: durableThread.hostId ?? expected.hostId ?? null,
      provisional,
      attempts: attempt,
      discoveryErrors,
    };
  };

  if (resolveProvisionalThread !== null) {
    let nativeResult = null;
    let nativeAttempts = 0;
    const remainingTimeoutMs = timeoutMs - (now() - resolutionStartedAt);
    if (remainingTimeoutMs > 0) {
      nativeAttempts = 1;
      try {
        const nativeResponse = await resolveProvisionalThread({
          provisionalId: provisional,
          ...(clientThreadId ? { clientThreadId } : {}),
          ...(pendingWorktreeId ? { pendingWorktreeId } : {}),
          timeoutMs: remainingTimeoutMs,
        });
        if (hasResolutionTime()) {
          nativeResult = parseToolResult(nativeResponse, "provisional thread resolver result");
        }
      } catch (error) {
        if (hasResolutionTime()) {
          discoveryErrors.push({
            attempt: 1,
            operation: "resolveProvisionalThread",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    hasResolutionTime();
    const nativeThreadId = toolIdentifier(nativeResult?.threadId);
    if (nativeThreadId !== null) {
      const resolved = await acceptResolvedThread({
        id: nativeThreadId,
        hostId: nativeResult.hostId ?? expected.hostId ?? null,
      }, "native", 1);
      if (resolved !== null) return resolved;
    }
    return {
      status: "recorded-unresolved",
      reason: discoveryErrors.length > 0
        ? "thread-discovery-error"
        : deadlineExpired
          ? "resolution-deadline-exhausted"
          : "native-resolution-unresolved",
      ...prepared,
      threadId: null,
      provisional,
      attempts: nativeAttempts,
      matchingThreadIds: [],
      discoveryErrors,
    };
  }

  let exactMatches = [];
  let ambiguousMatches = [];
  let attemptsMade = 0;
  for (let index = 0; index < checkpointsMs.length; index += 1) {
    const attempt = index + 1;
    const checkpointMs = checkpointsMs[index];
    const elapsedBeforeAttempt = now() - resolutionStartedAt;
    if (elapsedBeforeAttempt > timeoutMs) break;
    const remainingDelayMs = checkpointMs - elapsedBeforeAttempt;
    if (remainingDelayMs > 0) {
      try {
        await waitImpl(remainingDelayMs);
      } catch (error) {
        discoveryErrors.push({
          attempt,
          operation: "wait",
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    if (!hasResolutionTime()) break;
    attemptsMade = attempt;
    let candidates = [];
    let attemptFailed = false;
    try {
      const snapshot = await listThreads({ limit: recentLimit });
      if (hasResolutionTime()) {
        candidates = filterThreadCandidates(snapshot, {
          excludedThreadIds: provisionalIds,
          hostId: expected.hostId ?? null,
          projectId: expected.projectId ?? target.projectId ?? null,
          title,
          createdAfter,
          environmentType: expected.environmentType ?? target.environment?.type ?? null,
        });
      }
    } catch (error) {
      if (hasResolutionTime()) {
        attemptFailed = true;
        discoveryErrors.push({
          attempt,
          operation: "listThreads",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!hasResolutionTime()) break;
    const inspected = await inspectCandidates(candidates, {
      readThread,
      taskId: prepared.id,
      attempt,
      canVerify: hasResolutionTime,
    });
    exactMatches = inspected.exactMatches;
    discoveryErrors.push(...inspected.errors);
    if (inspected.errors.length > 0) attemptFailed = true;
    if (!hasResolutionTime()) break;
    if (exactMatches.length > 1) ambiguousMatches = exactMatches;
    if (
      exactMatches.length === 1
      && ambiguousMatches.length === 0
      && !attemptFailed
      && discoveryErrors.length === 0
    ) {
      const resolved = await acceptResolvedThread(
        exactMatches[0],
        "discovered",
        attempt,
        { verified: true },
      );
      if (resolved !== null) return resolved;
    }
  }

  const reason = ambiguousMatches.length > 1
    ? "multiple-exact-marker-matches"
    : discoveryErrors.length > 0
      ? "thread-discovery-error"
      : deadlineExpired
        ? "resolution-deadline-exhausted"
        : "no-exact-marker-match";
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
