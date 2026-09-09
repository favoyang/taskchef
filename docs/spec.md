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
| **Mutation preview** | A read-only, hash-bound exact before/after project-index diff required before destructive replacement, removal, or restore. |
| **State backup** | A private, verified snapshot under the dispatcher workspace's `backups/` directory. It never restores automatically. |
| **Routing** | Selecting exactly one configured project and exactly one matching native Codex project for an outcome. |
| **Delegated task** | One independently useful outcome represented by one TaskChef task UUID and snapshot. |
| **Executor** | The native Codex task created to own and perform one delegated task. |
| **Orchestrator parent** | The stable visible executor that owns lifecycle, authority, phase sequencing, writer safety, handoff acceptance, review gates, and delivery verification while fresh role subagents perform substantive phases. |
| **Execution phase** | One revision-fenced plan, implementation, review, verification, or delivery attempt recorded through reserve, start, optional identity bind, and finish events. |
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
| **Dashboard** | The loopback UI derived from validated workspace snapshots, with optional local usage projections, bounded native actions, and an explicit audited manual-outcome mutation. |
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
- The MCP server MUST expose `ensure_dashboard`, six primary lifecycle tools,
  and the deprecated `report_result` compatibility alias specified below.
- The CLI MAY administer and inspect the workspace, but MUST NOT provide a
  second agent lifecycle protocol.
- The dashboard MUST be read-only with respect to dispatcher files except for
  the explicit audited manual-transition operation defined below.
- `docs/spec.md` is the single normative behavior source. Other documents
  MUST link here rather than redefine the contract.

## Workspace contract

TaskChef MUST manage only `AGENTS.md`, `taskchef.json`, `tasks.jsonl`, the
optional `.taskchef-usage.json` cache, and the optional dashboard lifecycle
records `.taskchef-dashboard-owner.json` and
`.taskchef-dashboard-handoff.json` inside the dispatcher workspace. It MUST
preserve unrelated paths. The owner record MUST be a retained mode-`0600`
current-listener identity and control credential that is atomically replaced by
a new owner. The handoff record MUST be a retained mode-`0600`, secret-free,
credential-signed final lease snapshot that is atomically overwritten by the
next finalized handoff.

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
schema-11 records, one per line. Schemas 4 through 10 are supported
migration/read formats; every new record and state mutation MUST write schema 11. Other schemas
or unsupported fields MUST be rejected without conversion.
Reads and writes MUST reject symlinked managed files. Mutations
MUST hold the shared workspace lock and replace state atomically; read-only
operations MUST NOT require write permission.

## Task schema

Every record MUST contain exactly these fields:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `11`; schema-4/5/6/7/8/9/10 records remain readable until explicit migration or their next mutation. |
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
| `updatedBy` | `dispatcher`, `mcp`, or `dashboard`. `dashboard` is valid only when the latest turn is a manual dashboard transition. |
| `turns` | Ordered oldest-first array of `{turnRef, turnId, requestSummary, startedAt, result, provenance, intent, acceptedScope, planRef, phases}`. Every `turnRef` is required. `requestSummary` is null only for migrated/compatibility turns. `result` is null only for the latest working turn, a semantic `{status, summary, updatedAt}` result, or the fixed TaskChef `interrupted` outcome. `provenance` is `{kind: legacy}` or `{kind: mcp}` for ordinary turns, or the audited manual-transition record defined below. Orchestrated turns pair a non-null classified `intent` with `acceptedScope`, may carry an immutable `planRef`, and own their ordered phase ledger; legacy turns use null orchestration metadata and no phases. New self-linking and manual turn refs are unique. A migrated low-level opaque record may retain one final reused native-derived ref for its legacy ambiguity. |
| `executionMode` | `legacy` or `orchestrated`. New negotiated delegations use `orchestrated`; migrated and non-negotiated records remain `legacy`. |
| `executionRevision` | Non-negative optimistic revision. Every non-idempotent phase event increments it exactly once. |
| `parentResolution` | Null for legacy mode; required immutable resolution snapshot for orchestrated mode. |

Returned Task objects MUST additionally expose `latestTurn` as null for an empty
timeline or the final `turns` entry. They MUST derive `results` only from
semantic `needs_input`, `completed`, and `failed` turn results and `lastResult`
from the final derived semantic result. Interrupted outcomes MUST be excluded.
These projections MUST NOT be persisted in schema 11 and remain compatibility
aliases for existing callers.

## Orchestrated execution contract

New dispatch preparation MUST advertise execution contract version 1,
orchestrated execution, phase reporting, and `parent_only` descendant-usage
coverage. It MUST resolve only the visible `orchestrator` role. Recording an
orchestrated task MUST echo that exact contract version and parent-resolution
snapshot; otherwise the record MUST remain legacy. Existing records MUST NOT be
bulk-adopted or silently relabelled. Explicit adoption is allowed only when a
new working turn starts on a legacy task and MUST record fresh parent-resolution
evidence without rewriting earlier turns.

An orchestrated working report MUST classify the turn as `investigate`,
`plan_and_implement`, `implement`, or `continue_plan`, include a bounded
`acceptedScope`, and MAY include a repository-relative `planRef` containing the
repository, path, revision, and content hash. The parent MUST resolve the
planner, implementer, or reviewer role immediately before its corresponding
fresh phase. Review phases MUST use a read-only reviewer. Only one phase may be
active across the task, only one writer generation may own edits at a time,
and every review pass and writer generation MUST be unique.

Each phase event MUST target the current working parent and turn, include the
expected `executionRevision`, and use one stable idempotency event UUID. The
event sequence is reserve, start, optional bind, finish. Reserve captures phase
kind, attempt, role, exact resolution snapshot, writer status, and optional
review-pass identity before the native spawn. Start records the opaque native
agent handle. Bind is optional and MUST use only explicit native or child-
asserted durable identity evidence; handles and titles are not thread IDs.
Finish records a terminal phase state, summary, and bounded artifact references
only after native terminal state is established. An exact event retry is
idempotent; revision mismatch, conflicting event reuse, concurrent active
phases, duplicate identities, and invalid transitions MUST fail atomically.

`completed` is valid only after all phases are terminal and the current intent
has completed its minimum gates: investigate requires plan; plan-and-implement
requires plan, implement, and review; implement and continue-plan require
implement and review. The latest attempt of every required non-review phase
MUST be completed. For implementation intents, the final review after the
latest writer MUST be completed, so later edits or a superseding unsuccessful
review invalidate an earlier clean pass. `needs_input` or `failed` MUST interrupt any active phase
in the same state mutation. A newer lifecycle turn MUST likewise interrupt an
unfinished phase and the previous unfinished turn. Manual dashboard transitions
MUST reject a task while an orchestrated phase is active.

## Project-index mutation and recovery

TaskChef MUST provide a targeted update that preserves every unrelated project
and replaces an explicitly supplied repository list in full. Project list JSON
MUST expose stable semantic hashes. Whole-index replacement, project removal,
and restore MUST first return an exact diff and MUST reject stale hashes,
incomplete removed-name confirmation, mismatched counts, and unconfirmed large
count collapse. Agents MUST obtain explicit user permission for every removed
project entry and verify the complete post-state.

Every actual configuration mutation and actual dashboard-server start MUST
create or deduplicate a mode-private, manifest-and-hash-verified state snapshot
before writing. Mutations MUST append bounded attribution-free prepared and
terminal audit records. Backup list, create, and verify are read-only except for
explicit creation. Restore MUST default to projects only, show a diff, require
explicit approval, and create a pre-restore safety snapshot. TaskChef MUST NOT
restore automatically. State restore authorization MUST bind the selected
backup and every selected live/source payload hash. Missing or malformed live
configuration requires config or state scope plus exact raw-state and explicit
unreadable-current confirmation; a forensic safety snapshot remains eligible
for rollback when its own integrity verifies.

The dashboard MUST distinguish an unreadable index from missing historical
project paths, warn without rewriting state, and expose recovery guidance
without backup payload contents.

## Optional usage projection

TaskChef MUST pin one tested `ccusage` version as an optional dependency. It
MUST prefer that package-local executable and MAY use an exact-version,
cache-friendly `npx` invocation when a plugin-only installation has no local
dependency. The `npx` invocation MUST only resolve the pinned native executable
and MUST NOT launch the analyzer against Codex data. TaskChef MUST execute that
native binary directly. The adapter MUST first request structured Codex output
with live-capable online pricing and retry with ccusage's bundled offline
pricing after a bounded failure. TaskChef MUST NOT parse, store, or serve raw
Codex rollout files, prompts, responses, transcripts, or reasoning. Analyzer,
npm, network, timeout, malformed output, unknown pricing, or an unresolved
thread MUST NOT block lifecycle tools or dashboard loading.

Dashboard-manual turns are administrative events, not Codex executions. They
MUST immediately report per-turn usage as unavailable, MUST NOT schedule or
store a cumulative usage boundary, and MUST NOT receive a token or cost delta.
A later executor turn MUST use the nearest preceding reliable executor
boundary, skipping any intervening dashboard-manual turns.

The mode-0600 `.taskchef-usage.json` schema 3 cache stores only normalized cumulative
token boundaries, per-turn deltas, model names, estimated cost, source version,
freshness, and explicit execution coverage. It is independent of task-log schema
versions so legacy logs remain readable. Schema 1 and 2 usage caches MUST migrate
in memory as historical parent-only projections while preserving valid ccusage
cumulative estimates. Writes MUST use the workspace lock and atomic replacement. Symlinked
or unsupported cache files MUST be rejected. Writes MUST compact the derived
cache to recent task projections, recent per-turn results, and the latest
cumulative boundary. An oversized legacy cache MUST be treated as rebuildable
derived data so it cannot permanently disable usage reporting.

A linked Codex thread MAY map to multiple ccusage session segments. TaskChef
MUST aggregate only records whose primary durable thread UUID is that exact
identity; a UUID appearing only as a nested suffix MUST NOT be attributed to
the parent or child TaskChef task. It MUST retain input, cached-input, output,
reasoning-output, and total fields without adding cached or reasoning subsets
into totals a second time.

After a terminal report, TaskChef MUST mark the turn `calculating` and perform
bounded deferred reconciliation without delaying the lifecycle response.
The dashboard MUST also preload eligible derived usage in its existing service
lifecycle without requiring a task-detail request. Startup, task-log changes,
and periodic recovery passes MUST consider missing, interrupted, and
cooldown-expired records; successful current-generation records MUST remain
cached. Background work MUST be deduplicated, MUST enforce a small global
concurrency limit, MUST use bounded delayed retries, and MUST stop when the
dashboard closes.
Per-turn usage MUST be a non-negative delta between adjacent reliable cumulative
boundaries. A first recorded turn MAY use zero as its baseline. Historical
turns without boundaries and decreasing or ambiguous snapshots MUST be labeled
`unavailable`, never zero or estimated. A historical task MAY still show its
resolvable cumulative total. A boundary is reliable only after two consecutive
samples agree. Exhausted unstable sampling and a newer turn beginning before
stabilization MUST leave that turn unavailable and MUST NOT establish a delta
baseline. Zero is valid for the first turn only when TaskChef observed that turn
in progress before its terminal report; a first historical terminal turn MUST
remain unavailable even when its cumulative task total is resolvable.

Every available projection MUST identify ccusage, its version when available,
the requested online or fallback offline pricing mode, and usage freshness.
The online mode records TaskChef's request, not a claim about ccusage's internal
cache. Dollar values MUST be labeled API-equivalent estimates. Positive token
usage with a zero or missing analyzer cost MUST display cost unavailable, not
`$0.00`. A per-turn dollar delta MUST be unavailable when its adjacent
cumulative boundaries use different analyzer versions or requested pricing
modes. When ccusage supplies a valid cumulative estimate, TaskChef MUST display
it without applying its own model-family or cache-write coverage policy. A model
family change between otherwise compatible boundaries MUST NOT prevent TaskChef
from deriving the per-turn estimate.
Legacy execution coverage is complete parent-only coverage. Orchestrated
coverage MUST be labeled partial and parent-only, with every started descendant
phase counted as missing. TaskChef MUST NOT infer descendant membership from
native hierarchy or add child totals until the platform exposes trustworthy,
exclusive descendant accounting.
The dashboard Settings response MUST report the provider version returned by
the executable resolved for runtime use, not merely copy the dependency pin.

Task IDs and non-null thread identities MUST be unique. The immutable intent
fields MUST NOT change after recording.

## Required lifecycle

Before the canonical TaskChef MCP server connects and exposes its transport, it
MUST invoke the same serialized dashboard ensure path once by default. It MUST read the
canonical configuration and skip this only for explicit
`dashboard.autostart: false`. Initialization failures, invalid workspace state,
port conflicts, and dashboard errors MUST NOT prevent tool registration or MCP
availability. They MUST emit only a bounded non-sensitive diagnostic through
the MCP process logging channel. MCP initialization MUST NOT open a browser.
If transport connection fails after dashboard startup, the MCP server MUST
best-effort close its manager and partially attached transport, then propagate
the original connection failure even when cleanup also fails. Closing that
individual MCP MUST NOT directly close a valid Codex-session dashboard.

At the start of every dispatcher turn, the dispatcher SHOULD call
`ensure_dashboard` best-effort. Failure MUST NOT block direct TaskChef answers,
reporting, or delegation. Every dispatcher final response MUST end with the
exact clickable `[TaskChef Dashboard](http://127.0.0.1:3210/)` link even when
ensure failed. A created-thread directive MUST remain on its own line before
the final link, preserving the delegate skill's immediate-return contract.

1. The dispatcher MUST call `prepare_dispatch` once per outcome.
2. It MUST choose exactly one configured project and exact native-project path.
3. It MUST build the instruction with the user's outcome beginning on line 1
   and remaining uninterrupted, followed by one blank line and the authorization
   `Report this task and its follow-ups to my local TaskChef dashboard. Relevant private-repository links and concise work, test, and deployment results are authorized; exclude secrets.`
   followed by exactly two newline characters
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
**Caller:** dispatcher. **Mutation:** starts or reuses the authenticated
Codex-session-scoped loopback dashboard. The first start writes a private
dashboard ownership record in the canonical workspace. The record remains
after shutdown and the next owner atomically replaces it before reporting
startup success.

**Input:** empty object.

**Structured output:**

```text
{ dashboard: {
  action: "started" | "reused",
  launcher: "session",
  url: "http://127.0.0.1:3210/",
  workspace: string,
  taskchefVersion: string,
  serverVersion: string
} }
```

MCP initialization MUST complete its best-effort ensure before exposing the
MCP transport. Calls MUST serialize within one MCP process. The first call
starts a dashboard session process or reuses the exact current listener; later
and concurrent calls are idempotent. The stable default MUST bind only to
`127.0.0.1:3210` and MUST NOT accept a model-supplied workspace, host, port,
session PID, or credential.

Exact reuse MUST require the fixed service/schema, TaskChef version,
dashboard-server version, canonical workspace, and `session` launcher identity.
It MUST additionally prove the private owner credential and use a fresh,
single-use, action-bound HMAC to register the MCP's original Codex parent PID.
The registration acknowledgement and every transferred lease set MUST carry a
separate response HMAC bound to the request nonce and complete accepted result.
The independent dashboard MUST survive closure of an individual MCP transport.
The session manager MUST require an explicit nonzero port because a detached
child cannot safely return an ephemeral bound port without an additional IPC
ownership channel. Direct foreground server callers MAY continue to bind port
zero when they retain the returned listener.

The dashboard MUST track only explicitly registered PIDs using non-signalling
existence probes. Once every registered PID is absent for the grace period, it
MUST gracefully close its HTTP listener and exit. A new authenticated live
registration during the grace period MUST cancel expiry. This is a local
best-effort session guard, not a Codex restart guarantee.

An older TaskChef version MAY be retired only when its exact health identity
reports the same canonical workspace and an `mcp` or `session` launcher; a
private regular mode-0600 owner record exactly matches that listener; and a
fresh nonce-bound HMAC challenge proves control of the record's secret. Only
then MAY the new MCP send an action- and nonce-bound authenticated loopback
handoff. Before retiring a prior `session` listener, an idempotent prepare
action MUST fence new registrations, register the activating Codex PID,
validate and return the bounded live PID lease set while the old listener
remains running. Only a separate authenticated commit after the caller verifies
that result MAY schedule shutdown. A lost prepare response MUST be retryable,
and an abandoned preparation MUST expire without shutting down the listener. A
full, failed, or malformed transfer MUST leave the
listener running and MUST NOT acknowledge a concurrent registration that will
be absent from the returned set. A prior `mcp` listener MAY instead receive a
separately authenticated graceful shutdown request.
A commit MUST begin a short bounded finalization grace that allows concurrent
authenticated activators to join. Its response MUST contain a credential-bound
proof of the final immutable complete lease snapshot. The listener MUST remain
available for a bounded commit-response retry window before shutdown, so a
surviving activator can recover if the elected one exits before launch. An
activator observing the authenticated old-owner listener gap MUST wait for the
elected replacement and MUST NOT bind an older version into that gap.
The finalized transferable snapshot MUST reserve one bounded lease slot for a
distinct recovery activator. If that complete union cannot fit, commit MUST fail
without stopping the old listener. When different compatible newer versions
race, a higher version that loses the bind MUST authenticate and replace the
lower winner rather than accepting it as final.
Before acknowledging commit, the retiring session MUST atomically persist the
credential-bound final snapshot in a private mode-`0600` same-workspace record
that contains no secret. A replacement MAY use that record only after verifying
its exact workspace, listener identity, handoff identifier when known, bounded
PID set, and HMAC with the private owner credential. It MUST ignore the record
once replacement ownership is published, but MUST NOT unlink it after that
transition because a newer handoff may already have atomically replaced it. The
single retained record MUST be overwritten only by a newer finalized handoff
and MUST remain unusable against a different owner identity or credential.
Owner and handoff publication MUST sync the completed private file, atomically
rename it, and sync the containing canonical workspace directory before
reporting success. Finalization MUST fence further handoff joins before taking
and persisting the immutable snapshot.
The new MCP MAY then start its current `session` version and MUST NOT downgrade
a newer listener. Concurrent startup and handoff MUST converge on one
authenticated listener. Single-use control nonces MUST be retained in a fixed,
time-bounded replay cache that refuses overflow while entries remain valid.

The credential MUST NOT appear in health responses, requests, diagnostics, or
logs. A standalone, unknown, malformed, different-workspace, newer, unproven,
spoofed, or legacy listener without valid ownership metadata MUST produce a
concise actionable conflict and MUST NOT receive a shutdown request, signal,
or process-level termination attempt. TaskChef MUST NOT discover or kill port
owners. An invalid workspace, initial task log, or ownership write MUST leave
no newly owned listener.

Detached session startup MUST use a private child readiness acknowledgement
sent only after listener bind and atomic ownership publication. Startup errors
MUST propagate through that channel. A bounded readiness timeout MUST
cooperatively cancel the exact child so late initialization cannot strand an
unreported listener. Ownership publication MUST check cancellation before its
atomic replacement, and the listener MUST retain the port until that write
commits or aborts on every shutdown path so an older writer cannot overwrite a
successor's credential.

MCP EOF, explicit close, protocol close, SIGINT, SIGTERM, transport-start
failure, and MCP-parent loss MUST still bound MCP shutdown. They MUST close the
MCP manager and transport without directly closing the independently hosted
session dashboard. Foreground `taskchef dashboard` remains `standalone`, is
never adopted by MCP, and follows its foreground process lifetime.

The packaged `$taskchef-dashboard` skill MUST call this tool, report `started`
or `reused`, and return the canonical clickable URL. It MAY use an available
in-app browser when permitted; absent or blocked browser navigation MUST fall
back to the link without failing. It MUST NOT inspect task outcomes or dispatch.

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`,
`openWorldHint: false`.

The complete operational rationale and limits are documented in
[Dashboard lifecycle](dashboard-lifecycle.md).

### `prepare_dispatch`

**Caller:** dispatcher. **Mutation:** none.

**Input:** empty object.

**Structured output:**

```text
{ preparation: {
  schemaVersion: 2,
  workspace: string,
  taskId: string,
  preparedAt: string,
  marker: string,
  projectCount: number,
  capabilities: {
    executionContractVersion: 1,
    orchestratedExecution: true,
    phaseReporting: true,
    descendantUsage: "parent_only"
  },
  parentRole: object,
  parentResolution: ExecutionResolution,
  projects: Project[]
} }
```

The tool generates a fresh task UUID and exact marker, resolves only the current
orchestrator role, and returns current routing targets plus execution
capabilities. An invocation is not idempotent: each successful call creates new
preparation values, though it writes no state.

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
| `executionMode` | Optional `legacy` or `orchestrated`; new negotiated delegation uses `orchestrated`. |
| `executionContractVersion` | Required integer `1` exactly when orchestration is selected. |
| `parentResolution` | Required preparation-time resolution snapshot exactly when orchestration is selected. |

**Structured output:** `{ task: Task }`.

The returned task has schema 11, `working`, null summary/turn/thread/latestTurn/lastResult,
empty `turns` and derived `results` arrays,
`updatedBy: dispatcher`, and equal creation/update timestamps. Duplicate IDs,
unknown projects, malformed markers, and invalid input fail. Repeating a
successful call is not idempotent; it fails as a duplicate.

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`,
`openWorldHint: false`.

### `resolve_execution_role`

**Caller:** dispatcher for the visible parent, or orchestrator immediately
before a fresh child phase. **Mutation:** none.

**Input:** one `role` from `orchestrator`, `planner`, `implementer`, or
`reviewer`, plus optional explicit model and effort choices. A caller MAY set
`nativeAvailabilityConfirmed` only after the current create/spawn interface
itself proves that a cache-flagged model and effort are supported.

**Structured output:** `{ role: RoleResolution & {resolution} }`. `resolution`
is the immutable execution snapshot for persistence, including the explicit
requested values and resolution timestamp. It is null when resolution is not
usable.

Resolution applies the selected role's current personal configuration and the
explicit overrides. Missing configuration is an explicit result, not permission
to claim a configured role. Cached availability is advisory; the native create
or spawn API remains authoritative. Confirmation upgrades only cached
`unavailable` status, never malformed, duplicate, or structurally invalid role
configuration. Every orchestrated phase MUST persist the exact resolution
snapshot used for that spawn.

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`,
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
| `intent` | Required classified intent for an orchestrated `working` report; absent for legacy and semantic reports. |
| `acceptedScope` | Required bounded authority/scope summary with orchestrated `intent`. |
| `planRef` | Optional immutable repository-relative plan reference for an orchestrated working turn. |
| `executionContractVersion`, `parentResolution` | Accepted only together to explicitly adopt contract version 1 when starting a new turn on a legacy task. |

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

Reporting tool descriptions MUST identify the configured local `tasks.jsonl`
path and local `.taskchef-usage.json` tracking side effect. GitHub URLs remain
references in that log; reporting does not publish them to GitHub. The
`destructiveHint: true` annotation is retained because reports update existing
state and can recover an unfinished predecessor as interrupted; these tools
are not purely additive. The compatibility alias also changes existing state.
Executors MUST verify accepted terminal reporting before claiming TaskChef was
updated. A platform rejection of an authorized report MUST be described using
only the returned rationale, without inferring causes or retrying around an
explicit denial. Authorization and unit tests do not guarantee platform approval.

### `report_phase`

**Caller:** self-linked orchestrator parent. **Mutation:** atomically appends or
updates one current-turn phase event.

Every input contains `taskId`, `parentThreadId`, `turnRef`, unique `eventId`,
`expectedRevision`, `operation`, and `phaseId`. `reserve` additionally contains
kind, attempt, role, resolution, writer status, and optional `reviewPassId`;
`start` contains the opaque `agentHandle`; `bind` contains the durable child
`threadId` and `native` or `child_asserted` provenance; `finish` contains a
terminal state, bounded summary, and artifact references.

**Structured output:** `{ event: { task, phase, eventId, executionRevision,
idempotent } }`.

The tool enforces the orchestrated execution contract, optimistic revision,
event idempotency, phase ordering, identity uniqueness, and writer/reviewer
invariants described above. It MUST NOT infer a child identity. Reporting a
phase also triggers the same best-effort local usage observation as state
reporting.

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`,
`openWorldHint: false`.

### `report_result` (deprecated)

`report_result` retains the prior semantic-only input shape and statuses as a
temporary compatibility alias. It implicitly accepts a fresh supplied turn and
stores its semantic result in a request-unknown turn, including for supported schema-4/5/6 records and
low-level opaque direct records. It does not accept `working`. New executor
instructions MUST use `report_state`. Successful mutation upgrades schema 4-10
to schema 11; unsupported schemas remain rejected. It MUST reject a linked
orchestrated record so the alias cannot bypass phase completion gates. Legacy callers that omit
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
The task-detail dashboard MAY offer manual outcomes from `working` or
`needs_input` to either `completed` or `failed`, from `completed` to `failed`,
and from `failed` to `completed`. It MUST reject same-state terminal
transitions and MUST keep this infrequent administrative action out of list
cards. A keyboard-accessible **More task
actions** disclosure MUST reveal its action list immediately beside it and
change from an ellipsis to an accessible back/hide control while expanded. The
list MUST group **Copy Task ID** and each currently valid **Mark completed** or
**Mark failed** action. **Archive chat** MUST remain hidden while the archive capability
gate is disabled because the bundled CLI does not reliably archive desktop-app
threads. The dormant server endpoint MUST reject requests before discovering or
invoking the CLI. Re-enabling requires a reliable supported app-callable archive
interface or guaranteed CLI compatibility. Opening the
list is the deliberate disclosure step; choosing a terminal outcome submits it
immediately without a second confirmation. Escape MUST close the idle list,
pending controls MUST be
disabled, and failure feedback MUST remain in the dialog. Pending state MUST
focus and announce a stable status inside the dialog. Failed MUST have
destructive styling. The client MUST bound and abort a stalled manual-transition
request, restore the dialog controls, and preserve the action ID so a retry can
resolve idempotently if the server committed before the timeout.

`POST /api/tasks/:id/manual-transition` MUST require the exact loopback origin,
`application/json`, a bounded body, and exactly this versioned shape:
`{schemaVersion: 1, actionId, expected: {status, turnRef, threadId, updatedAt},
targetStatus}`. The server MUST compare every expected field while holding the
workspace lock. A stale request, invalid transition, or reused action ID with a
different operation MUST return a conflict without mutation. Replaying the
same committed action ID and operation MUST return the current task as an
idempotent success. The operation MUST atomically append one new manual turn;
it MUST NOT overwrite executor history. An active unfinished turn MUST first
receive the standard interrupted timeline outcome. The manual turn MUST have a
new server-generated `turnRef`, null `turnId`, one monotonic timestamp for its
start, result, and task update, `updatedBy: dashboard`, and deterministic
request/result summaries. It MUST record provenance
`{kind: dashboard_manual, actionId, fromStatus, toStatus, expectedTurnRef,
expectedThreadId, expectedUpdatedAt}`. No free-form reason is collected or
persisted. A committed write remains successful if the subsequent best-effort
monitor refresh or notification delivery fails.

The task-detail dashboard MAY offer Codex chat archival only when the stored
thread ID is a canonical Codex UUID and the current TaskChef state is not
`working`. It MUST revalidate both conditions for the POST request, require the
exact loopback origin, and obtain explicit user confirmation in the browser.
It MUST invoke the `archive` subcommand by directly executing only a Codex CLI
inside the canonical ChatGPT or Codex desktop application bundle under macOS
`/Applications`, with the thread UUID as a separate argument. It MUST NOT use a shell, a generic `PATH` fallback, a
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

`workspace migrate` MUST explicitly convert every supported schema-4/5/6/7/8/9/10 record
under the shared lock. Each legacy semantic result becomes a request-unknown
completed turn; a newer working state becomes a final unfinished turn, and a
schema-7/8 timeline is preserved. Each non-null legacy `turnId` becomes the
same `turnRef`; each null legacy `turnId` receives one durably persisted UUID.
Migration MUST validate the complete source, record/turn counts, turn-ref
invariants, and complete schema-11 candidate before changing the task log,
create and read back an exclusive recovery backup, atomically replace the log,
and validate the installed result. A fully schema-11 log MUST be an idempotent
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
permissions for dashboard availability. Availability is best-effort while a
registered Codex session process is alive and is not guaranteed while Codex is
closed.

Releases predating authenticated dashboard handoff are legacy listeners. A
verified legacy listener MUST be reported distinctly from an unknown port
conflict but MUST remain untouched; one final manual cleanup MAY be required
when upgrading from such a release. Once both sides implement the same control
protocol, compatible prior-version handoff is automatic.

Installing or replacing plugin files MUST NOT be described as activating the
new MCP code. Release verification MUST install the plugin, activate or reload
the new MCP process, ensure the dashboard, and verify the expected TaskChef
version, dashboard protocol `serverVersion`, `session` launcher, canonical workspace,
and canonical URL. Exact-compatible session-listener reuse remains valid; installation MUST NOT be
claimed to reload Codex automatically.
