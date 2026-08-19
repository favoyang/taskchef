import { parseTaskChefMarker } from "./delegation.js";
import { listTasks, startTaskFromHook } from "./workspace.js";
import { resolveWorkspacePath } from "./workspace-path.js";

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

export async function handleInitialPromptHook(input, {
  workspace = null,
  resolveWorkspace = () => resolveWorkspacePath().workspace,
  startTask = startTaskFromHook,
  listTaskSnapshots = listTasks,
} = {}) {
  if (input?.hook_event_name !== "UserPromptSubmit") return { continue: true };
  const taskId = parseTaskChefMarker(input.prompt);
  const threadId = nonEmptyString(input.session_id);
  const turnId = nonEmptyString(input.turn_id);
  if (threadId === null || turnId === null) {
    if (taskId === null) return { continue: true };
    return {
      continue: true,
      systemMessage: "TaskChef could not link this initial task because the hook payload lacked a session or turn ID.",
    };
  }
  if (taskId !== null) {
    const root = workspace ?? resolveWorkspace();
    await startTask(root, taskId, threadId, turnId);
    return hookContext(taskId, threadId, turnId);
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
