# TaskChef workflows

This developer and advanced-agent guide explains how the current implementation
moves data through TaskChef. The [specification](spec.md) is normative; the
[README](../README.md) owns user operation. The
[FirstMate comparison](firstmate-taskchef-comparison.md) is non-normative
research.

## Implementation map

| Surface | Responsibility |
| --- | --- |
| `skills/taskchef-delegate/SKILL.md` | Split, route, record-before-create, create, return. |
| `skills/taskchef-executor/SKILL.md` | Own, self-link, execute, and report every executor turn. |
| `skills/taskchef-bootstrap/SKILL.md` | Initialize current workspace and configure projects. |
| `skills/taskchef-report/SKILL.md` | Select cached tasks and perform bounded live checks. |
| `src/mcp.js` | Dashboard ensure, four primary lifecycle tools, one deprecated alias, shutdown ownership, and MCP annotations. |
| `src/delegation.js` | UUID marker, concise executor-skill invocation shape, and creation-failure handling. |
| `src/workspace.js` | Current schemas, validation, locking, atomic JSONL writes, linking, and result freshness. |
| `src/cli.js` | Administration, inspection, diagnostics, and dashboard startup. |
| `src/dashboard.js` | Versioned health identity, validated compact snapshots, SSE fan-out, on-demand details, and bounded open actions. |
| `src/dashboard-manager.js` | Concurrent singleton ensure, exact listener reuse, conflicts, and owned shutdown. |

The MCP process resolves `TASKCHEF_WORKSPACE` once and never accepts a model
supplied path. The CLI resolves `--workspace`, then the environment, then the
per-user default.

## Dispatcher dashboard lifecycle

The generated managed `AGENTS.md` block makes dashboard maintenance a
best-effort prelude to every dispatcher turn and keeps response ordering
centralized instead of duplicating it across delegate/report skills.

```mermaid
sequenceDiagram
  autonumber
  participant D as Dispatcher
  participant M as TaskChef MCP
  participant H as Loopback health
  participant S as Dashboard server
  D->>M: ensure_dashboard()
  M->>M: Serialize concurrent ensure calls
  M->>H: GET 127.0.0.1:3210/api/health
  alt Exact service, versions, and canonical workspace
    H-->>M: Bounded compatible identity
    M-->>D: reused, URL, workspace, versions
  else No listener
    H--xM: Connection refused
    M->>S: Start in this MCP process on 127.0.0.1:3210
    S-->>M: Owned server
    M-->>D: started, URL, workspace, versions
  else Unknown, stale, or different workspace
    H-->>M: Missing or incompatible identity
    M-->>D: Actionable conflict, listener untouched
  end
  Note over D: Continue even when ensure failed
  D-->>D: Answer, report, or dispatch
  Note over D: Created-thread directive, when any, precedes final dashboard link
```

When the MCP transport or plugin process closes, it closes only the server it
started. A compatible foreground `taskchef dashboard` listener may be reused
but remains owned by that CLI process. No TaskChef path terminates an unknown
listener or installs OS persistence.

## Normal delegation and self-linking

The dispatcher uses native Codex project discovery for routing and MCP for
TaskChef state. It never supplies executor identity.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant D as Dispatcher skill
  participant M as TaskChef MCP
  participant W as workspace.js
  participant C as Native Codex
  participant E as Executor
  U->>D: Request outcome
  par Route once
    D->>C: List native projects
  and Prepare each outcome
    D->>M: prepare_dispatch()
    M->>W: prepareDispatch()
    W-->>M: UUID, marker, projects
    M-->>D: preparation
  end
  D->>D: Choose one configured and native project
  D->>M: record_task(id, project, title, instruction, null)
  M->>W: recordTask()
  W->>W: Lock, validate, append schema-8 snapshot
  W-->>M: working link-pending task
  M-->>D: task
  D->>C: Create executor with marked instruction
  C-->>D: Created-task reference
  D-->>U: Return immediately
  C->>E: Start executor and load $taskchef-executor
  E->>E: Read own CODEX_THREAD_ID
  E->>M: link_task(taskId, threadId)
  M->>W: linkTask()
  W->>W: Lock and replace null identity atomically
  W-->>E: linked working task
```

Record-before-create makes native creation failure observable. Executor
self-linking removes dispatcher-side polling, task search, title matching, and
parent/child identity inference.

The generated task begins with the complete assignment, then places one explicit
`$taskchef-executor` invocation immediately before its final marker. Older
recorded tasks with first-line HTML or heading markers and former inline
protocol remain readable; the deprecated `report_result` alias preserves their
semantic callbacks.

## State reporting

The executor obtains the turn identity from an exact native read of its own
linked task. `report_state` records live turn state as a paired request/result
timeline.

```mermaid
sequenceDiagram
  autonumber
  participant E as Executor
  participant C as Native Codex task API
  participant M as TaskChef MCP
  participant W as workspace.js
  E->>C: Exact read of linked executor
  C-->>E: Current turn ID
  E->>M: report_state(..., working, requestSummary)
  M->>W: reportTaskState()
  W->>W: Append turn with request and null result
  E->>E: Work, finish, or reach semantic decision
  E->>M: report_state(..., semantic status, summary)
  M->>W: reportTaskState()
  W->>W: Lock and validate identity and freshness
  alt Same current working turn
    W->>W: Fill that turn's result and derive compatibility results
    W-->>M: Updated task
    M-->>E: Recorded result
  else Same turn and same result
    W-->>M: Existing task
    M-->>E: Idempotent success
  else Conflict or stale turn
    W-->>M: Tool error
    M-->>E: Visible failure
  end
```

A native approval prompt is not a semantic result. `needs_input` is reserved
for a user decision or fact required to proceed.

## Follow-up turns

Turn IDs are freshness tokens for semantic callbacks. Lexical UUIDv7 order lets
the workspace reject a callback from an older executor turn.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant E as Linked executor
  participant C as Native Codex task API
  participant M as TaskChef MCP
  participant W as workspace.js
  E->>M: report_state(..., turnA, needs_input, summaryA)
  M->>W: reportTaskState()
  W-->>M: needs_input snapshot
  M-->>E: needs_input snapshot
  U->>E: Provide decision
  E->>C: Read exact executor after follow-up
  C-->>E: turnB
  E->>M: report_state(..., turnB, working, requestB)
  M->>W: reportTaskState()
  W->>W: Require turnB greater and append request B
  W-->>M: working snapshot plus paired timeline
  M-->>E: working snapshot plus paired timeline
  E->>M: report_state(..., turnB, completed, summaryB)
  M->>W: reportTaskState()
  W-->>M: completed snapshot plus result B
  M-->>E: completed snapshot plus result B
  E->>M: report_state(..., turnA, completed, staleSummary)
  M->>W: Validate freshness
  W-->>M: Error: turn is not newer
  M-->>E: Visible tool error
```

The executor contract therefore requires a new exact read on every follow-up;
cached or inherited turn IDs are invalid.

## Interrupted-turn recovery

A crash, MCP failure, app restart, or upgrade can leave the latest turn with a
null result. A newer valid `working` report is the durable recovery signal. The
workspace handles it inside the same lock and atomic replacement as every
other lifecycle mutation:

```mermaid
sequenceDiagram
  autonumber
  participant E as Resumed executor
  participant M as TaskChef MCP
  participant W as workspace.js
  participant F as tasks.jsonl
  E->>M: report_state(..., turnB, working, requestB)
  M->>W: reportTaskState()
  W->>W: Acquire workspace lock and validate turnB > turnA
  W->>W: Close unfinished turnA as interrupted
  W->>W: Append turnB with requestB and null result
  W->>F: One atomic schema-8 replacement
  W-->>M: working task projected from turnB
  M-->>E: Idempotent recovery success
  E->>M: late semantic result for turnA
  M->>W: Validate active turn and historical outcome
  W-->>M: Reject stale result
  M-->>E: Visible tool error
```

The interrupted outcome uses only the fixed TaskChef-authored summary. It is
visible in CLI and detail timelines but excluded from semantic `results` and
`lastResult`. Compact dashboard cards therefore show request B with “In
progress.” Notification reconciliation observes one new working event and does
not manufacture a failed-result event. Exact retries of either working start
return the current snapshot without reopening or duplicating a turn. Concurrent
newer starts serialize under the lock, leaving one ordered timeline whose only
unfinished entry is the latest turn.

## Link-pending and failure paths

A failed or interrupted link never authorizes substantive work. The record
remains a visible retry point for the same executor.

```mermaid
sequenceDiagram
  autonumber
  participant E as Executor
  participant M as TaskChef MCP
  participant W as workspace.js
  E->>M: link_task(taskId, assertedThreadId)
  M->>W: linkTask()
  alt Exact eligible record and unused canonical UUIDv7
    W->>W: Atomic null-to-thread transition
    W-->>E: Linked task
  else MCP unavailable or call interrupted
    M--xE: Visible failure
    Note over E,W: Record remains link-pending
  else Wrong task, marker, state, or identity
    W-->>E: Validation error
    Note over E,W: No mutation
  end
  E->>E: Retry linking on a later turn before work
```

If `CODEX_THREAD_ID` is missing, the executor reports the problem visibly and
does not substitute `CODEX_SESSION_ID`, a parent ID, or search results.

Native creation can fail after the durable record exists:

```mermaid
sequenceDiagram
  autonumber
  participant D as Dispatcher
  participant M as TaskChef MCP
  participant W as workspace.js
  participant C as Native Codex
  D->>M: record_task(..., threadId null)
  M->>W: Append working record
  W-->>D: Recorded task
  D->>C: Create executor
  C--xD: Creation error
  D->>M: report_state(taskId, null, null, failed, boundedSummary)
  M->>W: Lock and store creation failure
  W-->>D: Failed task with null IDs
  D-->>D: Preserve original creation error and task ID
```

The summary is bounded and excludes secrets, transcripts, and raw command
output. A creation-failure record cannot later be linked.

## Dashboard update flow

Every mutation rewrites `tasks.jsonl` atomically under the workspace lock.
The monitor tolerates replacement races, validates a complete snapshot, and
publishes only the newest state to each SSE client.

```mermaid
sequenceDiagram
  autonumber
  participant M as MCP writer
  participant W as workspace.js
  participant F as tasks.jsonl
  participant D as Dashboard monitor
  participant B as Browser client
  participant C as Native Codex
  M->>W: link_task or report_state
  W->>W: Acquire shared lock
  W->>F: Atomic replacement
  W-->>M: Updated task
  F-->>D: Filesystem change
  D->>F: Bounded read from one descriptor
  D->>D: Validate current schema and sort
  D-->>B: Compact SSE snapshot with latestTurn only
  B->>D: GET task detail on demand
  D-->>B: Full validated history
  B->>D: Open task action
  alt Canonical Codex UUIDv7
    D->>C: Direct thread navigation
  else Null or non-native durable ID
    D->>D: Revalidate current project configuration
    D->>C: Open configured project
  end
```

The dashboard binds to `127.0.0.1`, has no shared session state, limits task
count, file size, result count, and display fields, and checks origin/authority
for stateful local actions. Its bounded identity endpoint contains no task data
or secrets. The monitor already validates the complete log, but
snapshot/SSE list projections omit `turns` and derived `results` so repeated
updates do not resend unnecessary history. A read-only per-task endpoint returns the full timeline only
when the dialog opens. Historical project paths are untrusted until matched
against current configuration.

The browser derives one immutable Updates-panel snapshot when it first observes
a semantic lifecycle transition. The snapshot keeps its event-time title,
state/event, turn ID, timestamp, and relevant summary. Its identity combines
task ID, turn ID, and event, with creation time as the fallback when creation
has no turn. A separate seen-identity set outlives the bounded visible notices,
individual dismissals, and Clear all, preventing replay after reconnect,
normalization, or disappearance and reappearance. Per-task semantic signatures
also remain as tombstones while a task is absent. When one compact snapshot
first reveals a latest semantic result plus a newer working turn, the browser
captures both. The first page snapshot is a quiet baseline so opening or
refreshing the dashboard does not replay existing history. If a task is first
observed in a progressed state after that baseline, creation is retained
alongside the observable result and working events. The current task list is
used only as the navigation target: if the task is gone, the notice stays
readable and selection reports that current details are unavailable.

The retained toast list is not live. Reconciliation passes only its newly added
snapshots to a separate polite status region, so reconnect, dismissal, Clear
all, and ordinary rerendering do not re-announce retained history. Toast action
labels remain concise while `aria-describedby` connects the visible summary,
event time, and missing-task explanation for assistive technology.

## Schema 4/5/6/7 migration

`taskchef workspace migrate` acquires the same workspace lock as lifecycle
writers, validates the complete legacy log, converts schema-4/5/6 results into
request-unknown completed turns and preserves a newer working turn, then validates the
complete candidate. Before replacement it writes and reads back an exclusive
`tasks.jsonl.pre-v8-*.bak` file. Schema-7 timelines are copied losslessly into
schema 8. The task log is replaced atomically and validated again. A second run
sees only schema 8 and returns unchanged without
another backup. Unsupported or malformed input fails before backup/rewrite;
after a later filesystem failure, the reported backup is the recovery source.

## Concurrency and trust boundaries

Configuration and task mutations use the same `proper-lockfile` lock. ID and
identity uniqueness checks, link eligibility, and result freshness occur
inside the critical section. Writes use temporary files/hard links and atomic
rename so readers see complete snapshots.

The dispatcher controls routing and immutable intent. The executor controls its
cooperatively asserted identity and semantic result. Neither identity nor
summary is cryptographically authenticated; this is a local single-user trust
model. Managed files, instructions, project snapshots, MCP inputs, and dashboard
requests are validated at every action boundary.

Configuration schema 2 and task schemas 4, 5, 6, 7, and 8 are accepted. Schemas
4/5/6/7 are read/migration compatibility until an explicit migration or lifecycle
mutation upgrades each record to schema 8. Schema 8 persists `turns`, including
timeline-only interrupted outcomes, and derives semantic-only `results` and
`lastResult` plus `latestTurn` for compact compatibility. Other schemas
are rejected without rewrite.
