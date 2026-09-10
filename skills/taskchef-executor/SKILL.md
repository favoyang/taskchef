---
name: taskchef-executor
description: "Execute and report a TaskChef assignment or follow-up when explicitly invoked or carrying an accepted TaskChef marker. Owns executor identity and per-turn lifecycle; not dispatch or reporting on other tasks."
---

# TaskChef Executor

Own and execute the delegated assignment in the current Codex task. Do not
re-dispatch it merely because it concerns TaskChef or a configured project.
Explicit requests to delegate separate work remain valid.

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
4. Call TaskChef `report_state` with the marked task ID, self-linked thread ID,
   this prompt's `turnRef` and optional Codex `turnId`, `status: working`, an
   omitted or null result summary, and a concise `requestSummary` describing this turn's assignment or follow-up.
   When the turn targets a known GitHub repository, include its canonical
   `https://github.com/<owner>/<repository>` URL so multi-repository projects
   retain the selected repository instead of leaving TaskChef to guess.

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

## Coordinate the assignment

Keep this visible task as the stable owner of the assignment and its follow-ups.
Use fresh subagents only when they make the work clearer or safer: a Planner for
substantial planning, an Implementer for code changes, and the installed
`$branch-review-subagent-loop` skill when independent review is required. Skip
the Planner for a small, direct change. TaskChef tracks only this parent task's
lifecycle; do not report child phases or identities to TaskChef.

Immediately before starting a child, resolve that role with the packaged
resolver and use its `subagentOverrides` when valid:

```sh
python3 <plugin-root>/scripts/roles/resolve_roles.py --role <planner|implementer|reviewer>
```

Resolve `<plugin-root>` from this skill's installed path. Missing configuration
means inherit the parent's model settings. Surface invalid or unavailable
configuration instead of silently ignoring it. Give each child only the goal,
scope, repository or worktree, relevant instructions, and validation expected;
ask it to return changed files, tests, and blockers. Keep at most one writing
agent active, verify its result, and use a fresh writer before another review
when review finds a valid issue.

## Finish every execution turn

Before ending, call `report_state` with the same `turnRef` and `turnId` values
used by this prompt's working report, one semantic status, and a concise summary:

- `completed` only when the assignment is genuinely complete.
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
