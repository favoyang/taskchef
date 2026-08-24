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
| `skills/taskchef-bootstrap/SKILL.md` | Initialize current workspace and configure projects. |
| `skills/taskchef-report/SKILL.md` | Select cached tasks and perform bounded live checks. |
| `src/mcp.js` | Four structured lifecycle tools and MCP annotations. |
| `src/delegation.js` | UUID marker, executor contract paragraphs, and creation-failure handling. |
| `src/workspace.js` | Current schemas, validation, locking, atomic JSONL writes, linking, and result freshness. |
| `src/cli.js` | Administration, inspection, diagnostics, and dashboard startup. |
| `src/dashboard.js` | Validated snapshots, SSE fan-out, and bounded open actions. |

The MCP process resolves `TASKCHEF_WORKSPACE` once and never accepts a model
supplied path. The CLI resolves `--workspace`, then the environment, then the
per-user default.

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
  W->>W: Lock, validate, append schema-4 snapshot
  W-->>M: working link-pending task
  M-->>D: task
  D->>C: Create executor with marked instruction
  C-->>D: Created-task reference
  D-->>U: Return immediately
  C->>E: Start executor
  E->>E: Read own CODEX_THREAD_ID
  E->>M: link_task(taskId, threadId)
  M->>W: linkTask()
  W->>W: Lock and replace null identity atomically
  W-->>E: linked working task
```

Record-before-create makes native creation failure observable. Executor
self-linking removes dispatcher-side polling, task search, title matching, and
parent/child identity inference.

## Result reporting

The executor obtains the turn identity from an exact native read of its own
linked task. `report_result` updates only the latest semantic snapshot.

```mermaid
sequenceDiagram
  autonumber
  participant E as Executor
  participant C as Native Codex task API
  participant M as TaskChef MCP
  participant W as workspace.js
  E->>E: Finish or reach semantic decision
  E->>C: Exact read of linked executor
  C-->>E: Current turn ID
  E->>M: report_result(taskId, threadId, turnId, status, summary)
  M->>W: reportTaskResult()
  W->>W: Lock and validate identity and freshness
  alt Fresh result
    W->>W: Replace status, summary, turnId, updatedAt, updatedBy
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
  E->>M: report_result(..., turnA, needs_input, summaryA)
  M->>W: Store turnA
  W-->>E: needs_input snapshot
  U->>E: Provide decision
  E->>C: Read exact executor after follow-up
  C-->>E: turnB
  E->>M: report_result(..., turnB, completed, summaryB)
  M->>W: Require turnB greater than turnA
  W-->>E: completed snapshot
  E->>M: report_result(..., turnA, completed, staleSummary)
  M->>W: Validate freshness
  W-->>E: Error: turn is not newer
```

The executor contract therefore requires a new exact read on every follow-up;
cached or inherited turn IDs are invalid.

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
  D->>M: report_result(taskId, null, null, failed, boundedSummary)
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
  M->>W: link_task or report_result
  W->>W: Acquire shared lock
  W->>F: Atomic replacement
  W-->>M: Updated task
  F-->>D: Filesystem change
  D->>F: Bounded read from one descriptor
  D->>D: Validate current schema and sort
  D-->>B: SSE snapshot
  B->>D: Open task action
  alt Canonical Codex UUIDv7
    D->>C: Direct thread navigation
  else Null or non-native durable ID
    D->>D: Revalidate current project configuration
    D->>C: Open configured project
  end
```

The dashboard binds to `127.0.0.1`, has no shared session state, limits
request bodies, and checks origin/authority for stateful local actions. Historical
project paths are untrusted until matched against current configuration.

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

Only current configuration schema 2 and task schema 4 are accepted.
Unsupported data is rejected without rewrite.
