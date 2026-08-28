# TaskChef specification

This is TaskChef's normative agent-facing contract. **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are requirements in the RFC 2119 sense. The
[README](../README.md) owns user setup and operation; [workflows](workflows.md)
owns implementation walkthroughs; the [FirstMate comparison](firstmate-taskchef-comparison.md)
is dated research, not contract.

## Terminology

| Term | Definition |
| --- | --- |
| **TaskChef** | The plugin, skills, MCP server, CLI, dashboard, and current workspace formats defined here. |
| **Dispatcher workspace** | The per-user local data project selected by `--workspace`, then `TASKCHEF_WORKSPACE`, then `~/.agents/taskchef`. |
| **Dispatcher** | The Codex task that accepts a request, routes it, records it, creates executors, and returns without supervising them. |
| **Configured project** | One routing target in `taskchef.json`, identified by canonical local path and described by `name`, optional `description`, `isGitRepository`, and `githubRepos`. |
| **Routing** | Selecting exactly one configured project and exactly one matching native Codex project for an outcome. |
| **Delegated task** | One independently useful outcome represented by one TaskChef task UUID and snapshot. |
| **Executor** | The native Codex task created to own and perform one delegated task. |
| **Task record** | One complete JSON object in `tasks.jsonl`; it contains immutable intent/project fields and mutable identity/result fields. |
| **Marker** | The exact correlation line `<!-- taskchef_id=<lowercase full UUID> -->`; new instructions place it on the final line, immediately after the executor-skill invocation. |
| **Record-before-create** | Persisting a link-pending task before asking Codex to create its executor. |
| **Self-linking** | The executor's one-way registration of its own canonical Codex UUIDv7 from `CODEX_THREAD_ID`. |
| **Link-pending** | A working task whose `threadId` is null and `updatedBy` is `dispatcher`. |
| **Current execution state** | The latest reported executor turn and its `working`, `needs_input`, `completed`, or `failed` status. |
| **Turn timeline** | The ordered collection pairing each turn's concise request summary with its semantic result, TaskChef-generated interruption outcome, or current in-progress state. |
| **Interrupted turn** | A formerly active turn that lacked a terminal report when a newer valid turn started; TaskChef closes it with the fixed timeline-only `interrupted` outcome. |
| **Last semantic result** | The final result-history entry, exposed through the derived `lastResult` compatibility alias. |
| **Turn reference** | Required lifecycle identity for one executor prompt. It is the native Codex turn ID when available, otherwise a retained client-generated UUID. |
| **Current turn ID** | Optional Codex metadata for the reported prompt; null when native turn reading is unavailable. |
| **Dashboard** | The loopback, read-only UI derived from validated workspace snapshots and bounded native actions. |
| **Skill** | One packaged agent procedure: `taskchef-bootstrap`, `taskchef-dashboard`, `taskchef-delegate`, `taskchef-executor`, or `taskchef-copilot`. |

## Components and ownership

- `taskchef-bootstrap` MUST own initialization, project configuration, and
  diagnostics. It MUST NOT dispatch or report unless separately requested.
- `taskchef-delegate` MUST own routing and record-before-create delegation.
  It MUST return after creation and MUST NOT poll, supervise, or infer identity.
- `taskchef-executor` MUST own executor assignment ownership, self-linking,
  exact thread/turn identity, per-turn state reporting, failure behavior,
  privacy, and idempotency. It MUST NOT dispatch the owned assignment again.
- `taskchef-copilot` MUST own conversational outcome explanation, attention,
  and next-action recommendations. It MUST use cached normalized briefs by
  default and MUST NOT poll or persist inferred state.
- `taskchef-dashboard` MUST own manual dashboard ensure and recovery. It MUST
  NOT dispatch work or inspect task outcomes, and browser navigation failure
  MUST NOT suppress the returned dashboard URL.
- The MCP server MUST expose `ensure_dashboard`, four primary lifecycle tools,
  and the deprecated `report_result` compatibility alias specified below.
- The CLI MAY administer and inspect the workspace, but MUST NOT provide a
  second agent lifecycle protocol.
- The dashboard MUST be read-only with respect to dispatcher files.
- `docs/spec.md` is the single normative behavior source. Other documents
  MUST link here rather than redefine the contract.

## Workspace contract

TaskChef MUST manage only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl`
inside the dispatcher workspace. It MUST preserve unrelated paths.

`taskchef.json` MUST have schema version 2, the following required fields, and
an optional exact `dashboard` object:

```json
{
  "schemaVersion": 2,
  "projects": []
}
```

Each project MUST contain `name`, normalized absolute `path`, boolean
`isGitRepository`, and array `githubRepos`; `description` is optional.
Names and paths MUST be unique. Git projects MUST be exact Git roots.
Repository URLs MUST canonicalize to `https://github.com/<owner>/<repository>`
and be case-insensitively deduplicated.

When present, `dashboard` MUST contain exactly boolean `autostart`. Its absence
is backward-compatible and means `true`; new workspaces SHOULD write
`{"autostart": true}`. `false` disables MCP-lifecycle autostart but MUST NOT
disable the explicit `ensure_dashboard` tool.

`tasks.jsonl` MUST contain zero or more newline-terminated schema-4 through
schema-9 records, one per line. Schemas 4 through 8 are supported
migration/read formats; every new record and state mutation MUST write schema 9. Other schemas
or unsupported fields MUST be rejected without conversion.
Reads and writes MUST reject symlinked managed files. Mutations
MUST hold the shared workspace lock and replace state atomically; read-only
operations MUST NOT require write permission.

## Task schema

Every record MUST contain exactly these fields:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `9`; schema-4/5/6/7/8 records remain readable until explicit migration or their next mutation. |
| `id` | Unique safe TaskChef ID; delegation uses a lowercase full UUID. |
| `project` | Immutable configured-project snapshot. |
| `title` | Non-empty display title. |
| `instruction` | Non-empty executor instruction; link-pending records MUST contain the exact marker for `id`. |
| `threadId` | Null while link-pending; after self-link, canonical Codex UUIDv7. Low-level current-schema direct records may hold another durable non-provisional ID but are outside the MCP delegation journey. |
| `createdAt` | ISO 8601 creation timestamp. |
| `status` | `working`, `needs_input`, `completed`, or `failed`. |
| `summary` | Null while working; otherwise the current semantic state's non-empty summary of at most 2,000 characters. |
| `turnRef` | Null before reporting begins; otherwise the required lifecycle identity of the current turn. Self-linking journeys use a native or fallback UUID. Migrated low-level `report_result` compatibility records may retain an opaque ref equal to their opaque `turnId`. |
| `turnId` | Optional Codex metadata. When non-null it equals `turnRef`; null indicates fallback identity. |
| `updatedAt` | ISO 8601 timestamp not earlier than `createdAt` or the prior `updatedAt`; clock rollback cannot backdate a transition. |
| `updatedBy` | `dispatcher` or `mcp`. |
| `turns` | Ordered oldest-first array of `{turnRef, turnId, requestSummary, startedAt, result}`. Every `turnRef` is required. `requestSummary` is null only for migrated/compatibility turns. `result` is null only for the latest working turn, a semantic `{status, summary, updatedAt}` result, or the fixed TaskChef `interrupted` outcome. New self-linking turn refs are unique. A migrated low-level opaque record may retain one final reused native-derived ref for its legacy ambiguity. |

Returned Task objects MUST additionally expose `latestTurn` as null for an empty
timeline or the final `turns` entry. They MUST derive `results` only from
semantic `needs_input`, `completed`, and `failed` turn results and `lastResult`
from the final derived semantic result. Interrupted outcomes MUST be excluded.
These projections MUST NOT be persisted in schema 9 and remain compatibility
aliases for existing callers.

Task IDs and non-null thread identities MUST be unique. The immutable intent
fields MUST NOT change after recording.

## Required lifecycle

When the canonical TaskChef MCP server finishes connecting, it MUST invoke the
same serialized dashboard ensure path once by default. It MUST read the
canonical configuration and skip this only for explicit
`dashboard.autostart: false`. Initialization failures, invalid workspace state,
port conflicts, and dashboard errors MUST NOT prevent tool registration or MCP
availability. They MUST emit only a bounded non-sensitive diagnostic through
the MCP process logging channel. MCP initialization MUST NOT open a browser.

At the start of every dispatcher turn, the dispatcher SHOULD call
`ensure_dashboard` best-effort. Failure MUST NOT block direct TaskChef answers,
reporting, or delegation. Every dispatcher final response MUST end with the
exact clickable `[TaskChef Dashboard](http://127.0.0.1:3210/)` link even when
ensure failed. A created-thread directive MUST remain on its own line before
the final link, preserving the delegate skill's immediate-return contract.

1. The dispatcher MUST call `prepare_dispatch` once per outcome.
2. It MUST choose exactly one configured project and exact native-project path.
3. It MUST build the instruction with the user's outcome beginning on line 1
   and remaining uninterrupted, followed by exactly two newline characters
   (one blank line), exactly one concise explicit `$taskchef-executor`
   invocation, one newline, and the returned marker on the final line. It MUST
   NOT place a blank line between the invocation and marker or inline the
   executor protocol into a new instruction.
4. It MUST call `record_task` with `threadId: null` before native creation.
5. It MUST create exactly one native Codex executor and return immediately.
6. The executor MUST read its own `CODEX_THREAD_ID` and call `link_task`
   before substantive work. It MUST NOT use parent/session identity or guess.
7. After initial linking, the executor MUST establish a `turnRef`. It MUST use
   the native Codex turn ID for both `turnRef` and `turnId` when available;
   otherwise it MUST retain a fresh UUID `turnRef` and use `turnId: null`.
   It MUST call `report_state` with that identity, `working`, and no summary before work.
8. Before ending, it MUST call `report_state` with the same `turnRef` and
   `turnId` metadata as the working report and a
   semantic status and concise summary.
9. A follow-up MUST report `working` with a new `turnRef` before work.
   It MUST NOT reuse a prior prompt's ref. If the preceding turn is still unfinished,
   TaskChef MUST atomically close it as `interrupted` before appending the new
   working turn; the executor MUST NOT report semantic `failed` for recovery.

Normal executor completion MUST stop after the terminal callback and return
normally. It MUST NOT archive, hand off, close, navigate away from, or otherwise
terminate the Codex task merely because work completed. Archive is authorized
only by an explicit request in the current assignment or follow-up for that
exact Codex task; `finish`, `complete`, `done`, `ship`, and ordinary cleanup do
not imply authorization.

For an explicitly authorized archive, the executor MUST finish and verify the
work, read its exact task identity, submit the current turn's terminal
`report_state`, verify TaskChef accepted that state, and only then invoke the
native archive operation as the final state-changing action. It MUST require
native confirmation before claiming archive succeeded. The same callback-first
ordering applies to any separately authorized action that can make the executor
unavailable before reporting, including handoff or terminating or restarting
the process that owns the TaskChef MCP transport; this rule does not itself
authorize those actions. A terminal reporting failure MUST prevent the later
action and leave the executor accessible. Failure of a later action MUST NOT
change or reopen the already accepted semantic terminal state.

Request and result summaries are the durable source for dashboard related-link
projection; TaskChef does not scan full Codex transcripts. When known, an
executor MUST preserve the selected repository as a canonical GitHub repository
URL and issues or pull requests as canonical URLs. A result spanning both a
managed child repository and its workspace/root repository MUST include both
pull-request URLs. Executors MUST NOT guess unresolved repository identity.

If native creation fails after recording, the dispatcher MUST call
`report_state` with `failed`, a retained fallback UUID `turnRef`, null thread
and Codex turn IDs, and a bounded summary.
A link failure MUST remain visible and retryable; the executor MUST report it
visibly and MUST NOT continue substantive work.

Previously recorded instructions with the trailing marker before the
invocation, with or without the former blank line before that marker; a
former compact assignment-to-invocation boundary with the marker last; a
first-line HTML marker; the older first-line
`# taskchef_id=<full UUID>` heading, or the former blank line and inline
executor protocol MUST remain marker-readable and executable. Their
`report_result` calls MUST remain supported by the deprecated alias. New
instructions MUST use the explicit executor invocation followed by the final
trailing marker contract above. A historical first-line instruction with an
executor-skill invocation MUST contain exactly one invocation as its final
line. A former inline-protocol instruction MUST retain non-whitespace
task-specific content beyond its known lifecycle paragraphs.

`needs_input` MUST mean a semantic user decision or missing fact. A native
approval prompt MUST remain live Codex state and MUST NOT be stored as
`needs_input`.

## MCP interface

All tools resolve the workspace internally. Callers MUST NOT supply a workspace
path. Success returns both one text content item and the stated structured
object. Validation, marker, identity, uniqueness, freshness, or filesystem
failures are surfaced as tool errors and MUST NOT partially mutate the log.

### `ensure_dashboard`

**Caller:** dispatcher. **Mutation:** starts at most one in-process loopback
HTTP server; it does not mutate dispatcher workspace files.

**Input:** empty object.

**Structured output:**

```text
{ dashboard: {
  action: "started" | "reused",
  url: "http://127.0.0.1:3210/",
  workspace: string,
  taskchefVersion: string,
  serverVersion: string
} }
```

Calls MUST serialize within one MCP process. The first call starts an owned
dashboard or reuses an exact compatible listener; later and concurrent calls
are idempotent and report reuse after the single start. The stable default MUST
bind only to `127.0.0.1:3210` and MUST NOT accept a model-supplied workspace,
host, or port.

Before reuse, TaskChef MUST query a bounded loopback identity endpoint and
require the exact fixed service/schema, TaskChef version, dashboard-server
version, and canonical workspace. An unknown, malformed, different-workspace,
or stale-version listener MUST produce a concise actionable conflict. TaskChef
MUST NOT kill, replace, signal, or otherwise control that listener. A startup
failure MUST leave no owned listener. The MCP server MUST close its owned
dashboard when its transport or process shuts down; it MUST NOT close a reused
external foreground server.

The packaged `$taskchef-dashboard` skill MUST call this tool, report `started`
or `reused`, and return the canonical clickable URL. It MAY use an available
in-app browser when permitted; absent or blocked browser navigation MUST fall
back to the link without failing. It MUST NOT inspect task outcomes or dispatch.

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`,
`openWorldHint: false`.

### `prepare_dispatch`

**Caller:** dispatcher. **Mutation:** none.

**Input:** empty object.

**Structured output:**

```text
{ preparation: {
  schemaVersion: 1,
  workspace: string,
  taskId: string,
  preparedAt: string,
  marker: string,
  projectCount: number,
  projects: Project[]
} }
```

The tool generates a fresh task UUID and exact marker and returns current
routing targets. An invocation is not idempotent: each successful call creates
new preparation values, though it writes no state.

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`.

### `record_task`

**Caller:** dispatcher. **Mutation:** atomically appends one task.

**Input:**

| Field | Type and rule |
| --- | --- |
| `id` | Non-empty string; MUST equal the instruction marker. |
| `project` | Non-empty configured project path. |
| `title` | Non-empty string. |
| `instruction` | Non-empty string containing exactly one accepted marker and a non-empty assignment. New instructions use the required trailing marker and executor-invocation scaffold; historical first-line forms remain accepted. |
| `threadId` | Literal null. |

**Structured output:** `{ task: Task }`.

The returned task has schema 9, `working`, null summary/turn/thread/latestTurn/lastResult,
empty `turns` and derived `results` arrays,
`updatedBy: dispatcher`, and equal creation/update timestamps. Duplicate IDs,
unknown projects, malformed markers, and invalid input fail. Repeating a
successful call is not idempotent; it fails as a duplicate.

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`,
`openWorldHint: false`.

### `link_task`

**Caller:** executor. **Mutation:** one atomic identity transition.

**Input:** `{ taskId: non-empty string, threadId: non-empty string }`.
The workspace layer requires `threadId` to be a canonical Codex UUIDv7.

**Structured output:** `{ task: Task }`.

The eligible record MUST be link-pending, working, dispatcher-written, and have
the exact marker. The thread ID MUST be unused. Success sets `threadId`,
refreshes `updatedAt`, and sets `updatedBy: mcp`. An exact successful retry
is idempotent. A different identity, terminal record, reused identity, missing
marker, or ineligible state fails.

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`,
`openWorldHint: false`.

### `report_state`

**Caller:** executor, or dispatcher only for native creation failure.
**Mutation:** replaces the current state atomically and preserves `turns`.

**Input:**

| Field | Type and rule |
| --- | --- |
| `taskId` | Non-empty string. |
| `threadId` | Matching non-empty ID for a linked task; null only for creation failure. |
| `turnRef` | Stable UUID for this prompt. It may be omitted only by legacy callers that supply a non-null `turnId`, in which case TaskChef derives the same value. |
| `turnId` | Optional Codex metadata. When present it MUST equal `turnRef`; null is valid for fallback UUID refs. Maximum 256 characters. |
| `status` | `working`, `needs_input`, `completed`, or `failed`. |
| `summary` | Omitted or null for `working`; required non-empty string of at most 2,000 characters otherwise. Known GitHub issues and pull requests use canonical URLs. |
| `requestSummary` | Concise current request of at most 1,000 characters for `working`; optional for backward compatibility and omitted for semantic states. A known selected GitHub repository uses its canonical URL. |

**Structured output:** `{ task: Task }`.

For a linked self-linking journey, a new `working` state MUST use a `turnRef`
not already assigned to a different turn. An exact retry of the current
working start MUST return the current task without mutation.
When `turnId` is present, its native-backed `turnRef` MUST also be newer than
every previously stored native-backed ref. Fallback UUID refs are opaque and
MUST NOT be lexically ordered.
A semantic state MUST match the current working turn. Conflicting or stale
state fails. A null-thread record accepts only a fresh executor creation
`failed` state with a retained `turnRef` and null thread/turn IDs. Starting work appends one turn with
its request and a null result. When the previous latest turn is unfinished, the
same locked atomic rewrite MUST first fill it with the fixed TaskChef-generated
`interrupted` outcome. The semantic report fills the active turn's result.
An identical retry for the current settled turn returns success without an
append. Once a newer turn starts, every callback for a historical ref is stale
and fails, even when its content exactly matches the stored callback. A
different request or result for the same turn, a stale turn, or a semantic
result that does not match the active working turn MUST fail.

`interrupted` MUST NOT be accepted as MCP input or projected as task `status`.
It MUST NOT alter `summary`, `results`, or `lastResult`, and its fixed summary
MUST contain no crash output, transcript, user text, or inferred failure cause.

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`,
`openWorldHint: false`.

### `report_result` (deprecated)

`report_result` retains the prior semantic-only input shape and statuses as a
temporary compatibility alias. It implicitly accepts a fresh supplied turn and
stores its semantic result in a request-unknown turn, including for supported schema-4/5/6 records and
low-level opaque direct records. It does not accept `working`. New executor
instructions MUST use `report_state`. Successful mutation upgrades schema 4-8
to schema 9; unsupported schemas remain rejected. Legacy callers that omit
`turnRef` remain compatible when `turnId` is non-null.

## Copilot and dashboard

A semantic result is cached evidence, not permanent live truth. The dashboard
MUST remain the primary monitoring and browsing UI. Copilot MUST start from the
schema-1 normalized cached brief and explain what finished, what needs
attention, why, and the recommended next action. It MUST NOT need to interpret
historical task schema versions. A working task's current summary MUST remain
null; any prior semantic result MUST be exposed separately as a clearly
historical `lastOutcome`. A link-pending task with no exact thread identity MUST
recommend passive waiting or inspection, never retry or continuation.

Copilot MAY take one bounded native metadata snapshot only when the user
explicitly requests fresh/live verification or a focused task presents a
meaningful contradiction. Active or approval-waiting native state overrides
cache. An inactive task does not prove completion. Copilot MAY read the exact
selected task once for an explicit focused live-verification request or to
resolve a focused contradiction. It MUST NOT poll, wait, perform exhaustive
live audits, or classify assistant prose.

Copilot MAY identify the exact existing executor, explain or draft a
same-assignment follow-up, and continue that executor only with explicit user
authorization. It MUST NOT automatically retry failures, interrupt working
tasks, or redelegate an existing executor. Independent new work MUST route
through delegation. Managed dispatcher routing MUST give same-assignment
answer, follow-up, resume, and continue requests precedence over the blanket
new-work delegation rule. A direct imperative naming the exact existing task
MAY constitute send authorization, but copilot MUST re-read that exact task
immediately before sending.

The published plugin MUST NOT package `taskchef-report` as a discoverable alias.
Its historical explicit name is a documented rename hint handled by copilot,
not a second workflow.

Task lists, summaries, and broad briefs MUST use the final result by default.
The dashboard MUST bind only to loopback, validate the current workspace
snapshot, and avoid sessions or shared client state. `GET /api/health` MUST
return only the bounded service identity, health schema, exact TaskChef and
dashboard-server versions, and canonical workspace. It MUST NOT return task
records, secrets, credentials, environment values, or process-control data.
Identity remains available while an already-started monitor retains its last
valid snapshot after a later invalid task log; an invalid initial log MAY fail
startup safely. Direct thread navigation
MUST require a canonical Codex UUIDv7. Otherwise it MAY open the revalidated
configured project. Project paths from task history MUST be matched against
current configuration before use.
The task-detail dashboard MAY offer Codex chat archival only when the stored
thread ID is a canonical Codex UUID and the current TaskChef state is not
`working`. It MUST revalidate both conditions for the POST request, require the
exact loopback origin, and obtain explicit user confirmation in the browser.
It MUST invoke the `archive` subcommand by directly executing only a Codex CLI
inside a known ChatGPT or Codex desktop application bundle bearing the OpenAI
signing identity, with the thread UUID as a separate argument. It MUST NOT use a shell, a generic `PATH` fallback, a
private desktop endpoint, or direct session-file manipulation. Successful
archival MUST NOT modify dispatcher files or remove the TaskChef task record.
The UI MUST disclose that spawned descendant chats may also be archived and
that TaskChef history remains available.
Snapshot and SSE list payloads MUST omit full `turns` and derived `results`
history and include `latestTurn`. The bounded per-task detail endpoint MAY
return the full validated task so the dialog can render the paired timeline newest first.
Dashboard notifications MUST capture an immutable event-time projection of the
task title, lifecycle state and event, turn ref and optional Codex turn ID, event timestamp,
and relevant concise summary. Rendering MUST NOT resolve historical notice text
from the task's later current state. Notice identity and deduplication MUST use
task ID, turn ref, and lifecycle event; a creation notice without a turn ref MUST
fall back to task ID plus the immutable creation timestamp. Dashboard revision
MUST NOT be the sole identity. Identical snapshots, SSE reconnects, idempotent
reports, schema normalization, and non-semantic rewrites MUST NOT add notices.
Distinct working and semantic-result events for one turn MAY each be retained.
When one compact snapshot first exposes both a latest semantic result and a
newer working turn, the browser MUST reconcile both events. Temporary task
absence MUST NOT discard the prior semantic signature or turn a later
reappearance into another creation event. The first page snapshot MUST establish
a quiet baseline rather than replay existing history. After that baseline, a
new task first observed with a turn or semantic result MUST retain its creation
event and each lifecycle event observable in that compact projection.

Working with no prior result SHOULD be labeled as a task start. Working on a
newer turn while a prior result remains projected SHOULD be labeled as a
follow-up start. Creation, completion, input-needed, and failure labels MUST be
distinct. The Updates panel MUST remain bounded and support individual dismiss
and clear-all without resetting replay protection. A retained notice whose task
is absent from the current list MUST remain readable; selecting it MUST NOT
navigate or mutate data and SHOULD explain that current details are unavailable.
The retained notice list MUST NOT be a live region that re-announces old notices
when it rerenders. A separate polite status region MUST announce only newly
reconciled events. Each notice control's accessible description MUST include
its displayed summary when present, event time, and missing-task state.

## Task-log migration

`workspace migrate` MUST explicitly convert every supported schema-4/5/6/7/8 record
under the shared lock. Each legacy semantic result becomes a request-unknown
completed turn; a newer working state becomes a final unfinished turn, and a
schema-7/8 timeline is preserved. Each non-null legacy `turnId` becomes the
same `turnRef`; each null legacy `turnId` receives one durably persisted UUID.
Migration MUST validate the complete source, record/turn counts, turn-ref
invariants, and complete schema-9 candidate before changing the task log,
create and read back an exclusive recovery backup, atomically replace the log,
and validate the installed result. A fully schema-9 log MUST be an idempotent
no-op without another backup. Invalid/unsupported input MUST remain untouched;
failures after backup creation MUST report the backup path and MUST never
partially rewrite individual lines.

## Concurrency and trust

All task and configuration writers MUST share one workspace lock. Duplicate ID,
duplicate thread, link, and result freshness checks MUST occur while holding
that lock. Atomic replacement MUST preserve valid unrelated records.

TaskChef is designed for a local, single-user boundary. Executor self-linking is
a cooperative assertion, not transport-authenticated proof. Task instructions,
stored project snapshots, and dashboard requests are untrusted input.
Implementations MUST validate exact shapes, canonical paths, safe IDs, markers,
loopback origin, and current configuration before acting.

TaskChef MUST NOT use lifecycle hooks, schedules, polling, recent-thread search,
transcript search, title matching, hidden reasoning, or token usage to discover
identity or infer semantic results.

TaskChef MUST NOT install or require daemons, launchd agents, login items,
system services, cron jobs, hooks, privileged components, or elevated/system
permissions for dashboard availability. Availability is best-effort while the
owning Codex/plugin MCP process is alive and is not guaranteed while Codex is
closed.

Installing or replacing plugin files MUST NOT be described as activating the
new MCP code. Release verification MUST install the plugin, activate or reload
the new MCP process, ensure the dashboard, and verify the expected TaskChef
version, dashboard protocol `serverVersion`, canonical workspace, and canonical
URL. Exact-compatible listener reuse remains valid; installation MUST NOT be
claimed to reload Codex automatically.
