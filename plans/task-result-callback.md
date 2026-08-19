---
title: Minimal task result callbacks and fresh reports
state: closed
priority: P1
created_at: 2026-08-19
closed_at: 2026-08-19
---

## Goal

Give TaskChef users a small, useful current-state view: record a task before
executor creation, resolve a fresh root task from its initial hook without the
bounded wait-and-snapshot fallback, accept semantic executor results through
MCP, and report only active, attention-worthy, or recently changed tasks while
using cheap live metadata to reject stale cached results.

## Implementation

- [x] Extend the versioned task record with minimal current-state fields and
      conditional, locked, atomic patch operations.
- [x] Change delegation to record before executor creation and make durable
      thread resolution idempotent between the dispatcher and initial hook.
- [x] Add one plugin `UserPromptSubmit` hook that resolves only an exact initial
      TaskChef marker, relying on the fresh executor being a root task.
- [x] Add an MCP result tool for `needs_input`, `completed`, and `failed`, with
      server timestamps, bounded summaries, exact task/thread validation, and a
      required model-supplied turn ID stored as freshness evidence.
- [x] Update report behavior to prefer cached semantic results, use batched live
      metadata for active/approval/recently changed tasks, and perform detailed
      reads only for stale, missing, or ambiguous results.
- [x] Update dispatcher, delegate, report, README, and specification guidance.
- [x] Add focused concurrency, hook, callback, migration, delegation, and report
      tests; run plugin/skill validation and the complete test suite.

## Explicitly postponed scope

- Event or transition history files; `tasks.jsonl` stores only the latest useful
  task snapshot.
- Lifecycle state writes from permission, tool, stop, session-end, notification,
  or subagent hooks. The only v1 hook is initial identity resolution.
- Automatic tracking or merging of forked executor tasks. A TaskChef task owns
  its recorded canonical `threadId`; a fork is a separate Codex task.
- SQLite or another database. The existing cross-process workspace lock plus
  read-merge-atomic-replace remains the storage mechanism.
- Polling, scheduled reconciliation, daemons, dispatcher wakeups, or waiting for
  executor completion.
- Durable per-user/per-project report watermarks or acknowledgement state.
  Recent-task filtering uses task and Codex update timestamps with a documented
  default window.
- Transcript parsing, assistant-prose classification, hidden-reasoning capture,
  or trusting model-supplied thread identity without validation.
- Marketplace release work: version bump, cachebuster, publishing, and
  reinstalling the built plugin. This plan delivers and validates the source
  working tree only.
