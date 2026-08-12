---
name: taskchef-report
description: "Report the live state of Codex tasks recorded in a TaskChef task history. Use only when the user asks for status, outcomes, or a report about delegated work. Queries each relevant task once, may resolve a nullable thread ID from one exact marker match, never polls or waits, and never persists status or results."
---

# TaskChef Report

Read the canonical per-user TaskChef task history and report the current state
of its Codex tasks once.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Invoke `<plugin-root>/bin/taskchef.js` for
all deterministic task-log operations.

## Report

1. Run `<plugin-root>/bin/taskchef.js workspace path --json`. The CLI resolves
   `--workspace`, then `TASKCHEF_WORKSPACE`, then `~/.agents/taskchef`; never
   infer the history from the current project. Select only the tasks the user
   asked about:
   - For an exact task ID, run
     `<plugin-root>/bin/taskchef.js task show <task-id> --json`.
   - For a project, run
     `<plugin-root>/bin/taskchef.js task list --project <name-or-path> --json`.
   - For a title or other description, run
     `<plugin-root>/bin/taskchef.js task list --json`
     once, then select matching entries. Ask the user if the match is ambiguous.
   - Use the full list only when the user asks for an overview of the task history.
2. Separate entries whose `threadId` is `null`. For those entries, take one
   `list_threads` snapshot with limit 50, filter by available project metadata,
   and inspect candidate structured delegated inputs. Use title only to
   prioritize candidates, never to exclude them. Require the exact first line
   `<!-- taskchef_id=<full lowercase UUID> -->` and an immediately following
   blank line; reject old heading-style markers, malformed comments, and missing
   blank separators. When exactly one candidate has that exact prefix, run
   `<plugin-root>/bin/taskchef.js task resolve <task-id> --thread-id <thread-id> --json`.
   Do not resolve zero or multiple matches. Report unmatched entries as
   recorded but unresolved and do not pass them to native thread tools.
3. Query every resolved or previously durable thread exactly once using
   immediate native snapshots, with no more than eight targets per call.
4. Summarize the live state and any reported outcome for each requested task.
   Distinguish active work, requests for user input, completed work, and failed
   or partial attempts.
5. Treat each Codex task as the source of truth. The task log records what
   TaskChef submitted, but it does not contain the task's current state.
6. Never edit `tasks.jsonl` directly. Use `task resolve` only for one exact
   marker match. Never persist status, results, transcripts, or hidden
   reasoning. Do not poll or wait for future activity.

If the task history is empty, say that TaskChef has not recorded any tasks. If
a task has no durable thread ID, identify it by task ID and say that its marker
remains available for later recovery. If a recorded thread cannot be read,
identify it by task ID and thread ID, then continue with the remaining entries.
