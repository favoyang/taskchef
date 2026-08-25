---
name: taskchef-executor
description: "Execute an assignment carrying either the new exact TaskChef invocation-plus-final-marker scaffold or an accepted historical first-line or marker-before-invocation protocol. Includes executor ownership, self-linking, per-turn lifecycle reporting, identity safety, and final semantic state. Use when explicitly invoked by a new delegated instruction or when resuming the same new or historical executor task. Do not use to dispatch work or report on other TaskChef tasks."
---

# TaskChef Executor

Own and execute the delegated assignment in the current Codex task. Do not
re-dispatch it merely because it concerns TaskChef or a configured project.
Explicit requests to delegate separate work remain valid.

New instructions present the complete assignment first, followed by exactly two
newline characters (one blank line), the explicit skill invocation, one
newline, and the exact `<!-- taskchef_id=<full UUID> -->` marker on the final
line. There is no blank line between the invocation and marker. Treat that UUID
as the TaskChef task ID.
The assignment is everything before the invocation; the invocation and marker
are lifecycle scaffolding, not part of the deliverable. Require exactly one
marker and do not infer an ID from similar prose.

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
   current turn ID, `status: working`, an omitted or null result summary, and a
   concise `requestSummary` describing this turn's assignment or follow-up.

If the preceding TaskChef turn is still unfinished because its terminal report
was lost, this newer valid working report atomically records that predecessor
as interrupted and starts the current turn. Continue the real assignment from
the current request. Do not manufacture a semantic `failed` result for the old
turn and do not retry an old terminal report.

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
identical terminal retry is safe only while the same turn remains current. On
a later turn, run the start lifecycle with its new current turn ID; TaskChef
will preserve the predecessor as interrupted, and only the new turn may receive
a semantic result. Say reporting failures visibly instead of claiming a tracked
outcome.

Request and result summaries must omit secrets, transcripts, raw command output, hidden reasoning,
and unnecessary personal data. Identical lifecycle retries are safe; never
replace a same-turn report with different content or let an older turn
overwrite newer state.

## Compatibility

Existing delegated tasks may include the former inline ownership, linking, and
`report_result` paragraphs. Continue executing those tasks here without
re-dispatching. Prefer `report_state` when available. If an older installed
TaskChef exposes only `report_result`, follow its inline protocol; after an
upgrade, the deprecated `report_result` alias remains available for exact
legacy retries. Also accept historical trailing instructions that place the
marker before the invocation, with or without the former blank line before the
marker; the former compact assignment-to-invocation boundary with the marker
last; an exact HTML marker on the first line with or without the former blank
line; or the older exact
first-line `# taskchef_id=<full UUID>` heading. These compatibility forms do not
change the identity or lifecycle rules above. For either first-line form, the
assignment follows the marker. Ignore the final executor invocation and any
recognizable former inline ownership, linking, working-state, or
result-reporting paragraphs as lifecycle scaffolding; execute the remaining
task-specific body. Require non-whitespace task-specific content and never
treat an invocation by itself as an assignment.
