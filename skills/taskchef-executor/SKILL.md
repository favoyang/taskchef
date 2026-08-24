---
name: taskchef-executor
description: "Execute an assignment whose first instruction line is an exact TaskChef task marker, including executor ownership, self-linking, per-turn lifecycle reporting, identity safety, and final semantic state. Use when explicitly invoked by a delegated TaskChef instruction or when resuming that same executor task. Do not use to dispatch work or report on other TaskChef tasks."
---

# TaskChef Executor

Own and execute the delegated assignment in the current Codex task. Do not
re-dispatch it merely because it concerns TaskChef or a configured project.
Explicit requests to delegate separate work remain valid.

The instruction's exact first line is
`<!-- taskchef_id=<full UUID> -->`. Treat that UUID as the TaskChef task ID.
The assignment is the remaining instruction body; the final explicit skill
invocation is lifecycle scaffolding, not part of the requested deliverable.

## Start every execution turn

Complete this lifecycle setup before substantive assignment work:

1. Read this task's own durable Codex thread ID from `CODEX_THREAD_ID`. Never
   use `CODEX_SESSION_ID`, `sourceThreadId`, a parent or delegator ID,
   inherited metadata, title matching, recent-task search, transcripts, or a
   provisional client ID.
2. On the initial turn, call TaskChef `link_task` with the marked task ID and
   that exact thread ID as the first TaskChef action. An identical retry is
   idempotent. On a follow-up, retry the same link only when the prior link
   cannot be established from the task context.
3. Read this exact Codex thread natively and obtain the current turn ID. Do not
   infer it or reuse an earlier turn ID.
4. Call TaskChef `report_state` with the marked task ID, self-linked thread ID,
   current turn ID, `status: working`, and an omitted or null summary.

If `CODEX_THREAD_ID`, exact native thread reading, or a required TaskChef tool
is unavailable, or if linking or the working-state report fails, report the
failure visibly and stop before substantive work. Retry on a later turn. Never
guess identity or bypass a link-pending state.

## Finish every execution turn

Before ending, read this exact Codex thread again and call `report_state` for
the current turn with one semantic status and a concise summary:

- `completed` only when the assignment is genuinely complete.
- `needs_input` only when a semantic decision or missing information must come
  from the user.
- `failed` when the requested outcome cannot be completed or safely resumed.

A live native approval prompt is Codex state, not semantic `needs_input`; leave
the approval live instead of storing it as a TaskChef result. Never invent or
reuse a turn ID after a follow-up. If a final-report response is lost, an
identical retry is safe only while the same turn remains current. On a later
turn, run the start lifecycle with its new current turn ID and report that
turn's actual outcome. Say reporting failures visibly instead of claiming a
tracked outcome.

Summaries must omit secrets, transcripts, raw command output, hidden reasoning,
and unnecessary personal data. Identical lifecycle retries are safe; never
replace a same-turn report with different content or let an older turn
overwrite newer state.

## Compatibility

Existing delegated tasks may include the former inline ownership, linking, and
`report_result` paragraphs. Continue executing those tasks here without
re-dispatching. Prefer `report_state` when available. If an older installed
TaskChef exposes only `report_result`, follow its inline protocol; after an
upgrade, the deprecated `report_result` alias remains available for exact
legacy retries.
