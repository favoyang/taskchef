import { parseTaskChefMarker } from "./delegation.js";
import { listTasks, startTaskFromHook } from "./workspace.js";
import { resolveWorkspacePath } from "./workspace-path.js";

// The final hook check trails the dispatcher's 30-second resolver checkpoint
// so a simultaneous final match is visible before the hook fails closed.
export const INITIAL_LINK_CHECKPOINTS_MS = Object.freeze([0, 250, 1_000, 3_000, 10_000, 32_000]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function hookContext(taskId, threadId, turnId) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `This is TaskChef task ${taskId} in root thread ${threadId}, current turn ${turnId}.`,
        "Before ending the task, call the TaskChef report_result MCP tool with the semantic outcome needs_input, completed, or failed and a concise summary.",
        "Pass this exact task ID, root thread ID, and current turn ID to report_result.",
        "Use needs_input only for a decision or information the user must provide; native approval prompts are reported from live Codex state.",
        "Do not include secrets, transcripts, or raw command output in the summary.",
      ].join(" "),
    },
  };
}

async function waitForLinkedTask(root, taskId, {
  checkpoints = INITIAL_LINK_CHECKPOINTS_MS,
  listTaskSnapshots = listTasks,
  waitImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  let previousCheckpoint = 0;
  for (const checkpoint of checkpoints) {
    if (!Number.isFinite(checkpoint) || checkpoint < previousCheckpoint) {
      throw new Error("initial-link checkpoints must be finite, non-decreasing milliseconds");
    }
    const delay = checkpoint - previousCheckpoint;
    if (delay > 0) await waitImpl(delay);
    previousCheckpoint = checkpoint;
    const task = (await listTaskSnapshots(root)).find((item) => item.id === taskId);
    if (task?.threadId) return task;
  }
  return null;
}

export async function handleInitialPromptHook(input, {
  workspace = null,
  resolveWorkspace = () => resolveWorkspacePath().workspace,
  startTask = startTaskFromHook,
  listTaskSnapshots = listTasks,
  linkCheckpoints = INITIAL_LINK_CHECKPOINTS_MS,
  waitImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (input?.hook_event_name !== "UserPromptSubmit") return { continue: true };
  const taskId = parseTaskChefMarker(input.prompt);
  const threadId = nonEmptyString(input.session_id);
  const turnId = nonEmptyString(input.turn_id);
  if (turnId === null || (taskId === null && threadId === null)) {
    if (taskId === null) return { continue: true };
    return {
      continue: true,
      systemMessage: "TaskChef could not prepare this initial task because the hook payload lacked a turn ID.",
    };
  }
  if (taskId !== null) {
    const root = workspace ?? resolveWorkspace();
    const linked = await waitForLinkedTask(root, taskId, {
      checkpoints: linkCheckpoints,
      listTaskSnapshots,
      waitImpl,
    });
    if (linked === null) {
      return {
        continue: true,
        systemMessage: "TaskChef left this task unresolved because its durable child task ID could not be verified. Do not report a semantic result until the recorded identity is repaired.",
      };
    }
    await startTask(root, taskId, linked.threadId, turnId);
    return hookContext(taskId, linked.threadId, turnId);
  }

  try {
    const root = workspace ?? resolveWorkspace();
    const task = (await listTaskSnapshots(root)).find((item) => item.threadId === threadId);
    return task === undefined
      ? { continue: true }
      : hookContext(task.id, threadId, turnId);
  } catch {
    // An unrelated prompt must not surface TaskChef workspace setup failures.
    return { continue: true };
  }
}
