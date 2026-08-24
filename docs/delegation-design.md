# Delegation and result design

TaskChef is deliberately smaller than a workflow engine. It records one useful
snapshot per delegated task, links the executor identity once, accepts semantic
results from the executor, and performs cheap freshness checks when reporting.

## Minimal workflow

```mermaid
sequenceDiagram
    participant U as User
    participant D as Delegate skill
    participant M as TaskChef MCP
    participant C as Codex executor
    participant H as Initial hook
    participant W as tasks.jsonl

    U->>D: Delegate work
    par Prepare routing
        D->>M: prepare_dispatch
    and
        D->>C: List native projects
    end
    D->>M: record_task(threadId: null)
    M->>W: Append working task under lock
    D->>C: Create task with exact marker
    alt Durable ID returned
        D->>M: resolve_task
    else Provisional ID returned
        D->>C: Bounded recent-task checks
        D->>C: Read candidates and verify exact marker
        D->>M: resolve_task(verified child ID)
        C->>H: Initial UserPromptSubmit
        H->>W: Wait for verified link; record initial turn
    end
    D-->>U: Return immediately
    C->>M: report_result(needs_input | completed | failed)
    M->>W: Replace latest semantic snapshot under lock
```

Recording happens before creation. This closes the only important race: when
the initial hook runs, the exact TaskChef marker already has an entry to update.
The dispatcher performs only the bounded 10/30-second identity checks. There is
no scheduler, daemon, indefinite polling, or dispatcher wakeup.

Every executor receives this ownership instruction unchanged:

> This task owns the delegated assignment. Execute it in this task; do not re-dispatch it merely because it concerns TaskChef or a configured project. Explicit requests to delegate separate work remain valid.

## Who writes what

| Writer | Trigger and condition | Fields it owns |
| --- | --- | --- |
| Dispatcher via `record_task` | Before executor creation | New entry, `status: working`, null identity/result, server timestamps |
| Dispatcher via `resolve_task` | Creation returns a durable ID, or bounded discovery verifies one exact-marker child | `threadId` only |
| Initial `UserPromptSubmit` hook | Prompt starts with the exact TaskChef marker and the verified link exists | Initial `turnId`, `status: working`, `updatedAt`, `updatedBy: hook` |
| Follow-up `UserPromptSubmit` hook | Session ID exactly matches a recorded executor | Nothing; reads the snapshot and injects the current `turnId` for the MCP callback |
| Executor via `report_result` | Work has a semantic outcome | `status`, bounded `summary`, result `turnId`, `updatedAt`, `updatedBy: mcp` |
| Reporter | On explicit report request | Nothing; inferred live state is never persisted |

The hook does not write needs-input, completed, or failed. Its follow-up path is
read-only and exists only so the executor can report the current turn. A native permission
request is live Codex state; it is not a TaskChef semantic result. The executor
uses `needs_input` only when it truly requires a user decision or information.

## Task snapshot

Schema version 3 retains the delegation fields and adds:

- `status`: `working`, `needs_input`, `completed`, or `failed`
- `summary`: null while working, otherwise a concise result capped at 2,000 characters
- `turnId`: initial or latest reported turn; linked MCP results require it, and
  only a pre-thread creation failure may report null
- `updatedAt`: server-side timestamp
- `updatedBy`: `dispatcher`, `hook`, or `mcp`

Schema versions 1 and 2 remain readable and normalize to nullable result fields.
There is no result-event file: each callback replaces the latest snapshot on the
same JSONL line.
Result instructions forbid secrets, transcripts, and raw command output; the
server also caps the stored summary at 2,000 characters.

## Locking and conflicts

All configuration, identity, and result writes use the existing cross-process
workspace lock. A writer acquires the lock, rereads and validates the complete
JSONL file, changes one exact task, and publishes a complete replacement with
an atomic rename. Concurrent writers therefore cannot create partial JSON,
duplicate entries, or lose changes to different tasks. Sequential callbacks for
the same task use last accepted write wins; normal executor turns are already
sequential.

SQLite is postponed because this file-level write volume is tiny and the
existing lock provides the property users need. SQLite becomes worthwhile only
if TaskChef later adds high-frequency event history or many continuous writers.

## Result trust

The MCP server does not receive an independently authenticated caller task ID
from the model transport. It validates that the supplied task exists and that
the supplied durable thread ID exactly matches the recorded thread. The turn ID
is stored as evidence but remains model-supplied. A trusted plugin install,
local-only MCP server, bounded summary, and exact task/thread match are the
current trust boundary.

This is sufficient for a lightweight personal dispatcher, but not a
multi-tenant authorization boundary. Transport-authenticated caller identity is
postponed until Codex exposes it.

## Fresh reporting without reading every task

A stored result is cached evidence, not permanent truth. Overview reports:

1. Load `tasks.jsonl` once.
2. Always consider working, needs-input, unresolved, and legacy entries.
3. Consider completed or failed entries updated in the last seven days.
4. Take one recent-thread metadata snapshot for all selected tasks. Include an
   older terminal task in an overview when the snapshot shows it is active or
   awaiting native approval.
5. A null-thread/null-turn `failed` snapshot written by MCP is a fresh creation
   failure and needs no live task lookup because no executor exists.
6. Treat only `updatedBy: mcp` as a semantic cache. Dispatcher- and hook-written
   `working` snapshots require a targeted live read; an inactive task with no
   callback has an unknown outcome.
7. In a broad overview, use an MCP result directly when identity is certain and
   the task is inactive; do not fan out detailed reads over idle terminal tasks
   solely because their timestamps are newer.
8. Active or awaiting-approval metadata overrides the cached result directly.
   For a focused task, title, or project report, read each selected inactive
   task at most once when matched metadata is newer than the callback by any
   amount. Batch targeted immediate reads, at most eight tasks per call, also
   for a missing callback, uncertain or contradictory state, or an explicitly
   fully-live request.
9. If an anomaly triggers a detailed read, compare its latest structured turn
   ID and native turn state with stored `turnId`. A newer turn without a
   callback makes the cache stale. An interrupted or cancelled callback turn
   cannot prove completion.

An explicit task, title, or project report bypasses the seven-day overview
filter. Old terminal tasks skipped from an overview are counted so the user
knows history was intentionally omitted.

The cheap operation is the single list/metadata snapshot, not one read per
historical task. It is sufficient to expose active and native-approval state for
many recent tasks at once. It does not prove completion; semantic outcomes come
from MCP callbacks. Detailed thread reads are the exceptional fallback.
Timestamps are a pragmatic anomaly filter; turn IDs and native turn state
provide the stronger check whenever a targeted response is necessary.

## Permission and follow-up example

1. Delegation records one `working` entry with null identity.
2. The dispatcher verifies and resolves the child thread; the initial hook then
   records its initial turn without trusting the inherited session ID.
3. The executor reaches a real product decision and calls `report_result` with
   `needs_input` plus “Approve deployment to production.”
4. The user opens that executor and approves. The same hook reads the matching
   task and injects the new turn ID without changing the stored snapshot. Until
   the final callback, a report sees newer/active live metadata and labels the
   cached needs-input result stale.
5. The executor finishes and calls `report_result` with `completed`, the new
   turn ID, and a concise outcome. The same JSONL line now contains the completed
   snapshot.

If step 3 were merely Codex asking for filesystem or command approval, no MCP
callback would be written. Reporting would show “awaiting native approval” from
live task state.

## Explicitly postponed

- append-only result or transition events
- lifecycle event types beyond `UserPromptSubmit`
- fork tracking or result merging
- SQLite
- indefinite polling, reconciliation schedules, daemons, and dispatcher wakeups
- durable report watermarks
- transcript or assistant-prose classification
- transport-authenticated caller thread/turn identity
