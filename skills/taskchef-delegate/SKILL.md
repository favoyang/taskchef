---
name: taskchef-delegate
description: "Dispatch actionable requests through the per-user TaskChef workspace into independently openable Codex project tasks. Use automatically for actionable work received in the canonical TaskChef dispatcher workspace. From any other project, use only when the user explicitly asks to delegate or split separate work into Codex tasks; TaskChef-related subject matter alone is not delegation intent. Record before creation, require executor self-linking, and never wait for executor completion."
---

# TaskChef Delegate

Create real Codex tasks through the canonical per-user TaskChef data workspace
and return immediately.

## Invocation boundary

A task whose initial structured `codexDelegation.input` starts with an exact
`<!-- taskchef_id=<full UUID> -->` marker already owns that delegated
assignment. Execute it in the current task. Do not re-dispatch it merely
because it concerns TaskChef or a configured project. Explicit requests to
delegate separate work remain valid.

Use the bundled `prepare_dispatch`, `record_task`, `link_task`, and
`report_state` MCP tools directly. `report_result` is a deprecated compatibility
alias and must not be emitted into new executor instructions. Never fall back to shell writes. If a
required tool is unavailable, stop and report that the TaskChef plugin must be
reloaded or installed.

## Boundaries

- Treat only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl` as TaskChef-managed
  dispatcher files. Preserve unrelated user-owned paths.
- Use real Codex tasks, never collaboration or subagent tools.
- Never use hooks, schedules, daemons, background monitors, recent-task
  searches, transcripts, hidden reasoning, or polling for identity.
- Never wait for delegated work after native creation.
- Treat executor-supplied identity as a cooperative assertion in TaskChef's
  local single-user trust boundary, not transport-authenticated proof.

## Dispatch

1. Split the request into the smallest independently useful outcomes. Include
   constraints, expected testing, and reporting in every instruction.
2. In parallel, list native Codex projects once and call `prepare_dispatch`
   exactly once per outcome. Never reuse a task ID or marker. Do not take a
   pre-creation thread snapshot.
3. Route against configured project `name`, `description`, and canonical
   `githubRepos`; use `path` only as checkout identity. Require exactly one
   match and an exact native-project path. Ask instead of guessing.
4. Prefix each executor instruction with the preparation's exact marker as the
   first line, a blank line, and these required paragraphs before the body:

   > This task owns the delegated assignment. Execute it in this task; do not re-dispatch it merely because it concerns TaskChef or a configured project. Explicit requests to delegate separate work remain valid.

   > Before any other work, read this executor's own durable Codex thread ID from the current task's CODEX_THREAD_ID environment value and call the TaskChef link_task MCP tool with that thread ID and the marked TaskChef task ID. Never use CODEX_SESSION_ID or the parent or delegator thread ID. If linking fails, CODEX_THREAD_ID is unavailable, or the tool is unavailable, report the failure visibly and retry on a later turn; do not guess an identity or continue substantive work while the task is link-pending.

   > After a successful initial link, and at the start of every follow-up turn before substantive work, read this exact Codex thread natively to obtain the current turn ID and call TaskChef report_state with the marked task ID, the self-linked thread ID, that current turn ID, status working, and summary omitted or null. link_task remains the first TaskChef action on the initial turn; do not report working before identity is linked. Never reuse a prior turn ID after a follow-up.

   > Before ending, read this exact Codex thread again and call TaskChef report_state for the same current working turn with status completed, needs_input, or failed and a concise summary. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.

5. Before creating each executor, call `record_task` exactly once with `id`,
   `project`, `title`, the exact marked `instruction`, and `threadId: null`.
6. Create one real Codex task using the exact configured project, an appropriate
   native environment, the marked instruction, and a short title.
7. Return immediately. Preserve a returned provisional client ID only for the
   created-thread directive. Do not call `link_task` from the dispatcher even
   when creation returns a durable ID; the child must self-link.
8. If creation fails after recording, call `report_state` with `failed`, null
   thread/turn IDs, and a bounded summary before returning the failure.

## Executor contract

The executor must make `link_task(taskId, threadId)` its first TaskChef action.
It obtains its own durable ID from the current task's `CODEX_THREAD_ID`, never
from the delegation's `sourceThreadId`, `CODEX_SESSION_ID`, inherited session
metadata, title matching, or a parent task.
Identical retries are safe. A rejected link, unavailable tool, or interrupted
initial turn leaves the record visibly link-pending and retryable; the executor
must not guess or do substantive work first.

After linking on the initial turn, and before substantive work on every later
turn, the executor reads the exact thread and calls `report_state` with
`working`, the current turn ID, and no summary. Before ending that same turn it
reports a semantic state with the same turn ID and a summary. A follow-up must
use the new turn ID. `needs_input` is only for a real user decision, not live
approval UI.

The filesystem watcher surfaces `link_task` and `report_state` writes to the
dashboard. The linked child ID drives the exact Codex deep link.
