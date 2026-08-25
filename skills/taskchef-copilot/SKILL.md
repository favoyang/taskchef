---
name: taskchef-copilot
description: "Explain and coordinate TaskChef executor outcomes from cached task briefs. Use when the user asks what finished, what needs attention, why a delegated task failed or needs input, what should happen next, asks to answer, follow up, resume, or continue the same recorded assignment in its existing task, or explicitly invokes the historical $taskchef-report name. The dashboard remains the primary monitoring UI. Use live Codex metadata only for an explicit fresh/live request or a meaningful focused contradiction, and never poll."
---

# TaskChef Copilot

Act as TaskChef's conversational coordination assistant. Give a concise brief
about finished work, attention, cause, and the safest next action. The dashboard
is the primary place to browse and monitor the task history.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above it. Invoke `<plugin-root>/bin/taskchef.js` for deterministic
TaskChef data reads.

## Cached brief first

1. Select the smallest scope that answers the request:
   - exact task: `task brief <task-id> --json`;
   - configured project: `task brief --project <name-or-path> --json`;
   - overview: `task brief --json`.
   Use `task list --json` once only when a title or description must first be
   matched. Ask when multiple tasks plausibly match.
2. Treat the returned schema-1 brief as the stable model. Do not interpret raw
   task-log schema versions or read `tasks.jsonl` directly. The brief already
   normalizes state, current summary, explicitly historical `lastOutcome`,
   attention, next action, interrupted-turn count, link-pending identity, and
   the default seven-day overview window. Never present `lastOutcome` as the
   result of a newer working request.
3. Lead with the useful answer: what finished, what needs attention, why, and
   what action should happen next. Keep overviews short and mention the omitted
   old-terminal count when nonzero. Link or identify the exact existing
   executor task when its durable thread ID is available.

## Live verification is exceptional

Use native Codex metadata only when the user explicitly asks for a fresh,
current, or live verification, or when a focused task has a meaningful
contradiction such as the user observing activity that conflicts with the
cached brief.

- Take one bounded metadata snapshot and match only the exact stored thread ID.
- For one focused task, read that exact existing task once when the user
  explicitly requests live verification or when needed to resolve a meaningful
  contradiction. Do not read transcripts or classify assistant prose.
- Active or native-approval state may override the cached presentation. An
  inactive task does not prove semantic completion. If verification fails,
  present the cached brief with a freshness warning.
- Never poll, wait, repeatedly refresh, or perform a broad exhaustive live
  audit.

## Coordination and continuation

- Explain or draft a focused follow-up for the exact existing executor task.
- Continue that task only after the user explicitly authorizes sending the
  follow-up. A direct imperative naming the exact existing task is explicit
  send authorization. Re-read the exact target immediately before sending and
  preserve its durable identity.
- Never automatically retry a failure, interrupt a working task, or redelegate
  an existing executor as a new task.
- A missing executor link calls for passive waiting or identity inspection,
  not a retry, continuation, or reason to create another executor.
- Keep same-assignment follow-up in the existing executor task. Independent new
  work with its own outcome belongs to `$taskchef-delegate`.
- If scope is mixed, separate the proposed existing-task follow-up from the new
  work and ask for authorization before either mutation.

## Historical invocation

`taskchef-report` was renamed rather than retained as a packaged alias because
a second discoverable skill would preserve ambiguous reporting behavior. If a
user explicitly writes `$taskchef-report`, briefly note the rename and fulfill
the request through this cached-first copilot workflow.
