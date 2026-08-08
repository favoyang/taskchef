---
name: taskchef-reconcile
description: "Reconcile active TaskChef task records with their visible Codex executor threads. Use at the start of ordinary prompts in a TaskChef workspace, for TaskChef status or progress requests, after delegated work may have completed or blocked, or for an explicitly requested full refresh. Performs one bounded snapshot pass and never polls or waits for future activity."
---

# TaskChef Reconcile

Refresh TaskChef's recorded task state from native Codex threads exactly once.

Resolve this linked skill with `realpath`. The TaskChef source root is three
parents above the skill directory. Invoke `<source-root>/bin/taskchef.js` for
all deterministic record operations.

## Reconcile

1. Run `task reconcile-candidates --json` once. It returns only `running` and
   `blocked` tasks with thread IDs. Do not scan pending or finished records.
2. Query every returned thread exactly once using immediate native snapshots,
   with no more than eight targets per call.
3. Do not wait for future activity and do not poll.
4. Map an active attempt to `running`, a user-input or external dependency to
   `blocked`, and any concluded attempt to `finished`, including failed or
   partial attempts.
5. Preserve an existing result unless the thread provides a meaningful newer
   report. Results contain exactly `message`, `githubPRs`, and `githubIssues`.
6. Update each changed record once with `task update`.
7. Report a concise snapshot and continue with the user's request. If there
   were no candidates or changes, say so briefly.

Use `task reconcile-candidates --include-finished --json` only when the user
explicitly requests a full refresh or says a finished executor received new
work. A finished task with a new active attempt becomes `running` again.

The native thread is authoritative between reconciliations. Executor reports
are evidence, not independently verified completion guarantees.
