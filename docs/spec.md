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
| **Marker** | The exact correlation line `<!-- taskchef_id=<lowercase full UUID> -->`; new instructions place it after the complete assignment and immediately before the executor-skill invocation. |
| **Record-before-create** | Persisting a link-pending task before asking Codex to create its executor. |
| **Self-linking** | The executor's one-way registration of its own canonical Codex UUIDv7 from `CODEX_THREAD_ID`. |
| **Link-pending** | A working task whose `threadId` is null and `updatedBy` is `dispatcher`. |
| **Current execution state** | The latest reported executor turn and its `working`, `needs_input`, `completed`, or `failed` status. |
| **Result history** | The ordered collection of every accepted `completed`, `needs_input`, or `failed` per-turn outcome. |
| **Last semantic result** | The final result-history entry, exposed through the derived `lastResult` compatibility alias. |
| **Current turn ID** | The canonical Codex UUIDv7 returned by an exact native read of the linked executor for the turn being reported. |
| **Dashboard** | The loopback, read-only UI derived from validated workspace snapshots and bounded native actions. |
| **Skill** | One packaged agent procedure: `taskchef-bootstrap`, `taskchef-delegate`, `taskchef-executor`, or `taskchef-report`. |

## Components and ownership

- `taskchef-bootstrap` MUST own initialization, project configuration, and
  diagnostics. It MUST NOT dispatch or report unless separately requested.
- `taskchef-delegate` MUST own routing and record-before-create delegation.
  It MUST return after creation and MUST NOT poll, supervise, or infer identity.
- `taskchef-executor` MUST own executor assignment ownership, self-linking,
  exact thread/turn identity, per-turn state reporting, failure behavior,
  privacy, and idempotency. It MUST NOT dispatch the owned assignment again.
- `taskchef-report` MUST own on-demand reporting. It MUST NOT poll or persist
  inferred state.
- The MCP server MUST expose four primary lifecycle tools plus the deprecated
  `report_result` compatibility alias specified below.
- The CLI MAY administer and inspect the workspace, but MUST NOT provide a
  second agent lifecycle protocol.
- The dashboard MUST be read-only with respect to dispatcher files.
- `docs/spec.md` is the single normative behavior source. Other documents
  MUST link here rather than redefine the contract.

## Workspace contract

TaskChef MUST manage only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl`
inside the dispatcher workspace. It MUST preserve unrelated paths.

`taskchef.json` MUST have schema version 2 and exactly:

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

`tasks.jsonl` MUST contain zero or more newline-terminated schema-4, schema-5,
or schema-6 records, one per line. Schemas 4 and 5 are supported migration/read
formats; every new record and state mutation MUST write schema 6. Other schemas
or unsupported fields MUST be rejected without conversion.
Reads and writes MUST reject symlinked managed files. Mutations
MUST hold the shared workspace lock and replace state atomically; read-only
operations MUST NOT require write permission.

## Task schema

Every record MUST contain exactly these fields:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `6`; schema-4/5 records remain readable until explicit migration or their next mutation. |
| `id` | Unique safe TaskChef ID; delegation uses a lowercase full UUID. |
| `project` | Immutable configured-project snapshot. |
| `title` | Non-empty display title. |
| `instruction` | Non-empty executor instruction; link-pending records MUST contain the exact marker for `id`. |
| `threadId` | Null while link-pending; after self-link, canonical Codex UUIDv7. Low-level current-schema direct records may hold another durable non-provisional ID but are outside the MCP delegation journey. |
| `createdAt` | ISO 8601 creation timestamp. |
| `status` | `working`, `needs_input`, `completed`, or `failed`. |
| `summary` | Null while working; otherwise the current semantic state's non-empty summary of at most 2,000 characters. |
| `turnId` | Null before turn reporting; otherwise the current reported turn. Linked MCP journeys use a canonical Codex UUIDv7. |
| `updatedAt` | ISO 8601 timestamp not earlier than `createdAt` or the prior `updatedAt`; clock rollback cannot backdate a transition. |
| `updatedBy` | `dispatcher` or `mcp`. |
| `results` | Ordered oldest-first array of `{status, summary, turnId, updatedAt}` semantic results, with unique turn IDs and nondecreasing timestamps. |

Returned Task objects MUST additionally expose `lastResult` as null for an empty
history or the final `results` entry. `lastResult` MUST be derived and MUST NOT
be persisted in schema 6. It is a compatibility alias for schema-4/5, CLI,
MCP, reporting-skill, and dashboard-list callers, with removal planned for the
next major version after callers migrate to `results.at(-1)`.

Task IDs and non-null thread identities MUST be unique. The immutable intent
fields MUST NOT change after recording.

## Required lifecycle

1. The dispatcher MUST call `prepare_dispatch` once per outcome.
2. It MUST choose exactly one configured project and exact native-project path.
3. It MUST build the instruction with the user's outcome beginning on line 1
   and remaining uninterrupted, followed by one blank line, the returned
   marker, and exactly one concise explicit `$taskchef-executor` invocation on
   the final line. It MUST NOT inline the executor protocol into a new
   instruction.
4. It MUST call `record_task` with `threadId: null` before native creation.
5. It MUST create exactly one native Codex executor and return immediately.
6. The executor MUST read its own `CODEX_THREAD_ID` and call `link_task`
   before substantive work. It MUST NOT use parent/session identity or guess.
7. After initial linking, the executor MUST exactly read its linked task and
   call `report_state` with that turn ID, `working`, and no summary before work.
8. Before ending, it MUST call `report_state` for the same working turn with a
   semantic status and concise summary.
9. A follow-up MUST report `working` with its new current turn ID before work.
   It MUST NOT reuse a prior turn.

If native creation fails after recording, the dispatcher MUST call
`report_state` with `failed`, null thread/turn IDs, and a bounded summary.
A link failure MUST remain visible and retryable; the executor MUST report it
visibly and MUST NOT continue substantive work.

Previously recorded instructions with a first-line HTML marker, the older
first-line `# taskchef_id=<full UUID>` heading, or the former blank line and
inline executor protocol MUST remain marker-readable and executable. Their
`report_result` calls MUST remain supported by the deprecated alias. New
instructions MUST use the trailing marker and explicit executor skill contract
above. A historical first-line instruction with an executor-skill invocation
MUST contain exactly one invocation as its final line. A former inline-protocol
instruction MUST retain non-whitespace task-specific content beyond its known
lifecycle paragraphs.

`needs_input` MUST mean a semantic user decision or missing fact. A native
approval prompt MUST remain live Codex state and MUST NOT be stored as
`needs_input`.

## MCP interface

All tools resolve the workspace internally. Callers MUST NOT supply a workspace
path. Success returns both one text content item and the stated structured
object. Validation, marker, identity, uniqueness, freshness, or filesystem
failures are surfaced as tool errors and MUST NOT partially mutate the log.

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

The returned task has schema 6, `working`, null summary/turn/thread/lastResult,
an empty `results` array,
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
**Mutation:** replaces the current state atomically and preserves `results`.

**Input:**

| Field | Type and rule |
| --- | --- |
| `taskId` | Non-empty string. |
| `threadId` | Matching non-empty ID for a linked task; null only for creation failure. |
| `turnId` | Current canonical Codex UUIDv7 for a linked MCP journey; null only for creation failure. Maximum 256 characters at the MCP boundary. |
| `status` | `working`, `needs_input`, `completed`, or `failed`. |
| `summary` | Omitted or null for `working`; required non-empty string of at most 2,000 characters otherwise. |

**Structured output:** `{ task: Task }`.

For a linked self-linking journey, `working` MUST identify a turn newer than
the current turn and last semantic result. A semantic state MUST match the
current working turn. Repeating an identical state is idempotent; conflicting
or older state fails. A null-identity record accepts only a fresh executor
creation `failed` state with both IDs null. Success sets the current state and
appends a semantic result to `results`; starting newer work preserves the entire
collection. An identical retry for any settled turn returns success without an
append. A different result for a settled turn, a stale turn, or a semantic
result that does not match the active working turn MUST fail.

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`,
`openWorldHint: false`.

### `report_result` (deprecated)

`report_result` retains the prior semantic-only input shape and statuses as a
temporary compatibility alias. It implicitly accepts a fresh supplied turn and
stores its semantic result, including for supported schema-4/5 records and
low-level opaque direct records. It does not accept `working`. New executor
instructions MUST use `report_state`. Successful mutation upgrades schema 4/5
to schema 6; unsupported schemas remain rejected.

## Reporting and dashboard

A semantic result is cached evidence, not permanent live truth. Reports SHOULD
use one bounded native metadata snapshot. Active or approval-waiting native
state overrides cache. An inactive task does not prove completion. Focused
reports MAY read a selected task once when metadata is newer or evidence is
uncertain. Reports MUST NOT poll or classify assistant prose.

Task lists, summaries, and broad reports MUST use the final result by default.
The dashboard MUST bind only to loopback, validate the current workspace
snapshot, and avoid sessions or shared client state. Direct thread navigation
MUST require a canonical Codex UUIDv7. Otherwise it MAY open the revalidated
configured project. Project paths from task history MUST be matched against
current configuration before use.
Snapshot and SSE list payloads MUST omit full `results` history and include the
derived latest-result projection. The bounded per-task detail endpoint MAY
return the full validated task so the dialog can render history newest first.

## Task-log migration

`workspace migrate` MUST explicitly convert every supported schema-4/5 record
under the shared lock. A legacy `lastResult`, or a schema-4 current semantic
state, becomes zero or one initial `results` entry. Migration MUST validate the
complete source and complete schema-6 candidate before changing the task log,
create and read back an exclusive recovery backup, atomically replace the log,
and validate the installed result. A fully schema-6 log MUST be an idempotent
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
