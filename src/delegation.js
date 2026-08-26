import { randomUUID } from "node:crypto";

/** @deprecated Historical v7 inline-prompt snapshot. New delegations use taskchef-executor. */
export const EXECUTOR_OWNERSHIP_PARAGRAPH = "This task owns the delegated assignment. Execute it in this task; do not re-dispatch it merely because it concerns TaskChef or a configured project. Explicit requests to delegate separate work remain valid.";
/** @deprecated Historical v7 inline-prompt snapshot. New delegations use taskchef-executor. */
export const EXECUTOR_LINK_PARAGRAPH = "Before any other work, read this executor's own durable Codex thread ID from the current task's CODEX_THREAD_ID environment value and call the TaskChef link_task MCP tool with that thread ID and the marked TaskChef task ID. Never use CODEX_SESSION_ID or the parent or delegator thread ID. If linking fails, CODEX_THREAD_ID is unavailable, or the tool is unavailable, report the failure visibly and retry on a later turn; do not guess an identity or continue substantive work while the task is link-pending.";
/** @deprecated Historical v7 inline-prompt snapshot. New delegations use taskchef-executor. */
export const EXECUTOR_WORKING_PARAGRAPH = "After a successful initial link, and at the start of every follow-up turn before substantive work, read this exact Codex thread natively to obtain the current turn ID and call TaskChef report_state with the marked task ID, the self-linked thread ID, that current turn ID, status working, summary omitted or null, and a concise requestSummary for this turn. link_task remains the first TaskChef action on the initial turn; do not report working before identity is linked. Never reuse a prior turn ID after a follow-up.";
/** @deprecated Historical v7 inline-prompt snapshot. New delegations use taskchef-executor. */
export const EXECUTOR_RESULT_PARAGRAPH = "Before ending, read this exact Codex thread again and call TaskChef report_state for the same current working turn with status completed, needs_input, or failed and a concise summary. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.";
export const EXECUTOR_SKILL_INVOCATION = "Use $taskchef-executor to execute and report this delegated TaskChef assignment.";
const HISTORICAL_RESULT_WITH_TURN_PARAGRAPH = "Before ending, call the TaskChef report_result MCP tool with the marked task ID, this executor's self-linked thread ID, the current turn ID from an exact native read of that same thread, completed, needs_input, or failed, and a concise summary. Never reuse a prior turn ID after a follow-up. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.";
const HISTORICAL_RESULT_PARAGRAPH = "Before ending, call the TaskChef report_result MCP tool with completed, needs_input, or failed and a concise summary. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.";
const HISTORICAL_EXECUTOR_SCAFFOLD_LINES = new Set([
  EXECUTOR_OWNERSHIP_PARAGRAPH,
  EXECUTOR_LINK_PARAGRAPH,
  EXECUTOR_WORKING_PARAGRAPH,
  EXECUTOR_RESULT_PARAGRAPH,
  HISTORICAL_RESULT_WITH_TURN_PARAGRAPH,
  HISTORICAL_RESULT_PARAGRAPH,
]);
const HISTORICAL_INLINE_PROTOCOLS = [
  [EXECUTOR_OWNERSHIP_PARAGRAPH, EXECUTOR_LINK_PARAGRAPH, EXECUTOR_WORKING_PARAGRAPH, EXECUTOR_RESULT_PARAGRAPH],
  [EXECUTOR_OWNERSHIP_PARAGRAPH, EXECUTOR_LINK_PARAGRAPH, HISTORICAL_RESULT_WITH_TURN_PARAGRAPH],
  [EXECUTOR_OWNERSHIP_PARAGRAPH, HISTORICAL_RESULT_PARAGRAPH],
  [EXECUTOR_OWNERSHIP_PARAGRAPH],
];

function hasTaskSpecificContent(lines) {
  return lines.some((line) => (
    line.trim().length > 0 && !HISTORICAL_EXECUTOR_SCAFFOLD_LINES.has(line)
  ));
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const CODEX_UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASKCHEF_MARKER_PATTERN = new RegExp(`^<!-- taskchef_id=(${UUID_SOURCE}) -->$`);
const LEGACY_TASKCHEF_MARKER_PATTERN = new RegExp(`^# taskchef_id=(${UUID_SOURCE})$`);

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
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

function toolIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function attachCreationRecovery(error, taskId, turnRef, resultReporting) {
  const creationError = error instanceof Error ? error : new Error(String(error));
  try {
    Object.defineProperties(creationError, {
      taskChefTaskId: { value: taskId, enumerable: true },
      taskChefTurnRef: { value: turnRef, enumerable: true },
      taskChefResultReporting: { value: resultReporting, enumerable: true },
    });
    return creationError;
  } catch {
    const wrapped = new Error(`Executor creation failed for recorded TaskChef task ${taskId}.`, { cause: creationError });
    wrapped.taskChefTaskId = taskId;
    wrapped.taskChefTurnRef = turnRef;
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
  if (isProvisionalThreadId(id)) throw new Error(`${name} must be a durable thread ID, not a provisional local ID`);
  return id;
}

export function normalizeCodexThreadId(value, name = "threadId") {
  const id = normalizeDurableThreadId(value, name).toLowerCase();
  if (!CODEX_UUID_V7_PATTERN.test(id)) {
    throw new Error(`${name} must be a canonical Codex UUIDv7`);
  }
  return id;
}

export function taskChefMarker(taskId) {
  return `<!-- taskchef_id=${requireUuid(taskId)} -->`;
}

export function parseTaskChefMarker(instruction) {
  if (typeof instruction !== "string") return null;
  const lines = instruction.split(/\r\n|\r|\n/);
  const hasHistoricalAssignment = () => {
    const rest = lines.slice(1);
    const executorSkillInvocationIndices = rest.flatMap((line, index) => (
      line === EXECUTOR_SKILL_INVOCATION ? [index] : []
    ));
    if (executorSkillInvocationIndices.length > 0) {
      const bodyLines = rest.slice(0, -2);
      return executorSkillInvocationIndices.length === 1
        && executorSkillInvocationIndices[0] === rest.length - 1
        && lines.at(-1) === EXECUTOR_SKILL_INVOCATION
        && lines.at(-2) === ""
        && bodyLines.length > 0
        && bodyLines[0].trim().length > 0
        && bodyLines.at(-1).trim().length > 0
        && hasTaskSpecificContent(bodyLines)
        && !bodyLines.some((line) => HISTORICAL_EXECUTOR_SCAFFOLD_LINES.has(line));
    }

    const containsInlineScaffold = rest.some((line) => HISTORICAL_EXECUTOR_SCAFFOLD_LINES.has(line));
    if (!containsInlineScaffold) return rest.join("\n").trim().length > 0;
    return HISTORICAL_INLINE_PROTOCOLS.some((protocol) => {
      const prefix = ["", ...protocol.flatMap((line) => [line, ""])];
      if (!prefix.every((line, index) => rest[index] === line)) return false;
      const bodyLines = rest.slice(prefix.length);
      return hasTaskSpecificContent(bodyLines)
        && !bodyLines.some((line) => HISTORICAL_EXECUTOR_SCAFFOLD_LINES.has(line));
    });
  };
  const currentMatches = lines.flatMap((line, index) => {
    const match = line.match(TASKCHEF_MARKER_PATTERN);
    return match === null ? [] : [{ id: match[1], index }];
  });
  const legacyMatches = lines.flatMap((line, index) => {
    const match = line.match(LEGACY_TASKCHEF_MARKER_PATTERN);
    return match === null ? [] : [{ id: match[1], index }];
  });
  if (currentMatches.length + legacyMatches.length !== 1) return null;

  if (legacyMatches.length === 1) {
    const [{ id, index }] = legacyMatches;
    if (index !== 0) return null;
    return hasHistoricalAssignment() ? id : null;
  }

  const [{ id, index }] = currentMatches;
  if (index === 0) {
    return hasHistoricalAssignment() ? id : null;
  }
  const executorSkillReferences = instruction.match(/\$taskchef-executor\b/gi) ?? [];
  const hasCurrentCompactBoundary = index >= 2
    && lines.at(index - 2).trim().length > 0;
  const hasCurrentBlankBoundary = index >= 3
    && lines.at(index - 2) === ""
    && lines.at(index - 3).trim().length > 0;
  const currentAssignmentEnd = hasCurrentCompactBoundary ? index - 1 : index - 2;
  const isFinalMarkerScaffold = index === lines.length - 1
    && (hasCurrentCompactBoundary || hasCurrentBlankBoundary)
    && lines[0].trim().length > 0
    && lines.at(-2) === EXECUTOR_SKILL_INVOCATION
    && hasTaskSpecificContent(lines.slice(0, currentAssignmentEnd))
    && !lines.slice(0, currentAssignmentEnd).some((line) => HISTORICAL_EXECUTOR_SCAFFOLD_LINES.has(line))
    && executorSkillReferences.length === 1;
  if (isFinalMarkerScaffold) return id;

  const hasCompactBoundary = index >= 1
    && lines.at(index - 1).trim().length > 0;
  const hasHistoricalBlankBoundary = index >= 2
    && lines.at(index - 1) === ""
    && lines.at(index - 2).trim().length > 0;
  const assignmentEnd = hasCompactBoundary ? index : index - 1;
  const isTrailingScaffold = index === lines.length - 2
    && (hasCompactBoundary || hasHistoricalBlankBoundary)
    && lines[0].trim().length > 0
    && lines.at(-1) === EXECUTOR_SKILL_INVOCATION
    && hasTaskSpecificContent(lines.slice(0, assignmentEnd))
    && !lines.slice(0, assignmentEnd).some((line) => HISTORICAL_EXECUTOR_SCAFFOLD_LINES.has(line))
    && executorSkillReferences.length === 1;
  return isTrailingScaffold ? id : null;
}

export function prepareDelegation(instruction, { taskId = randomUUID() } = {}) {
  const rawBody = requireString(instruction, "instruction");
  if (/^[^\S\r\n]*(?:\r\n|\r|\n)/.test(rawBody)) {
    throw new Error("instruction must begin with useful task content on its first line");
  }
  const body = rawBody.replace(/(?:(?:\r\n|\r|\n)[^\S\r\n]*)+$/, "");
  if (body.split(/\r\n|\r|\n/).some((line) => (
    TASKCHEF_MARKER_PATTERN.test(line) || LEGACY_TASKCHEF_MARKER_PATTERN.test(line)
  ))) {
    throw new Error("instruction already contains a TaskChef marker");
  }
  if (/\$taskchef-executor\b/i.test(body)) {
    throw new Error("instruction contains a reserved TaskChef executor skill reference");
  }
  const bodyLines = body.split(/\r\n|\r|\n/);
  if (!hasTaskSpecificContent(bodyLines)) {
    throw new Error("instruction must contain task-specific content, not only TaskChef lifecycle scaffolding");
  }
  if (bodyLines.some((line) => HISTORICAL_EXECUTOR_SCAFFOLD_LINES.has(line))) {
    throw new Error("instruction contains reserved historical TaskChef lifecycle scaffolding");
  }
  const id = requireUuid(taskId);
  return {
    id,
    instruction: `${body}\n\n${EXECUTOR_SKILL_INVOCATION}\n${taskChefMarker(id)}`,
  };
}

export async function createAndRecordDelegation(input) {
  const { project, title, instruction, target, createThread, recordTask, reportRecordedResult = null, taskId = randomUUID() } = input ?? {};
  requireString(project, "project");
  requireString(title, "title");
  requireObject(target, "target");
  for (const [value, name] of [[createThread, "createThread"], [recordTask, "recordTask"]]) {
    if (typeof value !== "function") throw new Error(`${name} must be a function`);
  }
  if (reportRecordedResult !== null && typeof reportRecordedResult !== "function") throw new Error("reportRecordedResult must be a function or null");

  const prepared = prepareDelegation(instruction, { taskId });
  await recordTask({ id: prepared.id, project, title, instruction: prepared.instruction, threadId: null });

  let createResult;
  try {
    createResult = parseToolResult(await createThread({ prompt: prepared.instruction, title, target }), "create_thread result");
  } catch (error) {
    const creationFailureTurnRef = randomUUID();
    let resultReporting = "unavailable";
    if (reportRecordedResult !== null) {
      try {
        await reportRecordedResult({
          taskId: prepared.id,
          threadId: null,
          turnRef: creationFailureTurnRef,
          turnId: null,
          status: "failed",
          summary: "Executor creation failed before the executor started.",
        });
        resultReporting = "recorded";
      } catch {
        resultReporting = "failed";
      }
    }
    throw attachCreationRecovery(
      error,
      prepared.id,
      creationFailureTurnRef,
      resultReporting,
    );
  }

  const returnedThreadId = toolIdentifier(createResult.threadId);
  const clientThreadId = toolIdentifier(createResult.clientThreadId);
  const pendingWorktreeId = toolIdentifier(createResult.pendingWorktreeId);
  const provisional = clientThreadId ?? pendingWorktreeId ?? (isProvisionalThreadId(returnedThreadId) ? returnedThreadId : null);
  return { status: "recorded-link-pending", resolution: "executor-self-link", ...prepared, threadId: null, provisional, hostId: createResult.hostId ?? null };
}
