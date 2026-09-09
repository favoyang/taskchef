---
name: taskchef-executor
description: "Execute and report a TaskChef assignment or follow-up when explicitly invoked or carrying an accepted TaskChef marker. Owns executor identity and per-turn lifecycle; not dispatch or reporting on other tasks."
---

# TaskChef Executor

Own the delegated assignment in this stable visible Codex task. Do not
re-dispatch it merely because it concerns TaskChef or a configured project.
When the linked record is orchestrated, this parent coordinates fresh internal
role subagents under [the orchestration contract](references/orchestration.md).
Explicit requests to delegate separate independent work remain valid.

New instructions present the complete assignment first, then the reporting
authorization paragraph, followed by exactly two newline characters (one blank
line), the explicit skill invocation, one newline, and the exact
`<!-- taskchef_id=<full UUID> -->` marker on the final line.
There is no blank line between the invocation and marker.
Treat that UUID as the TaskChef task ID.
The authorization, invocation, and marker are lifecycle scaffolding, not part
of the deliverable. Require non-whitespace task-specific content beyond them.
For historical first-line markers, marker-before-invocation forms, compact or
pre-authorization prompts, former inline protocol, or an installation exposing only `report_result`, read
[compatibility](references/compatibility.md) before interpreting the assignment.
Require exactly one marker and do not infer an ID from similar prose.

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
3. Establish this prompt's lifecycle identity before reporting. If this exact
   Codex thread can be read natively and exposes the current turn ID, use that
   exact value for both `turnRef` and `turnId`. Otherwise generate one fresh
   UUID locally, retain it for this entire prompt, use it as `turnRef`, and use
   `turnId: null`. Do not infer a native ID, reuse an earlier prompt's
   `turnRef`, or let a retry generate a replacement UUID.
4. Inspect the linked task's `executionMode`. For `orchestrated`, read the
   orchestration reference, classify this prompt, and include its `intent`,
   bounded `acceptedScope`, and optional repository-relative `planRef`. For
   `legacy`, preserve the historical single-executor behavior unless the user
   explicitly opts into contract version 1 on a new follow-up and current MCP
   capabilities support it. Never adopt an active task mid-phase.
5. Call TaskChef `report_state` with the marked task ID, self-linked thread ID,
   this prompt's `turnRef` and optional Codex `turnId`, `status: working`, an
   omitted or null result summary, and a concise `requestSummary` describing this turn's assignment or follow-up.
   When the turn targets a known GitHub repository, include its canonical
   `https://github.com/<owner>/<repository>` URL so multi-repository projects
   retain the selected repository instead of leaving TaskChef to guess.

## Execute the assignment

For `orchestrated` records, follow the complete
[orchestration contract](references/orchestration.md). The parent owns
authority, lifecycle, worktree and writer safety, Planrock, handoff acceptance,
review-gate control, communication, and delivery verification. Fresh planner,
implementer, and reviewer subagents perform substantive phases. If spawning or
role resolution is unavailable, fail visibly; do not pretend orchestration or
silently implement in the parent.

For `legacy` records, execute directly under the historical contract in this
task. Existing records are never bulk-migrated or silently relabelled. A later
explicit adoption keeps the same parent/thread, starts a new lifecycle turn,
records current parent resolution evidence, and does not rewrite historical
model or phase claims.

If the preceding TaskChef turn is still unfinished because its terminal report
was lost, this newer valid working report atomically records that predecessor
as interrupted and starts the current turn. Continue the real assignment from
the current request. Do not manufacture a semantic `failed` result for the old
turn and do not retry an old terminal report.

If `CODEX_THREAD_ID` or a required TaskChef tool is unavailable, or if linking
or the working-state report fails, report the failure visibly and stop before
substantive work. Native turn reading is optional because the retained fallback
UUID is the lifecycle identity. Retry a possibly lost working callback with the
same `turnRef`; never generate a replacement for the same prompt or bypass a
link-pending state.

## Finish every execution turn

Before ending, call `report_state` with the same `turnRef` and `turnId` values
used by this prompt's working report, one semantic status, and a concise summary:

- `completed` only when the assignment is genuinely complete. Orchestrated
  mode additionally requires all intent-mandated phases accepted and no active
  phase or writer.
- `needs_input` only when a semantic decision or missing information must come
  from the user.
- `failed` when the requested outcome cannot be completed or safely resumed.

A live native approval prompt is Codex state, not semantic `needs_input`; leave
the approval live instead of storing it as a TaskChef result. Never invent or
reuse a `turnRef` after a follow-up. If a final-report response is lost, an
identical terminal retry is safe only while the same turn remains current. On
a later prompt, run the start lifecycle with a new `turnRef`; TaskChef
will preserve the predecessor as interrupted, and only the new turn may receive
a semantic result.

Claim TaskChef was updated only after verifying the terminal response accepted
this task, turn, status, and summary. Report failures visibly. If the platform
rejects an authorized report, describe it as a platform rejection of that
report; quote only a rationale actually returned. Do not infer the reason,
promise approval, retry around an explicit denial, or change approval settings.
Ask the user once and wait for new authorization before retrying a denial.

Request and result summaries must omit secrets, transcripts, raw command output, hidden reasoning,
and unnecessary personal data. Identical lifecycle retries are safe; never
replace a same-`turnRef` report with different content or let an older turn
overwrite newer state.

## Preserve delivery context

Summaries are the durable TaskChef timeline; the dashboard does not scan the
full Codex transcript later. Include the known repository's canonical
`https://github.com/<owner>/<repository>` URL in the working `requestSummary`.
Use full canonical issue or pull-request URLs and include every delivered PR
in the terminal summary, including both child and workspace PRs when relevant.
Derive links from established project or remote evidence; never invent links
or copy unrelated links from earlier turns.

## Ending actions

Normal completion returns normally after accepted terminal reporting. Never
archive, hand off, close, navigate away from, or terminate the executor merely
because work completed. `finish`, `complete`, `done`, `ship`, and ordinary
cleanup do not authorize archive. Only when the user explicitly requests
archiving this exact task or another action that can make the executor
unavailable, read [ending actions](references/ending-actions.md) first.
