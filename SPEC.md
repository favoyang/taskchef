# TaskChef specification

## Purpose

TaskChef is an interactive Codex dispatcher. It routes independent assignments
to real Codex tasks in configured local projects, records each submitted
delegation in a task history, and returns immediately. New tasks append; locked
atomic updates may later resolve identity and replace the latest semantic result.

Codex tasks remain authoritative for current activity. TaskChef stores only the
latest useful semantic result, not a second lifecycle or event database.

## Core behavior

1. The user submits a request in the dispatcher workspace or explicitly invokes
   the delegation skill from another Codex project. Work merely concerning the
   TaskChef source code does not implicitly invoke delegation outside the
   dispatcher workspace.
2. TaskChef separates only outcomes that can proceed independently.
3. It selects each target using configured project metadata and validates the
   selected local path.
4. It embeds a generated TaskChef UUID marker, executor-ownership sentence, and
   result-callback instruction, then records the task with `threadId: null`.
5. It creates an independently openable Codex task. A durable returned ID is
   resolved immediately; otherwise the initial-prompt hook links the root
   session ID without polling.
6. It returns without waiting for executor work to complete.
7. Executors report `completed`, `needs_input`, or `failed` through MCP. Reports
   filter old terminal entries, use one live metadata snapshot, and read only
   tasks whose cached result may be stale.

A task created by TaskChef owns its delegated initial assignment. It executes
that assignment in the current task and does not re-dispatch it merely because
the subject is TaskChef or another configured project. The task may still use
TaskChef when the initial assignment explicitly requests delegation of separate
work or when the user later explicitly requests a new delegation.

Several active executors may target the same project.

## Workspace layout

```text
~/.agents/taskchef/
├── AGENTS.md
├── taskchef.json
└── tasks.jsonl
```

`AGENTS.md` contains a marked block that routes setup and administration to
`$taskchef-bootstrap`, actionable work to `$taskchef-delegate`, and explicit
live report requests to `$taskchef-report`. Bootstrap preserves unrelated
instructions and refreshes only the managed block.

`workspace init` is idempotent. It creates an empty configuration and task
log when missing, refreshes managed instructions, and removes legacy TaskChef
skill symlinks.

Every command resolves one workspace in this precedence order:

1. explicit `--workspace <path>`
2. `TASKCHEF_WORKSPACE`
3. `~/.agents/taskchef`

`TASKCHEF_WORKSPACE` must be absolute or start with `~/`; this prevents the
hook, MCP server, and CLI from resolving one relative override against
different process directories. The current directory is never an implicit
workspace. `workspace path` exposes
the resolved absolute path and its source. Bootstrap compares this canonical
path with native Codex projects, and when absent invokes the validated
`codex app <path>` command before verifying the native list again. It never
uses `codex add` or a hard-coded application bundle path.

`doctor` validates configuration, project paths, the JSONL log, managed
instructions, and the absence of legacy TaskChef skill links without modifying
the workspace.

Neither the workspace nor any directory containing it can be configured as a
delegation project. All project configuration and task-history mutations share
one cross-process workspace lock. Writers reread and validate state while
holding that lock and publish complete files by atomic replacement.

## Project configuration

`taskchef.json` is the user-facing routing configuration:

```json
{
  "schemaVersion": 2,
  "projects": [
    {
      "name": "payments-api",
      "path": "/workspace/payments-api",
      "isGitRepository": true,
      "githubRepos": [
        "https://github.com/example/payments-api",
        "https://github.com/example/payments-sdk"
      ],
      "description": "Owns payment authorization, capture, refunds, and provider integrations."
    },
    {
      "name": "local-data-tools",
      "path": "/workspace/local-data-tools",
      "isGitRepository": false,
      "githubRepos": []
    }
  ]
}
```

- `schemaVersion` identifies the configuration format.
- `projects` lists the local routing targets.
- `name` is the unique human-readable project identity.
- `path` is the normalized, canonical local directory. A Git project must use
  its repository root.
- `isGitRepository` identifies Git and non-Git projects.
- `githubRepos` is a deduplicated list of canonical GitHub repository URLs. Use
  `[]` when the project advertises no repositories. A managed `*-workspace`
  project lists each child or sub-repository that should route to it.
- `description` is optional routing context.

TaskChef classifies work against `name`, every URL in `githubRepos`, and
`description`. The path identifies the checkout but is not a routing hint. For
a GitHub issue or pull-request URL, TaskChef compares canonical,
case-insensitive owner/repository identities across every configured list. It
ignores the issue or PR suffix, `http` versus `https`, optional `www`, trailing
slashes, and trailing `.git`. It routes only when one configured project
matches; ambiguous and unmatched URLs are never guessed.

`project add` and `project import` detect Git status, exact Git roots, and
canonical GitHub origins. `--github-repo` is repeatable. Import merges by
canonical path, preserves an existing name or description when omitted, and
unions existing and imported repository lists without duplicates. `--replace`
replaces the configured set. Removing or replacing a project does not alter
historical task entries.

Schema version 2 replaces the string-or-null `githubRepo` field with the
list-valued `githubRepos` field. Schema-version-1 configurations remain
compatible: reads normalize a legacy string to one canonical list item and
legacy `null` to `[]`; `workspace init` persists the migration atomically, and
any later configuration write emits version 2.

The configuration does not store dispatcher identity, execution modes,
schedules, task state, host information, or the workspace path.

## Task entry

`tasks.jsonl` contains one compact JSON object per line, in append order:

```json
{"schemaVersion":3,"id":"c0f010ff-84f2-4838-a69d-0ff1f5d721d7","project":{"name":"payments-api","path":"/workspace/payments-api","isGitRepository":true,"githubRepos":["https://github.com/example/payments-api","https://github.com/example/payments-sdk"],"description":"Owns payment authorization, capture, refunds, and provider integrations."},"title":"Add payment retry logs","instruction":"<!-- taskchef_id=c0f010ff-84f2-4838-a69d-0ff1f5d721d7 -->\n\nThis task owns the delegated assignment. Execute it in this task; do not re-dispatch it merely because it concerns TaskChef or a configured project. Explicit requests to delegate separate work remain valid.\n\nBefore ending, call the TaskChef report_result MCP tool with completed, needs_input, or failed and a concise summary. Use needs_input only for a semantic decision or information the user must provide; a native approval prompt is live Codex state, not a TaskChef result. Do not include secrets, transcripts, or raw command output.\n\nAdd structured logs for failed payment retries and test them.","threadId":"019f9d46-f42c-7482-9707-3c107bf241ee","createdAt":"2026-08-08T10:00:00.000Z","status":"completed","summary":"Added structured retry logs and regression coverage.","turnId":"019f9d47-result-turn","updatedAt":"2026-08-08T10:08:00.000Z","updatedBy":"mcp"}
```

- `schemaVersion` identifies the task entry format.
- `id` is a unique TaskChef task identifier.
- `project` is the complete configured project snapshot used for routing.
- `title` is a short task name.
- `instruction` is the complete executor instruction, including its first-line
  `<!-- taskchef_id=<full UUID> -->` correlation marker, executor-ownership
  paragraph, and assignment body.
- `threadId` identifies the created Codex task, or is `null` when creation was
  accepted but its initial identity has not yet been linked.
- `createdAt` is the dispatch time as an ISO 8601 timestamp.
- `status` is `working`, `needs_input`, `completed`, or `failed`; legacy
  entries normalize it to `null`.
- `summary` is a nullable, bounded latest-result summary.
- `turnId` identifies the initial hook turn or latest reported result turn. An
  MCP result for a linked executor requires it; null is allowed only for a
  failed creation before any durable thread exists.
- `updatedAt` is the server-side update time.
- `updatedBy` is `dispatcher`, `hook`, or `mcp`.

Schema-version-3 entries have exactly these fields. IDs and non-null thread IDs must be
unique; any number of unresolved entries may have `threadId: null`. The file is
empty or newline terminated, with no blank lines. TaskChef rejects a malformed
log instead of skipping bad entries. Writers replace the complete validated
file atomically under a workspace lock, so an interrupted write leaves either
the old history or the complete new history.

Task creation appends entries. Identity resolution and result callbacks acquire
the same cross-process lock, reread and validate the complete log, patch one
matching entry, and atomically replace the file. Resolution is idempotent and
one-way from null to one unique durable thread ID. Result callbacks must match
the recorded task/thread and replace only the latest result snapshot; they do
not append events.

The project snapshot preserves the route even if the project is renamed,
moved, or removed later. Entries never contain transcripts, hidden reasoning,
`hostId`, or an event history.

New task entries use schema version 3. Version 1 and 2 entries remain readable
and normalize to version 3 in API and CLI output with nullable result fields.
Historical task entries with the
old heading-style marker also remain readable. New nullable records, candidate
matching, and resolution require the exact HTML-comment marker; TaskChef never
uses an old marker to correlate a thread. Direct records that already have a
durable thread ID remain marker-independent because they do not use recovery.
TaskChef does not eagerly rewrite legacy history solely for these compatibility
cases.

## Dispatch workflow

For each assignment, `$taskchef-delegate`:

1. calls the structured `prepare_dispatch` tool and native Codex project
   discovery concurrently; the preparation tool resolves the canonical
   workspace, loads and
   validates configured projects, and generates the full UUID, preparation
   timestamp, and exact marker in one process; it never takes a pre-creation
   thread snapshot
2. selects one unambiguous configured target and matches its exact path against
   the already-loaded native projects
3. prefixes the instruction with the prepared exact
   `<!-- taskchef_id=<UUID> -->` marker as the first line, followed by a blank
   line, the executor-ownership sentence, result-callback sentence, and
   assignment body
4. appends a `working` task entry with `threadId: null` through `record_task`
   before executor creation
5. creates a real Codex task at the exact configured path
6. calls `resolve_task` when creation returns a durable thread ID; otherwise it
   returns immediately and the initial `UserPromptSubmit` hook resolves the root
   session ID against the exact marker
7. records executor-creation failure as a `failed` semantic result on the
   already-existing entry
8. never lists, reads, waits for, or polls threads during delegation.

Recording first closes the creation/hook race. On the exact marked prompt, the
hook receives the root session ID and initial turn ID and writes only identity
plus `working`. On later prompts whose session ID matches a recorded executor,
the same `UserPromptSubmit` hook reads the task history and supplies the current
turn ID as callback context without writing. No permission, tool, stop,
notification, or session hook writes task lifecycle state. A provisional
`local:` ID is diagnostic only and can never be persisted as `threadId`.

The plugin bundles a local stdio MCP server with focused `prepare_dispatch`,
`record_task`, `resolve_task`, and `report_result` tools. It accepts no workspace path from the
model and resolves only an absolute (or `~/`-prefixed) `TASKCHEF_WORKSPACE` or the canonical
`~/.agents/taskchef` default. The write tools reuse the public workspace APIs,
so structured calls cannot bypass exact-field validation, locking, atomic
replacement, unique IDs, or one-way nullable resolution. They are closed-world
local mutations and never create Codex tasks. Desktop thread tools remain
available only to the Codex skill; the standalone CLI remains available for
bootstrap, manual inspection, and recovery.

### Legacy end-to-end benchmark results

Schema-v1 benchmark fixtures below validate historical bounded-resolver
artifacts only. New benchmarks must measure record-before-create, initial-hook
identity, and result callbacks without using the removed snapshot resolver.

An explicitly requested live benchmark writes one ignored, timestamped JSON
artifact through `scripts/e2e-benchmark.js`. Schema version 1 contains:

- benchmark name, TaskChef version, run ID, and wall-clock start/end
- project, title, and exact unmarked workload prompt
- TaskChef task ID, nullable durable/client IDs, recording state, resolution,
  and attempt count
- ISO start/end, derived duration, and outcome for preparation/project listing,
  task creation, recording, and optional provisional resolution
- boolean record, marker, executor-output, and candidate-filter-effectiveness
  validation results
- derived total wall time, measured stage time, orchestration overhead,
  resolution state, and attempt count

Stage outcomes are `success|failed` for preparation,
`durable|provisional|failed` for creation, `recorded|failed` for recording, and
`native|discovered|unresolved|failed` for provisional resolution. `failed`
distinguishes a terminal resolver error from a completed no-match checkpoint,
which must proceed to the second fallback attempt. Task resolution is
`immediate|native|discovered|unresolved`. Preparation failure has only the
preparation stage and a null task ID; creation failure stops after creation;
recording failure stops before provisional resolution. The committed example
shows the durable success shape, while these transition rules define the
shorter failure and longer provisional shapes.
The writer derives `taskchefVersion` from the running package instead of
trusting template input. Raw executor output and transcripts are never stored;
`outputVerified` records only whether the requested output was verified.

The writer rejects missing required stages, duplicate or unknown stages,
invalid timestamps, contradictory workflow outcomes, overlapping stages,
unknown fields, and overwriting an existing run. Later stages are omitted when
preparation or creation fails, and provisional resolution is omitted when task
recording fails. Fallback snapshot observations include the complete recent
task count plus the filtered candidate and exact-match counts, from which
candidate-filter effectiveness is checked. Each snapshot records
`resolveWriteOutcome` as `not-attempted`, `succeeded`, or `failed`, so a unique
match followed by an atomic write failure remains an honest unresolved result.
A compact valid starting document is committed as
`assets/e2e-benchmark-example.json`. Filenames use
`<startedAt-with-colons-replaced>-taskchef-delegate-e2e.json`. Its cleanup
operation removes only files matching the full generated filename grammar in
the selected results directory.

`task record` rejects an interactive TTY before reading because its protocol is
exactly one JSON value followed by EOF. Workspace-lock contention is retried for
up to seven seconds, while permanent permission failures such as `EPERM` or
`EACCES` fail immediately so the caller can request the required permission
without paying the contention retry budget.

A failed executor creation normally leaves its pre-created entry with `failed`.
The exported orchestration helper attaches `taskChefTaskId` and
`taskChefResultReporting` (`recorded`, `failed`, or `unavailable`) to a thrown
creation error so callers can recover the entry if failure reporting itself was
not available. A failed pre-creation record stops before executor creation, so
there is no untracked executor.

## Task history and live reports

The CLI reads persisted history without contacting Codex:

- `task show <id-or-8-character-prefix>` returns one entry. By default it emits
  labeled human-readable lines for title, project, status, summary, creation and
  update metadata, task/thread/turn IDs, and instruction. A null ID renders as `-`.
  Carriage returns and newlines in labeled values render as `\\r` and `\\n`.
  The instruction starts on the line after `Instruction:` and retains its stored
  line breaks and indentation. `--json` returns the unchanged complete task
  object. The short form is the exact ID text printed by the default
  human-readable `task list` output and succeeds only when it identifies
  exactly one recorded task. Missing, ambiguous, malformed, shorter, and
  wrong-case prefixes fail without selecting a task.
- `task list` returns entries newest-first by creation time, optionally filtered
  by historical project name or exact path. `--ascending` returns oldest-first.
  Human rows include status, update time, task ID, and thread ID, abbreviating UUID-shaped IDs
  to their first eight-character section unless `--full-id` is passed. Null
  thread IDs display as `-`. ID formatting does not alter JSON values, and the
  selected order applies to both human rows and the JSON `tasks` array.
- `task summary` returns the total and per-project counts.
- `task resolve <id> --thread-id <thread-id>` atomically fills one nullable
  thread ID after Codex verifies the exact structured marker match.

When the user requests an overview, `$taskchef-report` includes working,
needs-input, unresolved, legacy, and terminal tasks updated during the last
seven days. It omits older terminal entries unless explicitly requested or a
single recent-thread metadata snapshot shows that they are active or awaiting
approval. That one snapshot is a broad contradiction check: active or awaiting-
approval metadata overrides a cached result immediately, without one detailed
read per task. An inactive state does not prove semantic completion; in a broad
overview it permits an `updatedBy: mcp` result to stand by default.
Dispatcher- or hook-written `working` snapshots have no semantic callback and
trigger a live read when selected; an inactive task without an MCP callback has
an unknown outcome. An MCP-written `failed` snapshot with null thread/turn IDs
is a fresh executor-creation failure and requires no live lookup. For a focused
task, title, or project report, any newer matched metadata timestamp triggers at
most one targeted read per selected inactive task. This distinguishes normal
same-turn finalization from a quick newer turn by comparing structured turn IDs
and native turn state. Missing callbacks, uncertain or contradictory identity
or metadata, and explicitly fully-live requests also trigger one targeted read.
Reads are batched in groups of eight. Broad overviews do not fan out reads over
idle terminal tasks solely because their timestamps are newer. Reporting never
persists inferred live state and does not poll, wait, or schedule work.

## Boundaries

TaskChef does not include:

- lifecycle event history or hook-inferred completion
- lifecycle event types beyond `UserPromptSubmit`
- indefinite polling, daemons, heartbeats, dispatcher wakeups, or schedules
- arbitrary Codex task discovery
- remote hosts or `hostId` storage
- transcript or hidden-reasoning collection
- one-active-task-per-project restrictions
- batch cancellation or replay
- bundled development runtimes in dispatcher workspaces.

## Acceptance test

1. Bootstrap creates `AGENTS.md`, `taskchef.json`, and `tasks.jsonl`, then
   remains idempotent.
2. Project metadata routes an unambiguous request to the correct local project.
3. A delegation records `working` before creating a visible Codex task.
4. A durable creation resolves immediately; a provisional creation is linked
   by the initial exact-marker hook without polling.
5. The dispatcher returns without waiting for execution.
6. Several independent assignments can create several entries, including
   multiple entries for the same project.
7. Task history commands return deterministic entries and project counts.
8. MCP callbacks replace the latest needs-input, completed, or failed snapshot.
9. A report skips old terminal tasks by default, checks live metadata once,
   overrides active or approval-waiting tasks directly, and reads only anomalous
   candidates without writing inferred state.
10. Malformed JSONL, duplicate IDs, duplicate thread IDs, and symlinked managed
   files fail safely.
