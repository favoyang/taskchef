---
name: taskchef-report
description: "Report the live state of Codex tasks recorded in a TaskChef task history. Use only when the user asks for status, outcomes, or a report about delegated work. Queries each relevant task once, never polls or waits, and never persists status or results."
---

# TaskChef Report

Read the TaskChef task history and report the current state of its Codex
tasks once.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Invoke `<plugin-root>/bin/taskchef.js` for
all deterministic task-log operations.

## Report

1. Select only the tasks the user asked about:
   - For an exact task ID, run
     `<plugin-root>/bin/taskchef.js task show <task-id> --json --workspace <workspace>`.
   - For a project, run
     `<plugin-root>/bin/taskchef.js task list --project <name-or-path> --json --workspace <workspace>`.
   - For a title or other description, run
     `<plugin-root>/bin/taskchef.js task list --json --workspace <workspace>`
     once, then select matching entries. Ask the user if the match is ambiguous.
   - Use the full list only when the user asks for an overview of the task history.
2. Query every selected thread exactly once using immediate native snapshots,
   with no more than eight targets per call.
3. Summarize the live state and any reported outcome for each requested task.
   Distinguish active work, requests for user input, completed work, and failed
   or partial attempts.
4. Treat each Codex task as the source of truth. The task log proves that
   TaskChef created the task, but it does not contain the task's current state.
5. Never update `tasks.jsonl`. Never persist status, results, transcripts,
   or hidden reasoning. Do not poll or wait for future activity.

If the task history is empty, say that TaskChef has not recorded any tasks. If
a recorded task cannot be read, identify it by task ID and thread ID, then
continue with the remaining entries.
