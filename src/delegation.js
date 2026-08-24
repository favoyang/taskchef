import { randomUUID } from "node:crypto";

export const EXECUTOR_OWNERSHIP_PARAGRAPH = "This task owns the delegated assignment. Execute it in this task; do not re-dispatch it merely because it concerns TaskChef or a configured project. Explicit requests to delegate separate work remain valid.";
export const EXECUTOR_LINK_PARAGRAPH = "Before any other work, read this executor's own durable Codex thread ID from the current task's CODEX_THREAD_ID environment value and call the TaskChef link_task MCP tool with that thread ID and the marked TaskChef task ID. Never use CODEX_SESSION_ID or the parent or delegator thread ID. If linking fails, CODEX_THREAD_ID is unavailable, or the tool is unavailable, report the failure visibly and retry on a later turn; do not guess an identity or continue substantive work while the task is link-pending.";
export const EXECUTOR_WORKING_PARAGRAPH = "After a successful initial link, and at the start of every follow-up turn before substantive work, read this exact Codex thread natively to obtain the current turn ID and call TaskChef report_state with the marked task ID, the self-linked thread ID, that current turn ID, status working, and summary omitted or null. link_task remains the first TaskChef action on the initial turn; do not report working before identity is linked. Never reuse a prior turn ID after a follow-up.";
export const EXECUTOR_RESULT_PARAGRAPH = "Before ending, read this exact Codex thread again and call TaskChef report_state for the same current working turn with status completed, needs_input, or failed and a concise summary. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const CODEX_UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASKCHEF_MARKER_PATTERN = new RegExp(`^<!-- taskchef_id=(${UUID_SOURCE}) -->$`);

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

function attachCreationRecovery(error, taskId, resultReporting) {
  const creationError = error instanceof Error ? error : new Error(String(error));
  try {
    Object.defineProperties(creationError, {
      taskChefTaskId: { value: taskId, enumerable: true },
      taskChefResultReporting: { value: resultReporting, enumerable: true },
    });
    return creationError;
  } catch {
    const wrapped = new Error(`Executor creation failed for recorded TaskChef task ${taskId}.`, { cause: creationError });
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
  const firstLine = instruction.split(/\r?\n/, 1)[0];
  const currentMatch = firstLine.match(TASKCHEF_MARKER_PATTERN);
  if (currentMatch === null) return null;
  const prefix = instruction.match(/^([^\r\n]*)(\r?\n)\2/);
  return prefix === null ? null : currentMatch[1];
}

export function prepareDelegation(instruction, { taskId = randomUUID() } = {}) {
  requireString(instruction, "instruction");
  if (parseTaskChefMarker(instruction) !== null) throw new Error("instruction already contains a TaskChef marker");
  const id = requireUuid(taskId);
  return {
    id,
    instruction: `${taskChefMarker(id)}\n\n${EXECUTOR_OWNERSHIP_PARAGRAPH}\n\n${EXECUTOR_LINK_PARAGRAPH}\n\n${EXECUTOR_WORKING_PARAGRAPH}\n\n${EXECUTOR_RESULT_PARAGRAPH}\n\n${instruction}`,
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
    let resultReporting = "unavailable";
    if (reportRecordedResult !== null) {
      try {
        await reportRecordedResult({ taskId: prepared.id, threadId: null, turnId: null, status: "failed", summary: "Executor creation failed before the executor started." });
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
  const provisional = clientThreadId ?? pendingWorktreeId ?? (isProvisionalThreadId(returnedThreadId) ? returnedThreadId : null);
  return { status: "recorded-link-pending", resolution: "executor-self-link", ...prepared, threadId: null, provisional, hostId: createResult.hostId ?? null };
}
