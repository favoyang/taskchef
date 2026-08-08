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

- Add event-driven, scheduled, or background reconciliation only if interactive
  reconciliation proves insufficient.
- Evaluate heartbeat behavior, restart recovery, and recovery after the
  dispatcher task is deleted.
- Add a reconciliation cursor only when repeated full snapshots become costly
  or incorrect.
- Determine whether thread status alone is sufficient after Codex or machine
  restarts.

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
- Consider npm registry publication only after the GitHub-source installation
  and local managed-checkout workflows are stable.
