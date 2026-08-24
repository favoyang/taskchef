# Delegation and result design

TaskChef stores a durable local task history while Codex owns execution. The
dispatcher records intent, the executor registers its own identity, and only
the executor reports semantic outcomes.

## Key terminology

The central identity rule is: **the executor child links itself**. The
dispatcher may create the child, but it never treats its own thread, a parent
thread, or a provisional creation handle as the executor's durable identity.

| Term | Meaning |
| --- | --- |
| TaskChef task ID | Stable UUID allocated by `prepare_dispatch`; it identifies the durable TaskChef record. |
| Exact marker | First-line correlation marker copied into the executor instruction; it binds that instruction to the pre-recorded TaskChef task. |
| Source or parent thread ID | The dispatcher/delegator context; never valid as the executor identity. |
| Executor thread ID | The child's own durable `CODEX_THREAD_ID`; the executor supplies it to `link_task`. |
| Provisional client thread ID | Temporary native creation handle; useful for creation UI, but never identity authority. |
| Turn ID | Current native turn UUIDv7 read from the exact executor thread; it proves result freshness. |
| `tasks.jsonl` | Durable append/rewrite history whose latest snapshot is shown by TaskChef. |

The diagrams below are intentionally small. Calls into **TaskChef MCP** name
the MCP function being invoked. Notes beside `tasks.jsonl` name the fields that
step populates or replaces.

## Workflow 1: Prepare and record intent

The dispatcher first asks TaskChef to allocate routing and correlation values.
`prepare_dispatch` does not write a record. The dispatcher then embeds the exact
marker in the instruction and calls `record_task` **before** native creation, so
an executor can self-link as soon as its first turn starts.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant D as Dispatcher
  participant M as TaskChef MCP
  participant W as tasks.jsonl

  U->>D: Delegation request
  D->>M: prepare_dispatch()
  M-->>D: taskId, marker, preparedAt, projects
  Note over D,M: Allocate identity and routing only#59; no record written
  D->>M: record_task(id, project, title, marked instruction, threadId=null)
  M->>W: Append schema 4 snapshot
  Note right of W: id, project, title, instruction, createdAt<br>threadId=null, status=working, summary=null, turnId=null<br>updatedAt=createdAt, updatedBy=dispatcher
  M-->>D: Recorded task snapshot
```

## Workflow 2: Create and self-link the executor

After recording, the dispatcher creates the native Codex task and returns
immediately. A durable or provisional ID returned to the dispatcher is not
trusted as executor identity. The child reads its own `CODEX_THREAD_ID` and
uses `link_task` as its first TaskChef action.

The exact marker correlates the child instruction with the pre-created record.
`link_task` atomically permits one `null`-to-durable transition, rejects a
malformed or reused ID, and makes the dashboard deep link target the child—not
the source, parent, or dispatcher thread.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant D as Dispatcher
  participant C as Codex native tasks
  participant E as Executor child
  participant M as TaskChef MCP
  participant W as tasks.jsonl
  participant V as Dashboard

  D->>C: Create task with marked instruction
  C-->>D: Durable threadId or provisional clientThreadId
  Note over D,C: Creation result is not executor identity authority
  D-->>U: Created-task directive#59; dispatcher returns immediately
  C->>E: Start initial executor turn
  E->>E: Read own CODEX_THREAD_ID
  E->>M: link_task(taskId, child threadId)
  M->>W: Atomic identity registration
  Note right of W: Set threadId=child UUIDv7<br>Set updatedAt and updatedBy=mcp<br>Keep status=working, summary=null, turnId=null
  M-->>E: Self-linked task snapshot
  W-->>V: Filesystem watcher refresh
  Note right of V: Deep link targets the exact executor child
```

## Workflow 3: Report the current turn

Before ending with a semantic outcome, the executor reads its exact native
thread and obtains that turn's current UUIDv7. It then calls `report_result`
with its matching self-linked thread ID. The status is `completed`, `failed`,
or `needs_input`; the summary is concise and bounded.

Changed results must use a strictly newer turn ID. An identical same-turn retry
is idempotent, but reusing an old turn ID for a changed result cannot establish
freshness.

```mermaid
sequenceDiagram
  autonumber
  participant E as Executor child
  participant C as Codex native tasks
  participant M as TaskChef MCP
  participant W as tasks.jsonl
  participant V as Dashboard

  E->>C: Exact read of this executor thread
  C-->>E: Current turnId UUIDv7
  E->>M: report_result(taskId, threadId, turnId, status, summary)
  M->>W: Store semantic result
  Note right of W: Replace status, summary, turnId<br>Set updatedAt and updatedBy=mcp
  M-->>E: Updated task snapshot
  W-->>V: Filesystem watcher refresh
```

## Workflow 4: Resume after `needs_input`

`needs_input` is a semantic pause, not a native approval prompt. After the user
responds or resumes the task, the executor reads the exact task again. The new
turn ID, rather than the initial one, accompanies the updated result.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant E as Executor child
  participant C as Codex native tasks
  participant M as TaskChef MCP
  participant W as tasks.jsonl
  participant V as Dashboard

  E-->>U: Request decision or information
  U->>E: Follow up or resume
  E->>C: Exact native read after follow-up
  C-->>E: Newer current turnId UUIDv7
  E->>M: report_result(taskId, threadId, newer turnId, completed, summary)
  M->>W: Replace latest semantic result
  Note right of W: status=completed, new summary, newer turnId<br>updatedAt refreshed, updatedBy=mcp
  M-->>E: Completed task snapshot
  W-->>V: Filesystem watcher refresh
```

## Workflow 5: Creation and linking failures

Because `record_task` happens first, native creation failure remains visible:
the dispatcher reports one terminal failure while both identity fields stay
null. The dispatcher makes exactly one native creation call and never retries
it. TaskChef never guesses an executor identity from recent tasks, titles,
transcripts, or dashboard activity.

For linking, outcome depends on where interruption occurs. Before commit, an
eligible record remains link-pending. If the atomic write commits but its reply
is lost, the record is already linked and an identical retry returns that
snapshot. Inspect rejections before retrying; identity conflicts and terminal
records must not be blindly retried.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant D as Dispatcher
  participant C as Codex native tasks
  participant E as Executor child
  participant M as TaskChef MCP
  participant W as tasks.jsonl

  alt Native creation fails after record_task
    D->>C: Create task with marked instruction
    C--xD: Creation error
    D->>M: report_result(taskId, null, null, failed, bounded summary)
    M->>W: Store terminal creation failure
    Note right of W: Keep threadId=null and turnId=null<br>Set status=failed, summary, updatedAt, updatedBy=mcp
    M-->>D: Failed task snapshot
    D-->>U: Creation failure with preserved TaskChef taskId
  else Initial link stops before commit
    E--xM: link_task(taskId, child threadId)
    Note right of W: Remains threadId=null, status=working<br>Eligible link-pending record may retry later
  else Link commits but response is lost
    E->>M: link_task(taskId, child threadId)
    M->>W: Commit child threadId
    M--xE: Response lost
    E->>M: Identical link_task retry
    M-->>E: Return existing linked snapshot
  end
```

## MCP calls and field transitions

| Step | Caller | Operation | Key input | Task record effect |
| --- | --- | --- | --- | --- |
| 1 | Dispatcher | `prepare_dispatch` | No task identity supplied | Returns `taskId`, exact `marker`, `preparedAt`, and configured `projects`; does not write `tasks.jsonl`. |
| 2 | Dispatcher | `record_task` | `id`, `project`, `title`, marked `instruction`, `threadId: null` | Appends schema 4 with `createdAt`; sets `status: working`, `summary: null`, `turnId: null`, `updatedAt: createdAt`, `updatedBy: dispatcher`. |
| 3 | Dispatcher | Native Codex task creation—not MCP | Target project plus marked instruction | Does not change the TaskChef record. A returned durable or provisional ID is not identity authority. |
| 4 | Executor | `link_task` | Marked `taskId` plus its own `CODEX_THREAD_ID` | Atomically changes `threadId` from `null` to the canonical child UUIDv7; refreshes `updatedAt` and sets `updatedBy: mcp`. |
| 5 | Executor | `report_result` | Exact `taskId`, self-linked `threadId`, current `turnId`, semantic `status`, concise `summary` | Replaces the latest `status`, `summary`, and `turnId`; refreshes `updatedAt` and sets `updatedBy: mcp`. Changed follow-up results require a newer UUIDv7 `turnId`. |
| Failure | Dispatcher | `report_result` after native creation error | `taskId`, `threadId: null`, `turnId: null`, `status: failed`, bounded `summary` | Preserves the pre-created record and null identity while storing a terminal creation failure. |

## Design boundaries

There is no task listing, candidate read, marker search, wait, polling loop,
native creation retry, transcript read, or hook in the dispatch path. The
filesystem watcher notices atomic TaskChef writes and refreshes only the
dashboard; reports read current state on demand.

Custom MCP does not authenticate the calling Codex task. The executor thread ID
is therefore a cooperative assertion inside TaskChef's local single-user trust
boundary. The design prevents accidental parent/child confusion but does not
claim resistance to a deliberately forged local MCP call.

Historical `updatedBy: hook` values remain readable, but new installations
contain no hook and new writes use `dispatcher` or `mcp`.

## Legacy recovery

`taskchef task resolve` is retained only for unresolved schema 1-3 records.
Operators must establish one exact marker match and one unique durable child
ID. Schema 4 self-linking records reject manual resolution. History is read
compatibly and is not eagerly rewritten.

## Dashboard and reports

The dashboard deep link uses only the stored self-linked child ID. File watcher
events surface linking and results without user interaction. Reporting may
compare current native metadata with cached semantic results, but it never
writes inferred lifecycle state.
