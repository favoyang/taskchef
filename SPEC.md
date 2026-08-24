# TaskChef specification

## Purpose

TaskChef routes work from a data-only dispatcher workspace to visible Codex
project tasks, stores exact child links, and caches explicit semantic results.

## Workspace

The canonical workspace contains only:

- `AGENTS.md`: managed dispatcher instructions plus user instructions.
- `taskchef.json`: schema-versioned configured projects.
- `tasks.jsonl`: append-on-create, atomic-rewrite-on-update task snapshots.

All workspace writes use one lock and atomic replacement. Task IDs and non-null
thread IDs are globally unique.

## Task schema

New records use schema version 4 and contain:

- immutable `id`, project snapshot, title, instruction, and `createdAt`;
- nullable `threadId` until executor self-linking succeeds;
- `status`, nullable bounded `summary`, nullable `turnId`, `updatedAt`, and
  `updatedBy`.

New unresolved records require the exact first-line HTML marker followed by a
blank line. Schema 1-3 records and historical `updatedBy: hook` values remain
readable without eager migration, and task read/list APIs expose their persisted
schema version so reporting can distinguish legacy recovery from schema 4
executor link-pending state.

## Dispatch workflow

1. `prepare_dispatch` validates the workspace and returns one fresh lowercase
   UUID, exact marker, timestamp, and routing targets.
2. The marked instruction contains the executor ownership paragraph, mandatory
   first-action `link_task` paragraph, result callback paragraph, and task body.
3. `record_task` writes schema 4 with `threadId: null` before creation.
4. Native task creation runs once.
5. The dispatcher returns immediately, including for a provisional worktree
   client ID. It does not list or read tasks, search markers, wait, poll, or
   link the record.
6. Creation failure writes a terminal `failed` result with null identities and
   a concise bounded summary.

## Executor self-linking

The executor obtains its own durable native thread ID and calls
`link_task(taskId, threadId)` before substantive work. The operation:

- accepts only schema 4 records;
- rejects unknown task IDs, malformed/provisional IDs, exact-marker mismatch,
  thread reuse, and conflicting retries;
- atomically changes only `null` to one durable ID under the workspace lock;
- is idempotent for the same task and ID;
- leaves rejected, unavailable, interrupted, or cancelled links visibly
  pending and retryable.

The executor must never use a parent/delegator ID, inherited session identity,
title match, or provisional client ID. This is a cooperative local assertion,
not transport-authenticated caller identity.

## Semantic results

`report_result` accepts `completed`, `needs_input`, or `failed` with a concise
summary. Linked tasks require an exact stored thread-ID match and a non-null
current turn ID. Self-linked schema 4 journeys require canonical, time-ordered
Codex UUID turn IDs; each changed semantic result must use an ID newer than the
stored turn, while an identical same-turn retry is idempotent. Creation failure
is the sole null-identity result. Follow-up turns must self-read the exact
thread and submit the new turn ID. Atomic writes preserve one JSONL line per
task.

## Legacy resolver

The CLI-only `taskchef task resolve` command accepts unresolved schema 1-3
records after an operator establishes one exact marker match. It rejects schema
4 records. There is no public `resolve_task` MCP tool.

## Dashboard and reports

The existing file watcher observes `link_task` and result rewrites in real
time. "Open task in Codex" uses only the self-linked child ID. Reports treat
`updatedBy: mcp` terminal or needs-input snapshots as semantic cache and may
compare them with one native metadata snapshot. Reporting never mutates task
history or infers completion from hooks.

## Packaging

The plugin ships its skills, MCP server, CLI, dashboard, and source modules. It
contains no hooks configuration, hook executable, hook runtime, or hook trust
requirement.

## Acceptance

- Record-before-create and exact-marker guarantees remain mandatory.
- Creation returns without post-create waiting, polling, task search, or reads.
- A provisional-path executor self-links its exact durable child ID before
  substantive work.
- Parent/delegator and provisional IDs cannot be accidentally substituted.
- Link and result retries are idempotent; conflicts cannot corrupt JSONL.
- Link failures remain visible and retryable; creation failures are terminal.
- Current-turn freshness is retained across needs-input, follow-up, and final
  completion.
- The plugin installs and runs without hook configuration or approval.
