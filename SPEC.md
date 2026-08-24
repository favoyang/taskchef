# TaskChef specification

This document is TaskChef's normative agent-facing contract. **MUST**,
**MUST NOT**, **REQUIRED**, **SHOULD**, and **MAY** carry their usual normative
meanings. Background and implementation walkthroughs are deliberately kept in
[Delegation and result design](docs/delegation-design.md).

For user setup and commands, see the [README](README.md). The
[FirstMate comparison](docs/firstmate-taskchef-comparison.md) is dated research,
not part of this contract.

## Purpose and operating model

TaskChef routes work from a canonical local dispatcher workspace to visible
Codex project tasks. It records delegation intent, executor identity, and the
latest explicit semantic result. Codex remains authoritative for live task
activity, conversation, approvals, and execution.

TaskChef is an interactive dispatcher. It is not a scheduler, background
worker, task runtime, delivery supervisor, or transcript store.

## Terminology

| Term | Normative meaning |
| --- | --- |
| **Dispatcher workspace** | The canonical per-user TaskChef data workspace, resolved by explicit `--workspace`, then `TASKCHEF_WORKSPACE`, then `~/.agents/taskchef`. TaskChef manages `AGENTS.md`, `taskchef.json`, and `tasks.jsonl` there. |
| **Dispatcher** | A Codex task opened in the dispatcher workspace. Its managed instructions automatically invoke `$taskchef-delegate` for actionable work. |
| **Configured project** | One routing target in `taskchef.json`, identified by canonical local path and described by `name`, optional `description`, `isGitRepository`, and `githubRepos`. |
| **Routing** | Agent judgment that maps one independently useful outcome to exactly one configured project using its name, description, advertised GitHub repositories, and exact native project path. |
| **Delegated task** | One durable TaskChef record and its intended Codex executor. Its TaskChef task ID is a lowercase full UUID allocated before native creation. |
| **Executor** | The independently openable Codex task that owns delegated work in the configured project. It is the only actor permitted to self-link and to report ordinary semantic outcomes. |
| **Task record** | The latest persisted snapshot for one delegated task in `tasks.jsonl`. A record is not an event stream. |
| **Exact marker** | `<!-- taskchef_id=<full UUID> -->` on the first instruction line, followed by a blank line. It correlates an executor instruction with its pre-recorded TaskChef task. |
| **Record-before-create** | The invariant that `record_task` commits the exact marked instruction with `threadId: null` before the dispatcher calls native task creation. |
| **Executor self-linking** | The executor's first TaskChef action: read its own `CODEX_THREAD_ID` and call `link_task` for the marked task. |
| **Executor thread ID** | The canonical Codex UUIDv7 asserted by the executor from its own `CODEX_THREAD_ID`. Parent, dispatcher, `CODEX_SESSION_ID`, and provisional IDs are not executor identity. |
| **Turn ID** | The current canonical Codex UUIDv7 obtained from an exact native read of the linked executor thread. It orders semantic results across follow-up turns. |
| **Semantic result** | The latest explicit `needs_input`, `completed`, or `failed` outcome plus a concise summary reported through `report_result`. |
| **Link-pending** | A schema 4 record with `threadId: null`, `status: working`, and `updatedBy: dispatcher`. Its executor has not completed self-linking. |
| **Legacy recovery** | Operator-assisted identity repair for unresolved schema 1-3 records only, using the CLI `taskchef task resolve` command after exact marker verification. |

## Components and authority

### Dispatcher workspace

TaskChef MUST create and manage only these workspace files:

- `AGENTS.md`: TaskChef's managed dispatcher block plus user instructions;
- `taskchef.json`: project configuration;
- `tasks.jsonl`: one JSON object per delegated task.

Initialization MUST preserve unrelated user-owned paths. Such paths are outside
TaskChef's data model and MUST NOT be treated as TaskChef-managed state.

Configuration and task-history mutation APIs MUST acquire one shared workspace
lock. `initializeWorkspace` MUST acquire that lock before writing managed file
content, although creating the directory and setting its permissions MAY happen
first. Exported low-level scaffold compatibility helpers do not acquire the lock
themselves and MUST NOT be called concurrently. Configuration and task-log
replacements MUST be atomic. Task IDs and non-null thread IDs MUST be unique
across the task log; canonical Codex UUID identity comparison is
case-insensitive, while preserved opaque legacy identities retain their
historical case-sensitive semantics.

Workspace resolution MUST NOT depend implicitly on the current directory.

### Configured projects and routing

Current configuration writes use schema version 2. Each project contains:

- `name`: unique configured name;
- `path`: canonical local directory or Git root;
- `isGitRepository`: whether the path is a Git repository root;
- `githubRepos`: zero or more canonical, deduplicated GitHub repository URLs;
- optional `description`: routing context.

Routing MUST select exactly one configured project and an exact native local
project path. If evidence is missing or ambiguous, the dispatcher MUST ask the
user rather than guess. GitHub issue and pull-request URLs MAY identify any
repository advertised by a configured project. Remote-host projects are
outside the current contract.

One broad request MAY become several delegated tasks only when their outcomes
are independently useful. Each executor instruction MUST be self-contained.

### Skills

- `$taskchef-bootstrap` owns workspace initialization, diagnosis, managed
  instructions, and configured-project administration.
- `$taskchef-delegate` owns routing, record-before-create, native task creation,
  and immediate return.
- `$taskchef-report` owns read-only, on-demand reporting over TaskChef snapshots
  and bounded native task metadata.

An executor whose structured delegation input begins with an exact TaskChef
marker already owns that assignment. It MUST execute locally and MUST NOT
re-dispatch the assignment merely because it concerns TaskChef or a configured
project.

### MCP tools

The bundled local MCP server exposes four tools:

| Tool | Caller | Contract |
| --- | --- | --- |
| `prepare_dispatch` | Dispatcher | Read-only. Returns one fresh task UUID, exact marker, preparation timestamp, and configured routing targets. It does not create a task record. |
| `record_task` | Dispatcher | Appends the exact marked task with `threadId: null`. It MUST run before native creation. |
| `link_task` | Executor | Atomically registers the executor's own canonical Codex UUIDv7. Only the eligible schema 4 null-to-durable transition is allowed. |
| `report_result` | Executor, or dispatcher after creation failure | Stores the latest semantic result. Linked results require matching thread and current turn IDs. Creation failure is the only null-identity case. |

The public MCP surface MUST NOT expose a legacy resolver.

## Task record schema

New records use schema version 4 with these exact fields:

| Field | Meaning and constraints |
| --- | --- |
| `schemaVersion` | `4` for new records. Persisted schema 1-3 remains readable. |
| `id` | Immutable unique TaskChef task UUID. |
| `project` | Immutable configured-project snapshot used for routing. |
| `title` | Immutable non-empty display title. The dashboard independently applies display-size limits. |
| `instruction` | Immutable exact marked executor instruction. |
| `threadId` | Null until self-linking, then one canonical executor UUIDv7. |
| `createdAt` | Immutable ISO timestamp assigned when recorded. |
| `status` | `working`, `needs_input`, `completed`, `failed`, or null for normalized legacy records. |
| `summary` | Null until a semantic result; otherwise a non-empty string of at most 2,000 characters. |
| `turnId` | Null until a linked semantic result; otherwise the reporting turn ID. |
| `updatedAt` | Latest persisted identity or semantic update time. |
| `updatedBy` | `dispatcher` or `mcp` for current writes; historical `hook` remains readable. |

New `record_task` writes MUST initialize `status: working`, `summary: null`,
`turnId: null`, `updatedAt: createdAt`, and `updatedBy: dispatcher`.

The log stores latest snapshots. Updating a task MUST replace only that task's
line while preserving every unrelated line. TaskChef MUST NOT persist
transcripts, hidden reasoning, inferred live state, `hostId`, or native task
token usage.

## Required delegation lifecycle

1. The dispatcher MUST call `prepare_dispatch` exactly once per independently
   useful outcome and MUST NOT reuse its task ID or marker.
2. The dispatcher MUST prefix the task body with the exact marker, executor
   ownership paragraph, self-linking paragraph, and result-reporting paragraph
   defined by `$taskchef-delegate`.
3. The dispatcher MUST call `record_task` exactly once before native creation,
   passing the exact configured project path and `threadId: null`.
4. The dispatcher MUST make exactly one native creation call for that recorded
   task.
5. The dispatcher MUST return immediately after creation. It MUST NOT list or
   read recent tasks, search markers, wait, poll, retry creation, or link the
   executor. A returned durable or provisional creation ID is not identity
   authority.
6. If native creation fails after recording, the dispatcher MUST call
   `report_result` with `failed`, null thread and turn IDs, and a concise bounded
   summary. This is the only valid semantic result before self-linking.

## Executor self-linking

Before substantive work, a schema 4 executor MUST read its own
`CODEX_THREAD_ID` and call `link_task(taskId, threadId)`. It MUST NOT derive
identity from the source or delegator thread, `CODEX_SESSION_ID`, inherited
session data, title matching, recent-task searches, transcripts, or a
provisional client ID.

`link_task` MUST:

- accept only schema 4 records with the exact marker;
- require a canonical Codex UUIDv7;
- accept only an eligible `threadId: null`, `status: working`,
  `updatedBy: dispatcher` record;
- reject unknown tasks, thread reuse, terminal records, and conflicting
  identities;
- atomically change only null to the asserted durable ID;
- set `updatedAt` and `updatedBy: mcp` while preserving the working state;
- return the existing snapshot for an identical retry.

If linking is unavailable, interrupted, rejected, or cancelled before commit,
the record MUST remain visibly link-pending. The executor MUST report the
failure visibly, stop substantive work, and retry on a later turn. It MUST NOT
guess an identity.

## Semantic results and statuses

`working` means TaskChef has no terminal or needs-input semantic callback for
the latest snapshot. It does not prove that Codex is currently executing.

`needs_input` means the executor requires a semantic user decision or missing
information. A native approval prompt MUST remain live Codex state and MUST NOT
be persisted as `needs_input` merely because approval is pending.

`completed` means the executor asserts that its requested outcome is complete.
`failed` means the executor or the sole native creation attempt ended
unsuccessfully. TaskChef does not infer either status from inactivity.

Before ending with a semantic outcome, a linked executor MUST:

1. read the exact linked Codex thread natively;
2. obtain the current turn ID from that read;
3. call `report_result` with its task ID, exact linked thread ID, current turn
   ID, one result status, and a concise non-secret summary.

For schema 4 self-linked tasks, turn IDs MUST be canonical Codex UUIDv7 values.
A changed result MUST use a turn ID strictly newer than the stored one. An
identical same-turn retry MUST be idempotent; a different same-turn result MUST
be rejected. After a follow-up, the executor MUST read the thread again and
MUST NOT reuse a prior turn ID.

## Reports

Reports MUST be read-only and bounded. The report skill MUST select relevant
records first, then take one recent native thread-metadata snapshot for the
report. Active or approval-waiting native state MUST override a cached result.
Inactive native state MUST NOT prove semantic completion.

A broad overview SHOULD trust a structurally complete MCP result for an idle
task unless live metadata contradicts it. A focused report MAY read a selected
idle task once when native metadata is newer, the callback is missing, identity
is uncertain, or the user requests a fully live result. Reports MUST NOT poll,
wait, persist inferred state, or classify assistant prose.

User-facing report states are: working, needs input, awaiting native approval,
completed, failed, unresolved, and unknown.

## Dashboard

The dashboard MUST bind to numeric loopback and MUST reject non-loopback host
configuration. It reads and validates `tasks.jsonl`, retains its last valid
snapshot on an invalid or racing replacement, and watches atomic replacements
for updates. It MUST NOT write dispatcher-workspace files.

The dashboard MAY expose task history without browser authentication to local
loopback clients. State-changing open-in-Codex requests MUST require an exact
Host and same-origin request. Direct task navigation MUST use only a supported
UUID-shaped stored thread ID. Null or opaque legacy identities MUST use project
fallback, which MUST revalidate the configured project's canonical path.

The dashboard's status is the persisted TaskChef status. It does not perform
native report refresh, submit replies, estimate token usage, or infer executor
completion.

## Concurrency and trust boundary

Multiple dispatchers and executors MAY operate concurrently. The shared
workspace lock, exact task IDs, unique thread IDs, and atomic line replacement
MUST prevent duplicate records and lost updates.

The MCP transport does not authenticate the calling Codex task. Executor
identity and turn identity are therefore cooperative assertions within a local
single-user boundary. TaskChef's validation prevents accidental parent-child
confusion and record corruption; it does not claim resistance to a deliberately
forged local MCP caller. The loopback dashboard is a separate local read
boundary and MUST NOT be exposed through a proxy or tunnel.

## Legacy compatibility and recovery

Task schemas 1-3 and historical `updatedBy: hook` values remain readable
without eager migration. Their presence is compatibility data, not permission
to restore hooks or dispatcher-side identity search.

The CLI-only `taskchef task resolve` command MAY fill a null thread ID for an
unresolved schema 1-3 record after an operator establishes one exact marker
match and one unique durable child identity. It MUST reject schema 4 records
and duplicate identities. Unrelated task lines MUST remain byte-for-byte
unchanged.

Current installations MUST contain no lifecycle hook configuration, hook
executable, hook runtime, dispatcher-side identity polling, or public
`resolve_task` MCP tool.

## Packaging and acceptance

The plugin package MUST include its manifest, MCP configuration and server,
three skills, CLI, dashboard, source modules, `SPEC.md`, workflow document, and
FirstMate comparison. Manifest and package versions MUST remain synchronized.

Acceptance requires:

- record-before-create and exact-marker validation;
- immediate return without post-create identity discovery;
- executor-only self-linking from `CODEX_THREAD_ID`;
- idempotent link and result retries with conflict rejection;
- visible retryable link-pending state and terminal creation failure;
- current-turn freshness across `needs_input` and follow-up turns;
- atomic concurrent workspace writes;
- read-only bounded reporting and dashboard behavior;
- readable legacy records without reintroducing legacy runtime design;
- installation and operation without lifecycle hooks.
