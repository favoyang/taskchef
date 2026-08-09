# TaskChef backlog

This document contains capabilities intentionally excluded from the v1 MVP.
`SPEC.md` is the canonical v1 contract.

## Task activity and automatic reporting

- Determine whether Codex hook `session_id` reliably maps to a recorded task
  `threadId`.
- Evaluate task-specific hooks without inferring ownership from project path.
- Evaluate an explicit executor callback such as `taskchef task report`.
- Decide how delegated tasks can safely update the data workspace across Codex
  filesystem boundaries.
- Add automatic finish signals only after task attribution is proven reliable.
- Design event ordering, deduplication, cursors, and replay semantics before
  introducing `events.jsonl`.

## Reconciliation and continuity

- Prototype one standalone Codex Scheduled Task per dispatcher workspace. Run
  it in the local project, not an isolated worktree, so updates reach the
  canonical `tasks/*/task.json` records. Default to every 15 minutes and let the
  user choose another cadence when enabling it.
- Use a durable prompt that explicitly invokes `$taskchef-reconcile`, names the
  dispatcher workspace, processes every candidate in sequential batches of at
  most eight thread snapshots, and reports only changed, blocked, finished, or
  failed records. An unchanged run produces one concise no-change result.
- Add an atomic per-workspace reconciliation lease before enabling schedules.
  One run acquires it, releases it on completion, and skips when another run
  holds it. Treat a lease older than 30 minutes as stale and report its recovery.
- Do not retry failed snapshots within the same run. Report the affected task
  IDs and let the next scheduled run retry them.
- Keep the scheduled task active when there are no candidates so later
  delegations are discovered without re-enabling it. Only the user pauses or
  deletes the schedule. Test the durable prompt manually before enabling it.
- Keep scheduled reconciliation opt-in. Ordinary delegation must not wait for
  or invoke `$taskchef-reconcile`; users can request it explicitly to refresh
  outdated states.
- Evaluate heartbeat behavior, restart recovery, and recovery after the
  dispatcher task is deleted.
- Add a reconciliation cursor only when repeated full snapshots become costly
  or incorrect.
- Determine whether thread status alone is sufficient after Codex or machine
  restarts.
- Decide whether `$taskchef-bootstrap` should be renamed to
  `$taskchef-workspace` or split into setup and project-management skills.
  Until then, keep project listing and configuration in `$taskchef-bootstrap`
  rather than mixing workspace administration into delegation.

## Grouping and history

- Add dispatch or run records only when batch cancellation, aggregate status,
  replay, or decomposition history has a concrete use case.
- Decide whether and how to retain the original broad prompt.
- Add archival and retention policies for old task records.

## V2: remote connection projects

- Import remote connection projects returned by the native project-list tool.
- Persist the native `projectId` and `hostId` needed to distinguish identical
  paths on different hosts and route task creation.
- Re-resolve stored native identities against the project list before every
  dispatch instead of assuming they remain valid indefinitely.
- Validate remote paths and Git state through native host-aware project data;
  do not run local filesystem validation against a remote path.
- Persist enough host context with delegated tasks to reconcile remote threads
  reliably without arbitrary task discovery.
- Define unavailable-host, renamed-project, moved-path, and stale-identity
  behavior before enabling remote dispatch.
- Evaluate worktrees and isolated execution for concurrent tasks in one
  project.
- Define conflict handling when several tasks modify the same checkout.

## Data model extensions

- Add richer result fields only when real integrations require them.
- Evaluate structured verification, artifacts, commits, and completion outcome
  fields.
- Support multiple executor threads for one logical task if needed.
- Define schema migrations and compatibility rules after the first persisted
  v1 records exist.

## Integrations and distribution

- Add GitHub automation beyond storing PR and issue URLs.
- Evaluate automatic project discovery instead of an explicit configured list.
- Evaluate marketplace discovery and update automation after the shared plugin
  catalog has real usage.
